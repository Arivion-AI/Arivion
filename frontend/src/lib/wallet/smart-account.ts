"use client";

// MetaMask Smart Account + EIP-7710 delegation (the hackathon main-flow centerpiece).
//
// Implements the real delegation lifecycle, not just a wallet connect:
//  1. Upgrade the user's existing MetaMask EOA in place via EIP-7702 (Stateless7702) — same address,
//     keeps their USDC, no migration. The signed 7702 authorization rides with the first 1Shot
//     redemption (W5).
//  2. Create a SCOPED EIP-7710 delegation (USDC daily spend + allowedTargets + time window) granting
//     the backend ORCHESTRATOR agent account bounded authority.
//  3. Sign it via MetaMask (EIP-712), then POST the signed delegation to the backend store.
//
// All on Arbitrum One (42161). The orchestrator later redelegates narrowed scope to specialist
// agents (W4) and redeems via the DelegationManager through 1Shot (W5).

import {
  getSmartAccountsEnvironment,
  createDelegation,
  toMetaMaskSmartAccount,
  Implementation,
  ScopeType,
} from "@metamask/smart-accounts-kit";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import { createWalletClient, createPublicClient, custom, http, getAddress, type Address } from "viem";
import { arbitrum } from "viem/chains";
import { netrunnersGet, netrunnersPost } from "@/lib/netrunners/api";
import { preferredProvider } from "@/lib/wallet/evm";

export const ARBITRUM_ONE = 42161;

// Arbitrum One contract targets the delegation is scoped to (allowedTargets caveat). Native USDC plus
// the venues the agent trades into. Kept here as the single source of truth for the W3 grant; W6 adds
// the rest of the GM/GLV markets as they're wired.
export const ARB_USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const GMX_EXCHANGE_ROUTER: Address = "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6"; // GMX Router (USDC plugin-transfer)
export const GMX_EXCHANGE_ROUTER_V2: Address = "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41"; // ExchangeRouter (multicall target)
export const UNISWAP_NPM: Address = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"; // NonfungiblePositionManager
export const UNISWAP_SWAP_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // SwapRouter02
export const CCTP_TOKEN_MESSENGER: Address = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"; // TokenMessengerV2 (CCTP burn)

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
function injected(): Eip1193 {
  // Prefer MetaMask Flask (ERC-7715 Advanced Permissions is Flask-only), via the shared EIP-6963
  // resolver; falls back to regular MetaMask / window.ethereum.
  const eth = (preferredProvider() ?? (typeof window !== "undefined" ? (window as unknown as { ethereum?: Eip1193 }).ethereum : null)) as Eip1193 | null | undefined;
  if (!eth) throw new Error("No EVM wallet found. Install MetaMask.");
  return eth;
}

const ARB_ONE_HEX = "0xa4b1"; // 42161
/** Ensure MetaMask is on Arbitrum One — all delegation/7702/redemption is chain-bound to 42161. */
export async function ensureArbitrumOne(): Promise<void> {
  const eth = injected();
  const current = (await eth.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() === ARB_ONE_HEX) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARB_ONE_HEX }] });
  } catch (e) {
    if ((e as { code?: number }).code === 4902) {
      await eth.request({ method: "wallet_addEthereumChain", params: [{
        chainId: ARB_ONE_HEX, chainName: "Arbitrum One",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://arb1.arbitrum.io/rpc"], blockExplorerUrls: ["https://arbiscan.io"],
      }] });
    } else throw e;
  }
}

function clients(account: Address) {
  const eth = injected();
  const walletClient = createWalletClient({ account, chain: arbitrum, transport: custom(eth) });
  // Reads go through a public RPC; the Arbitrum One default works for counterfactual address derivation.
  const publicClient = createPublicClient({ chain: arbitrum, transport: http() });
  return { walletClient, publicClient };
}

/** Build the user's MetaMask Smart Account as an EIP-7702 upgrade-in-place of their existing EOA.
 *  The account keeps the EOA address (and its USDC). Returns the SA + the kit environment. */
export async function buildUserSmartAccount(userEoa: Address) {
  const address = getAddress(userEoa);
  const { walletClient, publicClient } = clients(address);
  const environment = getSmartAccountsEnvironment(ARBITRUM_ONE);
  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Stateless7702,
    address,                       // SAME address as the EOA — upgrade in place
    signer: { walletClient },
    environment,
  });
  return { smartAccount, environment, walletClient, publicClient };
}

/** Sign the EIP-7702 authorization that points the user's EOA at the stateless delegator
 *  implementation. Submitted on-chain (gas in USDC) by 1Shot alongside the first redemption (W5). */
