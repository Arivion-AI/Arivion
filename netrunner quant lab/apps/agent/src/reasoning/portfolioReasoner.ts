import { llmGateway, getPreferences, resolveModels } from "../llm-gateway/index.js";
import { isConfigured } from "../llm-gateway/providerHealth.js";
import { logger } from "../logger.js";
import type { ChatMessage } from "../llm-gateway/types.js";
import type { ObjectiveSpec } from "./objectiveSynth.js";
import { tryFetchKlines } from "../analysis/klines.js";
import { sharpeLike, maxDrawdown, returnOver } from "../analysis/indicators.js";
import { backtestLp } from "../onchain/lp/backtest.js";
import { gmxTrendPerp } from "../onchain/gmx/strategies.js";
import { discoverPools } from "../onchain/lp/discover.js";
import { resolveLpPricePath } from "../onchain/lp/pricePath.js";
import { getPoolDepth } from "../onchain/uniswap/poolDepth.js";
import { getGmxMarketBySymbol } from "../onchain/gmx/client.js";

// PORTFOLIO REASONER (§3.3–3.6). The "reasoning over rules" core: for an asset it RUNS three real
// experiments (HOLD / LEVERAGE / LP backtests), assembles the evidence, and lets the model JUDGE which
// expression best serves the synthesized OBJECTIVE — forming theses, scoring them on the objective,
// and reporting rejected alternatives with reasons. No hardcoded "if trend→leverage" table. A
// deterministic objective-weighted fallback keeps it usable without a model (clearly labelled).

export type Mode = "hold" | "leverage" | "lp";
export interface Experiment { mode: Mode; total_return: number; sharpe: number; max_drawdown: number; extra: Record<string, unknown>; note: string }
export interface ModeDecision {
  symbol: string;
  recommended: Mode;
  venue: string;
  experiments: Experiment[];
  rationale: string;
  rejected: Array<{ mode: Mode; reason: string }>;
  debate: string;
  objectiveFit: number;            // 0..1
  source: "llm" | "fallback";
  honesty: { result_tier: "LOCAL_SIM"; note: string };
}

export type WidgetEmit = (w: { id: string; kind: string; title: string; state: "running" | "done" | "error"; rationale?: string; data?: unknown }) => void;

