import { describe, expect, test } from "vitest";
import {
  evaluateExit, initRuntime, validateExitPolicy, unrealizedReturn, baseStopPrice,
  type ExitPolicy, type PositionView,
} from "../src/positions/exitPolicy.js";

// Pure exit-policy logic — the heart of "trades with consequences". No DB; fully deterministic.

const ENTRY = 100;
const T0 = 1_000_000_000_000;

function longView(policy: ExitPolicy, over: Partial<PositionView> = {}): PositionView {
  return {
    side: "long", entry_price: ENTRY, opened_at_ms: T0, policy,
    runtime: initRuntime({ side: "long", entry_price: ENTRY, policy }),
    ...over,
  };
}

const FIXED: ExitPolicy = { stop_loss: { type: "fixed_pct", value: 0.05 } };

describe("exit policy validation", () => {
  test("a stop-loss is mandatory", () => {
    expect(validateExitPolicy({}).ok).toBe(false);
    expect(validateExitPolicy({ stop_loss: { type: "fixed_pct", value: 0.05 } }).ok).toBe(true);
  });
  test("take-profit ladder must be strictly ascending", () => {
    const bad = { stop_loss: { type: "fixed_pct", value: 0.05 }, take_profit: { ladder: [{ target_pct: 0.05, reduce_fraction: 0.5 }, { target_pct: 0.05, reduce_fraction: 0.5 }] } };
    expect(validateExitPolicy(bad).ok).toBe(false);
  });
  test("reduce fractions cannot sum above 1", () => {
    const bad = { stop_loss: { type: "fixed_pct", value: 0.05 }, take_profit: { ladder: [{ target_pct: 0.02, reduce_fraction: 0.7 }, { target_pct: 0.05, reduce_fraction: 0.7 }] } };
    expect(validateExitPolicy(bad).ok).toBe(false);
  });
  test("fixed_pct stop ≥ 1 is rejected", () => {
    expect(validateExitPolicy({ stop_loss: { type: "fixed_pct", value: 1 } }).ok).toBe(false);
  });
});

describe("stop loss", () => {
  test("long: holds above the stop", () => {
    const d = evaluateExit(longView(FIXED), 98, T0);
    expect(d.action).toBe("hold");
  });
  test("long: closes at/below the stop with reason stop_loss", () => {
    const d = evaluateExit(longView(FIXED), 95, T0); // entry*(1-0.05)=95
    expect(d.action).toBe("close");
    expect(d.reason).toBe("stop_loss");
    expect(d.fraction).toBe(1);
  });
  test("short: closes when price rises into the stop", () => {
    const policy = FIXED;
    const view: PositionView = { side: "short", entry_price: ENTRY, opened_at_ms: T0, policy, runtime: initRuntime({ side: "short", entry_price: ENTRY, policy }) };
    expect(evaluateExit(view, 104, T0).action).toBe("hold");
    expect(evaluateExit(view, 105, T0).action).toBe("close");
  });
  test("atr-multiple stop computes the right price", () => {
    const policy: ExitPolicy = { stop_loss: { type: "atr_mult", value: 2 } };
    expect(baseStopPrice("long", 100, policy.stop_loss, 3)).toBe(94); // 100 - 2*3
    const view = longView(policy, { atr: 3, runtime: initRuntime({ side: "long", entry_price: 100, policy, atr: 3 }) });
    expect(evaluateExit(view, 93, T0).action).toBe("close");
  });
});

describe("max loss cap", () => {
  test("fires independently of the stop", () => {
    const policy: ExitPolicy = { stop_loss: { type: "fixed_pct", value: 0.5 }, max_loss_pct: 0.1 };
    const d = evaluateExit(longView(policy), 89, T0); // -11% > 10% cap, but well above the 50% stop
    expect(d.action).toBe("close");
    expect(d.reason).toBe("max_loss");
  });
});

describe("take-profit ladder", () => {
  const policy: ExitPolicy = {
    stop_loss: { type: "fixed_pct", value: 0.1 },
    take_profit: { ladder: [{ target_pct: 0.02, reduce_fraction: 0.5 }, { target_pct: 0.05, reduce_fraction: 0.5 }] },
  };
  test("first tier reduces, not closes", () => {
    const d = evaluateExit(longView(policy), 102, T0); // +2%
    expect(d.action).toBe("reduce");
    expect(d.reason).toBe("take_profit");
    expect(d.tier_index).toBe(0);
    expect(d.next_runtime.cleared_tiers).toContain(0);
  });
  test("final tier closes", () => {
    const view = longView(policy);
    view.runtime.cleared_tiers = [0];
    const d = evaluateExit(view, 105, T0); // +5% final tier
    expect(d.action).toBe("close");
    expect(d.reason).toBe("take_profit_final");
  });
  test("clearing a tier ratchets the stop up to at least breakeven", () => {
    const d = evaluateExit(longView(policy), 102, T0);
    // After tier 0 clears, stop should be lifted to >= entry (breakeven), above the original 90.
    expect(d.next_runtime.current_stop_price!).toBeGreaterThanOrEqual(ENTRY);
  });
});

describe("trailing stop", () => {
  const policy: ExitPolicy = {
    stop_loss: { type: "fixed_pct", value: 0.1 },
    trailing: { activate_at_pct: 0.03, trail_pct: 0.02, ratchet: true },
  };
  test("does not trail until activation gain is reached", () => {
    const view = longView(policy);
    const d = evaluateExit(view, 102, T0); // +2% < 3% activation
    expect(d.action).toBe("hold");
    expect(d.next_runtime.current_stop_price).toBeCloseTo(90, 5); // unchanged base stop
  });
  test("trails up and closes on a pullback from the high-water mark", () => {
    let view = longView(policy);
    // Run to +10% (110): trailing active, stop = 110*(1-0.02)=107.8
    let d = evaluateExit(view, 110, T0);
    expect(d.action).toBe("hold");
    expect(d.next_runtime.current_stop_price!).toBeCloseTo(107.8, 4);
    // Pull back to 107 → below trailing stop → close as trailing_stop
    view = { ...view, runtime: d.next_runtime };
    d = evaluateExit(view, 107, T0);
    expect(d.action).toBe("close");
    expect(d.reason).toBe("trailing_stop");
  });
  test("ratchet never loosens the stop", () => {
    let view = longView(policy);
    let d = evaluateExit(view, 110, T0); // stop → 107.8
    view = { ...view, runtime: d.next_runtime };
    d = evaluateExit(view, 108, T0); // high-water stays 110; stop must not drop below 107.8
    expect(d.next_runtime.current_stop_price!).toBeGreaterThanOrEqual(107.8 - 1e-6);
  });
});

describe("time exit", () => {
  test("closes once max hold elapses", () => {
    const policy: ExitPolicy = { stop_loss: { type: "fixed_pct", value: 0.2 }, time_exit: { max_hold_seconds: 3600 } };
    const view = longView(policy);
    expect(evaluateExit(view, 101, T0 + 1000).action).toBe("hold");
    const d = evaluateExit(view, 101, T0 + 3600_000);
    expect(d.action).toBe("close");
    expect(d.reason).toBe("time_exit");
  });
});

describe("unrealized return helper", () => {
  test("long vs short sign", () => {
    expect(unrealizedReturn("long", 100, 110)).toBeCloseTo(0.1, 6);
    expect(unrealizedReturn("short", 100, 110)).toBeCloseTo(-0.1, 6);
    expect(unrealizedReturn("short", 100, 90)).toBeCloseTo(0.1, 6);
  });
});
