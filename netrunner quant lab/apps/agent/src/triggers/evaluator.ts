import { createHash, randomUUID } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getOwnerSettings, globalKillActive, AUTONOMY_RANK } from "../settings/index.js";
import { buildReviewPlan } from "./reviewPlan.js";
import { createThread } from "../chat/store.js";
import { connectMcp } from "../mcp/client.js";
import { executePlan } from "../orchestrator/runner.js";
import { checkBudget, recordBudgetEvent } from "../budget/index.js";
import { mintInternalToken } from "../internalToken.js";
import { getRiskState } from "../risk/index.js";

// Phase 4 — trigger engine. A market event (bar close) is evaluated against the owner's armed
// triggers. Firing passes through every safety rail: kill switches → quiet hours → dedupe → cooldown
// → day cap → autonomy/confidence gate. A fire is shadow (propose-only) unless the owner is L2+ and
// the trigger is configured live; low-confidence always stays shadow. Every fire records a
// "why I woke up" reason. Live fires execute a read-only review playbook via the orchestrator.

export interface MarketEvent {
  symbol: string;
  category?: "spot" | "linear" | "xstock";
  interval?: string;
  close?: number;
  volume?: number;
  median_volume?: number;
  vol_pct?: number; // realized close-to-close vol %
  median_vol_pct?: number;
  regime?: string;
  prev_regime?: string;
  funding_rate?: number;
  drawdown?: number; // live-paper session drawdown fraction
  age_ms?: number; // data staleness
  bar_ts?: number;
  // On-chain / LP position state (present only for active LP/perp setups) — drives the §8.4 triggers
  // that REFINE an on-chain setup (re-center a range, flip a carry, re-hedge) rather than open a CEX bot.
  lp_in_range?: boolean;         // is the LP position's price still inside its band?
  lp_fee_apr_pct?: number;       // current pool fee APR
  lp_entry_fee_apr_pct?: number; // fee APR when the LP was entered (for decay detection)
  lp_il_pct?: number;            // current modeled IL drag %
  lp_il_budget_pct?: number;     // the IL budget for this position
  funding_sign?: number;         // current funding sign (+/−)
  prev_funding_sign?: number;    // previous funding sign (flip detection)
}

interface Candidate {
  trigger_type: string;
  playbook: string;
  confidence: number;
  signal: Record<string, unknown>;
  woke_reason: string;
}

