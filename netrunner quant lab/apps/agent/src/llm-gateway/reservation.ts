import { randomUUID } from "node:crypto";
import { withTransaction } from "../db.js";
import { config } from "../config.js";
import { lockAccount } from "./creditLedger.js";
import { GatewayError } from "./types.js";

// A reservation moves `reserved` micro-USD OUT of managed_balance into a hold BEFORE the provider
// call. finalize() charges the actual cost and returns the unused remainder; release() returns the
// whole hold (used when no tokens were consumed). All three lock the account row FOR UPDATE, so
// concurrent calls for one owner serialize and can never overspend (correction #3).

export interface ReservationRow {
  id: string;
  owner_id: number;
  reserved_micro_usd: number;
  finalized_micro_usd: number | null;
  status: string;
  provider: string;
  model: string;
  provider_mode: string;
}

function toReservation(r: Record<string, unknown>): ReservationRow {
  return {
    id: String(r.id),
    owner_id: Number(r.owner_id),
    reserved_micro_usd: Number(r.reserved_micro_usd),
    finalized_micro_usd: r.finalized_micro_usd === null ? null : Number(r.finalized_micro_usd),
    status: String(r.status),
    provider: String(r.provider),
    model: String(r.model),
    provider_mode: String(r.provider_mode),
  };
}

export interface ReserveArgs {
  ownerId: number;
  runId?: string;
  stepId?: string;
  idempotencyKey: string;
  provider: string;
  model: string;
  providerMode: string;
  reservedMicroUsd: number;
}

// Reserve a hold. Idempotent: a second reserve with the same (owner, idempotencyKey) returns the
// existing reservation without holding twice. Throws INSUFFICIENT_CREDIT (before any provider call)
// if the locked balance can't cover the hold.
export async function reserve(args: ReserveArgs): Promise<ReservationRow> {
  const reserved = Math.max(0, Math.ceil(args.reservedMicroUsd));
  return withTransaction(async (client) => {
    const account = await lockAccount(client, args.ownerId);
    if (!account) throw new GatewayError("NO_CREDIT_ACCOUNT", "credit account missing", 500);
    if (account.status !== "active") {
      throw new GatewayError("ACCOUNT_FROZEN", `credit account is ${account.status}`, 402);
    }

    // Idempotent reuse (we hold the account lock, so this read-then-insert is race-free per owner).
    const existing = await client.query(
      `SELECT * FROM agent_credit_reservations WHERE owner_id = $1 AND idempotency_key = $2`,
      [args.ownerId, args.idempotencyKey],
    );
    if (existing.rowCount) return toReservation(existing.rows[0]);

    if (account.managed_balance_micro_usd < reserved) {
      throw new GatewayError(
        "INSUFFICIENT_CREDIT",
        `need ${reserved} micro-USD, have ${account.managed_balance_micro_usd}`,
        402,
      );
    }

    const id = `res_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + config.reservationTtlSeconds * 1000).toISOString();
    await client.query(
      `INSERT INTO agent_credit_reservations
         (id, owner_id, run_id, step_id, idempotency_key, provider_mode, provider, model,
          reserved_micro_usd, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',$10)`,
      [id, args.ownerId, args.runId ?? null, args.stepId ?? null, args.idempotencyKey,
       args.providerMode, args.provider, args.model, reserved, expiresAt],
    );

    const newBalance = account.managed_balance_micro_usd - reserved;
    await client.query(
      `UPDATE agent_credit_accounts SET managed_balance_micro_usd = $2, updated_at = now() WHERE owner_id = $1`,
      [args.ownerId, newBalance],
    );
    await client.query(
      `INSERT INTO agent_credit_ledger
         (owner_id, run_id, step_id, reservation_id, idempotency_key, event_type, amount_micro_usd,
          balance_after_micro_usd, provider_mode, provider, model, reason)
       VALUES ($1,$2,$3,$4,$5,'reserve',$6,$7,$8,$9,$10,'RESERVE_HOLD')`,
      [args.ownerId, args.runId ?? null, args.stepId ?? null, id, `${args.idempotencyKey}:reserve`,
       -reserved, newBalance, args.providerMode, args.provider, args.model],
    );

    return {
      id, owner_id: args.ownerId, reserved_micro_usd: reserved, finalized_micro_usd: null,
      status: "reserved", provider: args.provider, model: args.model, providerMode: args.providerMode,
    } as unknown as ReservationRow;
  });
}

