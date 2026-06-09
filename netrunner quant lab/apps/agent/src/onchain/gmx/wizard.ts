import { getGmxMarketBySymbol, getGlvVaults, getGmxOhlcv } from "./client.js";
import { GMX_STRATEGIES, type GmxSimParams, type GmxSimResult } from "./strategies.js";
import { tryFetchKlines } from "../../analysis/klines.js";

// GMX WIZARD (§5.2) — the guided "make me a GMX strategy" flow. It: (1) pulls the live GMX market for
// context, (2) backtests the candidate strategies across a small LEVERAGE SWEEP accruing real
// funding/borrow, (3) picks the best by an objective metric (Sharpe by default), and (4) returns a
// proposal + a venue route. Paper-sim only (LOCAL_SIM). Emits gmx_market → backtest → venue_route.

export type WizardEmit = (w: { id: string; kind: string; title: string; state: "running" | "done" | "error"; rationale?: string; data?: unknown }) => void;

export interface GmxWizardResult {
  symbol: string;
  market: Awaited<ReturnType<typeof getGmxMarketBySymbol>>;
  best: { strategy: string; leverage: number; params: Partial<GmxSimParams>; score: number; accepted: boolean; critique: string; result: GmxSimResult } | null;
  tested: Array<{ strategy: string; leverage: number; params: Partial<GmxSimParams>; score: number; accepted: boolean; critique: string; total_return: number; sharpe: number; max_drawdown: number }>;
  rationale: string;
}

export async function runGmxWizard(opts: {
  symbol: string;
  strategies?: string[];
  leverages?: number[];
  objective?: "sharpe" | "return";
  emit?: WizardEmit;
}): Promise<GmxWizardResult> {
  const base = opts.symbol.replace(/USDT?$/i, "").toUpperCase();
  const emit = opts.emit;
  const objective = opts.objective ?? "sharpe";
  const strategies = (opts.strategies ?? Object.keys(GMX_STRATEGIES)).filter((s) => GMX_STRATEGIES[s]);
  const leverages = opts.leverages ?? [1, 2, 3, 5];

  const [nativeSeries, m] = await Promise.all([
    getGmxOhlcv(base, "1d", 180).catch(() => null),
    getGmxMarketBySymbol(base).catch(() => null),
  ]);
  const fallbackSeries = nativeSeries?.closes.length ? null : await tryFetchKlines(`${base}USDT`, "linear", "D", 180).catch(() => null);
  if (m) emit?.({ id: `gmx-${base}`, kind: "gmx_market", title: `GMX · ${m.indexSymbol}`, state: "done", rationale: m.name, data: m });

  const closes = nativeSeries?.closes ?? fallbackSeries?.closes ?? [];
  const baseParams: GmxSimParams = {
    fundingAnnualPct: m ? m.fundingAnnualPct : 0,
    borrowAnnualPct: m?.borrowAnnualPct ?? 10,
    dataSource: nativeSeries ? `gmx_api:${nativeSeries.requestSymbol}:${nativeSeries.timeframe}` : fallbackSeries ? "bybit_klines_fallback" : "none",
  };
  const variantsFor = (strategy: string): Array<Partial<GmxSimParams>> => {
    if (strategy !== "gmx_trend_perp") return [{}];
    return [
      { emaFast: 5, emaSlow: 20 },
      { emaFast: 10, emaSlow: 30 },
      { emaFast: 20, emaSlow: 60 },
    ];
  };

  emit?.({ id: `gmxsweep-${base}`, kind: "optimise", title: `GMX sweep · ${base}`, state: "running", rationale: `Backtesting strategies × leverage on ${baseParams.dataSource} with funding/borrow…` });
  const tested: GmxWizardResult["tested"] = [];
  let best: GmxWizardResult["best"] = null;
  for (const strat of strategies) {
    for (const params of variantsFor(strat)) {
      for (const lev of leverages) {
        const r = GMX_STRATEGIES[strat](closes, { ...baseParams, ...params, leverage: lev });
        if (r.error) continue;
        const quality = scoreCandidate(r, objective);
        tested.push({ strategy: strat, leverage: lev, params, ...quality, total_return: r.metrics.total_return, sharpe: r.metrics.sharpe, max_drawdown: r.metrics.max_drawdown });
        if (!Number.isFinite(quality.score)) continue;
        const bestScore = best?.score ?? -Infinity;
        if (quality.score > bestScore) best = { strategy: strat, leverage: lev, params, ...quality, result: r };
      }
    }
  }
  emit?.({ id: `gmxsweep-${base}`, kind: "optimise", title: `GMX sweep · ${base}`, state: tested.length ? "done" : "error",
    rationale: best ? `Best: ${best.strategy} @ ${best.leverage}× · score ${best.score.toFixed(2)} · ${best.accepted ? "accepted" : "needs review"}` : "no valid runs",
    data: { tested: tested.map((t) => ({ rebalance_threshold: `${t.strategy}@${t.leverage}x${paramLabel(t.params)}`, score: t.score, accepted: t.accepted, critique: t.critique, sharpe: t.sharpe, total_return: t.total_return, max_drawdown: t.max_drawdown })), chosen: best ? `${best.strategy}@${best.leverage}x${paramLabel(best.params)}` : null } });

  if (best) {
    emit?.({ id: `gmxbt-${base}`, kind: "backtest", title: `${best.strategy} @ ${best.leverage}× · ${base}`, state: "done",
      rationale: best.result.rationale, data: { metrics: best.result.metrics, equity_curve: best.result.equity_curve, truth: best.result.truth, rebalances: best.result.trades } });
    emit?.({ id: `vr-${base}`, kind: "venue_route", title: `Route · ${base}`, state: "done",
      rationale: `GMX v2 perp · ${best.leverage}× · ${best.accepted ? "accepted" : "needs review"} · funding ${baseParams.fundingAnnualPct?.toFixed(1)}%/yr`,
      data: { symbol: base, venue: "gmx", mode: "leverage", instrument: best.strategy, leverage: best.leverage, params: best.params,
        accepted: best.accepted, critique: best.critique,
        why: `Deepest GMX liquidity for ${base}; funding/borrow modeled; best risk-adjusted ${objective} in the sweep`, liquidity_usd: m?.availableLiquidityUsd ?? null } });
  }

  return {
    symbol: base, market: m, best, tested,
    rationale: best
      ? `GMX wizard for ${base}: best risk-adjusted candidate is ${best.strategy} at ${best.leverage}×${paramLabel(best.params)} — ${best.result.rationale} ${best.accepted ? "Accepted." : `Needs review: ${best.critique}`} (paper-sim, funding/borrow modeled).`
      : `GMX wizard for ${base}: no valid backtest (need ≥30 bars of history${m ? "" : "; no GMX market found"}).`,
  };
}

