// The single execution chokepoint for the smart-account / 1Shot path. Given an owner, the agent role
// that should act, and the on-chain executions to perform, it:
//   1. loads the user's stored signed root delegation (user -> orchestrator) from agent_delegations,
//   2. builds + signs the remaining redelegation hops with backend agent keys so the LAST delegate is
//      1Shot's relayer targetAddress (the redeemer): user -> orchestrator [-> specialist] -> relayer,
//   3. prepends a USDC fee transfer to the relayer feeCollector (1Shot's stablecoin-gas model),
//   4. submits the bundle to the 1Shot permissionless relayer (gas paid in USDC).
//
// Gated by DUALITY_EXEC_VIA_SMART_ACCOUNT — when false, callers fall back to the existing proven path
// (Gelato/PrivateKeySigner for GMX, ethers vault for stocks). Nothing here runs until the flag is on
// AND a stored delegation exists. The live redemption is proven via the browser MetaMask 7702 flow
// before this is enabled broadly (see plan W5).

import { encodeFunctionData, parseAbi, getAddress, createPublicClient, http, createWalletClient, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  getSmartAccountsEnvironment,
  createDelegation,
  signDelegation,
  toMetaMaskSmartAccount,
  Implementation,
  ScopeType,
} from "@metamask/smart-accounts-kit";
import { createCaveatBuilder, decodeDelegations } from "@metamask/smart-accounts-kit/utils";
import { redelegatePermissionContextAction } from "@metamask/smart-accounts-kit/actions";
import { db } from "./db.js";
import { agentAccountKey, type AgentRole } from "./agentExec.js";
import * as relayer from "./oneShotRelayer.js";
import { execChain, DEFAULT_EXEC_CHAIN } from "./execChains.js";

export function smartAccountExecEnabled(): boolean {
  return (process.env.DUALITY_EXEC_VIA_SMART_ACCOUNT ?? "false") === "true";
}

// 1Shot minFee/requiredPaymentAmount are decimal-USDC OR integer-atom strings; normalize to atoms.
function feeStrToAtoms(v: string | undefined, fallbackAtoms = 20000n): bigint {
  if (v == null) return fallbackAtoms;
  const s = String(v);
  if (s.includes(".")) { const n = Number(s); return Number.isFinite(n) ? BigInt(Math.ceil(n * 1e6)) : fallbackAtoms; }
  if (/^\d+$/.test(s)) return BigInt(s);
  return fallbackAtoms;
}

function usdcTransfer(token: Address, to: Address, atoms: bigint): relayer.Execution7710 {
  return {
    target: token, value: "0x0",
    data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [to, atoms] }),
  };
}
function publicClientFor(chainId: number) {
  const c = execChain(chainId);
  return createPublicClient({ chain: c.chain, transport: http(c.rpc) });
}

export interface SubmitInput {
  chainId: number;
  permissionContext: relayer.Delegation7710[];
  workExecutions: relayer.Execution7710[];
  feeCollector: Address;
  authorizationList?: relayer.Authorization7702[];
  destinationUrl?: string;
  memo?: string;
  // Put the USDC fee transfer AFTER the work executions instead of before. Used by the self-funding
  // CCTP mint: receiveMessage mints USDC to the agent first, then the fee is paid from that fresh
  // balance — so no destination-chain pre-funding is needed. Proven order-agnostic at the relayer
  // (scripts/oneshot-feelast-test.mjs: FEE-LAST estimate success=true).
  feeLast?: boolean;
}
export interface SubmitOutput { taskId: string; feeUsdc: number; requiredPaymentAtoms: string }

/** Canonical 1Shot submission (matches 1Shot's documented intended flow):
 *   getFeeData (price-lock context) -> estimate7710 (requiredPaymentAmount) -> send7710 with the EXACT
 *   required USDC fee transfer to feeCollector + the signed context. The fee transfer is prepended to
 *   the work executions (the USDC stablecoin-gas model); authorizationList is included only for an
 *   in-flight EOA->smart-account upgrade (first use of a not-yet-upgraded account). */
