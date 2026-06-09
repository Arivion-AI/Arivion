import { amountsForLiquidity, capitalEfficiency, suggestBand } from "../uniswap/clmm.js";
import { concentratedFeeMultiplier, type PoolDepth } from "../uniswap/poolDepth.js";
import { realizedVol, sharpeLike, maxDrawdown } from "../../analysis/indicators.js";

// Ceiling on the concentrated-fee premium vs the pool's blended APR (see fee-model note below). A real
// retail concentrated position out-earns the blended pool by single-digit×, not 40×. Bounded pending
// tick-level liquidity-share math (L1b). Conservative-but-honest.
const MAX_FEE_CONCENTRATION = 8;

// LP BACKTESTER — historical-replay simulation of a concentrated-liquidity position (the lp_backtest
// widget). HONEST by construction: this is a SIM, not a verified execution. It models, day by day:
//   • the LP mark (token amounts re-valued along the v3 curve → captures impermanent loss directly),
//   • fee accrual = pool fee rate × capital-efficiency while IN RANGE (0 when out),
//   • re-centering when price exits the band, charging gas each time,
// and reports both the standard metric block (return/Sharpe/maxDD) AND LP-specific honesty fields
// (fee APR, IL drag, time-in-range, rebalances) plus a Truth Card the UI surfaces verbatim.

export interface LpBacktestResult {
  symbol: string;
  bars: number;
  window: string;
  metrics: { total_return: number; sharpe: number; max_drawdown: number };
  fee_apr_pct: number;
  il_drag_pct: number;          // cumulative IL as a % drag over the window (≥ 0)
  time_in_range_pct: number;
  rebalances: number;
  gas_paid_usd: number;
  equity_curve: number[];
  truth: Record<string, unknown>;
  rationale: string;
  error?: string;
}

export interface LpBacktestInput {
  symbol: string;
  closes: number[];             // daily closes, oldest→newest
  grossFeeAprPct: number;       // pool's annualized fee APR (from discover / pool history)
  positionUsd?: number;
  gasPerRebalanceUsd?: number;
  targetTimeInRange?: number;
  horizonDays?: number;
  activeLiquidityUsd?: number;  // L1: pool's active-range liquidity (from poolDepth) → fee-share dilution
  poolDepth?: PoolDepth;        // L1b: full raw pool state → TRUE tick-level liquidity-share fee model
  tvlUsd?: number;              // L1b: pool TVL (for the true fee-share annualization)
}