function paramLabel(params: Partial<GmxSimParams>): string {
  return params.emaFast && params.emaSlow ? ` EMA${params.emaFast}/${params.emaSlow}` : "";
}

function scoreCandidate(r: GmxSimResult, objective: "sharpe" | "return"): { score: number; accepted: boolean; critique: string } {
  const ret = r.metrics.total_return;
  const sharpe = r.metrics.sharpe;
  const dd = Math.abs(r.metrics.max_drawdown);
  const fundingDrag = r.funding_paid_pct < -15;
  const accepted = ret > 0 && sharpe > 0.03 && dd <= (objective === "return" ? 0.45 : 0.35) && !fundingDrag;
  const score = objective === "return"
    ? ret - dd * 1.25 + Math.max(-0.5, sharpe) * 0.25
    : sharpe + Math.max(-0.5, Math.min(1.5, ret)) * 0.15 - dd * 0.9;
  const reasons: string[] = [];
  if (ret <= 0) reasons.push("non-positive return");
  if (sharpe <= 0.03) reasons.push("weak Sharpe");
  if (dd > 0.35) reasons.push(`drawdown ${(dd * 100).toFixed(1)}% is high`);
  if (fundingDrag) reasons.push(`funding/borrow drag ${r.funding_paid_pct.toFixed(1)}% is too large`);
  return { score, accepted, critique: reasons.length ? reasons.join("; ") : "passes return, Sharpe, drawdown, and funding-drag checks" };
}

// List GLV vaults (for the glv_vault widget). Optionally filter to those exposed to an asset.
export async function listGlvForWidget(symbol?: string, emit?: WizardEmit): Promise<void> {
  const glvs = await getGlvVaults().catch(() => []);
  const want = symbol?.replace(/USDT?$/i, "").toUpperCase();
  const filtered = want ? glvs.filter((g) => g.longSymbol.toUpperCase().includes(want) || want.includes(g.longSymbol.toUpperCase())) : glvs;
  for (const g of (filtered.length ? filtered : glvs)) {
    emit?.({ id: `glv-${g.glvToken.slice(0, 8)}`, kind: "glv_vault", title: g.name, state: "done",
      rationale: `$${(g.totalUsd / 1e6).toFixed(1)}M across ${g.markets.length} GM pools`, data: g });
  }
}