export async function submitDelegatedBundle(input: SubmitInput): Promise<SubmitOutput> {
  const chainId = input.chainId;
  const usdc = execChain(chainId).usdc;
  const fee = await relayer.getFeeData(chainId, usdc); // gasPrice, rate, minFee, signed context
  const minFeeAtoms = feeStrToAtoms(fee.minFee);
  const authPart = input.authorizationList?.length ? { authorizationList: input.authorizationList } : {};

  // The IN-FLIGHT 7702 upgrade case: when an authorizationList is present, the account isn't a smart
  // account YET — 1Shot upgrades it in the same relayed Type-4 tx. eth_estimateGas can't apply that
  // authorization, so estimate7710 always reverts here. We therefore SKIP the estimate gate for the
  // in-flight-upgrade path and pay a getFeeData-based fee (minFee + headroom) directly. This is the
  // 1Shot-intended "upgrade EOA -> smart account through the relayer, gas in USDC" path.
  const inFlightUpgrade = Boolean(input.authorizationList?.length);
  // Order the fee transfer relative to the work. feeLast = work first (so a self-funding mint can pay
  // the fee from its own output); default = fee first (the canonical order for funded accounts).
  const order = (feeAtoms: bigint): relayer.Execution7710[] =>
    input.feeLast
      ? [...input.workExecutions, usdcTransfer(usdc, input.feeCollector, feeAtoms)]
      : [usdcTransfer(usdc, input.feeCollector, feeAtoms), ...input.workExecutions];

  let requiredAtoms: bigint;
  let sendContext: string | undefined = fee.context;
  if (inFlightUpgrade) {
    // No estimate (can't simulate the upgrade). Use minFee + ~50% headroom over the quote.
    requiredAtoms = minFeeAtoms + minFeeAtoms / 2n + 5000n;
  } else {
    // 1) estimate with a provisional (minFee) fee transfer to obtain the exact requiredPaymentAmount.
    const est = await relayer.estimate7710({
      chainId: String(chainId),
      transactions: [{ permissionContext: input.permissionContext, executions: order(minFeeAtoms) }],
      ...(fee.context ? { context: fee.context } : {}),
    });
    if (!est.success) throw new Error(`1Shot estimate failed: ${est.error ?? "unknown"}`);
    requiredAtoms = feeStrToAtoms(est.requiredPaymentAmount, minFeeAtoms);
    if (est.context) sendContext = est.context;
  }

  // 2) send the final bundle with the required fee + the locked context (+ authorizationList for the
  //    in-flight upgrade, applied by 1Shot in the relayed Type-4 transaction).
  const taskId = await relayer.send7710({
    chainId: String(chainId),
    transactions: [{ permissionContext: input.permissionContext, executions: order(requiredAtoms) }],
    ...authPart,
    ...(sendContext ? { context: sendContext } : {}),
    ...(input.destinationUrl ? { destinationUrl: input.destinationUrl } : {}),
    ...(input.memo ? { memo: input.memo } : {}),
  });
  return { taskId, feeUsdc: Number(requiredAtoms) / 1e6, requiredPaymentAtoms: requiredAtoms.toString() };
}

export interface ExecRequest {
  ownerId: number;
  chainId?: number;                // execution chain (default Arbitrum One); 8453 = Base for cross-chain
  role: AgentRole;                 // single agent (A2A dropped)
  executions: relayer.Execution7710[]; // the work calls {target, value, data}
  kind?: string;                   // gmx_order | lp_mint | stock_buy | ... (ledger tag)
  refId?: string;                  // optional FK into a sleeve ledger
  memo?: string;
  destinationUrl?: string;         // 1Shot status webhook
  feeLast?: boolean;               // pay the 1Shot fee AFTER the work (self-funding CCTP mint)
}
export interface ExecResult {
  ok: boolean;
  taskId?: string;
  feeUsdc?: string;
  error?: string;
}

// An ERC-7715 grant wrapper (stored in signed_delegation when grantType=erc7715).
interface Erc7715Grant { grantType: "erc7715"; context: Hex; delegationManager?: string; dependencies?: unknown }
function isErc7715Grant(o: unknown): o is Erc7715Grant {
  return Boolean(o && typeof o === "object" && (o as { grantType?: string }).grantType === "erc7715" && typeof (o as Erc7715Grant).context === "string");
}

interface RootDelegationRow {
  signed: relayer.Delegation7710 | Erc7715Grant;
  delegator: string;
  auth: relayer.Authorization7702 | null;
}
/** Load the owner's active root delegation/grant for this chain, plus the user's stored EIP-7702
 *  authorization (for an in-flight upgrade if the account isn't upgraded yet; ERC-7715 grants have none
 *  since MetaMask handles the upgrade). */
