// Concentrated-liquidity (Uniswap v3) math — PURE + deterministic, so it's unit-testable and any LP
// analysis built on it is reproducible (same discipline as analysis/indicators.ts). No I/O here.
//
// Conventions: prices are token1-per-token0 (the pool's natural price). A position is a band [Pa, Pb].
// We model the canonical v3 results: the value of a unit of liquidity vs price, and the impermanent
// loss of a concentrated LP vs simply holding the two tokens (HODL), as a function of the price move.

export interface IlPoint { priceRatio: number; il: number } // il <= 0 (a loss vs HODL), per unit

/** Geometric helpers. v3 tracks sqrt(price); a band [Pa,Pb] has bounds sa=√Pa, sb=√Pb. */
const sq = (p: number) => Math.sqrt(p);

// Token amounts held by 1 unit of liquidity L at price P within [Pa,Pb] (Uniswap v3 closed forms).
// Returns { x, y } = { token0, token1 } amounts. Outside the band the position is single-sided.
export function amountsForLiquidity(P: number, Pa: number, Pb: number, L = 1): { x: number; y: number } {
  const s = sq(P), sa = sq(Pa), sb = sq(Pb);
  if (P <= Pa) return { x: L * (1 / sa - 1 / sb), y: 0 };          // all token0 below range
  if (P >= Pb) return { x: 0, y: L * (sb - sa) };                  // all token1 above range
  return { x: L * (1 / s - 1 / sb), y: L * (s - sa) };             // mixed in range
}

// Value (in token1 / quote) of a v3 LP position vs a HODL of the same initial deposit, for a price
// path that starts at P0 (in range) and ends at P1. Returns the impermanent loss (≤ 0) as a fraction
// of the initial value. For a full-range position this reduces to the classic v2 IL curve.
export function concentratedIl(P0: number, P1: number, Pa: number, Pb: number): number {
  // Use L=1; compute initial token amounts, value them at P1 as an LP vs as a static hold.
  const a0 = amountsForLiquidity(P0, Pa, Pb, 1);
  const a1 = amountsForLiquidity(P1, Pa, Pb, 1);
  const lpValue = a1.x * P1 + a1.y;                 // LP rebalances along the curve
  const holdValue = a0.x * P1 + a0.y;              // just held the initial mix
  if (holdValue <= 0) return 0;
  return lpValue / holdValue - 1;                  // ≤ 0
}

// IL curve over a range of price ratios r = P1/P0 (for the il_curve widget). band is the LP band as
// multiplicative bounds around P0: [P0*lower, P0*upper] (e.g. lower=0.93, upper=1.07 for ±7%).
export function ilCurve(lower: number, upper: number, ratios: number[] = defaultRatios()): IlPoint[] {
  const P0 = 1, Pa = P0 * lower, Pb = P0 * upper;
  return ratios.map((r) => ({ priceRatio: r, il: concentratedIl(P0, P0 * r, Pa, Pb) }));
}

function defaultRatios(): number[] {
  const out: number[] = [];
  for (let r = 0.5; r <= 1.5001; r += 0.025) out.push(Number(r.toFixed(4)));
  return out;
}

// Fraction of a recent price PATH that stays within the band [P0*lower, P0*upper]. A concentrated LP
// only earns fees while in range — this estimates the duty cycle from a real price series.
export function timeInRange(prices: number[], lower: number, upper: number): number {
  if (prices.length < 2) return 0;
  const P0 = prices[0], lo = P0 * lower, hi = P0 * upper;
  const inRange = prices.filter((p) => p >= lo && p <= hi).length;
  return inRange / prices.length;
}

// Capital-efficiency multiplier of a band [Pa,Pb] around P vs a full-range (v2) position. Tighter
// bands concentrate the same capital into more active liquidity ⇒ proportionally more fees while in
// range. Classic v3 result: efficiency ≈ 1 / (1 - (Pa/P)^(1/4) · ... ) — we use the standard
// 1/(1-√(Pa/Pb)) form relative to the active band.
export function capitalEfficiency(Pa: number, Pb: number): number {
  const ratio = sq(Pa / Pb);
  const denom = 1 - ratio;
  return denom > 1e-9 ? 1 / denom : 1;
}

// Suggest a band (multiplicative lower/upper around spot) that targets a desired time-in-range given a
// per-period realized vol (std of log returns) and a horizon in periods. Wider band = more time in
// range but less fee concentration. Uses a z-score sizing: width ≈ z · vol · √horizon.
export function suggestBand(realizedVolPerPeriod: number, horizonPeriods: number, targetTimeInRange = 0.8): { lower: number; upper: number } {
  // z for a two-sided coverage = targetTimeInRange (e.g. 0.8 ⇒ z≈1.2816 one-sided 0.9).
  const z = invNormOneSided((1 + targetTimeInRange) / 2);
  const sigma = Math.max(1e-6, realizedVolPerPeriod) * Math.sqrt(Math.max(1, horizonPeriods));
  const half = z * sigma;
  return { lower: Math.exp(-half), upper: Math.exp(half) };
}

// Acklam-style inverse normal CDF (one-sided), good enough for band sizing.
function invNormOneSided(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425, ph = 1 - pl;
  let q: number, r: number;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
