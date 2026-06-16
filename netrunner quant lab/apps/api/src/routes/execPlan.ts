// Cross-chain plan orchestration: STAGE A (pull the user's budget into the agent by redeeming the
// 7715 grant) then STAGE B (the agent executes the venue legs from its own account via submitAsAgent →
// 1Shot, gas in USDC). This is the only MetaMask-permitted shape for contract-call legs (see
// GMX_TO_1SHOT.md / research): the user can only authorize a token spend, so the agent pulls then acts.
//
// Returns per-leg taskIds; the widget reflects status via /api/relay/tasks. The Arbitrum legs (pull, LP,
// GMX) run here synchronously; the async CCTP bridge → Base legs are triggered separately.
import express from "express";
import { getAddress, createPublicClient, http, parseAbi, parseAbiItem, type Address } from "viem";
import { randomUUID } from "node:crypto";
import { requireOwnerId } from "../lib/auth.js";
import { db } from "../lib/db.js";
import { agentAccountKey } from "../lib/agentExec.js";
import { pullBudgetToAgent, submitAsAgent, smartAccountExecEnabled } from "../lib/smartAccountExec.js";
import { executeGmxViaOneShot, GMX_ETH_USD_MARKET } from "../lib/gmxOneShotExec.js";
import { buildUniswapV3Deposit } from "../lib/uniswapV3Exec.js";
import { buildUsdcToEth } from "../lib/uniswapSwapExec.js";
import { buildCctpBurn, fetchCctpAttestation, buildCctpMint } from "../lib/cctpBridge.js";
import { execChain, CROSSCHAIN_DEST_CHAIN } from "../lib/execChains.js";
import * as relayer from "../lib/oneShotRelayer.js";

const ARB = 42161;
const UNISWAP_V3_MINT = "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))";
const CCTP_TOKEN_MESSENGER = getAddress("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
const CCTP_MESSAGE_TRANSMITTER = getAddress("0x81D40F21F12A8F0E3252Bccb954D722d4c464B64");
const FEE_COLLECTOR = getAddress("0xE936e8FAf4A5655469182A49a505055B71C17604");
const DEPOSIT_FOR_BURN = "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)";
const RECEIVE_MESSAGE = "receiveMessage(bytes,bytes)";
const ERC20_BAL = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// Record a synthetic FAILED relay task so a stalled leg shows "failed" in the widget instead of hanging
// forever at "queued". The widget maps kind+chain → step; status 500 (REVERTED) → failed pill.
async function recordFailed(ownerId: number, kind: string, chainId: number, note: string): Promise<void> {
  await db.query(
    `INSERT INTO agent_relay_tasks (task_id, owner_id, role, kind, ref_id, chain_id, status, fee_usdc)
     VALUES ($1,$2,'agent',$3,$4,$5,$6,0) ON CONFLICT (task_id) DO NOTHING`,
    [`failed_${randomUUID()}`, ownerId, kind, note.slice(0, 120), chainId, relayer.STATUS.REVERTED],
  ).catch(() => {});
}

// Resolve the on-chain tx hash of a just-submitted bundle by scanning the agent→feeCollector USDC fee
// transfer on `chainId` after `fromBlock` (getStatus is broken — see GMX_TO_1SHOT.md §10). Bounded poll.
async function resolveBundleTx(chainId: number, agent: Address, fromBlock: bigint, timeoutMs = 60000): Promise<`0x${string}` | null> {
  const c = execChain(chainId);
  const rpc = chainId === 8453 ? (process.env.BASE_RPC_URL ?? "https://mainnet.base.org") : "https://arb1.arbitrum.io/rpc";
  const pc = createPublicClient({ chain: c.chain, transport: http(rpc) });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const latest = await pc.getBlockNumber();
      const logs = await pc.getLogs({ address: c.usdc, event: TRANSFER_EVENT, args: { from: agent, to: FEE_COLLECTOR }, fromBlock: fromBlock > 0n ? fromBlock : 0n, toBlock: latest });
      if (logs.length) return logs[logs.length - 1].transactionHash;
    } catch { /* range/RPC hiccup — retry */ }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return null;
}