export function backtestLp(input: LpBacktestInput): LpBacktestResult {
  const { symbol } = input;
  const closes = input.closes.filter((x) => Number.isFinite(x) && x > 0);
  const positionUsd = input.positionUsd ?? 5000;
  const gasPerRebalance = input.gasPerRebalanceUsd ?? 0.5;
  if (closes.length < 10) {
    return emptyResult(symbol, "insufficient price history (<10 bars)");
  }

  const volDaily = realizedVol(closes) ?? 0.03;
  const band = suggestBand(volDaily, input.horizonDays ?? 30, input.targetTimeInRange ?? 0.8);
  const dailyFeeRate = input.grossFeeAprPct / 100 / 365;

  // Re-center state. The band is multiplicative bounds [center*lower, center*upper]; L is fixed within
  // a centering. We track the LP value in QUOTE units, normalized to start at 1.
  let center = closes[0];
  let pa = center * band.lower, pb = center * band.upper;
  let L = 1;
  // Initial deposit value at center (in quote units).
  const a0 = amountsForLiquidity(center, pa, pb, L);
  let depositValue = a0.x * center + a0.y;
  const eff = capitalEfficiency(band.lower, band.upper);
  // FEE MODEL. The pool's grossFeeAprPct is the BLENDED APR (already earned by mostly-concentrated
  // liquidity), so naively multiplying by the full vs-full-range efficiency `eff` (40×+ for tight bands)
  // badly overstates fees.
  // • L1b (preferred): when full raw pool state is supplied, use the RIGOROUS tick-level liquidity-share
  //   model — my fees = poolFees × Lmine/(poolL+Lmine). This is unit-correct and already includes
  //   dilution, so no cap and no separate dilution factor are needed.
  // • L1 fallback: bound the concentration premium to a realistic ceiling and apply a saturating
  //   dilution factor against the active-range liquidity. Marked an estimate.
  const trueFee = input.poolDepth && input.tvlUsd
    ? concentratedFeeMultiplier(input.poolDepth, positionUsd, band.lower, band.upper, input.grossFeeAprPct, input.tvlUsd)
    : null;
  let feeMult: number, dilution: number, feeModel: string;
  if (trueFee) {
    feeMult = trueFee.feeMultiplier; dilution = 1; feeModel = "tick_liquidity_share";
  } else {
    feeMult = Math.min(eff, MAX_FEE_CONCENTRATION);
    const effValue = positionUsd * feeMult;
    dilution = input.activeLiquidityUsd && input.activeLiquidityUsd > 0 ? input.activeLiquidityUsd / (input.activeLiquidityUsd + effValue) : 1;
    feeModel = "bounded_estimate";
  }

  let fees = 0, gasPaid = 0, rebalances = 0, inRangeBars = 0;
  const equity: number[] = [];
  let holdValue0 = depositValue; // value if we'd just held the initial token mix (for IL drag)
  const a0hold = { x: a0.x, y: a0.y };

  for (let t = 0; t < closes.length; t++) {
    const P = closes[t];
    const inRange = P >= pa && P <= pb;
    if (inRange) {
      inRangeBars++;
      fees += depositValue * dailyFeeRate * feeMult * dilution; // bounded concentration × pool-share dilution
    } else {
      // Price left the band → re-center around current price, pay gas, reset L to keep capital constant.
      const a = amountsForLiquidity(P, pa, pb, L);
      depositValue = a.x * P + a.y;             // realize the (now single-sided) position value
      center = P; pa = center * band.lower; pb = center * band.upper;
      const an = amountsForLiquidity(center, pa, pb, 1);
      const unit = an.x * center + an.y;
      L = unit > 0 ? depositValue / unit : L;
      gasPaid += gasPerRebalance;
      rebalances++;
    }
    // Mark the LP position at P along the curve + accumulated fees, minus gas (as fraction of position).
    const aMark = amountsForLiquidity(P, pa, pb, L);
    const lpMark = aMark.x * P + aMark.y;
    const gasDrag = (gasPaid / positionUsd) * depositValue;
    const eq = (lpMark + fees - gasDrag) / depositValueAt0(a0hold, closes[0]);
    equity.push(eq);
  }

  // IL drag: compare final LP value (ex-fees) vs simply holding the initial token mix to the end.
  const Pend = closes[closes.length - 1];
  const holdValueEnd = a0hold.x * Pend + a0hold.y;
  const lpEnd = lastLpValue(equity, fees, depositValueAt0(a0hold, closes[0]));
  const ilDrag = holdValue0 > 0 ? Math.max(0, (holdValueEnd - lpEnd) / holdValueEnd) * 100 : 0;

  const fin = (v: number | null | undefined): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const totalReturn = fin(equity[equity.length - 1] - 1);
  const sharpe = fin(sharpeLike(equity));
  const mdd = fin(maxDrawdown(equity));
  const tir = inRangeBars / closes.length;
  const feeAprRealized = (fees / depositValueAt0(a0hold, closes[0])) / closes.length * 365 * 100;

  return {
    symbol, bars: closes.length, window: `${closes.length}d`,
    metrics: { total_return: totalReturn, sharpe, max_drawdown: mdd },
    fee_apr_pct: feeAprRealized,
    il_drag_pct: ilDrag,
    time_in_range_pct: tir * 100,
    rebalances, gas_paid_usd: gasPaid,
    equity_curve: sample(equity, 64),
    truth: {
      result_tier: "LOCAL_SIM",
      execution_fidelity: "historical_replay",
      data_source: "bybit_klines (price path) + pool fee APR (estimate)",
      models: trueFee
        ? "concentrated-liquidity IL (exact v3), fee accrual (EXACT tick-level liquidity-share: poolFees × Lmine/(poolL+Lmine)), gas (assumed)"
        : "concentrated-liquidity IL (exact v3), fee accrual (bounded concentration × pool-share dilution; UPPER-ISH estimate, no tick-level pool state), gas (assumed)",
      can_execute_real_money: false,
      fee_model: feeModel,
      fee_concentration_mult: Number(feeMult.toFixed(2)) + (!trueFee && eff > MAX_FEE_CONCENTRATION ? ` (capped from ${eff.toFixed(0)}×)` : "×"),
      fee_share: trueFee ? Number(trueFee.share.toFixed(6)) : (input.activeLiquidityUsd && input.activeLiquidityUsd > 0 ? `dilution ${dilution.toFixed(3)}` : "n/a"),
      assumptions: `band ±${(((band.upper - 1) - (band.lower - 1)) / 2 * 100).toFixed(1)}%, gas $${gasPerRebalance}/rebalance, position $${positionUsd}${input.activeLiquidityUsd ? `, active-liq $${Math.round(input.activeLiquidityUsd).toLocaleString()}` : ""}`,
    },
    rationale: `LP sim over ${closes.length}d: ${totalReturn >= 0 ? "+" : ""}${(totalReturn * 100).toFixed(1)}% · fee APR ~${feeAprRealized.toFixed(1)}% · IL drag ${ilDrag.toFixed(1)}% · ${(tir * 100).toFixed(0)}% in-range · ${rebalances} rebalances.`,
  };
}

function depositValueAt0(a0: { x: number; y: number }, P0: number): number { return a0.x * P0 + a0.y; }
function lastLpValue(equity: number[], fees: number, deposit0: number): number {
  const eqEnd = equity[equity.length - 1] ?? 1;
  return eqEnd * deposit0 - fees; // back out fees to isolate the position mark
}
function sample(a: number[], n: number): number[] {
  if (a.length <= n) return a;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(a[Math.floor((i / (n - 1)) * (a.length - 1))]);
  return out;
}
function emptyResult(symbol: string, error: string): LpBacktestResult {
  return { symbol, bars: 0, window: "—", metrics: { total_return: Number.NaN, sharpe: Number.NaN, max_drawdown: Number.NaN }, fee_apr_pct: Number.NaN, il_drag_pct: Number.NaN, time_in_range_pct: Number.NaN, rebalances: 0, gas_paid_usd: 0, equity_curve: [], truth: { result_tier: "LOCAL_SIM", error }, rationale: error, error };
}
