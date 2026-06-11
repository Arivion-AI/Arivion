/**
 * §25 Phase 3.1 (achievable part) — prove the verify path binds to the REAL Privy app via its
 * PUBLIC JWKS (no secret). Gated on ITEST_PRIVY_REAL_APP_ID + network. Confirms:
 *   - the real Privy JWKS loads and its ES256 keys convert to usable PEMs;
 *   - verifyPrivyToken (JWKS mode, no static key) is wired to those real keys and REJECTS a token
 *     not signed by Privy (signature mismatch) — i.e. the API is genuinely bound to real Privy.
 * A real ACCEPTED token requires a Privy-signed JWT (browser login) — see AUTH_DONE_REPORT.md 3.2.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";

const REAL_APP_ID = process.env.ITEST_PRIVY_REAL_APP_ID ?? "";
const ENABLED = Boolean(REAL_APP_ID);

let verifyPrivyToken: (t: string) => Promise<unknown>;
let PrivyVerificationError: new (...a: unknown[]) => Error;

beforeAll(async () => {
  if (!ENABLED) return;
  // JWKS mode: real app id, NO static verification key.
  process.env.PRIVY_APP_ID = REAL_APP_ID;
  delete process.env.PRIVY_VERIFICATION_KEY;
  const mod = await import("../src/lib/auth.js");
  verifyPrivyToken = mod.verifyPrivyToken as typeof verifyPrivyToken;
  PrivyVerificationError = mod.PrivyVerificationError as typeof PrivyVerificationError;
});
afterAll(() => {});

const itIf = (n: string, fn: () => Promise<void>) =>
  test(n, { timeout: 20_000 }, async () => { if (!ENABLED) { console.warn(`SKIP (no ITEST_PRIVY_REAL_APP_ID): ${n}`); return; } await fn(); });

describe("§25 3.1 — real Privy JWKS binding", () => {
  itIf("rejects a non-Privy-signed token against the real JWKS (binding active, no secret)", async () => {
    // Sign with our OWN key — Privy's real public keys must NOT verify it.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const forged = jwt.sign({ sub: "did:privy:forged" }, priv, { algorithm: "ES256", issuer: "privy.io", audience: REAL_APP_ID, expiresIn: "5m" });
    // Must reach the real JWKS, find no matching key / fail signature -> rejected (NOT a config error).
    await expect(verifyPrivyToken(forged)).rejects.toBeInstanceOf(PrivyVerificationError);
    try {
      await verifyPrivyToken(forged);
    } catch (e) {
      const code = (e as { code?: string }).code;
      // Proves JWKS was reachable + active (not PRIVY_NOT_CONFIGURED / PRIVY_JWKS_FETCH_FAILED).
      expect(["PRIVY_TOKEN_INVALID"]).toContain(code);
    }
  });
});
