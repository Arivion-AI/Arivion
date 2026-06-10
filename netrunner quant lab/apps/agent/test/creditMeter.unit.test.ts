import { describe, expect, test } from "vitest";
import {
  costForUsage,
  estimateTokensFromMessages,
  estimateWorstCaseCost,
} from "../src/llm-gateway/creditMeter.js";
import type { PriceRow } from "../src/llm-gateway/types.js";

// Pure cost-math tests — no DB, run in plain `npm test`.

const price: PriceRow = {
  provider: "test",
  model: "m",
  input_micro_usd_per_mtoken: 1_000_000, // $1.00 / Mtoken
  cached_input_micro_usd_per_mtoken: 100_000, // $0.10 / Mtoken
  output_micro_usd_per_mtoken: 2_000_000, // $2.00 / Mtoken
  reasoning_micro_usd_per_mtoken: null,
  source: "test",
  source_url: null,
  fetched_at: null,
  effective_from: "now",
  effective_to: null,
};

describe("creditMeter", () => {
  test("token estimate is ~chars/4 and non-zero", () => {
    const t = estimateTokensFromMessages([{ role: "user", content: "x".repeat(400) }]);
    expect(t).toBeGreaterThanOrEqual(100);
  });

  test("costForUsage charges uncached input at full rate, cached at cached rate", () => {
    const c = costForUsage(
      { input_tokens: 1_000_000, cached_input_tokens: 200_000, output_tokens: 500_000, reasoning_tokens: 0, tool_call_count: 0 },
      price,
    );
    // uncached = 800k @ $1/M = 800_000 micro; cached = 200k @ $0.10/M = 20_000; output 500k @ $2/M = 1_000_000
    expect(c.input_micro_usd).toBe(800_000);
    expect(c.cached_input_micro_usd).toBe(20_000);
    expect(c.output_micro_usd).toBe(1_000_000);
    expect(c.total_micro_usd).toBe(1_820_000);
  });

  test("reasoning falls back to output rate when no reasoning price", () => {
    const c = costForUsage(
      { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 1_000_000, tool_call_count: 0 },
      price,
    );
    expect(c.reasoning_micro_usd).toBe(2_000_000);
  });

  test("worst-case cost assumes full output budget and no cache", () => {
    const w = estimateWorstCaseCost([{ role: "user", content: "y".repeat(40) }], 1_000_000, price);
    expect(w.cached_input_micro_usd).toBe(0);
    expect(w.output_micro_usd).toBe(2_000_000); // 1M output tokens @ $2/M
    expect(w.total_micro_usd).toBeGreaterThanOrEqual(2_000_000);
  });

  test("never under-bills (rounds up partial micro)", () => {
    const tiny: PriceRow = { ...price, input_micro_usd_per_mtoken: 1, output_micro_usd_per_mtoken: 1, cached_input_micro_usd_per_mtoken: null };
    const c = costForUsage({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0, tool_call_count: 0 }, tiny);
    expect(c.input_micro_usd).toBe(1); // ceil(1*1/1e6) = 1, not 0
    expect(c.output_micro_usd).toBe(1);
  });
});