async function loadRootDelegation(ownerId: number, chainId: number): Promise<RootDelegationRow | null> {
  const r = await db.query(
    `SELECT signed_delegation, delegator_address, eip7702_auth FROM agent_delegations
       WHERE owner_id=$1 AND chain_id=$2 AND parent_id IS NULL AND status='active'
       ORDER BY created_at DESC LIMIT 1`,
    [ownerId, chainId],
  );
  if (!r.rowCount) return null;
  return {
    signed: r.rows[0].signed_delegation as relayer.Delegation7710 | Erc7715Grant,
    delegator: r.rows[0].delegator_address as string,
    auth: (r.rows[0].eip7702_auth as relayer.Authorization7702 | null) ?? null,
  };
}

/** Whether an address is already a deployed/upgraded smart account (has code). A 7702-upgraded EOA
 *  carries an `0xef0100…` delegation designator; a plain EOA returns "0x". */
async function isUpgraded(address: string, chainId: number): Promise<boolean> {
  const code = await publicClientFor(chainId).getCode({ address: getAddress(address) }).catch(() => undefined);
  return Boolean(code && code !== "0x");
}

const env = (chainId: number) => getSmartAccountsEnvironment(chainId);

/** Build the permissionContext so the final delegate is the 1Shot relayer target.
 *  A2A multi-tier was dropped: there is exactly ONE agent. The user delegates to the agent (the root,
 *  via ERC-7710 or ERC-7715), and the agent redelegates ONCE to the 1Shot relayer (the redeemer). If
 *  the root already delegates to the relayer (e.g. the local-signer proof path), no hop is added.
 *  Returns the array ordered leaf-first (delegation to the redeemer first). */
async function buildChainToRelayer(
  root: relayer.Delegation7710,
  ownerId: number,
  chainId: number,
  relayerTarget: Address,
  executionTargets: Address[],
): Promise<relayer.Delegation7710[]> {
  const environment = env(chainId);
  const dm = environment.DelegationManager as Address;

  // Root already targets the relayer (single-hop user->relayer): redeem directly.
  if (getAddress(root.delegate) === getAddress(relayerTarget)) return [root];

  // Otherwise the agent (the root's delegate) redelegates once to the relayer, narrowed to the
  // execution targets + USDC (fee). The agent signs with its backend key.
  const agent = await agentAccountKey(ownerId, "agent");
  if (getAddress(root.delegate) !== getAddress(agent.address)) {
    throw new Error(`DELEGATE_MISMATCH: root delegates to ${root.delegate}, expected agent ${agent.address}`);
  }
  const targets = Array.from(new Set([execChain(chainId).usdc, ...executionTargets].map((a) => getAddress(a))));
  const caveats = createCaveatBuilder(environment).addCaveat("allowedTargets", { targets }).build();
  const redelegation = createDelegation({
    environment, from: getAddress(agent.address), to: relayerTarget, parentDelegation: root, caveats,
  } as unknown as Parameters<typeof createDelegation>[0]);
  const signature = await signDelegation({ privateKey: agent.privateKey as Hex, delegation: redelegation, delegationManager: dm, chainId });
  const agentToRelayer = { ...(redelegation as unknown as relayer.Delegation7710), signature };

  // leaf-first: [agent->relayer, user->agent]
  return [agentToRelayer, root];
}

/** Build the permissionContext from an ERC-7715 grant (wallet_grantPermissions). MetaMask granted the
 *  permission to the agent (session) account; the agent redelegates that context to the 1Shot relayer
 *  (the redeemer), then we decode the resulting chain into Delegation7710[] for 1Shot. The agent must
 *  itself be a smart account (7702-upgraded) to redelegate — ensured by ensureAgentUpgraded. */
async function buildChainFromGrant(
  grant: Erc7715Grant,
  ownerId: number,
  chainId: number,
  relayerTarget: Address,
  executionTargets: Address[],
): Promise<relayer.Delegation7710[]> {
  const environment = env(chainId);
  const c = execChain(chainId);
  const agent = await agentAccountKey(ownerId, "agent");
  const account = privateKeyToAccount(agent.privateKey as Hex);
  const wc = createWalletClient({ account, chain: c.chain, transport: http(c.rpc) });
  const targets = Array.from(new Set([c.usdc, ...executionTargets].map((a) => getAddress(a))));
  const caveats = createCaveatBuilder(environment).addCaveat("allowedTargets", { targets }).build();

  // Agent redelegates the granted permission context to the 1Shot relayer (narrowed to allowedTargets).
  const { permissionContext: extended } = await redelegatePermissionContextAction(wc, {
    account,
    environment,
    permissionContext: grant.context,
    to: relayerTarget,
    caveats,
  } as unknown as Parameters<typeof redelegatePermissionContextAction>[1]);

  // Decode the extended chain (user->agent->relayer) into the Delegation7710[] 1Shot expects.
  const decoded = decodeDelegations(extended as Hex) as unknown as relayer.Delegation7710[];
  return decoded;
}

