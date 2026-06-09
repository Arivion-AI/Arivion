// Phase 29 — PURE technical-indicator math for the multi-factor token analysis engine. No I/O, no
// deps: every function takes plain number[] (oldest→newest) and returns a number (or null when there
// is not enough data). Unit-tested in test/indicators.unit.test.ts. These are the building blocks the
// factor scorer (factors.ts) turns into cross-sectional 0..1 scores.

// Simple moving average over the last `period` values (null if too few).
export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

// Exponential moving average over the whole series, returning the final value (null if too few).
export function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values, then roll forward.
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  for (let i = period; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}

// Full EMA series (aligned to input length; leading values before the seed are null).
function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = values.map(() => null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI over `period` (default 14). Returns 0..100, or null if too few values.
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// MACD line, signal line, and histogram (fast 12 / slow 26 / signal 9). null if too few values.
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: number; signal: number; hist: number } | null {
  if (closes.length < slow + signal) return null;
  const fastS = emaSeries(closes, fast);
  const slowS = emaSeries(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastS[i] == null || slowS[i] == null) continue;
    macdLine.push((fastS[i] as number) - (slowS[i] as number));
  }
  const sig = ema(macdLine, signal);
  if (sig == null) return null;
  const macdVal = macdLine[macdLine.length - 1];
  return { macd: macdVal, signal: sig, hist: macdVal - sig };
}

// Average True Range over `period` (default 14). null if too few bars.
export function atr(highs: number[], lows: number[], closes: number[], period = 14): number | null {
  const n = Math.min(highs.length, lows.length, closes.length);
  if (n < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trs.push(tr);
  }
  // Wilder smoothing.
  let prev = 0;
  for (let i = 0; i < period; i++) prev += trs[i];
  prev /= period;
  for (let i = period; i < trs.length; i++) prev = (prev * (period - 1) + trs[i]) / period;
  return prev;
}

// Standard deviation of log returns (per-bar realized volatility). null if too few values.
export function realizedVol(closes: number[]): number | null {
  if (closes.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

// Percent return over the last `n` bars (e.g. n=7 on daily closes ≈ 7-day return). null if too few.
export function returnOver(closes: number[], n: number): number | null {
  if (n <= 0 || closes.length < n + 1) return null;
  const a = closes[closes.length - 1 - n];
  const b = closes[closes.length - 1];
  if (!(a > 0)) return null;
  return (b - a) / a;
}

// Max peak-to-trough drawdown over the series (negative fraction, e.g. -0.32). null if empty.
export function maxDrawdown(closes: number[]): number | null {
  if (!closes.length) return null;
  let peak = closes[0];
  let mdd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    if (peak > 0) mdd = Math.min(mdd, (c - peak) / peak);
  }
  return mdd;
}

// Per-bar mean/std of simple returns (a Sharpe-like ratio, NOT annualized). null if too few.
export function sharpeLike(closes: number[]): number | null {
  if (closes.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return mean / sd;
}
