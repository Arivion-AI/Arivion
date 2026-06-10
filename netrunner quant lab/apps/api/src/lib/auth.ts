import type { NextFunction, Request, Response } from "express";
import { createPublicKey, type JsonWebKey as CryptoJwk } from "node:crypto";
import jwt from "jsonwebtoken";

type AuthClaims = {
  sub: string;
  email?: string;
  name?: string;
  // P2 session lifecycle: token version. The status/denylist wrapper rejects a token whose `ver`
  // is below the owner's current `auth:ver:{ownerId}`. authMiddleware itself ignores it (contract
  // unchanged — it still only maps sub -> ownerId).
  ver?: number;
};

// Privy access-token claims (ES256). sub is the Privy DID (did:privy:…).
export type PrivyIdentity = {
  did: string;
  email?: string;
  wallet?: string;
};

declare global {
  namespace Express {
    interface Request {
      auth?: {
        ownerId: number;
        claims: AuthClaims;
        token: string;
      };
    }
  }
}

const jwtSecret = process.env.JWT_SECRET ?? "REDACTED_JWT_SECRET";
const jwtAudience = process.env.JWT_AUDIENCE;
const jwtIssuer = process.env.JWT_ISSUER;

const publicApiPaths = new Set<string>([
  "/health",
  "/metrics",
  "/auth/dev-token",
  "/auth/session",   // Privy token-exchange (verifies the Privy ES256 token itself)
  "/api/templates",
  "/api/strategies/registry",
]);

function isPublicPath(path: string): boolean {
  if (publicApiPaths.has(path)) {
    return true;
  }
  return false;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isPublicPath(req.path)) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  // EventSource (SSE) cannot set headers — allow ?token= / ?access_token= as a fallback.
  const queryToken = typeof req.query?.token === "string" ? req.query.token
    : (typeof req.query?.access_token === "string" ? req.query.access_token : undefined);
  let token = "";
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice("Bearer ".length).trim();
  } else if (queryToken) {
    token = queryToken.trim();
  } else {
    res.status(401).json({ error: "UNAUTHORIZED", reason: "MISSING_BEARER_TOKEN" });
    return;
  }
  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED", reason: "EMPTY_BEARER_TOKEN" });
    return;
  }

  try {
    const verifyOptions: jwt.VerifyOptions = {
      algorithms: ["HS256"],
    };
    if (jwtAudience) verifyOptions.audience = jwtAudience;
    if (jwtIssuer) verifyOptions.issuer = jwtIssuer;

    const claims = jwt.verify(token, jwtSecret, verifyOptions) as AuthClaims;
    const ownerId = Number(claims.sub);
    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      res.status(401).json({ error: "UNAUTHORIZED", reason: "INVALID_SUB_CLAIM" });
      return;
    }
    req.auth = { ownerId, claims, token };
    next();
  } catch (error) {
    res.status(401).json({ error: "UNAUTHORIZED", reason: "INVALID_TOKEN", message: (error as Error).message });
  }
}

export function requireOwnerId(req: Request): number {
  if (!req.auth) {
    throw new Error("auth context missing");
  }
  return req.auth.ownerId;
}

// Internal owner-token TTL. Kept at 12h by default (overridable) — the P2 token-version + status
// wrapper provides immediate revocation, so a long TTL no longer means "unrevocable until expiry".
const ownerTokenTtl = (process.env.OWNER_TOKEN_TTL ?? "12h") as jwt.SignOptions["expiresIn"];

export function issueDevToken(ownerId: number, ver = 0): string {
  const payload: AuthClaims = { sub: String(ownerId), ver };
  const signOptions: jwt.SignOptions = {
    algorithm: "HS256",
    expiresIn: ownerTokenTtl,
  };
  if (jwtIssuer) signOptions.issuer = jwtIssuer;
  if (jwtAudience) signOptions.audience = jwtAudience;
  return jwt.sign(payload, jwtSecret, signOptions);
}

// The internal token minted for a Privy-authenticated owner is the SAME HS256 owner token the
// rest of the system already understands (variant A token-exchange). Privy only feeds the edge.
export function issueOwnerToken(ownerId: number, ver = 0): string {
  return issueDevToken(ownerId, ver);
}

// PEM SPKI public key (or set PRIVY_VERIFICATION_KEY to the verification key from the Privy
// dashboard). ES256. Verified locally with the existing jsonwebtoken dep — no per-request call to
// Privy, no new dependency. Read at call time so config/tests can set it after module load.
function privyVerificationKey(): string | undefined {
  const k = process.env.PRIVY_VERIFICATION_KEY;
  if (!k) return undefined;
  // Allow either a real PEM (with newlines) or a single-line env value with literal \n.
  return k.includes("BEGIN") ? k.replace(/\\n/g, "\n") : `-----BEGIN PUBLIC KEY-----\n${k}\n-----END PUBLIC KEY-----`;
}

