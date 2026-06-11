/**
 * §25 P3 — PII invariant helpers.
 *
 * Rule: PII (email / wallet / display name) lives ONLY in the `users` table and the /api/me and
 * /auth/session responses. It must never enter logs, execution-plane rows (backtest_events,
 * recovery_events_json, fills), or Redis `rt:session:{owner}` snapshots — those carry `owner_id`
 * only. `redactClaims` is the guard for the one ingress risk: logging `req.auth.claims` once it
 * carries real Privy email/name.
 */

const PII_KEYS = new Set(["email", "name", "display_name", "wallet", "primary_wallet", "address", "phone", "linked_accounts"]);

/** Strip PII fields from an object before it can be logged. Returns a shallow-redacted copy. */
export function redactClaims<T extends Record<string, unknown>>(claims: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(claims ?? {})) {
    out[k] = PII_KEYS.has(k) ? "[redacted]" : v;
  }
  return out as Partial<T>;
}

/** True iff a value (any nesting) contains something that looks like PII — used by the leakage
 *  test to assert execution-plane payloads / Redis snapshots stay owner_id-only. */
export function containsPii(value: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (v: unknown): boolean => {
    if (v == null || typeof v !== "object") {
      if (typeof v === "string" && /@[^\s@]+\.[^\s@]+/.test(v)) return true; // email-shaped
      return false;
    }
    if (seen.has(v)) return false;
    seen.add(v);
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (PII_KEYS.has(k) && child != null && child !== "[redacted]") return true;
      if (walk(child)) return true;
    }
    return false;
  };
  return walk(value);
}
