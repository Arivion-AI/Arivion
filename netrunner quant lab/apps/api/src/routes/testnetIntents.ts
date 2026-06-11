import express from "express";
import { randomUUID } from "node:crypto";
import { getAddress } from "ethers";
import { z } from "zod";
import { db } from "../lib/db.js";
import { requireOwnerId } from "../lib/auth.js";
import { findChain, isTestnetExecutionChain, publicChain, testnetActionsEnabled } from "../config/chains.js";

function normalizeAddress(address: string): string {
  return getAddress(address.trim());
}

type IntentPolicy = {
  allowed_to_prepare: boolean;
  allowed_to_submit: boolean;
  errors: string[];
  warnings: string[];
  can_execute_real_money: false;
  required_user_approval: true;
  testnet_disclaimer: string;
};

function policyFor(chainId: number, actionType: string, payload: Record<string, unknown>): IntentPolicy {
  const errors: string[] = [];
  const warnings: string[] = [];
  const chain = findChain(chainId);
  if (!chain) errors.push("CHAIN_NOT_FOUND");
  else if (!isTestnetExecutionChain(chainId)) errors.push("CHAIN_NOT_TESTNET_EXECUTION");
  if (!testnetActionsEnabled()) warnings.push("TESTNET_ACTIONS_FEATURE_FLAG_DISABLED");
  if (actionType.includes("mainnet")) errors.push("MAINNET_ACTIONS_FORBIDDEN");
  if (payload.chainId && Number(payload.chainId) !== chainId) errors.push("PAYLOAD_CHAIN_ID_MISMATCH");
  return {
    allowed_to_prepare: errors.length === 0,
    allowed_to_submit: errors.length === 0 && testnetActionsEnabled(),
    errors,
    warnings,
    can_execute_real_money: false,
    required_user_approval: true,
    testnet_disclaimer: "This intent is for testnet demonstration only. It is not a production trade.",
  };
}

export function createTestnetIntentsRouter(): express.Router {
  const router = express.Router();

  router.get("/api/testnet/intents", async (req, res) => {
    const ownerId = requireOwnerId(req);
    const r = await db.query(
      `
        SELECT intent_id, chain_id, wallet_address, action_type, payload_json,
               policy_result, status, tx_hash, created_at, updated_at
        FROM testnet_intents
        WHERE owner_id = $1
        ORDER BY created_at DESC
        LIMIT 100
      `,
      [ownerId]
    );
    res.json({ intents: r.rows });
  });

  router.post("/api/testnet/intents/prepare", async (req, res) => {
    const ownerId = requireOwnerId(req);
    const parsed = z.object({
      chainId: z.number().int(),
      walletAddress: z.string(),
      actionType: z.string().default("swap_preview"),
      payload: z.record(z.any()).default({}),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const chain = findChain(parsed.data.chainId);
    if (!chain) return res.status(404).json({ error: "CHAIN_NOT_FOUND" });
    let address: string;
    try {
      address = normalizeAddress(parsed.data.walletAddress);
    } catch {
      return res.status(400).json({ error: "INVALID_WALLET_ADDRESS" });
    }
    const linked = await db.query(
      `SELECT 1 FROM wallet_links WHERE owner_id = $1 AND wallet_address = $2 AND chain_id = $3 LIMIT 1`,
      [ownerId, address, parsed.data.chainId]
    );
    if (!linked.rowCount) return res.status(403).json({ error: "WALLET_NOT_LINKED_FOR_OWNER" });
    const policy = policyFor(parsed.data.chainId, parsed.data.actionType, parsed.data.payload);
    if (!policy.allowed_to_prepare) return res.status(400).json({ error: "TESTNET_INTENT_POLICY_BLOCK", policy });
    const intentId = `intent_${randomUUID()}`;
    await db.query(
      `
        INSERT INTO testnet_intents (
          intent_id, owner_id, chain_id, wallet_address, action_type,
          payload_json, policy_result, status
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'prepared')
      `,
      [intentId, ownerId, parsed.data.chainId, address, parsed.data.actionType, JSON.stringify(parsed.data.payload), JSON.stringify(policy)]
    );
    res.status(201).json({
      intentId,
      status: "prepared",
      chain: publicChain(chain),
      walletAddress: address,
      actionType: parsed.data.actionType,
      payload: parsed.data.payload,
      policy,
      truth: {
        result_tier: "LOCAL ONLY",
        data_source: chain.isTestnet ? "testnet" : "none",
        execution_fidelity: "testnet_intent_prepared",
        testnet_disclaimer: policy.testnet_disclaimer,
        can_execute_real_money: false,
      },
    });
  });

  router.post("/api/testnet/intents/:id/submit", async (req, res) => {
    const ownerId = requireOwnerId(req);
    const parsed = z.object({
      txHash: z.string().optional(),
      status: z.enum(["submitted", "confirmed", "failed", "cancelled"]).default("submitted"),
      receipt: z.record(z.any()).optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const current = await db.query<{ chain_id: string | number; policy_result: Record<string, unknown>; status: string }>(
      `SELECT chain_id, policy_result, status FROM testnet_intents WHERE intent_id = $1 AND owner_id = $2 LIMIT 1`,
      [req.params.id, ownerId]
    );
    if (!current.rowCount) return res.status(404).json({ error: "INTENT_NOT_FOUND" });
    const row = current.rows[0];
    const chainId = Number(row.chain_id);
    if (!isTestnetExecutionChain(chainId)) return res.status(400).json({ error: "CHAIN_NOT_TESTNET_EXECUTION" });
    if (!testnetActionsEnabled()) return res.status(403).json({ error: "TESTNET_ACTIONS_DISABLED", flag: "DUALITY_ENABLE_TESTNET_ACTIONS" });
    const policy = row.policy_result ?? {};
    if (policy.allowed_to_submit !== true) return res.status(403).json({ error: "INTENT_POLICY_NOT_SUBMITTABLE", policy });
    const r = await db.query(
      `
        UPDATE testnet_intents
        SET status = $3, tx_hash = COALESCE($4, tx_hash),
            policy_result = policy_result || $5::jsonb,
            updated_at = NOW()
        WHERE intent_id = $1 AND owner_id = $2
        RETURNING intent_id, chain_id, wallet_address, action_type, payload_json,
                  policy_result, status, tx_hash, created_at, updated_at
      `,
      [
        req.params.id,
        ownerId,
        parsed.data.status,
        parsed.data.txHash ?? null,
        JSON.stringify({ submit_record: { receipt: parsed.data.receipt ?? null, recorded_at: new Date().toISOString() } }),
      ]
    );
    res.json({
      intent: r.rows[0],
      truth: {
        result_tier: parsed.data.txHash ? "TESTNET EXECUTED" : "LOCAL ONLY",
        data_source: "testnet",
        execution_fidelity: "testnet_actual",
        testnet_disclaimer: "Recorded transaction is testnet-only and not production verified.",
        can_execute_real_money: false,
      },
    });
  });

  return router;
}
