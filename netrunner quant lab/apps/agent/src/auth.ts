import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

// The agent trusts the SAME internal HS256 owner token the Lab API issues (sub = String(ownerId)).
// The frontend /api/copilot/* proxy performs the Privy→owner-token exchange and forwards the bearer
// (the browser never holds it) — identical to the existing /api/netrunners/* proxy. EventSource
// (SSE) can't set headers, so ?token= is accepted as a fallback, matching the API.

const jwtAudience = process.env.JWT_AUDIENCE;
const jwtIssuer = process.env.JWT_ISSUER;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required");
  return secret;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ownerId?: number;
      ownerToken?: string;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health") return next();

  const header = req.headers.authorization;
  const queryToken = typeof req.query?.token === "string" ? req.query.token : undefined;
  let token = "";
  if (header?.startsWith("Bearer ")) token = header.slice("Bearer ".length).trim();
  else if (queryToken) token = queryToken.trim();
  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED", reason: "MISSING_BEARER_TOKEN" });
    return;
  }

  try {
    const opts: jwt.VerifyOptions = { algorithms: ["HS256"] };
    if (jwtAudience) opts.audience = jwtAudience;
    if (jwtIssuer) opts.issuer = jwtIssuer;
    const claims = jwt.verify(token, getJwtSecret(), opts) as { sub?: string };
    const ownerId = Number(claims.sub);
    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      res.status(401).json({ error: "UNAUTHORIZED", reason: "INVALID_SUB_CLAIM" });
      return;
    }
    req.ownerId = ownerId;
    req.ownerToken = token; // captured for MCP owner-token passthrough
    next();
  } catch (e) {
    res.status(401).json({ error: "UNAUTHORIZED", reason: "INVALID_TOKEN", message: (e as Error).message });
  }
}

export function requireOwnerId(req: Request): number {
  if (!req.ownerId) throw new Error("auth context missing");
  return req.ownerId;
}
