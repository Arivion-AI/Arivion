import { db } from "../db.js";
import { config } from "../config.js";
import { writeSemantic } from "../memory/store.js";
import { getOwnerSettings } from "../settings/index.js";
import { GatewayError } from "../llm-gateway/types.js";

// Phase 8 — opt-in, de-identified global insights. An owner may contribute STRUCTURAL semantic
// insights ("grid bots underperform in trend_up_high_vol") to a shared scope='global' pool that
// benefits everyone. Raw params, PnL, equity, and owner identifiers are NEVER allowed in. Private
// owner-scoped memory and the per-owner policy table never go global. Tenant isolation: owner-scoped
// rows are always queried WHERE owner_id=$owner; global rows are readable by all.

// De-identification guard — reject anything that leaks raw params/PnL or identifies an owner.
export function deidentify(statement: string): { ok: boolean; reason?: string } {
  const s = statement.trim();
  if (s.length < 20) return { ok: false, reason: "too short to be a structural insight" };
  if (/[{}]/.test(s)) return { ok: false, reason: "contains raw param JSON (not structural)" };
  if (/\$\s*\d|\bUSD\b|\d+\s*(USDT|usd)\b/i.test(s)) return { ok: false, reason: "contains monetary/PnL figures" };
  if (/\b(pnl|equity|balance|drawdown of|sharpe \d)\b/i.test(s)) return { ok: false, reason: "contains owner-specific performance figures" };
  if (/@\w+|owner[_\s]?id|user\s|account\b/i.test(s)) return { ok: false, reason: "contains an owner/account identifier" };
  return { ok: true };
}

// Promote a de-identified structural insight to the global pool (requires the owner to have opted in).
export async function promoteToGlobal(ownerId: number, statement: string): Promise<{ id: number }> {
  const settings = await getOwnerSettings(ownerId) as unknown as { contribute_global?: boolean };
  if (!settings.contribute_global) {
    throw new GatewayError("GLOBAL_OPT_IN_REQUIRED", "owner has not opted in to contribute global insights", 403);
  }
  const guard = deidentify(statement);
  if (!guard.ok) throw new GatewayError("DEIDENTIFICATION_FAILED", `cannot globalize: ${guard.reason}`, 422);
  const id = await writeSemantic(ownerId, statement, { scope: "global", confidence: 0.7, verificationWeight: 0.7 });
  return { id };
}

export async function listGlobal(): Promise<Record<string, unknown>> {
  const rows = (await db.query(
    `SELECT id, statement, confidence, verification_weight, updated_at FROM agent_semantic
       WHERE scope='global' AND deleted_at IS NULL ORDER BY confidence DESC, updated_at DESC LIMIT 100`,
  )).rows;
  return { global_insights: rows };
}

export function isAdmin(ownerId: number): boolean {
  return config.adminOwnerIds.includes(ownerId);
}

// Admin-only platform budget dashboard: aggregate LLM spend + balances per owner.
export async function adminBudget(): Promise<Record<string, unknown>> {
  const perOwner = (await db.query(
    `SELECT a.owner_id,
            (a.managed_balance_micro_usd/1e6)::float8 AS balance_usd,
            (a.lifetime_spend_micro_usd/1e6)::float8 AS lifetime_spend_usd,
            COALESCE((SELECT SUM(duality_credit_debit_micro_usd) FROM agent_llm_usage_events u
                       WHERE u.owner_id=a.owner_id AND u.created_at > now() - interval '1 day'),0)/1e6 AS spend_today_usd
       FROM agent_credit_accounts a ORDER BY lifetime_spend_usd DESC LIMIT 200`,
  )).rows;
  const totals = (await db.query(
    `SELECT COUNT(*) AS owners,
            COALESCE(SUM(lifetime_spend_micro_usd),0)/1e6 AS total_spend_usd,
            COALESCE(SUM(managed_balance_micro_usd),0)/1e6 AS total_balance_usd
       FROM agent_credit_accounts`,
  )).rows[0];
  return { totals, per_owner: perOwner };
}
