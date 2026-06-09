import { sharpeLike, maxDrawdown } from "../../analysis/indicators.js";

// GMX strategy PAPER-SIM templates — the backtestable strategies behind the GMX wizard (G4). Each runs
// a deterministic simulation over a GMX-native OHLCV price path and accrues the dominant real cost of a
// GMX position: FUNDING + BORROWING fees. HONEST: this is a sim (result_tier LOCAL_SIM) and models —
// not guarantees — funding/borrow and a flat taker fee. No price-impact/ADL yet. No execution path.

export interface GmxSimParams {
  leverage?: number;            // 1..N
  emaFast?: number; emaSlow?: number;
  takerFeeBps?: number;         // per side, e.g. 5
  fundingAnnualPct?: number;    // current GMX funding (annualized %); sign: + ⇒ longs pay
  borrowAnnualPct?: number;     // current GMX borrow (annualized %)
  dataSource?: string;          // e.g. gmx_api:BTC/USD [BTC-USDC]:1d
}

export interface GmxSimResult {
  strategy: string;
  bars: number;
  metrics: { total_return: number; sharpe: number; max_drawdown: number };
  trades: number;
  funding_paid_pct: number;     // net funding+borrow as % of equity over the window (signed: − = cost)
  equity_curve: number[];
  truth: Record<string, unknown>;
  rationale: string;
  error?: string;
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1); const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) { prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}

// Directional perp on an EMA-cross signal, leveraged, with daily funding/borrow accrual. Long when
// fast>slow, short when fast<slow (flips cost a taker fee both sides). The position pays funding when
// it's on the side funding charges, and always pays borrow on the leveraged notional.
export function gmxTrendPerp(closes: number[], p: GmxSimParams = {}): GmxSimResult {
  const px = closes.filter((x) => Number.isFinite(x) && x > 0);
  if (px.length < 30) return empty("gmx_trend_perp", "insufficient history (<30 bars)");
  const lev = clamp(p.leverage ?? 2, 1, 20);
  const fast = ema(px, p.emaFast ?? 10), slow = ema(px, p.emaSlow ?? 30);
  const feeRate = (p.takerFeeBps ?? 5) / 10000;
  const fundingDaily = saneFunding(p.fundingAnnualPct) / 100 / 365;
  const borrowDaily = saneBorrow(p.borrowAnnualPct) / 100 / 365;

  let equity = 1, pos = 0, trades = 0, fundingPaid = 0;
  const curve: number[] = [];
  for (let t = 1; t < px.length; t++) {
    const want = fast[t] > slow[t] ? 1 : -1;
    if (want !== pos) { equity -= feeRate * lev; trades++; pos = want; } // flip/enter cost
    const ret = (px[t] - px[t - 1]) / px[t - 1];
    equity *= 1 + pos * ret * lev;
    // funding: longs pay when fundingDaily>0; cost = pos==long? +fundingDaily : -fundingDaily, on notional
    const fundingCost = (pos > 0 ? fundingDaily : -fundingDaily) * lev;
    const borrowCost = borrowDaily * lev;
    equity *= 1 - fundingCost - borrowCost;
    fundingPaid -= (fundingCost + borrowCost);
    curve.push(equity);
  }
  return finalize("gmx_trend_perp", curve, trades, fundingPaid * 100, { leverage: lev, signal: `EMA ${p.emaFast ?? 10}/${p.emaSlow ?? 30}`, dataSource: p.dataSource });
}

