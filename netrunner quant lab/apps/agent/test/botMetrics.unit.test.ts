import { describe, expect, test } from "vitest";
import { botMetricsFromSteps } from "../src/multiasset/setup.js";

// Regression for the "-100% / fake 0%" bot-widget bug: the extractor must prefer the engine's own
// performance.total_return and return null (→ UI shows "—") when the backtest produced nothing, NOT a
// fabricated -100% from defaulting a missing final_equity to 0.

const step = (result: unknown) => [{ tool: "run_bot_backtest", result }];

describe("botMetricsFromSteps", () => {
  test("uses the engine's reported performance.total_return directly", () => {
    const m = botMetricsFromSteps(step({ performance: { total_return: -0.1, sharpe: 1.2, max_drawdown: -0.2 }, result_tier: "BACKTEST VERIFIED" }));
    expect(m.metrics.total_return).toBeCloseTo(-0.1, 6);
    expect(m.metrics.sharpe).toBeCloseTo(1.2, 6);
    expect(m.metrics.max_drawdown).toBeCloseTo(0.2, 6); // abs
    expect(m.result_tier).toBe("BACKTEST VERIFIED");
  });

  test("missing metrics → null (never -100%)", () => {
    const m = botMetricsFromSteps(step({ result_tier: "unverified" }));
    expect(m.metrics.total_return).toBeNull();
    expect(m.metrics.sharpe).toBeNull();
    expect(m.metrics.max_drawdown).toBeNull();
  });

  test("no run_bot_backtest step at all → all null", () => {
    const m = botMetricsFromSteps([{ tool: "ensure_candles", result: {} }]);
    expect(m.metrics.total_return).toBeNull();
  });

  test("derives from equity only when BOTH endpoints are present", () => {
    const m = botMetricsFromSteps(step({ starting_equity: "10000", final_equity: "11000" }));
    expect(m.metrics.total_return).toBeCloseTo(0.1, 6);
  });
});