/** Canonical 1Shot connectivity proof: builds a MetaMask Smart Account (Stateless7702) for a local
 *  signer, signs an EIP-7710 delegation directly to the relayer redeemer, and submits a tiny USDC
 *  self-transfer via the canonical handshake. Confirms on-chain by the balance delta (= the fee). */
export async function runCanonicalSelfTransferTest(privateKey: string, usdcAmount = 0.05, chainId: number = DEFAULT_EXEC_CHAIN): Promise<{
  ok: boolean; taskId?: string; feeUsdc?: number; landed?: boolean; deltaUsdc?: number; user?: string; chainId?: number; error?: string;
}> {
  const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
  const account = privateKeyToAccount(pk);
  const user = getAddress(account.address);
  const c = execChain(chainId);
  const USDC = c.usdc;
  const pc = createPublicClient({ chain: c.chain, transport: http(c.rpc) });
  const environment = env(chainId);

  const caps = await relayer.getCapabilities(chainId);
  if (!caps?.targetAddress || !caps?.feeCollector) return { ok: false, error: "RELAYER_NO_CAPABILITIES" };
  const relayerTarget = getAddress(caps.targetAddress);

  const sa = await toMetaMaskSmartAccount({ client: pc, implementation: Implementation.Stateless7702, address: user, signer: { account }, environment });
  const now = Math.floor(Date.now() / 1000);
  const selfAtoms = BigInt(Math.round(usdcAmount * 1e6));
  const caveats = createCaveatBuilder(environment)
    .addCaveat("allowedTargets", { targets: [USDC] })
    .addCaveat("timestamp", { afterThreshold: now - 60, beforeThreshold: now + 3600 })
    .build();
  const delegation = createDelegation({
    environment, from: user, to: relayerTarget,
    scope: { type: ScopeType.Erc20PeriodTransfer, tokenAddress: USDC, periodAmount: selfAtoms + 300000n, periodDuration: 86400, startDate: now - 60 },
    caveats,
  } as unknown as Parameters<typeof createDelegation>[0]);
  const signature = await sa.signDelegation({ delegation, chainId });
  const signedDelegation = { ...(delegation as unknown as relayer.Delegation7710), signature };

  // In-flight upgrade only if the account isn't already a smart account.
  let authorizationList: relayer.Authorization7702[] | undefined;
  if (!(await isUpgraded(user, chainId))) {
    const impl = getAddress((environment.implementations as Record<string, string>).EIP7702StatelessDeleGatorImpl);
    const nonce = await pc.getTransactionCount({ address: user });
    const wc = createWalletClient({ account, chain: c.chain, transport: http(c.rpc) });
    const auth = await wc.signAuthorization({ account, contractAddress: impl, nonce });
    authorizationList = [{ address: getAddress(impl), chainId, nonce, r: auth.r, s: auth.s, yParity: auth.yParity ?? 0 }];
  }

  const workExecutions: relayer.Execution7710[] = [usdcTransfer(USDC, user, selfAtoms)];
  const balAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const before = await pc.readContract({ address: USDC, abi: balAbi, functionName: "balanceOf", args: [user] }) as bigint;

  const { taskId, feeUsdc } = await submitDelegatedBundle({
    chainId, permissionContext: [signedDelegation], workExecutions, feeCollector: getAddress(caps.feeCollector),
    authorizationList, destinationUrl: process.env.ONESHOT_WEBHOOK_URL, memo: "1shot canonical self-transfer test",
  });

  let landed = false, after = before;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    after = await pc.readContract({ address: USDC, abi: balAbi, functionName: "balanceOf", args: [user] }) as bigint;
    if (after !== before) { landed = true; break; }
  }
  return { ok: true, taskId, feeUsdc, landed, deltaUsdc: Number(after - before) / 1e6, user, chainId };
}

/** Execute the given calls on the user's behalf via a delegation chain redeemed by the 1Shot relayer,
 *  paying gas in USDC. Returns the relayer TaskId. */