export async function signEip7702Authorization(userEoa: Address) {
  const address = getAddress(userEoa);
  const { walletClient } = clients(address);
  const environment = getSmartAccountsEnvironment(ARBITRUM_ONE);
  const impls = environment.implementations as Record<string, Address>;
  const implementation = impls.EIP7702StatelessDeleGatorImpl ?? impls.EIP7702StatelessDeleGator;
  if (!implementation) throw new Error("No EIP-7702 implementation address in environment.");
  // viem's EIP-7702 authorization signing (MetaMask popup).
  const authorization = await (walletClient as unknown as {
    signAuthorization: (a: { account: Address; contractAddress: Address; chainId: number }) => Promise<unknown>;
  }).signAuthorization({ account: address, contractAddress: implementation, chainId: ARBITRUM_ONE });
  return authorization;
}

export interface AuthorizeAgentResult {
  ok: boolean;
  delegationId?: string;
  agent?: string;
  error?: string;
}

/** "Authorize Agent" via ERC-7715 Advanced Permissions (`wallet_grantPermissions`). The user approves
 *  a scoped, periodic USDC spend permission to the backend agent (session) account in MetaMask's native
 *  UI — MetaMask handles the smart-account upgrade + delegation signing (sidestepping the dapp
 *  delegation-signing restriction). The granted permission context is stored; the backend redeems it
 *  via the agent → 1Shot relayer (gas in USDC). Requires MetaMask Flask 13.5+ (ERC-7715 is experimental).
 *  `dailyUsdcCap` is whole USDC; converted to 6-decimal base units. */
