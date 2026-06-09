// Phase 29 — PURE multi-factor scoring. Turns each token's raw metrics (from the live ticker + the
// computed indicators) into cross-sectional 0..1 factor scores, then a risk-weighted composite, then a
// ranking with a human-readable rationale. No I/O — unit-tested in test/factors.unit.test.ts.
//
// Grounded in the crypto factor literature (momentum is the strongest single factor; plus
// liquidity/size, volatility/risk-adjusted return, carry/funding, trend, sentiment). Factors are
// rank-normalized ACROSS the candidate set so "0.9 momentum" means "top decile vs its peers right now",
// not an absolute — the honest way to compare a live universe.

export type RiskAppetite = "conservative" | "moderate" | "aggressive";
// Selection style — the user picks this (the agent asks). "momentum" chases movers; "quality" favors
// trend/risk-adjusted/liquidity/low-vol and treats momentum as just one factor; "balanced" is between.
export type SelectionStyle = "quality" | "balanced" | "momentum";

// Raw per-token metrics the engine assembles before scoring.
export interface TokenRaw {
  symbol: string;
  base: string;
  last: number;
  pct24h: number;
  turnover24h: number;
  range24h: number;
  funding: number | null; // perp funding rate (null for spot/equity)
  oiValue: number | null; // open-interest notional (null for spot/equity)
  ret7d: number | null;
  ret30d: number | null;
  sma20: number | null;
  sma50: number | null;
  rsi: number | null;
  macdHist: number | null;
  realizedVol: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  sentiment: number | null; // -1..1, folded in after the news pass (null = unknown)
  regime?: string;
}

// The eight factor keys (each 0..1, higher = more attractive for a long-side investment).
export interface FactorScores {
  momentum: number;
  trend: number;
  rsi_health: number;
  liquidity: number;
  low_vol: number; // calmer = higher
  risk_adj: number; // Sharpe-like, higher = better return per unit risk
  carry: number; // favorable/cheap funding = higher
  sentiment: number;
}

export interface ScoredToken {
  symbol: string;
  base: string;
  rank: number;
  composite: number;
  factors: FactorScores;
  raw: TokenRaw;
  rationale: string;
}

// Cross-sectional percentile rank in 0..1 (ties get the average rank). null/non-finite → neutral 0.5.
export function rankNormalize(values: Array<number | null>): number[] {
  const out = values.map(() => 0.5);
  const present = values
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v != null && Number.isFinite(x.v)) as Array<{ v: number; i: number }>;
  const n = present.length;
  if (n <= 1) return out;
  const sorted = present.slice().sort((a, b) => a.v - b.v);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].v === sorted[i].v) j++;
    const avgRank = (i + j) / 2;
    for (let k = i; k <= j; k++) out[sorted[k].i] = avgRank / (n - 1);
    i = j + 1;
  }
  return out;
}

function normalize(w: Record<keyof FactorScores, number>): Record<keyof FactorScores, number> {
  const sum = (Object.values(w) as number[]).reduce((s, x) => s + x, 0) || 1;
  const out = {} as Record<keyof FactorScores, number>;
  for (const k of Object.keys(w) as Array<keyof FactorScores>) out[k] = Number((w[k] / sum).toFixed(4));
  return out;
}

// Factor weights per risk appetite (base = "balanced" style), each summing to ~1. Conservative leans on
// liquidity + calm + trend; aggressive leans more on momentum; moderate is balanced.
function baseWeights(risk: RiskAppetite): Record<keyof FactorScores, number> {
  if (risk === "conservative") {
    return { liquidity: 0.24, low_vol: 0.22, trend: 0.16, risk_adj: 0.14, momentum: 0.08, rsi_health: 0.08, sentiment: 0.06, carry: 0.02 };
  }
  if (risk === "aggressive") {
    return { momentum: 0.32, trend: 0.18, risk_adj: 0.10, rsi_health: 0.08, sentiment: 0.12, liquidity: 0.08, carry: 0.08, low_vol: 0.04 };
  }
  return { momentum: 0.22, trend: 0.16, risk_adj: 0.14, liquidity: 0.14, low_vol: 0.12, rsi_health: 0.08, sentiment: 0.08, carry: 0.06 };
}

