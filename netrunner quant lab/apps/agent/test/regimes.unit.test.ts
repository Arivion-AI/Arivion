import { describe, expect, test } from "vitest";
import { detectRegimes, aggregateReturns } from "../src/analysis/regimes.js";

const days = (closes: number[]) => closes.map((_, i) => i * 86_400_000);

describe("detectRegimes", () => {
  test("splits a clear up-then-down series into a bull then a bear season", () => {
    const closes = [100, 110, 120, 130, 140, 150, 140, 120, 100, 90];
    const segs = detectRegimes(closes, days(closes), 0.2);
    expect(segs.length).toBe(2);
    expect(segs[0].type).toBe("bull");
    expect(segs[0].return).toBeCloseTo(0.5, 6); // 100 → 150
    expect(segs[1].type).toBe("bear");
    expect(segs[1].return).toBeCloseTo(-0.4, 6); // 150 → 90
  });

  test("a monotonic uptrend is a single bull season", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 5);
    const segs = detectRegimes(closes, days(closes), 0.2);
    expect(segs.length).toBe(1);
    expect(segs[0].type).toBe("bull");
  });

  test("sub-threshold wiggles do not create seasons", () => {
    const closes = [100, 105, 98, 103, 99, 104, 100]; // all moves < 20%
    const segs = detectRegimes(closes, days(closes), 0.2);
    expect(segs.length).toBeLessThanOrEqual(1);
  });

  test("captures multiple cycles", () => {
    const closes = [100, 150, 100, 160, 90]; // up, down, up, down — each ≥20%
    const segs = detectRegimes(closes, days(closes), 0.2);
    expect(segs.map((s) => s.type)).toEqual(["bull", "bear", "bull", "bear"]);
  });

  test("guards against bad input", () => {
    expect(detectRegimes([], [], 0.2)).toEqual([]);
    expect(detectRegimes([100], [0], 0.2)).toEqual([]);
  });
});

describe("aggregateReturns", () => {
  test("computes mean, compounded, win-rate, best/worst", () => {
    const a = aggregateReturns([0.1, -0.05, 0.2]);
    expect(a.n).toBe(3);
    expect(a.avg_return).toBeCloseTo(0.0833, 3);
    expect(a.compounded_return).toBeCloseTo(1.1 * 0.95 * 1.2 - 1, 4);
    expect(a.win_rate).toBeCloseTo(0.67, 2);
    expect(a.best).toBeCloseTo(0.2, 6);
    expect(a.worst).toBeCloseTo(-0.05, 6);
  });
  test("empty → zeros", () => {
    expect(aggregateReturns([])).toEqual({ n: 0, avg_return: 0, compounded_return: 0, win_rate: 0, best: 0, worst: 0 });
  });
});
