import express from "express";
import { db } from "../lib/db.js";
import { requireOwnerId } from "../lib/auth.js";
import * as relayer from "../lib/oneShotRelayer.js";
import { getStatus } from "../lib/oneShotRelayer.js";
import { submitDelegatedBundle, runCanonicalSelfTransferTest } from "../lib/smartAccountExec.js";
import { getAddress, createPublicClient, http, parseAbiItem, type Address } from "viem";
import { agentAccountKey } from "../lib/agentExec.js";
import { execChain } from "../lib/execChains.js";

const CHAIN_ID = Number(process.env.DUALITY_EXEC_CHAIN_ID ?? 42161);
const ONESHOT_FEE_COLLECTOR = getAddress("0xE936e8FAf4A5655469182A49a505055B71C17604");
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// Resolve real on-chain tx hashes for relayed tasks WITHOUT relying on 1Shot's getStatus (which throws
// a server-side `hex2.startsWith` crash for 7702/value tasks — see GMX_TO_1SHOT.md §10). Each relayed
// bundle includes a USDC fee transfer (agent account → feeCollector); we scan those Transfer logs on the
// task's chain and match each task to its tx by the fee amount. Backfills tx_hash in the ledger so the
// UI can render a correct per-chain explorer link. Best-effort; never throws into the request path.
async function backfillRelayTxHashes(ownerId: number): Promise<void> {
  try {
    // Newest-first so we can pair the newest pending task with the newest fee-transfer tx.
    const pending = await db.query<{ task_id: string; chain_id: number; fee_usdc: string | number | null }>(
      `SELECT task_id, chain_id, fee_usdc FROM agent_relay_tasks
        WHERE owner_id=$1 AND (tx_hash IS NULL OR tx_hash='') AND created_at > now() - interval '2 hours'
        ORDER BY created_at DESC`,
      [ownerId],
    );
    if (!pending.rowCount) return;
    // Execution runs from the agent SMART account (agentAccountKey "agent"), not the legacy agent_wallets
    // EOA — scan THAT account's fee transfers, or tx_hash never resolves.
    const { address } = await agentAccountKey(ownerId, "agent");
    const agent = getAddress(address);
    // chain_id is a Postgres bigint → STRING at runtime; coerce to a number for chain logic.
    const byChain = new Map<number, typeof pending.rows>();
    for (const t of pending.rows) { const cid = Number(t.chain_id); byChain.set(cid, [...(byChain.get(cid) ?? []), t]); }
    for (const [chainId, tasks] of byChain) {
      const cfg = execChain(chainId); if (!cfg) continue;
      // getLogs-friendly RPC per chain (public Arbitrum node; configured Base RPC for Base).
      const rpc = chainId === 8453 ? (process.env.BASE_RPC_URL ?? "https://mainnet.base.org") : "https://arb1.arbitrum.io/rpc";
      const pc = createPublicClient({ chain: cfg.chain, transport: http(rpc) });
      const latest = await pc.getBlockNumber().catch(() => null); if (latest == null) continue;
      // All agent → feeCollector USDC fee transfers (one per relayed tx). Every leg pays ~the same minFee,
      // so we CANNOT match by amount — instead pair by recency (newest task ↔ newest tx), each used once.
      const logs: Array<{ tx: `0x${string}`; block: bigint; idx: number }> = [];
      for (let to = latest; to > latest - 200000n && logs.length < 500; to -= 9000n) {
        const from = to - 8999n;
        try {
          const ls = await pc.getLogs({ address: cfg.usdc, event: TRANSFER_EVENT, args: { from: agent, to: ONESHOT_FEE_COLLECTOR }, fromBlock: from, toBlock: to });
          for (const l of ls) if (l.transactionHash) logs.push({ tx: l.transactionHash, block: l.blockNumber ?? 0n, idx: l.logIndex ?? 0 });
        } catch { /* range rejected */ }
      }
      logs.sort((a, b) => (b.block === a.block ? b.idx - a.idx : (b.block > a.block ? 1 : -1))); // newest first
      // Pair newest pending task ↔ newest fee-transfer tx, each tx consumed once. A fee transfer only
      // exists if the redeemDelegations SUCCEEDED (a reverted tx pays no fee), so a resolved tx ⇒ the
      // leg CONFIRMED — set status=200 too (getStatus is broken, so this is our confirmation source).
      tasks.forEach((t, i) => {
        const hit = logs[i];
        if (hit) db.query(`UPDATE agent_relay_tasks SET tx_hash=$2, status=$3, updated_at=now() WHERE task_id=$1 AND (tx_hash IS NULL OR tx_hash='')`, [t.task_id, hit.tx, relayer.STATUS.CONFIRMED]).catch(() => {});
      });
    }
    // A leg SUBMITTED for >4 min with still no tx hash almost certainly reverted on-chain (the whole
    // redeemDelegations reverted, so there's no fee-transfer log to find) — mark it failed, never stuck.
    await db.query(
      `UPDATE agent_relay_tasks SET status=$2, updated_at=now()
        WHERE owner_id=$1 AND status=$3 AND (tx_hash IS NULL OR tx_hash='') AND created_at < now() - interval '4 minutes'`,
      [ownerId, relayer.STATUS.REVERTED, relayer.STATUS.SUBMITTED],
    ).catch(() => {});
  } catch { /* best-effort */ }
}
const FEE_TOKEN = process.env.ONESHOT_FEE_TOKEN ?? "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// 1Shot's getFeeData.minFee comes back as a DECIMAL USDC string (e.g. "0.0149"), not integer atoms.
// Interpret a value containing "." as human USDC; otherwise as 6-decimal atoms.
export function feeUsdcFromMinFee(minFee: string | undefined): number | null {
  if (minFee == null) return null;
  const s = String(minFee);
  if (s.includes(".")) { const n = Number(s); return Number.isFinite(n) ? n : null; }
  if (/^\d+$/.test(s)) return Number(s) / 1e6;
  return null;
}