export async function executeViaOneShot(req: ExecRequest): Promise<ExecResult> {
  if (!smartAccountExecEnabled()) return { ok: false, error: "SMART_ACCOUNT_EXEC_DISABLED" };
  try {
    const chainId = req.chainId ?? DEFAULT_EXEC_CHAIN;
    const caps = await relayer.getCapabilities(chainId);
    if (!caps?.targetAddress) return { ok: false, error: "RELAYER_NO_CAPABILITIES" };
    const relayerTarget = getAddress(caps.targetAddress);
    const feeCollector = getAddress(caps.feeCollector);

    const root = await loadRootDelegation(req.ownerId, chainId);
    if (!root) return { ok: false, error: "NO_ACTIVE_DELEGATION" };

    const executionTargets = req.executions.map((e) => getAddress(e.target));

    // ERC-7715 grant (Advanced Permissions) vs ERC-7710 signed delegation. For 7715, MetaMask already
    // upgraded the user's account, so no authorizationList from us; the agent redelegates to 1Shot.
    let permissionContext: relayer.Delegation7710[];
    let authorizationList: relayer.Authorization7702[] | undefined;
    if (isErc7715Grant(root.signed)) {
      permissionContext = await buildChainFromGrant(root.signed, req.ownerId, chainId, relayerTarget, executionTargets);
    } else {
      permissionContext = await buildChainToRelayer(root.signed, req.ownerId, chainId, relayerTarget, executionTargets);
      // In-flight EOA->smart-account upgrade only when the user account isn't already upgraded AND we
      // hold its stored 7702 authorization (canonical: omit authorizationList for an upgraded SA).
      authorizationList = (!(await isUpgraded(root.delegator, chainId)) && root.auth) ? [root.auth] : undefined;
    }

    const { taskId, feeUsdc } = await submitDelegatedBundle({
      chainId,
      permissionContext,
      workExecutions: req.executions,
      feeCollector,
      authorizationList,
      destinationUrl: req.destinationUrl,
      memo: req.memo,
      feeLast: req.feeLast,
    });

    // Record the task so the webhook / status poller can track it (source of truth for status).
    await db.query(
      `INSERT INTO agent_relay_tasks (task_id, owner_id, role, kind, ref_id, chain_id, status, fee_usdc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (task_id) DO NOTHING`,
      [taskId, req.ownerId, req.role, req.kind ?? null, req.refId ?? null, chainId, relayer.STATUS.SUBMITTED, feeUsdc],
    ).catch(() => { /* ledger best-effort; the taskId is still returned */ });

    return { ok: true, taskId, feeUsdc: feeUsdc.toFixed(6) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function recordTask(taskId: string, ownerId: number, kind: string, chainId: number, feeUsdc: number): Promise<void> {
  await db.query(
    `INSERT INTO agent_relay_tasks (task_id, owner_id, role, kind, ref_id, chain_id, status, fee_usdc)
     VALUES ($1,$2,'agent',$3,NULL,$4,$5,$6) ON CONFLICT (task_id) DO NOTHING`,
    [taskId, ownerId, kind, chainId, relayer.STATUS.SUBMITTED, feeUsdc],
  ).catch(() => { /* best-effort */ });
}

/** STAGE A — pull the user's budget into the agent's account by redeeming the user's authorization
 *  (ERC-7715 grant or ERC-7710 delegation) for a single USDC.transfer to the agent. This is the ONLY
 *  thing MetaMask lets the user authorize on their account (a token transfer); the agent then does the
 *  contract calls in Stage B. Bounded by the granted period cap. Relayed by 1Shot (gas in USDC). */
export async function pullBudgetToAgent(ownerId: number, chainId: number, usdcAmount: number): Promise<ExecResult> {
  if (!smartAccountExecEnabled()) return { ok: false, error: "SMART_ACCOUNT_EXEC_DISABLED" };
  const { address: agent } = await agentAccountKey(ownerId, "agent");
  const usdc = execChain(chainId).usdc;
  const atoms = BigInt(Math.round(usdcAmount * 1e6));
  return executeViaOneShot({ ownerId, chainId, role: "agent", executions: [usdcTransfer(usdc, getAddress(agent), atoms)], kind: "pull_budget", memo: `pull ${usdcAmount} USDC to agent` });
}

export interface AgentSubmitOpts {
  ownerId: number;
  chainId: number;
  workExecutions: relayer.Execution7710[];
  allowedTargets: Address[];   // FunctionCall scope: contracts the agent may call (USDC is added automatically)
  selectors: string[];         // FunctionCall scope: method signatures (transfer is added automatically for the fee)
  valueCapWei?: bigint;        // native-value cap per call (GMX keeper fee); default 0
  feeLast?: boolean;           // pay the 1Shot fee AFTER the work (self-funding CCTP mint)
  kind?: string;
  memo?: string;
}

/** STAGE B — execute contract calls FROM the agent's own account. The agent (a MetaMask Smart Account
 *  over its backend key) signs a scoped FunctionCall delegation to the 1Shot relayer and redeems the
 *  work executions (gas in USDC). In-flight 7702-upgrades the agent account on first use. The agent must
 *  already hold the USDC (from Stage A) to pay the 1Shot fee — and a little ETH only if a leg carries
 *  native value (GMX keeper fee). This is the proven GMX-adapter pattern, generalized to any leg. */
export async function submitAsAgent(opts: AgentSubmitOpts): Promise<{ ok: true; taskId: string; feeUsdc: number; agent: Address } | { ok: false; error: string }> {
  if (!smartAccountExecEnabled()) return { ok: false, error: "SMART_ACCOUNT_EXEC_DISABLED" };
  try {
    const { address, privateKey } = await agentAccountKey(opts.ownerId, "agent");
    const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
    const account = privateKeyToAccount(pk);
    const agent = getAddress(address);
    const chainId = opts.chainId;
    const c = execChain(chainId);
    const environment = env(chainId);
    const pc = publicClientFor(chainId);

    const caps = await relayer.getCapabilities(chainId);
    if (!caps?.targetAddress || !caps?.feeCollector) return { ok: false, error: "RELAYER_NO_CAPABILITIES" };
    const relayerTarget = getAddress(caps.targetAddress);
    const now = Math.floor(Date.now() / 1000);

    // FunctionCall scope: allow the work targets + USDC (the appended fee transfer / approvals), the work
    // selectors + transfer/approve, and a native-value cap. NOT a transfer scope (those forbid calldata).
    const targets = Array.from(new Set([...opts.allowedTargets.map(getAddress), c.usdc].map((a) => getAddress(a))));
    const selectors = Array.from(new Set([...opts.selectors, "transfer(address,uint256)", "approve(address,uint256)"]));
    const delegation = createDelegation({
      environment, from: agent, to: relayerTarget,
      scope: { type: ScopeType.FunctionCall, targets, selectors, valueLte: { maxValue: opts.valueCapWei ?? 0n } },
      caveats: createCaveatBuilder(environment).addCaveat("timestamp", { afterThreshold: now - 60, beforeThreshold: now + 3600 }).build(),
    } as unknown as Parameters<typeof createDelegation>[0]);
    // The agent's MetaMask Smart Account signs (local key — NOT subject to MetaMask's internal-account block).
    const sa = await toMetaMaskSmartAccount({ client: pc, implementation: Implementation.Stateless7702, address: agent, signer: { account }, environment });
    const signature = await sa.signDelegation({ delegation, chainId });
    const signed = { ...(delegation as unknown as relayer.Delegation7710), signature };

    // In-flight 7702 upgrade of the agent account on first use (gas in USDC via 1Shot).
    let authorizationList: relayer.Authorization7702[] | undefined;
    if (!(await isUpgraded(agent, chainId))) {
      const impl = getAddress((environment.implementations as Record<string, string>).EIP7702StatelessDeleGatorImpl);
      const nonce = await pc.getTransactionCount({ address: agent });
      const wc = createWalletClient({ account, chain: c.chain, transport: http(c.rpc) });
      const auth = await wc.signAuthorization({ account, contractAddress: impl, nonce });
      authorizationList = [{ address: impl, chainId, nonce, r: auth.r, s: auth.s, yParity: auth.yParity ?? 0 }];
    }

    const { taskId, feeUsdc } = await submitDelegatedBundle({
      chainId, permissionContext: [signed], workExecutions: opts.workExecutions,
      feeCollector: getAddress(caps.feeCollector), authorizationList, feeLast: opts.feeLast,
      memo: opts.memo, destinationUrl: process.env.ONESHOT_WEBHOOK_URL,
    });
    await recordTask(taskId, opts.ownerId, opts.kind ?? "agent_exec", chainId, feeUsdc);
    return { ok: true, taskId, feeUsdc, agent };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