// Finalize: charge `actualMicroUsd`, return the remainder of the hold. Idempotent — a second
// finalize on an already-finalized/released reservation is a no-op (prevents double debit).
export async function finalize(reservationId: string, actualMicroUsd: number): Promise<void> {
  const actual = Math.max(0, Math.ceil(actualMicroUsd));
  await withTransaction(async (client) => {
    const resv = await client.query(
      `SELECT * FROM agent_credit_reservations WHERE id = $1 FOR UPDATE`,
      [reservationId],
    );
    if (!resv.rowCount) throw new GatewayError("RESERVATION_NOT_FOUND", reservationId, 500);
    const r = toReservation(resv.rows[0]);
    if (r.status !== "reserved") return; // already settled — idempotent no-op

    const account = (await lockAccount(client, r.owner_id))!;
    const charge = Math.min(actual, r.reserved_micro_usd); // never charge more than was held
    const refund = r.reserved_micro_usd - charge;

    // Release the full hold back to balance, then debit the actual charge — two explicit ledger
    // rows so the balance trail is auditable and an actual-spend row always exists.
    let balance = account.managed_balance_micro_usd + r.reserved_micro_usd;
    await client.query(
      `INSERT INTO agent_credit_ledger
         (owner_id, reservation_id, idempotency_key, event_type, amount_micro_usd,
          balance_after_micro_usd, provider_mode, provider, model, reason)
       VALUES ($1,$2,$3,'reserve_release',$4,$5,$6,$7,$8,'FINALIZE_RELEASE')`,
      [r.owner_id, r.id, `${r.id}:release`, r.reserved_micro_usd, balance, r.provider_mode, r.provider, r.model],
    );
    balance -= charge;
    if (charge > 0) {
      await client.query(
        `INSERT INTO agent_credit_ledger
           (owner_id, reservation_id, idempotency_key, event_type, amount_micro_usd,
            balance_after_micro_usd, provider_mode, provider, model, reason)
         VALUES ($1,$2,$3,'debit',$4,$5,$6,$7,$8,'ACTUAL_SPEND')`,
        [r.owner_id, r.id, `${r.id}:debit`, -charge, balance, r.provider_mode, r.provider, r.model],
      );
    }
    void refund; // refund is implicit: hold released in full, only `charge` debited.

    await client.query(
      `UPDATE agent_credit_accounts
          SET managed_balance_micro_usd = $2,
              lifetime_spend_micro_usd = lifetime_spend_micro_usd + $3,
              updated_at = now()
        WHERE owner_id = $1`,
      [r.owner_id, balance, charge],
    );
    await client.query(
      `UPDATE agent_credit_reservations
          SET status = 'finalized', finalized_micro_usd = $2, finalized_at = now()
        WHERE id = $1`,
      [r.id, charge],
    );
  });
}

// Release the entire hold (no spend). Idempotent. Used on pre-token provider error, kill switch,
// Lab 429, plan-blocked, etc. (correction: refund reservation on those paths).
export async function release(reservationId: string, reason = "RELEASE"): Promise<void> {
  await withTransaction(async (client) => {
    const resv = await client.query(
      `SELECT * FROM agent_credit_reservations WHERE id = $1 FOR UPDATE`,
      [reservationId],
    );
    if (!resv.rowCount) return;
    const r = toReservation(resv.rows[0]);
    if (r.status !== "reserved") return; // idempotent no-op

    const account = (await lockAccount(client, r.owner_id))!;
    const balance = account.managed_balance_micro_usd + r.reserved_micro_usd;
    await client.query(
      `UPDATE agent_credit_accounts SET managed_balance_micro_usd = $2, updated_at = now() WHERE owner_id = $1`,
      [r.owner_id, balance],
    );
    await client.query(
      `INSERT INTO agent_credit_ledger
         (owner_id, reservation_id, idempotency_key, event_type, amount_micro_usd,
          balance_after_micro_usd, provider_mode, provider, model, reason)
       VALUES ($1,$2,$3,'refund',$4,$5,$6,$7,$8,$9)`,
      [r.owner_id, r.id, `${r.id}:refund`, r.reserved_micro_usd, balance, r.provider_mode, r.provider, r.model, reason],
    );
    await client.query(
      `UPDATE agent_credit_reservations SET status = 'released', finalized_micro_usd = 0, finalized_at = now() WHERE id = $1`,
      [r.id],
    );
  });
}