// Funding carry: hold the side funding PAYS (no directional EMA view). If funding>0 (longs pay), be
// SHORT to receive it; flip with sign. Earns carry, takes directional risk — leverage amplifies both.
export function gmxFundingCarry(closes: number[], p: GmxSimParams = {}): GmxSimResult {
  const px = closes.filter((x) => Number.isFinite(x) && x > 0);
  if (px.length < 10) return empty("gmx_funding_carry", "insufficient history (<10 bars)");
  const lev = clamp(p.leverage ?? 2, 1, 10);
  const fundingDaily = saneFunding(p.fundingAnnualPct) / 100 / 365;
  const borrowDaily = saneBorrow(p.borrowAnnualPct) / 100 / 365;
  const side = fundingDaily > 0 ? -1 : 1; // receive funding: short if longs pay, long if shorts pay
  let equity = 1, fundingPaid = 0;
  const curve: number[] = [];
  for (let t = 1; t < px.length; t++) {
    const ret = (px[t] - px[t - 1]) / px[t - 1];
    equity *= 1 + side * ret * lev;
    const carry = Math.abs(fundingDaily) * lev;        // received (side chosen to receive funding)
    const borrowCost = borrowDaily * lev;
    equity *= 1 + carry - borrowCost;
    fundingPaid += (carry - borrowCost);
    curve.push(equity);
  }
  return finalize("gmx_funding_carry", curve, 1, fundingPaid * 100, { leverage: lev, side: side > 0 ? "long" : "short", dataSource: p.dataSource });
}

export const GMX_STRATEGIES: Record<string, (closes: number[], p: GmxSimParams) => GmxSimResult> = {
  gmx_trend_perp: gmxTrendPerp,
  gmx_funding_carry: gmxFundingCarry,
};

function fin(v: number | null | undefined): number { return Number.isFinite(v as number) ? (v as number) : 0; }
function finalize(strategy: string, curve: number[], trades: number, fundingPct: number, extra: Record<string, unknown>): GmxSimResult {
  const total = fin((curve[curve.length - 1] ?? 1) - 1);
  const { dataSource, ...truthExtra } = extra;
  return {
    strategy, bars: curve.length,
    metrics: { total_return: total, sharpe: fin(sharpeLike(curve)), max_drawdown: fin(maxDrawdown(curve)) },
    trades, funding_paid_pct: fundingPct, equity_curve: sample(curve, 64),
    truth: {
      result_tier: "LOCAL_SIM", execution_fidelity: "historical_replay",
      data_source: typeof dataSource === "string" && dataSource ? `${dataSource} + GMX funding/borrow (current snapshot)` : "gmx_api_ohlcv + GMX funding/borrow (current snapshot)",
      models: "leverage P&L, funding+borrow accrual, flat taker fee — NO price-impact/ADL",
      can_execute_real_money: false, ...truthExtra,
    },
    rationale: `${strategy} sim: ${total >= 0 ? "+" : ""}${(total * 100).toFixed(1)}% · funding/borrow net ${fundingPct >= 0 ? "+" : ""}${fundingPct.toFixed(1)}% · ${trades} trades.`,
  };
}
function empty(strategy: string, error: string): GmxSimResult {
  return { strategy, bars: 0, metrics: { total_return: Number.NaN, sharpe: Number.NaN, max_drawdown: Number.NaN }, trades: 0, funding_paid_pct: 0, equity_curve: [], truth: { result_tier: "LOCAL_SIM", error }, rationale: error, error };
}
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
// GMX's raw funding/borrow factors don't map cleanly to a per-second rate; until the exact scale is
// pinned, clamp the annualized inputs to a sane band so a misscaled value can't wreck the sim. Funding
// is a secondary cost vs the directional P&L; the clamp keeps it honest (bounded) rather than absurd.
const saneFunding = (annualPct?: number): number => (Number.isFinite(annualPct) ? clamp(annualPct as number, -150, 150) : 0);
const saneBorrow = (annualPct?: number): number => (Number.isFinite(annualPct) ? clamp(annualPct as number, 0, 150) : 10);
function sample(a: number[], n: number): number[] { if (a.length <= n) return a; const o: number[] = []; for (let i = 0; i < n; i++) o.push(a[Math.floor((i / (n - 1)) * (a.length - 1))]); return o; }
