import { describe, expect, test, vi } from "vitest";
import { normalizeToolResult, isRateLimited } from "../src/mcp/normalize.js";
import { withBackoff } from "../src/mcp/backoff.js";

// A backtest-shaped result the way the Lab encodes it: structured JSON inside content[0].text, with
// honesty fields nested at various depths.
const backtestResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        final_equity: 10234.5,
        result_tier: "unverified",
        performance: { sharpe: 1.2, max_drawdown: 0.18 },
        fill_model: {
          fill_model_mode: "optimistic_maker",
          maker_fills_optimistic: true,
          liquidity_free_upper_bound: true,
        },
        coverage_proof: { coverage: 0.97, bars: 5000 },
        execution_fidelity: "bar_based",
        validation: { labels: ["LOOKAHEAD_SAFE"] },
        risk: { risk_class: "aggressive", risk_score: 0.81, hard_blocks: ["RUIN_MARGIN_EXCEEDS_CAPITAL"] },
      }),
    },
  ],
};

describe("normalizeToolResult", () => {
  test("preserves the raw payload verbatim (nothing stripped)", () => {
    const n = normalizeToolResult(backtestResult);
    expect(n.isError).toBe(false);
    const raw = n.raw as Record<string, any>;
    expect(raw.final_equity).toBe(10234.5);
    expect(raw.fill_model.maker_fills_optimistic).toBe(true);
    expect(raw.risk.hard_blocks).toContain("RUIN_MARGIN_EXCEEDS_CAPITAL");
  });

  test("surfaces every honesty field (deeply nested ones included)", () => {
    const n = normalizeToolResult(backtestResult);
    expect(n.honesty.result_tier).toBe("unverified");
    expect(n.honesty.execution_fidelity).toBe("bar_based");
    expect(n.honesty.fill_model).toBeTruthy();
    expect(n.honesty.coverage_proof).toBeTruthy();
    expect(n.honesty.maker_fills_optimistic).toBe(true);
    expect(n.honesty.liquidity_free_upper_bound).toBe(true);
    expect(n.honesty.risk_class).toBe("aggressive");
    expect(n.honesty.hard_blocks).toContain("RUIN_MARGIN_EXCEEDS_CAPITAL");
    expect(n.honesty.validation).toBeTruthy();
  });

  test("non-JSON text result keeps text and yields no false honesty", () => {
    const n = normalizeToolResult({ content: [{ type: "text", text: "plain note" }] });
    expect(n.text).toBe("plain note");
    expect(n.raw).toBeUndefined();
    expect(Object.keys(n.honesty)).toHaveLength(0);
  });
});

describe("isRateLimited", () => {
  test("detects 429 / rate-limit signals", () => {
    expect(isRateLimited("HTTP 429 Too Many Requests")).toBe(true);
    expect(isRateLimited({ error: "RATE_LIMIT" })).toBe(true);
    expect(isRateLimited("ok")).toBe(false);
  });
});

describe("withBackoff", () => {
  test("retries a retryable failure then succeeds", async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const out = await withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("429");
        return "done";
      },
      { isRetryable: (e) => isRateLimited((e as Error).message), sleep, retries: 5, baseMs: 1 },
    );
    expect(out).toBe("done");
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test("does not retry a non-retryable failure", async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls += 1;
          throw new Error("VALIDATION_FAILED");
        },
        { isRetryable: (e) => isRateLimited((e as Error).message), sleep: async () => {}, retries: 5 },
      ),
    ).rejects.toThrow("VALIDATION_FAILED");
    expect(calls).toBe(1);
  });

  test("gives up after the retry budget", async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls += 1;
          throw new Error("429");
        },
        { isRetryable: () => true, sleep: async () => {}, retries: 3, baseMs: 1 },
      ),
    ).rejects.toThrow("429");
    expect(calls).toBe(4); // initial + 3 retries
  });
});
