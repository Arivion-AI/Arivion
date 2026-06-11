import { describe, expect, test } from "vitest";
import { redactClaims, containsPii } from "../src/lib/pii.js";

describe("§25 P3 PII guard", () => {
  test("redactClaims strips PII but keeps sub/ver", () => {
    const r = redactClaims({ sub: "5", ver: 2, email: "a@b.com", name: "Alice", wallet: "0xabc" });
    expect(r.sub).toBe("5");
    expect(r.ver).toBe(2);
    expect(r.email).toBe("[redacted]");
    expect(r.name).toBe("[redacted]");
    expect(r.wallet).toBe("[redacted]");
  });

  test("containsPii detects email-shaped strings and PII keys", () => {
    expect(containsPii({ owner_id: 5, note: "user a@b.com filled" })).toBe(true);
    expect(containsPii({ payload: { email: "x@y.com" } })).toBe(true);
  });

  test("containsPii passes owner_id-only execution rows / session snapshots", () => {
    // Shape of a backtest_events payload / rt:session snapshot — owner_id + numbers only.
    expect(containsPii({ type: "FILL", payload: { order_id: "o0", qty: "1", price: "100" } })).toBe(false);
    expect(containsPii({ session_id: "s1", owner_id: 5, equity: 10000, performance: { sharpe: 1.2 } })).toBe(false);
  });
});
