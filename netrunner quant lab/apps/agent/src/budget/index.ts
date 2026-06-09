import { db } from "../db.js";
import { config } from "../config.js";

// Phase 5 — autonomous-action budget governance (separate from the LLM credit ledger). Caps the
// number of runs / live sessions an owner's agent may launch per day, plus exposes the ledger.

export interface DayUsage {
  runs_today: number;
  live_sessions_today: number;
  llm_usd_today: number;
}

export async function dayUsage(ownerId: number): Promise<DayUsage> {
  const runs = Number((await db.query(
    `SELECT COUNT(*) n FROM agent_budget_events WHERE owner_id=$1 AND kind='run' AND ts > now() - interval '1 day'`,
    [ownerId],
  )).rows[0].n);
  const live = Number((await db.query(
    `SELECT COUNT(*) n FROM agent_budget_events WHERE owner_id=$1 AND kind='live_session' AND ts > now() - interval '1 day'`,
    [ownerId],
  )).rows[0].n);
  const usd = Number((await db.query(
    `SELECT COALESCE(SUM(duality_credit_debit_micro_usd),0) s FROM agent_llm_usage_events
       WHERE owner_id=$1 AND created_at > now() - interval '1 day'`,
    [ownerId],
  )).rows[0].s) / 1_000_000;
  return { runs_today: runs, live_sessions_today: live, llm_usd_today: usd };
}

export interface BudgetCheck {
  ok: boolean;
  reason?: string;
}

// Check whether an autonomous action of `kind` is within the owner's daily caps.
export async function checkBudget(ownerId: number, kind: "run" | "live_session"): Promise<BudgetCheck> {
  const u = await dayUsage(ownerId);
  if (u.llm_usd_today >= config.maxCostPerDayUsd) {
    return { ok: false, reason: `daily LLM budget reached ($${u.llm_usd_today.toFixed(2)} ≥ $${config.maxCostPerDayUsd})` };
  }
  if (kind === "run" && u.runs_today >= config.maxRunsPerDay) {
    return { ok: false, reason: `daily run cap reached (${u.runs_today} ≥ ${config.maxRunsPerDay})` };
  }
  if (kind === "live_session" && u.live_sessions_today >= config.maxLiveSessionsPerDay) {
    return { ok: false, reason: `daily live-session cap reached (${u.live_sessions_today} ≥ ${config.maxLiveSessionsPerDay})` };
  }
  return { ok: true };
}

export async function recordBudgetEvent(ownerId: number, kind: string, runId?: string, reason?: string, amount = 1): Promise<void> {
  await db.query(
    `INSERT INTO agent_budget_events (owner_id, run_id, kind, amount, reason) VALUES ($1,$2,$3,$4,$5)`,
    [ownerId, runId ?? null, kind, amount, reason ?? null],
  );
}

// Budget dashboard payload: caps, remaining, today's usage, and recent ledger.
export async function budgetState(ownerId: number): Promise<Record<string, unknown>> {
  const u = await dayUsage(ownerId);
  const ledger = (await db.query(
    `SELECT kind, amount, reason, run_id, ts FROM agent_budget_events WHERE owner_id=$1 ORDER BY ts DESC LIMIT 50`,
    [ownerId],
  )).rows;
  return {
    caps: {
      max_runs_per_day: config.maxRunsPerDay,
      max_live_sessions_per_day: config.maxLiveSessionsPerDay,
      max_cost_per_day_usd: config.maxCostPerDayUsd,
      max_cost_per_run_usd: config.maxCostPerRunUsd,
      max_cost_per_step_usd: config.maxCostPerStepUsd,
    },
    today: u,
    remaining: {
      runs: Math.max(0, config.maxRunsPerDay - u.runs_today),
      live_sessions: Math.max(0, config.maxLiveSessionsPerDay - u.live_sessions_today),
      usd: Math.max(0, config.maxCostPerDayUsd - u.llm_usd_today),
    },
    ledger,
  };
}
