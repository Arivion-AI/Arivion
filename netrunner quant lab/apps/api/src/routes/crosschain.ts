import express from "express";
import { db } from "../lib/db.js";
import { requireOwnerId } from "../lib/auth.js";
import { buildUsdcSwap } from "../lib/uniswapSwapExec.js";
import { buildCctpBurn, buildCctpMint, fetchCctpAttestation } from "../lib/cctpBridge.js";
import { executeViaOneShot, smartAccountExecEnabled } from "../lib/smartAccountExec.js";
import { CROSSCHAIN_DEST_CHAIN } from "../lib/execChains.js";

// Swap (Uniswap v3) + bridge (Circle CCTP) executed through the 1Shot delegated relayer (gas in USDC).
// Cross-chain LP demo: Arbitrum One (user's USDC) -> Base (low-cost L2). From one up-front user
// authorization, no ETH, no re-signs. Owner-scoped; spend gated by DUALITY_EXEC_VIA_SMART_ACCOUNT.
// Bridge flow: burn on source (1Shot) -> Circle attests -> mint on Base (1Shot, permissionless receiveMessage).

const CHAIN_ID = Number(process.env.DUALITY_EXEC_CHAIN_ID ?? 42161);
const badAmount = (n: unknown) => { const x = Number(n); return !(x > 0) || x > 50; }; // ≤50 USDC guardrail

/** The user (delegator) address from their active delegation — receives swap output / bridged USDC. */
async function delegatorFor(ownerId: number): Promise<string | null> {
  const r = await db.query(
    `SELECT delegator_address FROM agent_delegations
       WHERE owner_id=$1 AND chain_id=$2 AND parent_id IS NULL AND status='active'
       ORDER BY created_at DESC LIMIT 1`,
    [ownerId, CHAIN_ID],
  );
  return r.rowCount ? (r.rows[0].delegator_address as string) : null;
}

