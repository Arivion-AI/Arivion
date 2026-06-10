import { llmGateway, getPreferences, resolveModels } from "../llm-gateway/index.js";
import { isConfigured } from "../llm-gateway/providerHealth.js";
import { logger } from "../logger.js";
import type { ChatMessage } from "../llm-gateway/types.js";

// OBJECTIVE SYNTHESIS (§3.2 of the plan). Turns the discovery pop-up answers into a FORMAL objective
// the Portfolio Reasoner optimizes against. This is REASONED, not table-mapped: an LLM reads the
// profile + free-text and writes the objective + weights/constraints. A deterministic fallback keeps
// the system usable when no model is configured (mock/dev), but the LLM path is the intended one — it
// is what lets two "steady income" users with different notes get different objectives.

export interface DiscoveryProfile {
  capitalUsd: number;
  portfolioSharePct?: number;          // this capital as % of net worth (risk context)
  objective: "grow" | "income" | "preserve" | "view";
  drawdownTolerancePct: number;        // a bad-month DD they'd still hold through
  involvement: "active" | "weekly" | "set_and_forget";
  // conditional / advanced
  view?: { asset: string; direction: "long" | "short"; conviction: "low" | "med" | "high"; horizonDays?: number };
  ilComfort?: "low" | "med" | "high";
  leverageCap?: number;
  assetPrefs?: string[];               // crypto-major, alt, stock, stablecoin
  excludes?: string[];                 // hard "never" (e.g. "no leverage", "no shorting")
  note?: string;                       // free text
}

export interface ObjectiveSpec {
  statement: string;                   // plain-language objective, shown to the user
  weights: { yield: number; growth: number; drawdown: number; simplicity: number };
  hardConstraints: { maxDrawdownPct: number; maxLeverage: number; allowShorts: boolean; allowLp: boolean };
  preferMarketNeutral: boolean;
  horizonDays: number;
  source: "llm" | "fallback";
}

const SYS = `You translate an investor's intake answers into a FORMAL portfolio objective. Output STRICT JSON only:
{"statement": string, "weights": {"yield":0..1,"growth":0..1,"drawdown":0..1,"simplicity":0..1},
 "hardConstraints":{"maxDrawdownPct":number,"maxLeverage":number,"allowShorts":boolean,"allowLp":boolean},
 "preferMarketNeutral":boolean,"horizonDays":number}
Rules: weights sum ~1. The drawdown tolerance is a HARD cap (maxDrawdownPct). "income" → high yield weight + preferMarketNeutral; "grow" → high growth weight + leverage allowed up to the cap; "preserve" → high drawdown weight, low leverage; "view" → growth weight + the named direction. allowLp should be TRUE for almost every objective — providing liquidity (LP) is the primary fee/yield engine and is the income/balanced strategy; only set allowLp=false if the user EXPLICITLY excludes LP/liquidity. Honor excludes (e.g. "no leverage" ⇒ maxLeverage 1, allowShorts false; "no LP" ⇒ allowLp false). Read the free-text note and let it shift the objective. No prose outside the JSON.`;

export async function synthesizeObjective(ownerId: number, profile: DiscoveryProfile): Promise<ObjectiveSpec> {
  const prefs = await getPreferences(ownerId).catch(() => null);
  const provider = prefs?.default_provider ?? "mock";
  const model = prefs ? resolveModels(prefs as Parameters<typeof resolveModels>[0]).actor : "mock-echo";
  if (prefs && isConfigured(provider)) {
    try {
      const res = await llmGateway.complete({
        ownerId, purpose: "reason:objective", providerMode: "managed", provider, model,
        messages: [{ role: "system", content: SYS }, { role: "user", content: JSON.stringify(profile) }] as ChatMessage[],
        idempotencyKey: `objective:${ownerId}:${Date.now()}`,
      });
      const parsed = JSON.parse((res.content ?? "").replace(/^```json\s*|\s*```$/g, "").trim());
      return normalize(parsed, profile, "llm");
    } catch (e) {
      logger.warn("objective synthesis (llm) failed — using fallback", { message: (e as Error).message });
    }
  }
  return fallbackObjective(profile);
}