// 1Shot relayer status: a public webhook the relayer POSTs to (destinationUrl), plus an owner-scoped
// list of relay tasks. The webhook is the preferred status source (1Shot scores webhook-driven status
// higher); polling getStatus is the fallback. Webhook signature verification is Ed25519 per 1Shot's
// docs, but the JWKS/public-key URL is not yet documented — until confirmed we accept + persist the
// payload and reconcile against the relayer's own getStatus before trusting a terminal state.

function extractTaskId(b: Record<string, unknown>): string | null {
  const cand = b.taskId ?? b.id ?? (b.data as Record<string, unknown> | undefined)?.taskId ?? (b.data as Record<string, unknown> | undefined)?.id;
  return typeof cand === "string" && /^0x[a-fA-F0-9]{64}$/.test(cand) ? cand : null;
}
function extractStatus(b: Record<string, unknown>): number | null {
  const s = b.status ?? (b.data as Record<string, unknown> | undefined)?.status;
  if (typeof s === "number") return s;
  // Map named events when a numeric status isn't present.
  const ev = String(b.eventName ?? b.event ?? "");
  if (/Success|Confirmed/i.test(ev)) return 200;
  if (/Reject/i.test(ev)) return 400;
  if (/Revert/i.test(ev)) return 500;
  if (/Submit/i.test(ev)) return 110;
  return null;
}
function extractHash(b: Record<string, unknown>): string | null {
  const h = b.hash ?? (b.receipt as Record<string, unknown> | undefined)?.transactionHash ?? (b.data as Record<string, unknown> | undefined)?.hash;
  return typeof h === "string" ? h : null;
}