export class PrivyVerificationError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

// --- JWKS path (real Privy app) ---------------------------------------------------------------
// Real Privy signs with rotating ES256 keys published as a public JWKS. We fetch+cache the JWKS
// (PUBLIC keys only — no PRIVY_APP_SECRET on the verify path) and select by the token's `kid`.
// Keys are converted to PEM with Node's built-in crypto (no new dependency). Cached, so this is
// not a per-request Privy call. The static PRIVY_VERIFICATION_KEY still takes precedence (used by
// the deterministic test harness with its synthetic keypair).
let jwksCache: { keys: Map<string, string>; at: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

function privyJwksUrl(): string | undefined {
  if (process.env.PRIVY_JWKS_URL) return process.env.PRIVY_JWKS_URL;
  const id = process.env.PRIVY_APP_ID;
  return id ? `https://auth.privy.io/api/v1/apps/${id}/jwks.json` : undefined;
}

async function jwksKeyMap(): Promise<Map<string, string>> {
  if (jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const url = privyJwksUrl();
  if (!url) throw new PrivyVerificationError("PRIVY_NOT_CONFIGURED", "no PRIVY_JWKS_URL / PRIVY_APP_ID");
  const resp = await fetch(url, { cache: "no-store" } as RequestInit);
  if (!resp.ok) throw new PrivyVerificationError("PRIVY_JWKS_FETCH_FAILED", `jwks ${resp.status}`);
  const body = (await resp.json()) as { keys?: Array<Record<string, unknown>> };
  const map = new Map<string, string>();
  for (const jwk of body.keys ?? []) {
    if (jwk.use && jwk.use !== "sig") continue;
    try {
      const pem = createPublicKey({ key: jwk as unknown as CryptoJwk, format: "jwk" }).export({ type: "spki", format: "pem" }).toString();
      if (typeof jwk.kid === "string") map.set(jwk.kid, pem);
    } catch { /* skip unconvertible key */ }
  }
  if (map.size === 0) throw new PrivyVerificationError("PRIVY_JWKS_EMPTY", "no usable signing keys");
  jwksCache = { keys: map, at: Date.now() };
  return map;
}

async function resolveVerifyKey(token: string): Promise<string> {
  const staticKey = privyVerificationKey();
  if (staticKey) return staticKey; // test harness / dashboard-PEM override
  const decoded = jwt.decode(token, { complete: true }) as { header?: { kid?: string } } | null;
  const kid = decoded?.header?.kid;
  const map = await jwksKeyMap();
  const pem = (kid && map.get(kid)) || [...map.values()][0];
  if (!pem) throw new PrivyVerificationError("PRIVY_TOKEN_INVALID", "no matching JWKS key");
  return pem;
}

/** Verify a Privy access token (ES256) locally using only PUBLIC key material (static PEM or the
 *  cached public JWKS — never the app secret). Throws PrivyVerificationError with a code the client
 *  maps to getAccessToken() re-fetch (e.g. PRIVY_TOKEN_EXPIRED). */
export async function verifyPrivyToken(token: string): Promise<PrivyIdentity> {
  const privyAppId = process.env.PRIVY_APP_ID;
  if (!privyAppId) throw new PrivyVerificationError("PRIVY_NOT_CONFIGURED", "PRIVY_APP_ID unset");
  const key = await resolveVerifyKey(token);
  let claims: jwt.JwtPayload;
  try {
    claims = jwt.verify(token, key, {
      algorithms: ["ES256"],
      issuer: "privy.io",
      audience: privyAppId,
    }) as jwt.JwtPayload;
  } catch (error) {
    const name = (error as Error).name;
    const code = name === "TokenExpiredError" ? "PRIVY_TOKEN_EXPIRED" : "PRIVY_TOKEN_INVALID";
    throw new PrivyVerificationError(code, (error as Error).message);
  }
  const did = String(claims.sub ?? "");
  if (!did.startsWith("did:privy:")) {
    throw new PrivyVerificationError("PRIVY_TOKEN_INVALID", "missing did subject");
  }
  // Privy puts linked accounts in `linked_accounts`; email/wallet may also arrive via custom claims.
  const linked = Array.isArray((claims as Record<string, unknown>).linked_accounts)
    ? ((claims as Record<string, unknown>).linked_accounts as Array<Record<string, unknown>>)
    : [];
  const emailAcct = linked.find((a) => a.type === "email");
  const walletAcct = linked.find((a) => a.type === "wallet");
  return {
    did,
    email: (claims.email as string) ?? (emailAcct?.address as string) ?? undefined,
    wallet: (claims.wallet as string) ?? (walletAcct?.address as string) ?? undefined,
  };
}