export function createCrossChainRouter(): express.Router {
  const router = express.Router();

  // Swap USDC -> tokenOut on Uniswap v3 (Arbitrum), relayed by 1Shot. body: { tokenOut, usdcAmount, feeTier?, confirm }
  router.post("/api/exec/swap", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const tokenOut = String(b.tokenOut ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(tokenOut)) return res.status(400).json({ error: "BAD_TOKEN_OUT" });
      if (badAmount(b.usdcAmount)) return res.status(400).json({ error: "BAD_AMOUNT", detail: "0 < usdcAmount <= 50" });
      const recipient = await delegatorFor(owner);
      if (!recipient) return res.status(409).json({ error: "NO_ACTIVE_DELEGATION", detail: "Authorize the agent first." });
      const preview = buildUsdcSwap({ tokenOut, usdcAmount: Number(b.usdcAmount), recipient, feeTier: b.feeTier ? Number(b.feeTier) : undefined });
      if (b.confirm !== "SWAP_MAINNET") {
        return res.json({ ok: true, preview: true, plan: preview.plan, executions: preview.executions, willSend: smartAccountExecEnabled() });
      }
      if (!smartAccountExecEnabled()) return res.status(409).json({ error: "SMART_ACCOUNT_EXEC_DISABLED" });
      const r = await executeViaOneShot({ ownerId: owner, role: "agent", executions: preview.executions, kind: "swap", memo: preview.plan.note, destinationUrl: process.env.ONESHOT_WEBHOOK_URL });
      res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true, taskId: r.taskId, feeUsdc: r.feeUsdc, plan: preview.plan } : { ok: false, error: r.error, plan: preview.plan });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Bridge USDC src->dst via Circle CCTP (burn leg), relayed by 1Shot. dst defaults to Base (low-cost).
  // body: { dstChainId?, usdcAmount, mintRecipient?, fast?, confirm }
  router.post("/api/exec/bridge/burn", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const dstChainId = Number(b.dstChainId ?? CROSSCHAIN_DEST_CHAIN); // default Base 8453
      // mintRecipient defaults to the user (same address on the destination chain).
      const mintRecipient = String(b.mintRecipient ?? (await delegatorFor(owner)) ?? "");
      if (!Number.isInteger(dstChainId) || dstChainId <= 0) return res.status(400).json({ error: "BAD_DST_CHAIN" });
      if (!/^0x[0-9a-fA-F]{40}$/.test(mintRecipient)) return res.status(400).json({ error: "BAD_MINT_RECIPIENT", detail: "authorize the agent or pass mintRecipient" });
      if (badAmount(b.usdcAmount)) return res.status(400).json({ error: "BAD_AMOUNT", detail: "0 < usdcAmount <= 50" });
      const build = buildCctpBurn({ srcChainId: CHAIN_ID, dstChainId, usdcAmount: Number(b.usdcAmount), mintRecipient, fast: b.fast !== false });
      if (b.confirm !== "BRIDGE_MAINNET") {
        return res.json({ ok: true, preview: true, plan: build.plan, executions: build.executions, willSend: smartAccountExecEnabled() });
      }
      if (!smartAccountExecEnabled()) return res.status(409).json({ error: "SMART_ACCOUNT_EXEC_DISABLED" });
      const r = await executeViaOneShot({ ownerId: owner, role: "agent", executions: build.executions, kind: "cctp_burn", memo: build.plan.note, destinationUrl: process.env.ONESHOT_WEBHOOK_URL });
      res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true, taskId: r.taskId, feeUsdc: r.feeUsdc, plan: build.plan, next: "poll /api/exec/bridge/attestation with the burn tx hash, then mint on the destination chain" } : { ok: false, error: r.error, plan: build.plan });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Poll Circle for the burn attestation (so the destination mint can be submitted). query: ?srcChainId&txHash
  router.get("/api/exec/bridge/attestation", async (req, res) => {
    try {
      requireOwnerId(req);
      const srcChainId = Number(req.query.srcChainId ?? CHAIN_ID);
      const txHash = String(req.query.txHash ?? "");
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: "BAD_TX_HASH" });
      const att = await fetchCctpAttestation(srcChainId, txHash, { timeoutMs: 20000, intervalMs: 4000 }); // short poll; client re-polls
      res.json({ ok: true, ...att });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Complete the bridge: mint on the destination chain (Base) via 1Shot (permissionless receiveMessage),
  // gas paid in USDC. body: { dstChainId?, message, attestation, confirm }. Call after attestation is
  // "complete". The destination mint is relayed through 1Shot on the dest chain — no ETH needed.
  router.post("/api/exec/bridge/mint", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const dstChainId = Number(b.dstChainId ?? CROSSCHAIN_DEST_CHAIN);
      const message = String(b.message ?? "");
      const attestation = String(b.attestation ?? "");
      if (!message.startsWith("0x") || !attestation.startsWith("0x")) return res.status(400).json({ error: "MISSING_MESSAGE_OR_ATTESTATION" });
      if (b.confirm !== "BRIDGE_MINT") return res.status(400).json({ error: "CONFIRMATION_REQUIRED", required: "BRIDGE_MINT" });
      if (!smartAccountExecEnabled()) return res.status(409).json({ error: "SMART_ACCOUNT_EXEC_DISABLED" });
      const { execution } = buildCctpMint(message as `0x${string}`, attestation as `0x${string}`);
      // Redeem on the DESTINATION chain (Base). SELF-FUNDING: feeLast=true puts receiveMessage (which
      // mints USDC to the agent) BEFORE the 1Shot fee transfer, so the fee is paid from the freshly
      // minted balance — no destination-chain pre-funding needed (the bridge funds its own mint fee).
      const r = await executeViaOneShot({ ownerId: owner, chainId: dstChainId, role: "agent", executions: [execution], kind: "cctp_mint", memo: "CCTP mint on destination (self-funding)", destinationUrl: process.env.ONESHOT_WEBHOOK_URL, feeLast: true });
      res.status(r.ok ? 200 : 502).json(r);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  return router;
}