// Apply the selection STYLE on top of the risk base. "quality" demotes raw momentum and promotes
// trend/risk-adjusted/low-vol/liquidity (buy durable strength, not parabolas); "momentum" does the
// reverse; "balanced" leaves the risk base. Re-normalized to sum to 1.
export function weightsFor(risk: RiskAppetite, style: SelectionStyle = "balanced"): Record<keyof FactorScores, number> {
  const w = { ...baseWeights(risk) };
  if (style === "quality") {
    w.momentum *= 0.4; w.rsi_health *= 1.4; w.trend *= 1.4; w.risk_adj *= 1.5; w.low_vol *= 1.4; w.liquidity *= 1.3;
  } else if (style === "momentum") {
    w.momentum *= 1.7; w.trend *= 1.2; w.low_vol *= 0.5; w.risk_adj *= 0.8;
  }
  return normalize(w);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// Score + rank a whole candidate set. Returns tokens sorted by composite (desc) with rank assigned.
export function rankCandidates(raws: TokenRaw[], risk: RiskAppetite, style: SelectionStyle = "balanced"): ScoredToken[] {
  if (!raws.length) return [];
  const w = weightsFor(risk, style);

  // --- assemble the raw signal arrays (one per factor), then rank-normalize each across the set ---
  const momRaw = raws.map((r) => 0.5 * (r.ret30d ?? 0) + 0.3 * (r.ret7d ?? 0) + 0.2 * (r.pct24h / 100));
  const trendRaw = raws.map((r) => {
    let s = 0;
    if (r.sma20 && r.last > 0) s += (r.last - r.sma20) / r.sma20;
    if (r.sma20 && r.sma50) s += (r.sma20 - r.sma50) / r.sma50;
    if (r.macdHist != null && r.last > 0) s += r.macdHist / r.last;
    return s;
  });
  // RSI "health": closest to ~58 is healthiest (trending, not yet overbought); distance penalized.
  const rsiRaw = raws.map((r) => -Math.abs((r.rsi ?? 50) - 58));
  const liqRaw = raws.map((r) => Math.log10(Math.max(1, r.turnover24h)));
  const lowVolRaw = raws.map((r) => (r.realizedVol != null ? -r.realizedVol : null));
  const riskAdjRaw = raws.map((r) => r.sharpe);
  const carryRaw = raws.map((r) => (r.funding != null ? -r.funding : null)); // cheap/negative funding favors longs

  const mom = rankNormalize(momRaw);
  const trend = rankNormalize(trendRaw);
  const rsiH = rankNormalize(rsiRaw);
  const liq = rankNormalize(liqRaw);
  const lowVol = rankNormalize(lowVolRaw);
  const riskAdj = rankNormalize(riskAdjRaw);
  const carry = rankNormalize(carryRaw);

  const scored: ScoredToken[] = raws.map((r, i) => {
    const factors: FactorScores = {
      momentum: round(mom[i]),
      trend: round(trend[i]),
      rsi_health: round(rsiH[i]),
      liquidity: round(liq[i]),
      low_vol: round(lowVol[i]),
      risk_adj: round(riskAdj[i]),
      carry: round(carry[i]),
      sentiment: round(r.sentiment != null ? (clamp(r.sentiment, -1, 1) + 1) / 2 : 0.5),
    };
    const composite = round(
      (Object.keys(factors) as Array<keyof FactorScores>).reduce((s, k) => s + (w[k] ?? 0) * factors[k], 0),
    );
    return { symbol: r.symbol, base: r.base, rank: 0, composite, factors, raw: r, rationale: rationaleFor(r, factors) };
  });

  scored.sort((a, b) => b.composite - a.composite);
  scored.forEach((s, i) => (s.rank = i + 1));
  return scored;
}

function round(x: number): number {
  return Number(x.toFixed(3));
}

// Build a short, honest "why it ranks here" line from the strongest factors + the raw numbers.
function rationaleFor(r: TokenRaw, f: FactorScores): string {
  const parts: string[] = [];
  if (f.momentum >= 0.66 && (r.ret30d != null || r.ret7d != null)) {
    const m = r.ret30d ?? r.ret7d ?? 0;
    parts.push(`strong momentum (${(m * 100).toFixed(0)}% over ${r.ret30d != null ? "30d" : "7d"})`);
  } else if (f.momentum <= 0.34) {
    parts.push("weak/negative momentum");
  }
  if (f.trend >= 0.66) parts.push("uptrend (price above SMA20/50)");
  else if (f.trend <= 0.34) parts.push("below trend");
  if (r.rsi != null) {
    if (r.rsi >= 80) parts.push(`overbought RSI ${r.rsi.toFixed(0)}`);
    else if (r.rsi <= 25) parts.push(`oversold RSI ${r.rsi.toFixed(0)}`);
    else if (f.rsi_health >= 0.66) parts.push(`healthy RSI ${r.rsi.toFixed(0)}`);
  }
  if (f.liquidity >= 0.66) parts.push("deep liquidity");
  else if (f.liquidity <= 0.34) parts.push("thin liquidity");
  if (f.low_vol >= 0.66) parts.push("calm volatility");
  else if (f.low_vol <= 0.2) parts.push("high volatility");
  if (r.funding != null && Math.abs(r.funding) > 0.0005) {
    parts.push(`${r.funding > 0 ? "crowded longs" : "negative"} funding ${(r.funding * 100).toFixed(3)}%`);
  }
  if (r.sentiment != null) {
    if (r.sentiment >= 0.3) parts.push("positive news flow");
    else if (r.sentiment <= -0.3) parts.push("negative news flow");
  }
  return parts.length ? parts.join(", ") + "." : "balanced across factors.";
}