// STAGE B (cross-chain) — runs in the BACKGROUND after run-plan responds. Burn on Arbitrum → resolve the
// burn tx → poll Circle attestation → mint on Base (self-funding feeLast) → wait for the mint → Base LP.
// Every stage is time-bounded and records a FAILED task on timeout/error so the widget never hangs.
async function runBridgeToBase(ownerId: number, agent: Address, bridgeUsd: number, baseLpUsd: number): Promise<void> {
  const dst = CROSSCHAIN_DEST_CHAIN; // 8453
  try {
    // 1. Burn on Arbitrum (mintRecipient = the agent on Base, same address).
    const arbRpc = "https://arb1.arbitrum.io/rpc";
    const arbPc = createPublicClient({ chain: execChain(ARB).chain, transport: http(arbRpc) });
    const beforeBlock = await arbPc.getBlockNumber().catch(() => 0n);
    const burn = buildCctpBurn({ srcChainId: ARB, dstChainId: dst, usdcAmount: bridgeUsd, mintRecipient: agent, fast: true });
    const burnRes = await submitAsAgent({ ownerId, chainId: ARB, workExecutions: burn.executions, allowedTargets: [CCTP_TOKEN_MESSENGER], selectors: [DEPOSIT_FOR_BURN], kind: "cctp_burn", memo: `CCTP burn ${bridgeUsd} → Base` });
    if (!burnRes.ok) { await recordFailed(ownerId, "lp_deposit", dst, `burn failed: ${burnRes.error}`); return; }

    // 2. Resolve the burn tx hash (needed for the attestation).
    const burnTx = await resolveBundleTx(ARB, agent, beforeBlock, 70000);
    if (!burnTx) { await recordFailed(ownerId, "lp_deposit", dst, "burn tx not resolved in time"); return; }

    // 3. Poll Circle for the attestation (~8-20s fast; bounded to 2 min).
    const att = await fetchCctpAttestation(ARB, burnTx, { timeoutMs: 120000, intervalMs: 5000 });
    if (att.status !== "complete" || !att.message || !att.attestation) { await recordFailed(ownerId, "lp_deposit", dst, "CCTP attestation timeout"); return; }

    // 4. Mint on Base — SELF-FUNDING: feeLast pays the 1Shot fee from the just-minted USDC (no Base float).
    const mint = buildCctpMint(att.message, att.attestation);
    const mintRes = await submitAsAgent({ ownerId, chainId: dst, workExecutions: [mint.execution], allowedTargets: [CCTP_MESSAGE_TRANSMITTER], selectors: [RECEIVE_MESSAGE], feeLast: true, kind: "cctp_mint", memo: "CCTP mint on Base" });
    if (!mintRes.ok) { await recordFailed(ownerId, "lp_deposit", dst, `mint failed: ${mintRes.error}`); return; }

    // 5. Wait for the minted USDC to land on the agent on Base, then deposit the Base LP.
    if (baseLpUsd > 0) {
      const baseAtoms = BigInt(Math.round(baseLpUsd * 1e6));
      const cfg = execChain(dst);
      const basePc = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
      const deadline = Date.now() + 90000;
      let landed = false;
      while (Date.now() < deadline) {
        const bal = (await basePc.readContract({ address: cfg.usdc, abi: ERC20_BAL, functionName: "balanceOf", args: [agent] }).catch(() => 0n)) as bigint;
        if (bal >= baseAtoms) { landed = true; break; }
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (!landed) { await recordFailed(ownerId, "lp_deposit", dst, "bridged USDC not on Base in time"); return; }
      const build = await buildUniswapV3Deposit({ poolAddress: cfg.ethUsdcPool, usdcAmount: baseLpUsd, recipient: agent, chainId: dst });
      const targets = Array.from(new Set(build.executions.map((e) => getAddress(e.target))));
      const lp = await submitAsAgent({ ownerId, chainId: dst, workExecutions: build.executions, allowedTargets: targets, selectors: [UNISWAP_V3_MINT], kind: "lp_deposit", memo: `base LP ${baseLpUsd} USDC` });
      if (!lp.ok) await recordFailed(ownerId, "lp_deposit", dst, `base LP failed: ${lp.error}`);
    }
  } catch (e) {
    await recordFailed(ownerId, "lp_deposit", dst, `bridge sequence error: ${(e as Error).message}`);
  }
}

// Wait until the agent's USDC reflects the Stage-A pull before firing Stage B (the pull is a relayed
// tx that takes a few seconds to land; firing Stage B against an unfunded agent would revert).
async function waitForAgentUsdc(chainId: number, agent: `0x${string}`, minAtoms: bigint, timeoutMs = 40000): Promise<boolean> {
  const c = execChain(chainId);
  const pc = createPublicClient({ chain: c.chain, transport: http(c.rpc) });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bal = (await pc.readContract({ address: c.usdc, abi: ERC20_BAL, functionName: "balanceOf", args: [agent] }).catch(() => 0n)) as bigint;
    if (bal >= minAtoms) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

interface PlanParams { budget: number; arbLpUsd: number; gmxUsd: number; bridgeUsd: number; baseLpUsd: number }

// The FULL plan, run entirely in the background so the HTTP request never hangs. Stage A pull → wait →
// Arbitrum LP → GMX → (cross-chain) bridge → Base LP. Every leg either submits a task or records a FAILED
// task, so the widget (polling /api/relay/tasks) always resolves each step — never stuck at "queued".
async function runFullPlan(owner: number, agent: Address, p: PlanParams): Promise<void> {
  const dst = CROSSCHAIN_DEST_CHAIN;
  try {
    // STAGE A — pull the full budget into the agent (redeem the user's grant). The grant cap = budget+1
    // ($6 for a $5 budget), so the pull ($5) + its own 1Shot fee (~$0.015) stay well under the
    // ERC20PeriodTransferEnforcer cap. The $5 then covers all Stage B legs + the USDC→ETH swap + fees.
    const pull = await pullBudgetToAgent(owner, ARB, p.budget);
    if (!pull.ok) {
      // Nothing downstream can run — surface every remaining step as failed so none hang.
      await recordFailed(owner, "lp_deposit", ARB, `pull failed: ${pull.error}`);
      await recordFailed(owner, "gmx_order", ARB, `pull failed: ${pull.error}`);
      await recordFailed(owner, "cctp_burn", ARB, `pull failed: ${pull.error}`);
      await recordFailed(owner, "lp_deposit", dst, `pull failed: ${pull.error}`);
      return;
    }
    // Wait for the pulled USDC to land before Stage B (avoid firing the legs against an unfunded agent).
    const needAtoms = BigInt(Math.round((p.arbLpUsd + p.gmxUsd + p.bridgeUsd + 0.3) * 1e6));
    if (!(await waitForAgentUsdc(ARB, agent, needAtoms, 60000))) {
      await recordFailed(owner, "lp_deposit", ARB, "pull not reflected on agent in time");
      await recordFailed(owner, "gmx_order", ARB, "pull not reflected on agent in time");
      await recordFailed(owner, "cctp_burn", ARB, "pull not reflected on agent in time");
      await recordFailed(owner, "lp_deposit", dst, "pull not reflected on agent in time");
      return;
    }

    // STAGE B — Arbitrum LP into the configured (on-chain-verified) WETH/USDC pool.
    if (p.arbLpUsd > 0) {
      try {
        const build = await buildUniswapV3Deposit({ poolAddress: execChain(ARB).ethUsdcPool, usdcAmount: p.arbLpUsd, recipient: agent, chainId: ARB });
        const targets = Array.from(new Set(build.executions.map((e) => getAddress(e.target))));
        const lp = await submitAsAgent({ ownerId: owner, chainId: ARB, workExecutions: build.executions, allowedTargets: targets, selectors: [UNISWAP_V3_MINT], kind: "lp_deposit", memo: `arb LP ${p.arbLpUsd} USDC` });
        if (!lp.ok) await recordFailed(owner, "lp_deposit", ARB, `arb LP failed: ${lp.error}`);
      } catch (e) { await recordFailed(owner, "lp_deposit", ARB, `arb LP error: ${(e as Error).message}`); }
    }

    // STAGE B — GMX perp. The keeper fee is native ETH, but the pull only delivers USDC — so the agent
    // SELF-FUNDS it: if it has no ETH, swap a sliver of USDC → native ETH (Uniswap + unwrap, via 1Shot),
    // wait for it to land, then open the perp. No manual ETH seeding.
    if (p.gmxUsd > 0) {
      const arbPc = createPublicClient({ chain: execChain(ARB).chain, transport: http(execChain(ARB).rpc) });
      const ETH_MIN = BigInt("150000000000000"); // ~0.00015 ETH — enough for the keeper fee
      let ethBal = (await arbPc.getBalance({ address: agent }).catch(() => 0n)) as bigint;
      if (ethBal < ETH_MIN) {
        const ethBuild = buildUsdcToEth({ usdcAmount: 0.7, recipient: agent }); // ~$0.70 → ~0.0002+ ETH (GMX refunds the unused fee)
        const targets = Array.from(new Set(ethBuild.executions.map((e) => getAddress(e.target))));
        const swap = await submitAsAgent({ ownerId: owner, chainId: ARB, workExecutions: ethBuild.executions, allowedTargets: targets, selectors: ["multicall(bytes[])"], kind: "acquire_eth", memo: "swap USDC→ETH for GMX keeper fee" });
        if (!swap.ok) {
          await recordFailed(owner, "gmx_order", ARB, `ETH self-swap failed: ${swap.error}`);
        } else {
          const deadline = Date.now() + 60000; // wait for native ETH to land
          while (Date.now() < deadline) { ethBal = (await arbPc.getBalance({ address: agent }).catch(() => 0n)) as bigint; if (ethBal >= ETH_MIN) break; await new Promise((r) => setTimeout(r, 4000)); }
        }
      }
      if (ethBal >= ETH_MIN) {
        const gmx = await executeGmxViaOneShot({ ownerId: owner, marketAddress: GMX_ETH_USD_MARKET, collateralUsd: p.gmxUsd, leverageBps: 20000, isLong: true });
        if (!gmx.ok) await recordFailed(owner, "gmx_order", ARB, `gmx failed: ${gmx.error}`);
      } else {
        await recordFailed(owner, "gmx_order", ARB, "could not self-acquire ETH for the GMX keeper fee");
      }
    }

    // STAGE B (cross-chain) — bridge → Base LP (records its own failures internally).
    if (p.bridgeUsd > 0) await runBridgeToBase(owner, agent, p.bridgeUsd, p.baseLpUsd);
  } catch (e) {
    await recordFailed(owner, "lp_deposit", ARB, `plan error: ${(e as Error).message}`);
  }
}

export function createExecPlanRouter(): express.Router {
  const router = express.Router();

  // Kick off the full plan in the background and return IMMEDIATELY — the widget reflects every leg via
  // /api/relay/tasks, and each leg resolves to confirmed/failed, so the flow can't get stuck.
  router.post("/api/exec/run-plan", express.json({ limit: "64kb" }), async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      if (!smartAccountExecEnabled()) return res.status(409).json({ error: "SMART_ACCOUNT_EXEC_DISABLED" });
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b.confirm !== "RUN_PLAN_MAINNET") return res.status(400).json({ error: "CONFIRMATION_REQUIRED", required: "RUN_PLAN_MAINNET" });
      // Leg sizes sum to LESS than the pulled budget so Stage B's per-leg 1Shot fees (~$0.015 each) fit:
      // arb LP 1.5 + GMX 1 + bridge 1.5 = 4 on Arbitrum (leaves ~1 for fees from a $5 pull); Base LP 1.4.
      const p: PlanParams = {
        budget: Math.min(Math.max(Number(b.budgetUsd ?? 5), 0.1), 50),
        arbLpUsd: Math.max(Number(b.arbLpUsd ?? 1.5), 0),
        gmxUsd: Math.max(Number(b.gmxUsd ?? 1), 0),
        bridgeUsd: Math.max(Number(b.bridgeUsd ?? 1.5), 0),
        baseLpUsd: Math.max(Number(b.baseLpUsd ?? 1.4), 0),
      };
      const agent = getAddress((await agentAccountKey(owner, "agent")).address);
      void runFullPlan(owner, agent, p);
      res.json({ ok: true, started: true, agent, note: "Plan running in the background (pull → Arb LP → GMX → bridge → Base LP). Watch /api/relay/tasks; every leg resolves to done/failed." });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  return router;
}