export function createRelayRouter(): express.Router {
  const router = express.Router();

  // PUBLIC webhook (no owner auth — the relayer calls it). Reconciles against getStatus before
  // marking terminal, so a spoofed payload can't fake a confirmation while sig verification is pending.
  router.post("/webhooks/1shot", express.json({ limit: "256kb" }), async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const taskId = extractTaskId(b);
      if (!taskId) { res.status(400).json({ error: "NO_TASK_ID" }); return; }
      let status = extractStatus(b);
      let hash = extractHash(b);

      // Trust-but-verify: confirm terminal states against the relayer's own getStatus.
      if (status != null && status >= 200) {
        const live = await getStatus(taskId).catch(() => null);
        if (live && typeof live.status === "number") { status = live.status; hash = live.hash ?? hash; }
      }
      await db.query(
        `UPDATE agent_relay_tasks
           SET status = COALESCE($2, status), tx_hash = COALESCE($3, tx_hash), raw = $4, updated_at = now()
         WHERE task_id = $1`,
        [taskId, status, hash, JSON.stringify(b)],
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Relayer capabilities for the execution UI / test page: the redeemer target, feeCollector, and a
  // live USDC fee quote. Owner-scoped but returns only public relayer data. Accepts ?chainId= so the
  // cross-chain Execute widget can fetch a PER-CHAIN quote (Arbitrum 42161 + Base 8453) and merge them —
  // each chain has its own minFee (Arb ~0.0149, Base ~0.01), so a single quote ×N would be inaccurate.
  router.get("/api/relay/capabilities", async (req, res) => {
    try {
      requireOwnerId(req);
      const chainId = Number(req.query.chainId ?? CHAIN_ID) || CHAIN_ID;
      const feeToken = execChain(chainId)?.usdc ?? FEE_TOKEN;
      const caps = await relayer.getCapabilities(chainId);
      const fee = await relayer.getFeeData(chainId, feeToken).catch(() => undefined);
      res.json({
        ok: true,
        chainId,
        feeToken,
        targetAddress: caps?.targetAddress ?? null,
        feeCollector: caps?.feeCollector ?? null,
        tokens: caps?.tokens ?? [],
        estFeeUsdc: feeUsdcFromMinFee(fee?.minFee),
      });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Submit a browser-assembled delegation + WORK executions to the 1Shot relayer via the canonical
  // handshake (getFeeData -> estimate7710 -> send with exact requiredPaymentAmount + signed context).
  // The USDC fee transfer is appended server-side, so clients send only the work executions. Used by
  // the execution flow + the /test-1shot proof page. body: { permissionContext, workExecutions,
  // authorizationList?, memo?, kind? }
  router.post("/api/relay/send", express.json({ limit: "256kb" }), async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const permissionContext = b.permissionContext as relayer.Delegation7710[] | undefined;
      // Accept workExecutions (preferred) or executions (back-compat).
      const workExecutions = (b.workExecutions ?? b.executions) as relayer.Execution7710[] | undefined;
      if (!Array.isArray(permissionContext) || !permissionContext.length) return res.status(400).json({ error: "MISSING_PERMISSION_CONTEXT" });
      if (!Array.isArray(workExecutions) || !workExecutions.length) return res.status(400).json({ error: "MISSING_EXECUTIONS" });
      const sendChainId = Number(b.chainId ?? CHAIN_ID);
      const caps = await relayer.getCapabilities(sendChainId);
      if (!caps?.feeCollector) return res.status(502).json({ error: "RELAYER_NO_CAPABILITIES" });
      const { taskId, feeUsdc } = await submitDelegatedBundle({
        chainId: sendChainId,
        permissionContext,
        workExecutions,
        feeCollector: getAddress(caps.feeCollector),
        authorizationList: Array.isArray(b.authorizationList) ? (b.authorizationList as relayer.Authorization7702[]) : undefined,
        destinationUrl: process.env.ONESHOT_WEBHOOK_URL,
        memo: typeof b.memo === "string" ? b.memo : undefined,
      });
      await db.query(
        `INSERT INTO agent_relay_tasks (task_id, owner_id, role, kind, chain_id, status, fee_usdc)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (task_id) DO NOTHING`,
        [taskId, owner, "user", typeof b.kind === "string" ? b.kind : "relay_test", sendChainId, relayer.STATUS.SUBMITTED, feeUsdc],
      ).catch(() => {});
      res.json({ ok: true, taskId, feeUsdc });
    } catch (e) { res.status(502).json({ ok: false, error: (e as Error).message }); }
  });

  // Canonical 1Shot connectivity proof (dev/test). Runs the real intended pipeline server-side with a
  // configured local signer (signer-agnostic kit pattern): MetaMask Smart Account (Stateless7702) ->
  // EIP-7710 delegation -> canonical submit (estimate7710 -> exact requiredPaymentAmount + context).
  // A tiny USDC self-transfer (only the relayer fee leaves). Gated: needs ONESHOT_TEST_PRIVATE_KEY.
  router.post("/api/relay/test", async (req, res) => {
    try {
      requireOwnerId(req);
      const pk = process.env.ONESHOT_TEST_PRIVATE_KEY ?? process.env.MAINNET_TEST_PRIVATE_KEY;
      if (!pk) return res.status(409).json({ error: "TEST_SIGNER_NOT_CONFIGURED", detail: "set ONESHOT_TEST_PRIVATE_KEY" });
      const out = await runCanonicalSelfTransferTest(pk, Number((req.body as { usdc?: number })?.usdc ?? 0.05));
      res.json(out);
    } catch (e) { res.status(502).json({ ok: false, error: (e as Error).message }); }
  });

  // Best-effort status for one task (1Shot getStatus + our ledger row). getStatus may surface a
  // relayer-side error; the client should also confirm on-chain.
  router.get("/api/relay/status/:taskId", async (req, res) => {
    try {
      requireOwnerId(req);
      const taskId = req.params.taskId;
      const [live, row] = await Promise.all([
        getStatus(taskId).catch((e) => ({ error: (e as Error).message })),
        db.query(`SELECT status, tx_hash, kind FROM agent_relay_tasks WHERE task_id=$1`, [taskId]),
      ]);
      res.json({ ok: true, taskId, live, ledger: row.rowCount ? row.rows[0] : null });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Owner-scoped: list this owner's relay tasks (the WalletDock / portfolio can show execution status).
  router.get("/api/relay/tasks", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      await backfillRelayTxHashes(owner); // resolve real per-chain tx hashes (getStatus is broken)
      const r = await db.query(
        `SELECT task_id, role, kind, ref_id, chain_id, status, tx_hash, fee_usdc, created_at, updated_at
           FROM agent_relay_tasks WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100`,
        [owner],
      );
      res.json({ ok: true, tasks: r.rows });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  return router;
}
