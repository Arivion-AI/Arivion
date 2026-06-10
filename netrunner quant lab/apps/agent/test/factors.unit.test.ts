import { describe, expect, test } from "vitest";
import { rankNormalize, weightsFor, rankCandidates, type TokenRaw } from "../src/analysis/factors.js";

// Pure factor scoring — cross-sectional rank-normalization + risk-weighted composite. No I/O.

describe("rankNormalize", () => {
  test("maps ascending values to 0..1 percentile", () => {
    expect(rankNormalize([10, 20, 30])).toEqual([0, 0.5, 1]);
  });
  test("is monotonic regardless of order", () => {
    const out = rankNormalize([30, 10, 20]);
    expect(out[1]).toBeLessThan(out[2]); // 10 < 20
    expect(out[2]).toBeLessThan(out[0]); // 20 < 30
  });
  test("nulls become neutral 0.5; single value neutral", () => {
    expect(rankNormalize([null, 5, null])[0]).toBe(0.5);
    expect(rankNormalize([42])).toEqual([0.5]);
  });
  test("ties share the average rank", () => {
    expect(rankNormalize([5, 5, 5])).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("weightsFor", () => {
  test("each risk profile's weights sum to ~1", () => {
    for (const r of ["conservative", "moderate", "aggressive"] as const) {
      const sum = Object.values(weightsFor(r)).reduce((s, w) => s + w, 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });
  test("aggressive weights momentum more than conservative does", () => {
    expect(weightsFor("aggressive").momentum).toBeGreaterThan(weightsFor("conservative").momentum);
    expect(weightsFor("conservative").liquidity).toBeGreaterThan(weightsFor("aggressive").liquidity);
  });
  test("selection style re-weights: quality demotes momentum, momentum promotes it", () => {
    for (const r of ["conservative", "moderate", "aggressive"] as const) {
      expect(weightsFor(r, "quality").momentum).toBeLessThan(weightsFor(r, "balanced").momentum);
      expect(weightsFor(r, "momentum").momentum).toBeGreaterThan(weightsFor(r, "balanced").momentum);
      // quality leans more on durable factors than momentum style does
      expect(weightsFor(r, "quality").risk_adj).toBeGreaterThan(weightsFor(r, "momentum").risk_adj);
      // still a valid distribution (per-weight rounding allows tiny drift)
      expect(Object.values(weightsFor(r, "quality")).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 2);
    }
  });
});

function raw(over: Partial<TokenRaw>): TokenRaw {
  return {
    symbol: "X", base: "X", last: 100, pct24h: 0, turnover24h: 10_000_000, range24h: 0.03,
    funding: 0, oiValue: 1_000_000, ret7d: 0, ret30d: 0, sma20: 100, sma50: 100, rsi: 50,
    macdHist: 0, realizedVol: 0.02, sharpe: 0, maxDrawdown: -0.1, sentiment: null,
    ...over,
  };
}

describe("rankCandidates", () => {
  test("ranks the high-momentum, liquid, uptrending token first (aggressive)", () => {
    const tokens: TokenRaw[] = [
      raw({ symbol: "WINNER", base: "WIN", ret30d: 0.8, ret7d: 0.3, pct24h: 12, turnover24h: 5e8, sma20: 110, sma50: 90, rsi: 60, macdHist: 2, sharpe: 0.5 }),
      raw({ symbol: "LOSER", base: "LOS", ret30d: -0.5, ret7d: -0.2, pct24h: -8, turnover24h: 6e6, sma20: 90, sma50: 110, rsi: 30, macdHist: -2, sharpe: -0.4 }),
      raw({ symbol: "MID", base: "MID", ret30d: 0.05, ret7d: 0.01, pct24h: 1, turnover24h: 5e7, sma20: 101, sma50: 100, rsi: 52, macdHist: 0.1, sharpe: 0.05 }),
    ];
    const ranked = rankCandidates(tokens, "aggressive");
    expect(ranked[0].symbol).toBe("WINNER");
    expect(ranked[ranked.length - 1].symbol).toBe("LOSER");
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    // composite is bounded and the breakdown is populated
    expect(ranked[0].composite).toBeGreaterThan(0);
    expect(ranked[0].composite).toBeLessThanOrEqual(1);
    expect(ranked[0].factors.momentum).toBeGreaterThan(ranked[2].factors.momentum);
    expect(ranked[0].rationale.length).toBeGreaterThan(0);
  });

  test("risk appetite re-orders the ranking", () => {
    // A calm, ultra-liquid major vs a hot, thin, volatile mover.
    const tokens: TokenRaw[] = [
      raw({ symbol: "MAJOR", base: "MAJ", ret30d: 0.05, ret7d: 0.01, pct24h: 1, turnover24h: 2e9, sma20: 101, sma50: 100, rsi: 55, realizedVol: 0.01, sharpe: 0.2 }),
      raw({ symbol: "MOVER", base: "MOV", ret30d: 0.9, ret7d: 0.4, pct24h: 20, turnover24h: 6e6, sma20: 130, sma50: 90, rsi: 78, realizedVol: 0.12, sharpe: 0.3 }),
    ];
    const conservative = rankCandidates(tokens, "conservative");
    const aggressive = rankCandidates(tokens, "aggressive");
    expect(conservative[0].symbol).toBe("MAJOR"); // liquidity + calm win
    expect(aggressive[0].symbol).toBe("MOVER"); // momentum wins
  });

  test("style re-orders: quality prefers the steady trender, momentum prefers the parabola", () => {
    const tokens: TokenRaw[] = [
      raw({ symbol: "STEADY", base: "STD", ret30d: 0.25, ret7d: 0.06, pct24h: 2, turnover24h: 4e8, sma20: 108, sma50: 100, rsi: 58, realizedVol: 0.02, sharpe: 0.4, macdHist: 0.5 }),
      raw({ symbol: "PARABOLA", base: "PAR", ret30d: 1.6, ret7d: 0.7, pct24h: 35, turnover24h: 3e7, sma20: 140, sma50: 95, rsi: 88, realizedVol: 0.12, sharpe: 0.35, macdHist: 3 }),
    ];
    expect(rankCandidates(tokens, "moderate", "quality")[0].symbol).toBe("STEADY");
    expect(rankCandidates(tokens, "moderate", "momentum")[0].symbol).toBe("PARABOLA");
  });

  test("empty input → empty output", () => {
    expect(rankCandidates([], "moderate")).toEqual([]);
  });
});
