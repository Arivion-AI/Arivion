import type pg from "pg";
import { db, withTransaction } from "../db.js";
import { config, WELCOME_CREDIT_MICRO_USD } from "../config.js";
import { GatewayError } from "./types.js";

// The credit ledger is the single source of truth for managed balance. Every mutation:
//   1. runs inside a DB transaction (correction #3),
//   2. locks the owner's agent_credit_accounts row with SELECT … FOR UPDATE (serialization point),
//   3. is idempotent via an idempotency_key (correction #4).
// Money is integer micro-USD. The reserve→finalize flow keeps the ledger's running balance exact.

export interface AccountRow {
  owner_id: number;
  currency: string;
  managed_balance_micro_usd: number;
  lifetime_grants_micro_usd: number;
  lifetime_spend_micro_usd: number;
  status: string;
}

function toAccount(r: Record<string, unknown>): AccountRow {
  return {
    owner_id: Number(r.owner_id),
    currency: String(r.currency),
    managed_balance_micro_usd: Number(r.managed_balance_micro_usd),
    lifetime_grants_micro_usd: Number(r.lifetime_grants_micro_usd),
    lifetime_spend_micro_usd: Number(r.lifetime_spend_micro_usd),
    status: String(r.status),
  };
}

// Lock the account row for update inside an open transaction. Returns the locked row, or null if
// the account does not exist yet.
export async function lockAccount(client: pg.PoolClient, ownerId: number): Promise<AccountRow | null> {
  const res = await client.query(
    `SELECT * FROM agent_credit_accounts WHERE owner_id = $1 FOR UPDATE`,
    [ownerId],
  );
  return res.rowCount ? toAccount(res.rows[0]) : null;
}

// Idempotent account creation + one-time welcome grant (correction: grant once per owner, survives
// retries / multiple activation sites). Safe to call on every gateway request and every Copilot
// route hit.
export async function ensureAccount(ownerId: number): Promise<AccountRow> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO agent_credit_accounts (owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING`,
      [ownerId],
    );
    const account = (await lockAccount(client, ownerId))!;

    // Welcome grant — idempotent on (owner_id, 'WELCOME_GRANT:<owner>'). DO NOTHING ⇒ already granted.
    const grantKey = `WELCOME_GRANT:${ownerId}`;
    const expiresAt = new Date(
      Date.now() + config.welcomeCreditExpiresDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const ins = await client.query<{ id: string }>(
      `INSERT INTO agent_credit_ledger
         (owner_id, idempotency_key, event_type, amount_micro_usd, provider_mode, reason, metadata)
       VALUES ($1, $2, 'grant', $3, 'managed', 'WELCOME_GRANT', $4)
       ON CONFLICT (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [ownerId, grantKey, WELCOME_CREDIT_MICRO_USD, { expires_at: expiresAt, source: "WELCOME_GRANT" }],
    );
    if (ins.rowCount) {
      const newBalance = account.managed_balance_micro_usd + WELCOME_CREDIT_MICRO_USD;
      await client.query(
        `UPDATE agent_credit_accounts
            SET managed_balance_micro_usd = $2,
                lifetime_grants_micro_usd = lifetime_grants_micro_usd + $3,
                updated_at = now()
          WHERE owner_id = $1`,
        [ownerId, newBalance, WELCOME_CREDIT_MICRO_USD],
      );
      await client.query(`UPDATE agent_credit_ledger SET balance_after_micro_usd = $2 WHERE id = $1`, [
        ins.rows[0].id,
        newBalance,
      ]);
      account.managed_balance_micro_usd = newBalance;
      account.lifetime_grants_micro_usd += WELCOME_CREDIT_MICRO_USD;
    }
    return account;
  });
}

export async function getAccount(ownerId: number): Promise<AccountRow> {
  return ensureAccount(ownerId);
}

export interface LedgerEntry {
  id: number;
  event_type: string;
  amount_micro_usd: number;
  balance_after_micro_usd: number | null;
  provider_mode: string | null;
  provider: string | null;
  model: string | null;
  reason: string | null;
  run_id: string | null;
  reservation_id: string | null;
  created_at: string;
}

export async function listLedger(ownerId: number, limit = 50, before?: string): Promise<LedgerEntry[]> {
  const params: unknown[] = [ownerId, Math.min(Math.max(limit, 1), 200)];
  let where = `owner_id = $1`;
  if (before) {
    params.push(before);
    where += ` AND created_at < $3`;
  }
  const res = await db.query(
    `SELECT id, event_type, amount_micro_usd, balance_after_micro_usd, provider_mode, provider,
            model, reason, run_id, reservation_id, created_at
       FROM agent_credit_ledger
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    params,
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    event_type: r.event_type,
    amount_micro_usd: Number(r.amount_micro_usd),
    balance_after_micro_usd: r.balance_after_micro_usd === null ? null : Number(r.balance_after_micro_usd),
    provider_mode: r.provider_mode,
    provider: r.provider,
    model: r.model,
    reason: r.reason,
    run_id: r.run_id,
    reservation_id: r.reservation_id,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

// Admin grant (e.g. top-up / promo). Idempotent on the supplied key.
export async function recordGrant(
  ownerId: number,
  amountMicroUsd: number,
  reason: string,
  idempotencyKey: string,
): Promise<AccountRow> {
  if (!Number.isInteger(amountMicroUsd) || amountMicroUsd <= 0) {
    throw new GatewayError("INVALID_GRANT_AMOUNT", "grant amount must be a positive integer micro-USD");
  }
  await ensureAccount(ownerId);
  return withTransaction(async (client) => {
    const account = (await lockAccount(client, ownerId))!;
    const ins = await client.query<{ id: string }>(
      `INSERT INTO agent_credit_ledger
         (owner_id, idempotency_key, event_type, amount_micro_usd, provider_mode, reason)
       VALUES ($1, $2, 'grant', $3, 'managed', $4)
       ON CONFLICT (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [ownerId, idempotencyKey, amountMicroUsd, reason],
    );
    if (ins.rowCount) {
      const newBalance = account.managed_balance_micro_usd + amountMicroUsd;
      await client.query(
        `UPDATE agent_credit_accounts
            SET managed_balance_micro_usd = $2,
                lifetime_grants_micro_usd = lifetime_grants_micro_usd + $3,
                updated_at = now()
          WHERE owner_id = $1`,
        [ownerId, newBalance, amountMicroUsd],
      );
      await client.query(`UPDATE agent_credit_ledger SET balance_after_micro_usd = $2 WHERE id = $1`, [
        ins.rows[0].id,
        newBalance,
      ]);
      account.managed_balance_micro_usd = newBalance;
      account.lifetime_grants_micro_usd += amountMicroUsd;
    }
    return account;
  });
}
