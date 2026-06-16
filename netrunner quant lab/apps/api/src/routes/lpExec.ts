import express from "express";
import { db } from "../lib/db.js";
import { requireOwnerId } from "../lib/auth.js";
import { buildUniswapV3Deposit } from "../lib/uniswapV3Exec.js";
import { executeViaOneShot, smartAccountExecEnabled } from "../lib/smartAccountExec.js";
import { getCapabilities, getFeeData } from "../lib/oneShotRelayer.js";
import { feeUsdcFromMinFee } from "./relay.js";

// LP execution into EXISTING Uniswap v3 pools on Arbitrum One, relayed through 1Shot (gas in USDC).
// /prepare assembles + previews the deposit (no send); /deposit redeems the user's delegation via the
// 1Shot relayer. Never creates a pool. Owner-scoped. Gated by DUALITY_EXEC_VIA_SMART_ACCOUNT.

const CHAIN_ID = Number(process.env.DUALITY_EXEC_CHAIN_ID ?? 42161);

/** The user's (delegator) address from their active root delegation — receives the LP position NFT. */
async function delegatorFor(ownerId: number): Promise<string | null> {
  const r = await db.query(
    `SELECT delegator_address FROM agent_delegations
       WHERE owner_id=$1 AND chain_id=$2 AND parent_id IS NULL AND status='active'
       ORDER BY created_at DESC LIMIT 1`,
    [ownerId, CHAIN_ID],
  );
  return r.rowCount ? (r.rows[0].delegator_address as string) : null;
}

function badAmount(n: unknown): boolean {
  const x = Number(n);
  return !(x > 0) || x > 50; // minimal-deposit guardrail: cap at 50 USDC
}

export function createLpExecRouter(): express.Router {
  const router = express.Router();

  // Assemble + preview the deposit (executions, tick range, USDC fee) WITHOUT sending.
  router.post("/api/exec/lp/prepare", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const poolAddress = String(b.poolAddress ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(poolAddress)) return res.status(400).json({ error: "BAD_POOL_ADDRESS" });
      if (badAmount(b.usdcAmount)) return res.status(400).json({ error: "BAD_AMOUNT", detail: "0 < usdcAmount <= 50" });
      const recipient = await delegatorFor(owner);
      if (!recipient) return res.status(409).json({ error: "NO_ACTIVE_DELEGATION", detail: "Authorize the agent first." });

      const build = await buildUniswapV3Deposit({ poolAddress, usdcAmount: Number(b.usdcAmount), recipient });
      // Quote the 1Shot fee for the preview (read-only).
      const caps = await getCapabilities(CHAIN_ID).catch(() => undefined);
      const fee = await getFeeData(CHAIN_ID, process.env.ONESHOT_FEE_TOKEN ?? "0xaf88d065e77c8cC2239327C5EDb3A432268e5831").catch(() => undefined);
      const feeUsdc = feeUsdcFromMinFee(fee?.minFee);

      res.json({
        ok: true,
        plan: build.plan,
        executions: build.executions,
        relay: {
          chainId: CHAIN_ID,
          relayer: caps?.targetAddress ?? null,
          feeCollector: caps?.feeCollector ?? null,
          gasToken: "USDC",
          estFeeUsdc: feeUsdc,
        },
        willSend: smartAccountExecEnabled(),
        truth: {
          venue: "uniswap_v3",
          action: "deposit_existing_pool",
          creates_pool: false,
          execution_path: "1shot_delegated_relay",
          gas_paid_in: "USDC",
          can_execute_real_money: smartAccountExecEnabled(),
        },
      });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Deposit into the existing pool via the 1Shot delegated relay (gas in USDC).
  router.post("/api/exec/lp/deposit", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const poolAddress = String(b.poolAddress ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(poolAddress)) return res.status(400).json({ error: "BAD_POOL_ADDRESS" });
      if (badAmount(b.usdcAmount)) return res.status(400).json({ error: "BAD_AMOUNT", detail: "0 < usdcAmount <= 50" });
      if (b.confirm !== "DEPOSIT_LP_MAINNET") return res.status(400).json({ error: "CONFIRMATION_REQUIRED", required: "DEPOSIT_LP_MAINNET" });
      if (!smartAccountExecEnabled()) return res.status(409).json({ error: "SMART_ACCOUNT_EXEC_DISABLED", detail: "Set DUALITY_EXEC_VIA_SMART_ACCOUNT=true once the live 1Shot redemption is proven." });
      const recipient = await delegatorFor(owner);
      if (!recipient) return res.status(409).json({ error: "NO_ACTIVE_DELEGATION", detail: "Authorize the agent first." });

      const build = await buildUniswapV3Deposit({ poolAddress, usdcAmount: Number(b.usdcAmount), recipient });
      const result = await executeViaOneShot({
        ownerId: owner,
        role: "agent",
        executions: build.executions,
        kind: "lp_deposit",
        memo: `uniswap_v3 deposit ${build.plan.usdcAtoms} USDC -> ${poolAddress}`,
        destinationUrl: process.env.ONESHOT_WEBHOOK_URL,
      });
      if (!result.ok) return res.status(502).json({ ok: false, error: result.error, plan: build.plan });
      res.json({ ok: true, taskId: result.taskId, feeUsdc: result.feeUsdc, plan: build.plan });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  return router;
}