// Deterministic fallback — explicit, honest, and clearly a heuristic (used only when no model is up).
export function fallbackObjective(p: DiscoveryProfile): ObjectiveSpec {
  const base = { yield: 0.25, growth: 0.25, drawdown: 0.25, simplicity: 0.25 };
  if (p.objective === "income") Object.assign(base, { yield: 0.55, growth: 0.1, drawdown: 0.25, simplicity: 0.1 });
  else if (p.objective === "grow") Object.assign(base, { yield: 0.1, growth: 0.55, drawdown: 0.2, simplicity: 0.15 });
  else if (p.objective === "preserve") Object.assign(base, { yield: 0.25, growth: 0.1, drawdown: 0.55, simplicity: 0.1 });
  else Object.assign(base, { yield: 0.15, growth: 0.5, drawdown: 0.25, simplicity: 0.1 });
  const noLev = p.excludes?.some((x) => /leverage/i.test(x)) || p.objective === "preserve";
  const maxLev = noLev ? 1 : Math.max(1, Math.min(p.leverageCap ?? (p.objective === "grow" ? 5 : 2), 20));
  return {
    statement: objectiveSentence(p),
    weights: base,
    hardConstraints: { maxDrawdownPct: p.drawdownTolerancePct, maxLeverage: maxLev, allowShorts: !p.excludes?.some((x) => /short/i.test(x)) && p.objective !== "preserve", allowLp: !p.excludes?.some((x) => /\b(lp|liquidity|pool)\b/i.test(String(x))) },
    preferMarketNeutral: p.objective === "income" || p.objective === "preserve",
    horizonDays: p.view?.horizonDays ?? (p.involvement === "set_and_forget" ? 90 : 30),
    source: "fallback",
  };
}

function normalize(j: Record<string, unknown>, p: DiscoveryProfile, source: "llm" | "fallback"): ObjectiveSpec {
  const w = (j.weights ?? {}) as Record<string, unknown>;
  const c = (j.hardConstraints ?? {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    statement: typeof j.statement === "string" && j.statement ? j.statement : objectiveSentence(p),
    weights: { yield: n(w.yield, 0.25), growth: n(w.growth, 0.25), drawdown: n(w.drawdown, 0.25), simplicity: n(w.simplicity, 0.25) },
    hardConstraints: {
      maxDrawdownPct: n(c.maxDrawdownPct, p.drawdownTolerancePct),
      maxLeverage: Math.max(1, Math.min(n(c.maxLeverage, 2), 20)),
      allowShorts: c.allowShorts !== false,
      // LP is a core sleeve of this product and the income engine. Disabling it just SKIPS the LP
      // analysis entirely (the bug users hit). Always allow LP unless the user EXPLICITLY excludes it;
      // the per-asset reasoner still rejects LP on backtest evidence when it doesn't fit. (Don't let
      // the model silently turn off a whole analysis path.)
      allowLp: !(p.excludes ?? []).some((x) => /\b(lp|liquidity|provide liquidity|pool)\b/i.test(String(x))),
    },
    preferMarketNeutral: j.preferMarketNeutral === true,
    horizonDays: Math.max(1, n(j.horizonDays, 30)),
    source,
  };
}

function objectiveSentence(p: DiscoveryProfile): string {
  const goal = p.objective === "income" ? "maximize realized yield (fees + carry) net of IL and gas"
    : p.objective === "grow" ? "maximize risk-adjusted growth"
    : p.objective === "preserve" ? "preserve capital and beat inflation with minimal drawdown"
    : `express a ${p.view?.direction ?? "directional"} view on ${p.view?.asset ?? "the chosen asset"}`;
  return `${goal}, subject to max drawdown ≤ ${p.drawdownTolerancePct}%${p.involvement === "set_and_forget" ? ", low-babysit" : ""}.`;
}