// Pure condition evaluation — which triggers' conditions does this event satisfy?
export function evaluateConditions(ev: MarketEvent, thresholds: Record<string, number>): Candidate[] {
  const out: Candidate[] = [];
  const volMult = thresholds.volatility_spike ?? 2.0;
  const fundingThresh = thresholds.funding_extreme ?? 0.0008;
  const volumeMult = thresholds.volume_spike ?? 3.0;
  const ddThresh = thresholds.drawdown ?? 0.15;
  const staleThresh = thresholds.coverage ?? 600000; // 10m

  if (ev.vol_pct != null && ev.median_vol_pct != null && ev.median_vol_pct > 0 && ev.vol_pct > volMult * ev.median_vol_pct) {
    out.push({ trigger_type: "volatility_spike", playbook: "volatility_spike_review", confidence: 0.9,
      signal: { vol_pct: ev.vol_pct, threshold: volMult * ev.median_vol_pct },
      woke_reason: `Volatility ${ev.vol_pct.toFixed(2)}% > ${(volMult * ev.median_vol_pct).toFixed(2)}% (${volMult}× median).` });
  }
  if (ev.regime && ev.prev_regime && ev.regime !== ev.prev_regime) {
    out.push({ trigger_type: "regime_flip", playbook: "regime_flip_review", confidence: 1.0,
      signal: { from: ev.prev_regime, to: ev.regime },
      woke_reason: `Regime flipped from ${ev.prev_regime} to ${ev.regime}.` });
  }
  if (ev.funding_rate != null && Math.abs(ev.funding_rate) > fundingThresh) {
    out.push({ trigger_type: "funding_extreme", playbook: "funding_extreme_scan", confidence: 1.0,
      signal: { funding_rate: ev.funding_rate, threshold: fundingThresh },
      woke_reason: `Funding rate ${ev.funding_rate} beyond ±${fundingThresh} extreme.` });
  }
  if (ev.volume != null && ev.median_volume != null && ev.median_volume > 0 && ev.volume > volumeMult * ev.median_volume) {
    out.push({ trigger_type: "volume_spike", playbook: "volatility_spike_review", confidence: 0.8,
      signal: { volume: ev.volume, threshold: volumeMult * ev.median_volume },
      woke_reason: `Volume ${ev.volume} > ${volumeMult}× median (${ev.median_volume}).` });
  }
  if (ev.drawdown != null && ev.drawdown > ddThresh) {
    out.push({ trigger_type: "drawdown", playbook: "inspect_drawdown", confidence: 1.0,
      signal: { drawdown: ev.drawdown, threshold: ddThresh },
      woke_reason: `Live-paper drawdown ${(ev.drawdown * 100).toFixed(1)}% > ${(ddThresh * 100).toFixed(1)}% threshold.` });
  }
  if (ev.age_ms != null && ev.age_ms > staleThresh) {
    out.push({ trigger_type: "coverage", playbook: "coverage_repair", confidence: 1.0,
      signal: { age_ms: ev.age_ms, threshold: staleThresh },
      woke_reason: `Data stale: ${Math.round(ev.age_ms / 1000)}s > ${Math.round(staleThresh / 1000)}s.` });
  }

  // --- On-chain refinement triggers (§8.4). These fire on an ACTIVE on-chain setup's state to refine
  // it (re-center / migrate / re-hedge), not to open a new CEX bot. All paper/sim, autonomy-gated.
  const feeDecay = thresholds.fee_apr_decay ?? 0.5;     // fee APR fell to <50% of entry
  const ilBreachMult = thresholds.il_breach ?? 1.0;     // IL exceeded its budget
  if (ev.lp_in_range === false) {
    out.push({ trigger_type: "lp_out_of_range", playbook: "lp_recenter_review", confidence: 1.0,
      signal: { symbol: ev.symbol }, woke_reason: `LP position for ${ev.symbol} left its range — re-center or exit.` });
  }
  if (ev.lp_fee_apr_pct != null && ev.lp_entry_fee_apr_pct != null && ev.lp_entry_fee_apr_pct > 0 &&
      ev.lp_fee_apr_pct < feeDecay * ev.lp_entry_fee_apr_pct) {
    out.push({ trigger_type: "fee_apr_decay", playbook: "lp_recompare_review", confidence: 0.9,
      signal: { now: ev.lp_fee_apr_pct, entry: ev.lp_entry_fee_apr_pct },
      woke_reason: `Pool fee APR ${ev.lp_fee_apr_pct.toFixed(1)}% fell below ${(feeDecay * 100).toFixed(0)}% of entry (${ev.lp_entry_fee_apr_pct.toFixed(1)}%) — re-rank pools.` });
  }
  if (ev.lp_il_pct != null && ev.lp_il_budget_pct != null && ev.lp_il_pct > ilBreachMult * ev.lp_il_budget_pct) {
    out.push({ trigger_type: "il_breach", playbook: "lp_rehedge_review", confidence: 0.95,
      signal: { il: ev.lp_il_pct, budget: ev.lp_il_budget_pct },
      woke_reason: `Modeled IL ${ev.lp_il_pct.toFixed(1)}% exceeded budget ${ev.lp_il_budget_pct.toFixed(1)}% — tighten/hedge.` });
  }
  if (ev.funding_sign != null && ev.prev_funding_sign != null && ev.funding_sign !== ev.prev_funding_sign && ev.funding_sign !== 0) {
    out.push({ trigger_type: "funding_flip", playbook: "carry_flip_review", confidence: 0.85,
      signal: { from: ev.prev_funding_sign, to: ev.funding_sign },
      woke_reason: `Funding sign flipped for ${ev.symbol} — flip the carry side / re-hedge the LP.` });
  }
  return out;
}

function dedupeKey(ownerId: number, type: string, symbol: string, regime: string | undefined, barTs: number | undefined): string {
  const barBucket = barTs ? Math.floor(barTs / 60000) : 0; // 1-minute bucket
  return createHash("sha256").update(`${ownerId}|${type}|${symbol}|${regime ?? ""}|${barBucket}`).digest("hex").slice(0, 32);
}

export interface FireResult {
  fired: Array<{ id: string; trigger_type: string; mode: string; acted: boolean; woke_reason: string; run_id?: string; skipped?: string }>;
}

