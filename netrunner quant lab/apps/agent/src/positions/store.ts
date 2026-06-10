import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { initRuntime, type ExitPolicy, type PositionRuntime, type Side } from "./exitPolicy.js";

// Phase 17 — persistence for managed positions. Each row is the bracket/OCO record bound at entry;
// the monitor advances `runtime` each tick and appends an audit event for every decision. Every
// query is owner-scoped except the cross-owner OPEN sweep the monitor uses.

export interface PositionIntent {
  id: string;
  owner_id: number;
  run_id: string | null;
  session_id: string | null;
  bot_id: string | null;
  symbol: string;
  category: string;
  side: Side;
  entry_price: number;
  exit_policy: ExitPolicy;
  runtime: PositionRuntime;
  state: "open" | "closing" | "closed";
  close_reason: string | null;
  last_mark: number | null;
  realized_return: number | null;
  opened_at: string;
  time_exit_at: string | null;
}

export interface OpenIntentInput {
  ownerId: number;
  runId?: string;
  sessionId?: string;
  botId?: string;
  symbol: string;
  category: string;
  side: Side;
  entryPrice: number;
  policy: ExitPolicy;
  atr?: number;
}

export async function openIntent(input: OpenIntentInput): Promise<PositionIntent> {
  const id = `pos_${randomUUID()}`;
  const runtime = initRuntime({ side: input.side, entry_price: input.entryPrice, policy: input.policy, atr: input.atr });
  const timeExitAt = input.policy.time_exit
    ? new Date(Date.now() + input.policy.time_exit.max_hold_seconds * 1000).toISOString()
    : null;
  const r = await db.query(
    `INSERT INTO agent_position_intents
       (id, owner_id, run_id, session_id, bot_id, symbol, category, side, entry_price,
        exit_policy, runtime, state, last_mark, time_exit_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,'open',$9,$12)
     RETURNING *`,
    [
      id, input.ownerId, input.runId ?? null, input.sessionId ?? null, input.botId ?? null,
      input.symbol, input.category, input.side, input.entryPrice,
      JSON.stringify(input.policy), JSON.stringify(runtime), timeExitAt,
    ],
  );
  return rowToIntent(r.rows[0]);
}

export async function getIntent(ownerId: number, id: string): Promise<PositionIntent | null> {
  const r = await db.query(`SELECT * FROM agent_position_intents WHERE id=$1 AND owner_id=$2`, [id, ownerId]);
  return r.rowCount ? rowToIntent(r.rows[0]) : null;
}

export async function listIntents(ownerId: number, opts: { state?: string; limit?: number } = {}): Promise<PositionIntent[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const r = opts.state
    ? await db.query(`SELECT * FROM agent_position_intents WHERE owner_id=$1 AND state=$2 ORDER BY updated_at DESC LIMIT $3`, [ownerId, opts.state, limit])
    : await db.query(`SELECT * FROM agent_position_intents WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT $2`, [ownerId, limit]);
  return r.rows.map(rowToIntent);
}

// The monitor's cross-owner sweep: every OPEN position, optionally narrowed to a symbol. Used by the
// rt:session:* subscriber (per-symbol) and the periodic safety sweep (all).
export async function listOpenIntentsForSweep(symbol?: string): Promise<PositionIntent[]> {
  const r = symbol
    ? await db.query(`SELECT * FROM agent_position_intents WHERE state='open' AND symbol=$1`, [symbol])
    : await db.query(`SELECT * FROM agent_position_intents WHERE state='open' ORDER BY opened_at ASC LIMIT 1000`);
  return r.rows.map(rowToIntent);
}

// Advance the persisted runtime + last mark after a 'hold' decision (no state change).
export async function updateRuntime(id: string, runtime: PositionRuntime, mark: number): Promise<void> {
  await db.query(
    `UPDATE agent_position_intents SET runtime=$2::jsonb, last_mark=$3, updated_at=now() WHERE id=$1`,
    [id, JSON.stringify(runtime), mark],
  );
}

// Atomically claim a position for closing so two concurrent monitor ticks can't both exit it.
// Returns true iff this caller won the race (state flipped open → closing).
export async function claimForClosing(id: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE agent_position_intents SET state='closing', updated_at=now() WHERE id=$1 AND state='open'`,
    [id],
  );
  return r.rowCount === 1;
}

export async function markClosed(
  id: string,
  opts: { reason: string; mark: number; realizedReturn: number; runId?: string },
): Promise<void> {
  await db.query(
    `UPDATE agent_position_intents
        SET state='closed', close_reason=$2, last_mark=$3, realized_return=$4, run_id=COALESCE($5, run_id),
            closed_at=now(), updated_at=now()
      WHERE id=$1`,
    [id, opts.reason, opts.mark, opts.realizedReturn, opts.runId ?? null],
  );
}

// Release a 'closing' claim back to 'open' if the exit run failed — so the next tick can retry.
export async function releaseClaim(id: string): Promise<void> {
  await db.query(`UPDATE agent_position_intents SET state='open', updated_at=now() WHERE id=$1 AND state='closing'`, [id]);
}

export async function recordPositionEvent(e: {
  intentId: string;
  ownerId: number;
  action: string;
  reason: string;
  mark: number;
  fraction?: number;
  unrealized?: number;
  runId?: string;
  detail?: unknown;
}): Promise<void> {
  await db.query(
    `INSERT INTO agent_position_events (intent_id, owner_id, action, reason, mark, fraction, unrealized, run_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [e.intentId, e.ownerId, e.action, e.reason, e.mark, e.fraction ?? null, e.unrealized ?? null, e.runId ?? null,
      e.detail == null ? null : JSON.stringify(e.detail)],
  );
}

export async function listPositionEvents(ownerId: number, intentId: string): Promise<unknown[]> {
  const r = await db.query(
    `SELECT action, reason, mark, fraction, unrealized, run_id, detail, ts
       FROM agent_position_events WHERE owner_id=$1 AND intent_id=$2 ORDER BY ts ASC`,
    [ownerId, intentId],
  );
  return r.rows;
}

function rowToIntent(r: Record<string, unknown>): PositionIntent {
  return {
    id: String(r.id),
    owner_id: Number(r.owner_id),
    run_id: (r.run_id as string) ?? null,
    session_id: (r.session_id as string) ?? null,
    bot_id: (r.bot_id as string) ?? null,
    symbol: String(r.symbol),
    category: String(r.category),
    side: (r.side as Side) ?? "long",
    entry_price: Number(r.entry_price),
    exit_policy: r.exit_policy as ExitPolicy,
    runtime: r.runtime as PositionRuntime,
    state: (r.state as PositionIntent["state"]) ?? "open",
    close_reason: (r.close_reason as string) ?? null,
    last_mark: r.last_mark == null ? null : Number(r.last_mark),
    realized_return: r.realized_return == null ? null : Number(r.realized_return),
    opened_at: r.opened_at instanceof Date ? r.opened_at.toISOString() : String(r.opened_at),
    time_exit_at: r.time_exit_at instanceof Date ? r.time_exit_at.toISOString() : ((r.time_exit_at as string) ?? null),
  };
}