// Run the three experiments on real data. Each is an honest sim (LOCAL_SIM), so the reasoner judges on
// comparable, evidence-backed numbers rather than vibes.
export async function runExperiments(symbol: string, objective: ObjectiveSpec): Promise<Experiment[]> {
  const base = symbol.replace(/USDT?$/i, "").toUpperCase();
  const series = await tryFetchKlines(`${base}USDT`, "linear", "D", 180).catch(() => null);
  const closes = series?.closes ?? [];
  const exps: Experiment[] = [];

  // HOLD — spot, 1x. The return/dd of just holding the asset over the window.
  if (closes.length > 5) {
    const ret = returnOver(closes, closes.length - 1) ?? 0;
    const eq = closes.map((c) => c / closes[0]);
    exps.push({ mode: "hold", total_return: ret, sharpe: sharpeLike(eq) ?? 0, max_drawdown: maxDrawdown(eq) ?? 0, extra: { leverage: 1 }, note: "Spot hold (1x)." });
  }

  // LEVERAGE — GMX trend perp, funding/borrow-aware, capped by the objective's max leverage. Surface
  // exactly WHICH GMX market/pair was used + its live funding/borrow/OI so the decision is auditable.
  if (closes.length > 30 && objective.hardConstraints.maxLeverage > 1) {
    const m = await getGmxMarketBySymbol(base).catch(() => null);
    const lev = Math.min(3, objective.hardConstraints.maxLeverage);
    const tp = gmxTrendPerp(closes, {
      leverage: lev,
      fundingAnnualPct: m ? m.fundingAnnualPct : 0,
      borrowAnnualPct: m?.borrowAnnualPct ?? 10,
    });
    exps.push({ mode: "leverage", total_return: tp.metrics.total_return, sharpe: tp.metrics.sharpe, max_drawdown: tp.metrics.max_drawdown,
      extra: { venue: "gmx", gmx_market: m?.name ?? `${base}/USD`, leverage: lev, funding_annual_pct: m?.fundingAnnualPct ?? null,
        borrow_annual_pct: m?.borrowAnnualPct ?? null, funding_paid_pct: tp.funding_paid_pct, trades: tp.trades },
      note: `GMX perp ${m?.name ?? base+"/USD"} @${lev}x · ${tp.rationale}` });
  }

  // LP — concentrated liquidity, if the objective allows it. Surface the CHOSEN pool (venue, pair, fee
  // tier, TVL, fee APR, IL risk) so "which pool" is explicit, not a black box. The LP leg backtests on
  // the POOL's own price path (not the CEX series used by hold/leverage) so IL is correct.
  if (closes.length > 10 && objective.hardConstraints.allowLp) {
    const [disc, path] = await Promise.all([
      discoverPools({ symbol: base }).catch(() => null),
      resolveLpPricePath(base, 180).catch(() => null),
    ]);
    const pick = disc?.pick ?? null;
    const lpCloses = path?.closes.length ? path.closes : closes;
    const feeApr = path?.feeAprPct || pick?.feeAprPct || 12;
    const depth = path?.poolId ? await getPoolDepth(path.poolId).catch(() => null) : null;
    const lp = backtestLp({ symbol: base, closes: lpCloses, grossFeeAprPct: feeApr, activeLiquidityUsd: depth?.activeLiquidityUsd, poolDepth: depth ?? undefined, tvlUsd: path?.tvlUsd });
    exps.push({ mode: "lp", total_return: lp.metrics.total_return, sharpe: lp.metrics.sharpe, max_drawdown: lp.metrics.max_drawdown,
      extra: { venue: pick?.venue ?? "uniswap", pool: pick?.label ?? null, pool_id: pick?.id ?? null, pair: pick?.pair ?? null,
        fee_tier_pct: pick?.feeTierPct ?? null, tvl_usd: pick?.tvlUsd ?? null, fee_apr_pct: lp.fee_apr_pct, il_drag_pct: lp.il_drag_pct,
        time_in_range_pct: lp.time_in_range_pct, il_risk: pick?.ilRisk ?? null, candidates: (disc?.candidates ?? []).length,
        price_source: path?.source ?? "bybit" },
      note: `${pick?.label ?? "Uniswap pool"} · ${lp.rationale} [${path?.source ?? "bybit"} price]` });
  }

  return exps;
}

const SYS = `You are a portfolio architect. Given an OBJECTIVE and three BACKTESTED experiments (hold / leverage / lp) for one asset, decide which expression best serves the objective — you may also reject an option. These are honest sims. Argue it: a Proposer advances the best thesis, a Skeptic attacks it, an Arbiter rules on the numbers + the objective's HARD constraints (never violate maxDrawdownPct). Output STRICT JSON only:
{"recommended":"hold|leverage|lp","objectiveFit":0..1,"rationale":string,
 "rejected":[{"mode":"hold|leverage|lp","reason":string}],"debate":string}
Respect hard constraints: if an option's max_drawdown exceeds the objective's maxDrawdownPct, it cannot be recommended. Favor the option whose evidence best matches the objective weights (yield/growth/drawdown/simplicity). No prose outside the JSON.`;

export async function reasonAsset(ownerId: number, symbol: string, objective: ObjectiveSpec, emit?: WidgetEmit): Promise<ModeDecision> {
  const base = symbol.replace(/USDT?$/i, "").toUpperCase();
  emit?.({ id: `mode-${base}`, kind: "mode_router", title: `Expression · ${base}`, state: "running", rationale: "Backtesting hold vs leverage vs LP…" });
  const experiments = await runExperiments(base, objective);
  if (!experiments.length) {
    const d: ModeDecision = { symbol: base, recommended: "hold", venue: "spot", experiments: [], rationale: "No price data — defaulting to hold.", rejected: [], debate: "", objectiveFit: 0, source: "fallback", honesty: { result_tier: "LOCAL_SIM", note: "no data" } };
    emit?.({ id: `mode-${base}`, kind: "mode_router", title: `Expression · ${base}`, state: "error", rationale: d.rationale, data: d });
    return d;
  }

  const prefs = await getPreferences(ownerId).catch(() => null);
  const provider = prefs?.default_provider ?? "mock";
  const model = prefs ? resolveModels(prefs as Parameters<typeof resolveModels>[0]).actor : "mock-echo";
  let decision: ModeDecision;

  if (prefs && isConfigured(provider)) {
    try {
      const res = await llmGateway.complete({
        ownerId, purpose: "reason:mode", providerMode: "managed", provider, model,
        messages: [{ role: "system", content: SYS }, { role: "user", content: JSON.stringify({ objective, experiments }) }] as ChatMessage[],
        idempotencyKey: `mode:${ownerId}:${base}:${Date.now()}`,
      });
      const j = JSON.parse((res.content ?? "").replace(/^```json\s*|\s*```$/g, "").trim());
      decision = assemble(base, experiments, j, "llm");
    } catch (e) {
      logger.warn("mode reasoning (llm) failed — using fallback", { message: (e as Error).message });
      decision = fallbackDecision(base, experiments, objective);
    }
  } else {
    decision = fallbackDecision(base, experiments, objective);
  }

  emit?.({ id: `mode-${base}`, kind: "mode_router", title: `Expression · ${base} → ${decision.recommended}`, state: "done", rationale: decision.rationale, data: decision });
  emit?.({ id: `hvtl-${base}`, kind: "hold_vs_trade_vs_lp", title: `Hold vs Trade vs LP · ${base}`, state: "done", data: { symbol: base, experiments, recommended: decision.recommended } });
  return decision;
}