// Evaluate one event for one owner and fire any armed, condition-matching triggers (subject to all
// safety rails). Returns what fired / was skipped (with reasons) for observability + tests.
export async function evaluateEvent(ownerId: number, ev: MarketEvent): Promise<FireResult> {
  const fired: FireResult["fired"] = [];
  if (globalKillActive()) return { fired };
  const settings = await getOwnerSettings(ownerId);
  if (!settings.agent_enabled || settings.disable_triggers) return { fired };

  const cfgRows = (await db.query(
    `SELECT trigger_type, armed, threshold, cooldown_seconds, default_mode, quiet_hours
       FROM agent_trigger_config WHERE owner_id=$1 AND armed=true`,
    [ownerId],
  )).rows as Array<{ trigger_type: string; threshold: number | null; cooldown_seconds: number; default_mode: string; quiet_hours: number[] }>;
  if (!cfgRows.length) return { fired };

  const cfgByType = new Map(cfgRows.map((r) => [r.trigger_type, r]));
  const thresholds: Record<string, number> = {};
  for (const r of cfgRows) if (r.threshold != null) thresholds[r.trigger_type] = r.threshold;

  const candidates = evaluateConditions(ev, thresholds).filter((c) => cfgByType.has(c.trigger_type));
  const symbol = ev.symbol;
  const category = ev.category ?? "linear";
  const nowHour = Number((await db.query(`SELECT EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS h`)).rows[0].h);

  for (const c of candidates) {
    const cfg = cfgByType.get(c.trigger_type)!;
    if (Array.isArray(cfg.quiet_hours) && cfg.quiet_hours.includes(nowHour)) {
      fired.push({ id: "", trigger_type: c.trigger_type, mode: "skipped", acted: false, woke_reason: c.woke_reason, skipped: "quiet_hours" });
      continue;
    }
    const key = dedupeKey(ownerId, c.trigger_type, symbol, ev.regime, ev.bar_ts);
    // Dedupe: same key already fired recently?
    const dup = await db.query(`SELECT 1 FROM agent_trigger_events WHERE owner_id=$1 AND dedupe_key=$2 LIMIT 1`, [ownerId, key]);
    if (dup.rowCount) { fired.push({ id: "", trigger_type: c.trigger_type, mode: "skipped", acted: false, woke_reason: c.woke_reason, skipped: "dedupe" }); continue; }
    // Cooldown: last fire of this (type, symbol) within cooldown window?
    const cool = await db.query(
      `SELECT MAX(ts) AS last FROM agent_trigger_events WHERE owner_id=$1 AND trigger_type=$2 AND symbol=$3`,
      [ownerId, c.trigger_type, symbol],
    );
    const last = cool.rows[0].last ? new Date(cool.rows[0].last).getTime() : 0;
    if (last && Date.now() - last < (cfg.cooldown_seconds ?? config.triggerCooldownSeconds) * 1000) {
      fired.push({ id: "", trigger_type: c.trigger_type, mode: "skipped", acted: false, woke_reason: c.woke_reason, skipped: "cooldown" });
      continue;
    }
    // Day cap on acted (executed) triggers.
    const dayCount = Number((await db.query(
      `SELECT COUNT(*) AS n FROM agent_trigger_events WHERE owner_id=$1 AND acted=true AND ts > now() - interval '1 day'`,
      [ownerId],
    )).rows[0].n);
    const overCap = dayCount >= config.triggerMaxPerDay;

    // Decide mode: configured default, but force shadow if autonomy < L2, low confidence, over the
    // trigger day-cap, or out of daily run/USD budget (Phase 5 governance).
    const wantLive = cfg.default_mode === "live";
    const budget = await checkBudget(ownerId, "run");
    // A halted risk state forces every trigger to shadow (no autonomous action) until cooldown clears.
    const risk = await getRiskState(ownerId);
    const canLive = AUTONOMY_RANK[settings.autonomy_level] >= AUTONOMY_RANK["L2"] && c.confidence >= 0.7 && !overCap && budget.ok && risk.state !== "halted";
    const mode = wantLive && canLive ? "live" : "shadow";

    const threadId = (await createThread(ownerId, `Trigger: ${c.trigger_type} ${symbol}`)).id;
    const plan = buildReviewPlan({ ownerId, threadId, playbook: c.playbook, symbol, category, regime: ev.regime, interval: ev.interval });
    const id = `trg_${randomUUID()}`;
    const reason = `${c.woke_reason} Mode=${mode}${overCap ? " (day cap reached → shadow)" : ""}.`;

    await db.query(
      `INSERT INTO agent_trigger_events (id, owner_id, trigger_type, symbol, regime, signal, confidence, dedupe_key, mode, acted, proposed_playbook, plan, woke_reason)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,false,$10,$11::jsonb,$12)`,
      [id, ownerId, c.trigger_type, symbol, ev.regime ?? null, JSON.stringify(c.signal), c.confidence, key, mode, c.playbook, JSON.stringify(plan), reason],
    );

    if (mode === "live") {
      // Execute the read-only review playbook now.
      void executeTriggerPlan(ownerId, id, plan).catch((e) => logger.error("trigger exec failed", { id, message: (e as Error).message }));
      fired.push({ id, trigger_type: c.trigger_type, mode, acted: true, woke_reason: reason });
    } else {
      fired.push({ id, trigger_type: c.trigger_type, mode, acted: false, woke_reason: reason });
    }
  }
  return { fired };
}

// Execute a trigger's plan (used for live fires and shadow→live promotion). Owner-scoped MCP.
export async function executeTriggerPlan(ownerId: number, triggerId: string, plan: import("../orchestrator/plan.js").AgentPlan, ownerToken?: string): Promise<string> {
  const mcp = await connectMcp(ownerToken ?? mintInternalToken(ownerId));
  try {
    const outcome = await executePlan({ plan, mcp, agentAction: `trigger ${plan.playbook_id}` });
    await db.query(`UPDATE agent_trigger_events SET acted=true, mode='live', run_id=$2 WHERE id=$1`, [triggerId, outcome.runId]);
    // Phase 5 — count this autonomous run against the owner's daily budget.
    await recordBudgetEvent(ownerId, "run", outcome.runId, `trigger ${plan.playbook_id}`).catch(() => {});
    return outcome.runId;
  } finally {
    await mcp.close().catch(() => {});
  }
}
