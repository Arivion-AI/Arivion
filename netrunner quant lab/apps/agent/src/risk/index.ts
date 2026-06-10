import { db } from "../db.js";
import { config } from "../config.js";

// Phase 17 — risk-state escalation + circuit breakers (FinCon/go-trader patterns). The agent can be
// pushed from 'normal' into:
//   - 'risk_averse' : NO new entries; existing positions keep being managed/exited.
//   - 'halted'      : exits only; new entries blocked until the cooldown clears.
// Triggers: a consecutive-loss streak, a recent realized-drawdown breach, or a sharp CVaR drop.
// This complements the existing global + per-owner kill switches (those are manual; this is reactive).
// The PURE helpers (computeCVaR / evaluateBreakers) are unit-tested without a DB.

export type RiskState = "normal" | "risk_averse" | "halted";

// Conditional Value-at-Risk: the mean of the worst `alpha` fraction of returns (a left-tail loss
// measure). Returns a NEGATIVE number when the tail is losing. Empty input → 0.
export function computeCVaR(returns: number[], alpha = 0.05): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b); // ascending: worst (most negative) first
  const k = Math.max(1, Math.floor(sorted.length * alpha));
  let sum = 0;
  for (let i = 0; i < k; i++) sum += sorted[i];
  return sum / k;
}

export interface BreakerInputs {
  consecutiveLosses: number;
  recentReturns: number[]; // realized return fractions of recent closed positions (chronological)
  worstDrawdown: number; // worst single realized loss fraction (positive number, e.g. 0.22 = -22%)
}

export interface BreakerVerdict {
  state: RiskState;
  reason: string | null;
}

// Pure decision: given recent realized-position stats, what risk state should the owner be in?
// 'halted' is the strongest (drawdown breach or long loss streak); 'risk_averse' is a softer CVaR/
// streak warning. Returns 'normal' when nothing is tripped.
export function evaluateBreakers(inp: BreakerInputs): BreakerVerdict {
  if (inp.worstDrawdown >= config.riskHaltDrawdownPct) {
    return { state: "halted", reason: `realized drawdown ${(inp.worstDrawdown * 100).toFixed(1)}% ≥ halt threshold ${(config.riskHaltDrawdownPct * 100).toFixed(0)}%` };
  }
  if (inp.consecutiveLosses >= config.riskHaltConsecutiveLosses) {
    return { state: "halted", reason: `${inp.consecutiveLosses} consecutive losing positions ≥ ${config.riskHaltConsecutiveLosses}` };
  }
  const cvar = computeCVaR(inp.recentReturns, 0.1);
  if (cvar <= -config.riskAverseCvarPct) {
    return { state: "risk_averse", reason: `CVaR(10%) ${(cvar * 100).toFixed(1)}% ≤ -${(config.riskAverseCvarPct * 100).toFixed(0)}% (tail risk elevated)` };
  }
  if (inp.consecutiveLosses >= config.riskAverseConsecutiveLosses) {
    return { state: "risk_averse", reason: `${inp.consecutiveLosses} consecutive losing positions ≥ ${config.riskAverseConsecutiveLosses}` };
  }
  return { state: "normal", reason: null };
}

export interface RiskStatus {
  state: RiskState;
  reason: string | null;
  cooldown_until: string | null;
}

// Read the owner's effective risk state, auto-clearing an expired cooldown back to 'normal'.
export async function getRiskState(ownerId: number): Promise<RiskStatus> {
  const r = await db.query(
    `SELECT risk_state, risk_reason, risk_cooldown_until FROM agent_owner_settings WHERE owner_id=$1`,
    [ownerId],
  );
  if (!r.rowCount) return { state: "normal", reason: null, cooldown_until: null };
  const row = r.rows[0] as { risk_state: RiskState; risk_reason: string | null; risk_cooldown_until: Date | string | null };
  const until = row.risk_cooldown_until ? new Date(row.risk_cooldown_until).getTime() : 0;
  if (row.risk_state !== "normal" && until && Date.now() >= until) {
    await db.query(`UPDATE agent_owner_settings SET risk_state='normal', risk_reason=NULL, risk_cooldown_until=NULL, updated_at=now() WHERE owner_id=$1`, [ownerId]);
    return { state: "normal", reason: null, cooldown_until: null };
  }
  return {
    state: row.risk_state ?? "normal",
    reason: row.risk_reason ?? null,
    cooldown_until: row.risk_cooldown_until ? new Date(row.risk_cooldown_until).toISOString() : null,
  };
}

export async function setRiskState(ownerId: number, state: RiskState, reason: string | null, cooldownSeconds?: number): Promise<void> {
  const until = state !== "normal" && cooldownSeconds ? new Date(Date.now() + cooldownSeconds * 1000).toISOString() : null;
  // Upsert: the settings row is created lazily elsewhere, so ensure it exists before updating (a
  // bare UPDATE would silently no-op for an owner who has never touched settings).
  await db.query(
    `INSERT INTO agent_owner_settings (owner_id, risk_state, risk_reason, risk_cooldown_until)
       VALUES ($1,$2,$3,$4)
     ON CONFLICT (owner_id) DO UPDATE SET risk_state=$2, risk_reason=$3, risk_cooldown_until=$4, updated_at=now()`,
    [ownerId, state, reason, until],
  );
}

// Recompute the owner's risk state from their recent CLOSED managed positions and persist any
// escalation. De-escalation is handled by cooldown expiry in getRiskState (so a breach enforces a
// cooling-off period rather than flapping). Called after every autonomous position exit.
export async function refreshRiskState(ownerId: number): Promise<RiskStatus> {
  const rows = (await db.query(
    `SELECT realized_return FROM agent_position_intents
       WHERE owner_id=$1 AND state='closed' AND realized_return IS NOT NULL
       ORDER BY closed_at DESC LIMIT 30`,
    [ownerId],
  )).rows as Array<{ realized_return: string }>;
  const returns = rows.map((r) => Number(r.realized_return)).reverse(); // chronological
  let consecutive = 0;
  for (let i = returns.length - 1; i >= 0; i--) {
    if (returns[i] < 0) consecutive++;
    else break;
  }
  const worstDrawdown = returns.length ? Math.abs(Math.min(0, ...returns)) : 0;
  const verdict = evaluateBreakers({ consecutiveLosses: consecutive, recentReturns: returns, worstDrawdown });

  const current = await getRiskState(ownerId);
  // Only escalate (normal→risk_averse→halted). Never auto-downgrade here — cooldown does that.
  const rank: Record<RiskState, number> = { normal: 0, risk_averse: 1, halted: 2 };
  if (rank[verdict.state] > rank[current.state]) {
    await setRiskState(ownerId, verdict.state, verdict.reason, config.riskCooldownSeconds);
    return { state: verdict.state, reason: verdict.reason, cooldown_until: new Date(Date.now() + config.riskCooldownSeconds * 1000).toISOString() };
  }
  return current;
}
