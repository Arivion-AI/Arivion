import { describe, expect, test } from "vitest";
import { sma, ema, rsi, macd, atr, realizedVol, returnOver, maxDrawdown, sharpeLike } from "../src/analysis/indicators.js";

// Pure technical-indicator math — deterministic, no I/O.

describe("sma / ema", () => {
  test("sma of last period", () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([2, 4, 6], 2)).toBe(5); // (4+6)/2
  });
  test("too few values → null", () => {
    expect(sma([1, 2], 3)).toBeNull();
    expect(ema([1, 2], 3)).toBeNull();
  });
  test("ema of a flat series equals the level", () => {
    expect(ema([7, 7, 7, 7, 7, 7], 3)).toBeCloseTo(7, 6);
  });
});

describe("rsi", () => {
  test("a monotonically rising series → 100", () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(up, 14)).toBe(100);
  });
  test("a monotonically falling series → near 0", () => {
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(down, 14)).toBeCloseTo(0, 5);
  });
  test("too few values → null", () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });
});

describe("macd", () => {
  test("rising series → positive MACD line (fast EMA above slow), falling → negative", () => {
    // A steady linear ramp drives the histogram to ~0 (the EMAs settle to a constant gap), but the
    // MACD line itself carries the trend: fast EMA > slow EMA on the way up.
    const up = Array.from({ length: 60 }, (_, i) => 100 + i);
    const down = Array.from({ length: 60 }, (_, i) => 160 - i);
    expect(macd(up)!.macd).toBeGreaterThan(0);
    expect(macd(down)!.macd).toBeLessThan(0);
  });
  test("an accelerating uptrend → positive histogram", () => {
    const accel = Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.1);
    expect(macd(accel)!.hist).toBeGreaterThan(0);
  });
  test("too few values → null", () => {
    expect(macd([1, 2, 3, 4, 5])).toBeNull();
  });
});

describe("atr / vol / returns / drawdown / sharpe", () => {
  test("atr of a constant-range series", () => {
    const n = 20;
    const highs = Array.from({ length: n }, () => 11);
    const lows = Array.from({ length: n }, () => 9);
    const closes = Array.from({ length: n }, () => 10);
    expect(atr(highs, lows, closes, 14)).toBeCloseTo(2, 6); // TR = high-low = 2 each bar
  });
  test("realizedVol of a flat series is 0", () => {
    expect(realizedVol([5, 5, 5, 5, 5])).toBe(0);
  });
  test("returnOver computes pct over n bars", () => {
    expect(returnOver([100, 110, 120, 130], 3)).toBeCloseTo(0.3, 6);
    expect(returnOver([100], 3)).toBeNull();
  });
  test("maxDrawdown is the worst peak-to-trough", () => {
    expect(maxDrawdown([100, 120, 60, 90])!).toBeCloseTo(-0.5, 6); // 120 → 60
  });
  test("sharpeLike of a flat series is 0", () => {
    expect(sharpeLike([10, 10, 10, 10])).toBe(0);
  });
});
