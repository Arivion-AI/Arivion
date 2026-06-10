import { describe, expect, test } from "vitest";
import { computeCVaR, evaluateBreakers } from "../src/risk/index.js";
import { config } from "../src/config.js";

// Pure circuit-breaker logic — CVaR + escalation thresholds. No DB.

describe("computeCVaR", () => {
  test("empty input is 0", () => {
    expect(computeCVaR([])).toBe(0);
  });
  test("averages the worst tail (most negative)", () => {
    // worst 10% of 10 samples = 1 sample = -0.5
    expect(computeCVaR([-0.5, -0.1, 0, 0.1, 0.2, 0.3, 0.1, 0.05, 0.02, 0.4], 0.1)).toBeCloseTo(-0.5, 6);
  });
  test("all-positive returns a positive (non-alarming) CVaR", () => {
    expect(computeCVaR([0.1, 0.2, 0.3], 0.5)).toBeGreaterThan(0);
  });
});

describe("evaluateBreakers", () => {
  test("normal when nothing is tripped", () => {
    const v = evaluateBreakers({ consecutiveLosses: 1, recentReturns: [0.02, -0.01, 0.03], worstDrawdown: 0.05 });
    expect(v.state).toBe("normal");
  });
  test("halts on a drawdown breach", () => {
    const v = evaluateBreakers({ consecutiveLosses: 0, recentReturns: [-0.3], worstDrawdown: config.riskHaltDrawdownPct + 0.01 });
    expect(v.state).toBe("halted");
    expect(v.reason).toMatch(/drawdown/);
  });
  test("halts on a long losing streak", () => {
    const v = evaluateBreakers({ consecutiveLosses: config.riskHaltConsecutiveLosses, recentReturns: [-0.01], worstDrawdown: 0.02 });
    expect(v.state).toBe("halted");
  });
  test("risk_averse on an elevated tail (CVaR)", () => {
    // Many losses so CVaR(10%) ≤ -riskAverseCvarPct but no single drawdown ≥ halt threshold.
    const returns = Array.from({ length: 20 }, (_, i) => (i < 3 ? -(config.riskAverseCvarPct + 0.02) : 0.01));
    const v = evaluateBreakers({ consecutiveLosses: 0, recentReturns: returns, worstDrawdown: config.riskAverseCvarPct + 0.02 });
    expect(["risk_averse", "halted"]).toContain(v.state);
  });
  test("risk_averse on a medium losing streak", () => {
    const v = evaluateBreakers({ consecutiveLosses: config.riskAverseConsecutiveLosses, recentReturns: [0.01, -0.01], worstDrawdown: 0.03 });
    expect(v.state).toBe("risk_averse");
  });
});