function venueFor(mode: Mode, experiments: Experiment[]): string {
  const e = experiments.find((x) => x.mode === mode);
  return mode === "hold" ? "spot" : String(e?.extra.venue ?? (mode === "leverage" ? "gmx" : "uniswap"));
}

function assemble(symbol: string, experiments: Experiment[], j: Record<string, unknown>, source: "llm" | "fallback"): ModeDecision {
  const rec = (["hold", "leverage", "lp"].includes(String(j.recommended)) ? j.recommended : experiments[0].mode) as Mode;
  return {
    symbol, recommended: rec, venue: venueFor(rec, experiments), experiments,
    rationale: typeof j.rationale === "string" ? j.rationale : "",
    rejected: Array.isArray(j.rejected) ? (j.rejected as Array<Record<string, unknown>>).map((r) => ({ mode: r.mode as Mode, reason: String(r.reason ?? "") })) : [],
    debate: typeof j.debate === "string" ? j.debate : "",
    objectiveFit: Number.isFinite(Number(j.objectiveFit)) ? Number(j.objectiveFit) : 0.5,
    source, honesty: { result_tier: "LOCAL_SIM", note: "All three expressions are historical-replay sims; hold/lp/leverage are comparable but unverified." },
  };
}

// Deterministic fallback: score each experiment by the objective weights + hard constraints, pick best.
export function fallbackDecision(symbol: string, experiments: Experiment[], objective: ObjectiveSpec): ModeDecision {
  const cap = objective.hardConstraints.maxDrawdownPct / 100;
  const score = (e: Experiment): number => {
    if (Math.abs(e.max_drawdown) > cap) return -1; // violates the hard DD cap
    const yieldS = e.mode === "lp" ? Math.max(0, Number(e.extra.fee_apr_pct ?? 0)) / 100 : 0;
    const growthS = Math.max(0, e.total_return);
    const ddS = 1 - Math.min(1, Math.abs(e.max_drawdown) / Math.max(0.01, cap));
    const simpS = e.mode === "hold" ? 1 : e.mode === "lp" ? 0.5 : 0.2;
    return objective.weights.yield * yieldS + objective.weights.growth * growthS + objective.weights.drawdown * ddS + objective.weights.simplicity * simpS;
  };
  const ranked = [...experiments].map((e) => ({ e, s: score(e) })).sort((a, b) => b.s - a.s);
  const best = ranked[0];
  const rejected = ranked.slice(1).map((r) => ({ mode: r.e.mode, reason: r.s < 0 ? `max drawdown ${(Math.abs(r.e.max_drawdown) * 100).toFixed(0)}% exceeds the ${objective.hardConstraints.maxDrawdownPct}% cap` : `lower objective fit (${(r.s).toFixed(2)} vs ${best.s.toFixed(2)})` }));
  return {
    symbol, recommended: best.e.mode, venue: venueFor(best.e.mode, experiments), experiments,
    rationale: `${best.e.mode} best fits the objective (fit ${(best.s).toFixed(2)}): ${best.e.note}`,
    rejected, debate: "Objective-weighted comparison of the three backtested expressions (fallback; no model configured).",
    objectiveFit: Math.max(0, Math.min(1, best.s)), source: "fallback",
    honesty: { result_tier: "LOCAL_SIM", note: "All three expressions are historical-replay sims." },
  };
}
