import { backtestLp } from "./backtest.js";
import type { PoolDepth } from "../uniswap/poolDepth.js";

// L3 — RANGE OPTIMIZER. Sweeps concentrated-band widths (via target time-in-range) and, for each, runs
// the honest LP backtest on the pool's real price path, then scores the band by NET APR =
// fee APR − annualized IL drag − annualized gas. Picks the width that maximizes net APR, biased by the
// user's involvement (set-and-forget penalizes rebalance churn → wider bands; active tolerates tighter).
// Returns the optimal band + the full net-APR-vs-width curve for the lp_range_opt widget.

export interface RangePoint {
  targetTimeInRange: number;   // the sweep knob (wider band ⇒ higher TIR)
  bandHalfWidthPct: number;    // resulting ± band half-width
  feeAprPct: number;
  ilAnnualPct: number;         // IL drag annualized
  gasAnnualPct: number;
  netAprPct: number;
  timeInRangePct: number;
  rebalances: number;
}

export interface RangeOptimization {
  symbol: string;
  best: RangePoint | null;
  curve: RangePoint[];
  involvement: "active" | "weekly" | "set_and_forget";
  rationale: string;
}

export interface OptimizeInput {
  symbol: string;
  closes: number[];
  grossFeeAprPct: number;
  positionUsd?: number;
  gasPerRebalanceUsd?: number;
  activeLiquidityUsd?: number;
  poolDepth?: PoolDepth;     // L1b — true tick-level fee-share when supplied
  tvlUsd?: number;
  horizonDays?: number;
  involvement?: "active" | "weekly" | "set_and_forget";
}

const TIR_SWEEP = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

export function optimizeRange(input: OptimizeInput): RangeOptimization {
  const bars = input.closes.filter((x) => Number.isFinite(x) && x > 0).length;
  const involvement = input.involvement ?? "weekly";
  // Rebalancing churn penalty per involvement — set-and-forget hates frequent re-centering.
  const churnPenalty = involvement === "set_and_forget" ? 1.0 : involvement === "weekly" ? 0.4 : 0.1;

  const curve: RangePoint[] = [];
  for (const tir of TIR_SWEEP) {
    const r = backtestLp({
      symbol: input.symbol, closes: input.closes, grossFeeAprPct: input.grossFeeAprPct,
      positionUsd: input.positionUsd, gasPerRebalanceUsd: input.gasPerRebalanceUsd,
      activeLiquidityUsd: input.activeLiquidityUsd, poolDepth: input.poolDepth, tvlUsd: input.tvlUsd,
      targetTimeInRange: tir, horizonDays: input.horizonDays,
    });
    if (r.error || bars < 10) continue;
    const ann = bars > 0 ? 365 / bars : 1;
    const ilAnnual = r.il_drag_pct * ann;
    const gasAnnual = (r.gas_paid_usd / (input.positionUsd ?? 5000)) * 100 * ann;
    const churnAnnual = r.rebalances * ann * churnPenalty * 0.01 * 100; // small per-rebalance friction
    const netApr = r.fee_apr_pct - ilAnnual - gasAnnual - churnAnnual;
    // Recover the band half-width the backtest used (suggestBand is deterministic from vol+horizon+tir).
    curve.push({
      targetTimeInRange: tir,
      bandHalfWidthPct: bandHalfFromResult(r),
      feeAprPct: Number(r.fee_apr_pct.toFixed(2)),
      ilAnnualPct: Number(ilAnnual.toFixed(2)),
      gasAnnualPct: Number(gasAnnual.toFixed(3)),
      netAprPct: Number(netApr.toFixed(2)),
      timeInRangePct: Number(r.time_in_range_pct.toFixed(0)),
      rebalances: r.rebalances,
    });
  }
  curve.sort((a, b) => a.targetTimeInRange - b.targetTimeInRange);
  const best = curve.length ? [...curve].sort((a, b) => b.netAprPct - a.netAprPct)[0] : null;
  return {
    symbol: input.symbol, best, curve, involvement,
    rationale: best
      ? `Best net APR ${best.netAprPct.toFixed(1)}% at ±${best.bandHalfWidthPct.toFixed(1)}% band (${best.timeInRangePct}% in-range, ${best.rebalances} rebalances) for ${involvement} involvement: ${best.feeAprPct.toFixed(1)}% fees − ${best.ilAnnualPct.toFixed(1)}% IL − costs.`
      : "Insufficient price history to optimize a range.",
  };
}

// The backtest encodes its band in the truth-card assumptions ("band ±X%"); parse it back so the curve
// can report the half-width without re-deriving suggestBand here.
function bandHalfFromResult(r: { truth: Record<string, unknown> }): number {
  const a = String(r.truth.assumptions ?? "");
  const m = a.match(/band ±([\d.]+)%/);
  return m ? Number(m[1]) : 0;
}