export async function authorizeAgent(userEoa: Address, opts?: { dailyUsdcCap?: number; sessionHours?: number }): Promise<AuthorizeAgentResult> {
  try {
    // NOTE: do NOT call ensureArbitrumOne() here — it would open a SECOND MetaMask popup (switch network)
    // on top of the grant. The ERC-7715 request carries `chainId: ARBITRUM_ONE`, so MetaMask scopes the
    // permission to Arbitrum itself; one popup (the grant) is all the user should see.
    const dailyUsdcCap = opts?.dailyUsdcCap ?? 5; // minimal default cap
    const expiry = Math.floor(Date.now() / 1000) + (opts?.sessionHours ?? 24) * 3600;

    // 1. The agent (session) account address from the backend — the grant's delegate (`to`).
    const acc = await netrunnersGet<{ accounts: Record<string, string> }>("/api/agents/accounts");
    const agent = acc?.accounts?.agent;
    if (!agent) return { ok: false, error: "Could not load the agent address." };

    // 2. ERC-7715 wallet_grantPermissions — MetaMask-native Advanced Permissions UI.
    const { erc7715ProviderActions } = await import("@metamask/smart-accounts-kit/actions");
    const provider = createWalletClient({ chain: arbitrum, transport: custom(injected()) }).extend(erc7715ProviderActions());
    const granted = await provider.requestExecutionPermissions([{
      chainId: ARBITRUM_ONE,
      to: getAddress(agent),
      expiry,
      permission: {
        type: "erc20-token-periodic",
        isAdjustmentAllowed: true,
        data: {
          tokenAddress: ARB_USDC,
          // Cap = deploy budget + 1 USDC gas headroom. The pull (Stage A) moves the budget AND a 1Shot
          // USDC fee, both counted by the ERC20PeriodTransferEnforcer — without headroom, budget + fee
          // exceeds the cap and the pull reverts with transfer-amount-exceeded.
          periodAmount: BigInt(Math.round((dailyUsdcCap + 1) * 1e6)),
          periodDuration: 86400,
          justification: `Allow the Arivion agent to deploy up to ${dailyUsdcCap} USDC/day into existing pools on your behalf, via the 1Shot relayer (≈$1/day gas headroom; gas paid in USDC).`,
        },
      },
    }]);
    const g = granted[0];
    if (!g?.context) return { ok: false, agent, error: "MetaMask returned no permission context." };

    // 3. persist the granted permission for backend redemption (JSON-safe).
    const payload = JSON.parse(JSON.stringify({
      delegateAddress: agent,
      delegatorAddress: getAddress(userEoa),
      chainId: ARBITRUM_ONE,
      grantType: "erc7715",
      permissionContext: g.context,                       // opaque encoded Delegation[]
      delegationManager: g.delegationManager,
      dependencies: g.dependencies,                       // [{ factory, factoryData }] for counterfactual SA
      scope: { type: "erc20-token-periodic", tokenAddress: ARB_USDC, periodAmount: String(Math.round(dailyUsdcCap * 1e6)), periodDuration: 86400 },
      expiresAt: new Date(expiry * 1000).toISOString(),
    }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

    const res = await netrunnersPost<{ ok?: boolean; id?: string; error?: string }>("/api/delegations", payload);
    if (!res?.ok) return { ok: false, agent, error: res?.error ?? "Failed to store grant." };
    return { ok: true, delegationId: res.id, agent };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** NO-FLASK user authorization as a genuine MetaMask Smart Account delegation (EIP-7702 + ERC-7710),
 *  NOT a plain USDC transfer. The user's EOA is upgraded in place to a Stateless7702 Smart Account and
 *  signs ONE scoped delegation directly to the 1Shot relayer (single-hop redeemer): a FunctionCall scope
 *  over exactly the venues the plan touches (USDC, Uniswap NPM, GMX ExchangeRouter, CCTP TokenMessenger),
 *  with a native-value cap for GMX's keeper fee and a time bound. No USDC moves at authorize time — the
 *  agent redeems this delegation via 1Shot to spend the user's USDC directly (gas in USDC). The signed
 *  delegation + the 7702 authorization are stored; `executeViaOneShot` loads and redeems them.
 *
 *  NOTE: `smartAccount.signDelegation` may be blocked by stable MetaMask ("External signature requests
 *  cannot sign delegations for internal accounts"). If so, the error surfaces here and the ERC-7715
 *  (Advanced Permissions, Flask) path in `authorizeAgent` is the alternative. */
export async function authorizeAgentDelegation(userEoa: Address, opts?: { dailyUsdcCap?: number; sessionHours?: number }): Promise<AuthorizeAgentResult> {
  try {
    await ensureArbitrumOne(); // delegation/redemption is chain-bound to 42161
    const sessionHours = opts?.sessionHours ?? 24;
    const caps = await netrunnersGet<{ targetAddress: string }>("/api/relay/capabilities");
    if (!caps?.targetAddress) return { ok: false, error: "Relayer capabilities unavailable." };
    const relayerTarget = getAddress(caps.targetAddress);

    const { smartAccount, environment } = await buildUserSmartAccount(userEoa);
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + sessionHours * 3600;

    // FunctionCall scope = allowedTargets + allowedMethods + valueLte (permits contract calls WITH
    // calldata, unlike the NativeToken*/Erc20* transfer scopes which force empty calldata).
    const delegation = createDelegation({
      environment,
      from: getAddress(userEoa),
      to: relayerTarget,
      scope: {
        type: ScopeType.FunctionCall,
        targets: [ARB_USDC, UNISWAP_NPM, GMX_EXCHANGE_ROUTER_V2, CCTP_TOKEN_MESSENGER],
        selectors: [
          "approve(address,uint256)",
          "transfer(address,uint256)",
          "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))",
          "multicall(bytes[])",
          "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
        ],
        valueLte: { maxValue: BigInt("2000000000000000") }, // ≤0.002 ETH per call — GMX keeper execution fee headroom
      },
      caveats: createCaveatBuilder(environment)
        .addCaveat("timestamp", { afterThreshold: now - 60, beforeThreshold: expiry })
        .build(),
    } as unknown as Parameters<typeof createDelegation>[0]);

    // The Smart Account signs the delegation (EIP-712 via MetaMask). May hit the internal-account block.
    const signature = await smartAccount.signDelegation({ delegation, chainId: ARBITRUM_ONE });
    const signedDelegation = { ...delegation, signature };

    // 7702 authorization so the relayer can upgrade the EOA in-flight on the first redemption if needed.
    const authorization = await signEip7702Authorization(userEoa).catch(() => null);

    const payload = JSON.parse(JSON.stringify({
      signedDelegation,
      delegateAddress: relayerTarget,
      delegatorAddress: getAddress(userEoa),
      chainId: ARBITRUM_ONE,
      authorization,
      scope: { type: "functionCall", dailyUsdcCap: String(Math.round((opts?.dailyUsdcCap ?? 5) * 1e6)) },
      expiresAt: new Date(expiry * 1000).toISOString(),
    }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

    const res = await netrunnersPost<{ ok?: boolean; id?: string; error?: string }>("/api/delegations", payload);
    if (!res?.ok) return { ok: false, error: res?.error ?? "Failed to store delegation." };
    return { ok: true, delegationId: res.id, agent: relayerTarget };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface DelegationRow {
  id: string;
  delegate_address: string;
  delegator_address: string;
  chain_id: number;
  status: string;
  expires_at: string | null;
  created_at: string;
}

export async function listDelegations(): Promise<DelegationRow[]> {
  const r = await netrunnersGet<{ delegations: DelegationRow[] }>("/api/delegations");
  return r?.delegations ?? [];
}

// --- Live 1Shot proof (browser MetaMask 7702 path) ------------------------------------------------
// Runs the full delegated-execution pipeline end to end on Arbitrum One with a MINIMAL USDC action,
// to verify the 1Shot relayer works: build 7702 smart account -> sign a delegation directly to the
// relayer redeemer -> sign the 7702 authorization -> submit [fee transfer + tiny self-transfer] -> relay.
export interface OneShotTestResult {
  ok: boolean;
  taskId?: string;
  feeUsdc?: number;
  selfTransferUsdc?: number;
  relayerTarget?: string;
  error?: string;
}

export async function runOneShotLiveTest(userEoa: Address, selfTransferUsdc = 0.05): Promise<OneShotTestResult> {
  try {
    await ensureArbitrumOne(); // signing is chain-bound to 42161
    // 1. relayer capabilities (redeemer target + feeCollector + live USDC fee).
    const caps = await netrunnersGet<{ targetAddress: string; feeCollector: string; estFeeUsdc: number | null }>("/api/relay/capabilities");
    if (!caps?.targetAddress || !caps?.feeCollector) return { ok: false, error: "Relayer capabilities unavailable." };
    const relayerTarget = getAddress(caps.targetAddress);
    // Period cap covers the work + an upper-bound on the relayer fee (backend resolves the exact fee
    // via estimate7710 and appends the USDC fee transfer; we just need scope headroom).
    const selfAtoms = BigInt(Math.round(selfTransferUsdc * 1e6));
    const feeCapAtoms = BigInt(Math.ceil(((caps.estFeeUsdc ?? 0.05) + 0.05) * 1e6));

    // 2. user 7702 smart account (signer-agnostic kit; same EOA address).
    const { smartAccount, environment } = await buildUserSmartAccount(userEoa);
    const now = Math.floor(Date.now() / 1000);

    // 3. delegation: user -> relayer target (single hop; the relayer is the redeemer). Scope USDC, only USDC targets.
    const caveats = createCaveatBuilder(environment)
      .addCaveat("allowedTargets", { targets: [ARB_USDC] })
      .addCaveat("timestamp", { afterThreshold: now - 60, beforeThreshold: now + 3600 })
      .build();
    const delegation = createDelegation({
      environment,
      from: getAddress(userEoa),
      to: relayerTarget,
      scope: { type: ScopeType.Erc20PeriodTransfer, tokenAddress: ARB_USDC, periodAmount: selfAtoms + feeCapAtoms, periodDuration: 86400, startDate: now - 60 },
      caveats,
    });
    const signature = await smartAccount.signDelegation({ delegation, chainId: ARBITRUM_ONE });
    const signedDelegation = { ...delegation, signature };

    // 4. EIP-7702 authorization (only used in-flight if the account isn't already a smart account;
    //    viem's authorization carries the impl contract address per EIP-7702 — do not override it).
    const authorization = await signEip7702Authorization(userEoa).catch(() => null);

    // 5. WORK execution only: a tiny USDC self-transfer (net cost ≈ the relayer fee). The backend
    //    appends the canonical USDC fee transfer to feeCollector after estimate7710.
    const { encodeFunctionData, parseAbi } = await import("viem");
    const workExecutions = [{
      target: ARB_USDC, value: "0x0",
      data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [getAddress(userEoa), selfAtoms] }),
    }];

    // 6. submit via the backend canonical relay path (JSON-safe: bigint -> string).
    const payload = JSON.parse(JSON.stringify({
      permissionContext: [signedDelegation],
      workExecutions,
      authorizationList: authorization ? [authorization] : undefined,
      kind: "relay_test",
      memo: "1shot live proof",
    }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const res = await netrunnersPost<{ ok?: boolean; taskId?: string; feeUsdc?: number; error?: string }>("/api/relay/send", payload);
    if (!res?.ok || !res.taskId) return { ok: false, relayerTarget, error: res?.error ?? "Relay submit failed." };
    return { ok: true, taskId: res.taskId, feeUsdc: res.feeUsdc, selfTransferUsdc, relayerTarget };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function pollOneShotStatus(taskId: string): Promise<{ live?: unknown; ledger?: { status?: number; tx_hash?: string } | null }> {
  const r = await netrunnersGet<{ live?: unknown; ledger?: { status?: number; tx_hash?: string } | null }>(`/api/relay/status/${taskId}`);
  return r ?? {};
}

// Reliable canonical proof via the backend (signer-agnostic local-signer path — works without
// MetaMask's delegation-signing restriction). Runs MetaMask SA -> delegation -> canonical 1Shot submit.
export interface BackendTestResult { ok: boolean; taskId?: string; feeUsdc?: number; landed?: boolean; deltaUsdc?: number; user?: string; error?: string }
export async function runBackendOneShotTest(usdc = 0.05): Promise<BackendTestResult> {
  const r = await netrunnersPost<BackendTestResult>("/api/relay/test", { usdc });
  return r ?? { ok: false, error: "No response from relay test endpoint." };
}
