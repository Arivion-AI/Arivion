import { beforeAll, describe, expect, test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { verifyPrivyToken, PrivyVerificationError, issueDevToken } from "../src/lib/auth.js";

// Local ES256 keypair stands in for Privy's signing key — proves the verifier accepts a correctly
// signed Privy-shaped token and rejects expired/wrong-audience/non-DID/HS256 tokens. No DB.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const APP_ID = "test-privy-app";

function privyToken(claims: object, opts: jwt.SignOptions = {}): string {
  return jwt.sign(claims, privPem, { algorithm: "ES256", issuer: "privy.io", audience: APP_ID, ...opts });
}

describe("verifyPrivyToken (ES256, no DB)", () => {
  beforeAll(() => {
    process.env.PRIVY_APP_ID = APP_ID;
    process.env.PRIVY_VERIFICATION_KEY = pubPem;
  });

  test("accepts a valid Privy token and extracts identity", async () => {
    const t = privyToken({ sub: "did:privy:abc123", email: "a@b.com" }, { expiresIn: "5m" });
    const id = await verifyPrivyToken(t);
    expect(id.did).toBe("did:privy:abc123");
    expect(id.email).toBe("a@b.com");
  });

  test("extracts wallet from linked_accounts", async () => {
    const t = privyToken({ sub: "did:privy:w1", linked_accounts: [{ type: "wallet", address: "0xabc" }] }, { expiresIn: "5m" });
    expect((await verifyPrivyToken(t)).wallet).toBe("0xabc");
  });

  test("rejects an expired token with PRIVY_TOKEN_EXPIRED", async () => {
    const t = privyToken({ sub: "did:privy:abc" }, { expiresIn: -10 });
    await expect(verifyPrivyToken(t)).rejects.toMatchObject({ code: "PRIVY_TOKEN_EXPIRED" });
  });

  test("rejects wrong audience", async () => {
    const t = jwt.sign({ sub: "did:privy:abc" }, privPem, { algorithm: "ES256", issuer: "privy.io", audience: "other-app", expiresIn: "5m" });
    await expect(verifyPrivyToken(t)).rejects.toBeInstanceOf(PrivyVerificationError);
  });

  test("rejects a non-DID subject", async () => {
    const t = privyToken({ sub: "12345" }, { expiresIn: "5m" });
    await expect(verifyPrivyToken(t)).rejects.toMatchObject({ code: "PRIVY_TOKEN_INVALID" });
  });

  test("rejects an HS256 token (algorithm confusion)", async () => {
    const t = jwt.sign({ sub: "did:privy:abc" }, "shared-secret", { algorithm: "HS256", issuer: "privy.io", audience: APP_ID });
    await expect(verifyPrivyToken(t)).rejects.toBeInstanceOf(PrivyVerificationError);
  });
});

describe("internal owner token carries version (P2)", () => {
  test("issueDevToken embeds ver for the revocation gate", () => {
    const decoded = jwt.decode(issueDevToken(7, 3)) as { sub: string; ver: number };
    expect(decoded.sub).toBe("7");
    expect(decoded.ver).toBe(3);
  });
});
