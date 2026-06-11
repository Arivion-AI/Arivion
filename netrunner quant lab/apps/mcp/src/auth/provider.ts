import type { Config } from "../config.js";

// Per-request context. In passthrough mode the host supplies an ownerToken
// (Privy-exchanged or any internal JWT); in dev-token mode an ownerId can be
// chosen per call. Configured mode ignores both.
export interface RequestContext {
  ownerToken?: string;
  ownerId?: number;
}

export interface AuthProvider {
  readonly mode: string;
  /** Headers for an API/internal call: Authorization + optional x-internal-secret. */
  getHeaders(ctx?: RequestContext): Promise<Record<string, string>>;
  /** Bearer token alone (used to build the SSE ?token= query). */
  getToken(ctx?: RequestContext): Promise<string>;
}

export class ConfiguredTokenProvider implements AuthProvider {
  readonly mode = "configured";
  constructor(private cfg: Config) {
    if (!cfg.apiToken) {
      // Not fatal at construction — health/meta tools work — but every owner-scoped
      // call will fail with a clear message until DUALITY_API_TOKEN is set.
    }
  }
  async getToken(): Promise<string> {
    if (!this.cfg.apiToken) {
      throw new Error(
        "DUALITY_API_TOKEN is not set. In 'configured' auth mode the MCP server needs a pre-minted internal owner JWT."
      );
    }
    return this.cfg.apiToken;
  }
  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.getToken()}` };
    if (this.cfg.internalSecret) headers["x-internal-secret"] = this.cfg.internalSecret;
    return headers;
  }
}

export class DevTokenProvider implements AuthProvider {
  readonly mode = "dev-token";
  private cache = new Map<number, { token: string; at: number }>();
  private ttlMs = 10 * 60 * 1000;
  constructor(private cfg: Config) {}

  private async mint(ownerId: number): Promise<string> {
    const hit = this.cache.get(ownerId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.token;
    const url = `${this.cfg.apiUrl}/auth/dev-token?ownerId=${encodeURIComponent(String(ownerId))}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `dev-token mint failed (${resp.status}). The API must run with ALLOW_DEV_TOKEN=true and a non-default JWT_SECRET. Body: ${body}`
      );
    }
    const data = (await resp.json()) as { token: string };
    this.cache.set(ownerId, { token: data.token, at: Date.now() });
    return data.token;
  }

  async getToken(ctx?: RequestContext): Promise<string> {
    const ownerId = ctx?.ownerId ?? this.cfg.defaultOwnerId;
    return this.mint(ownerId);
  }
  async getHeaders(ctx?: RequestContext): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.getToken(ctx)}` };
    if (this.cfg.internalSecret) headers["x-internal-secret"] = this.cfg.internalSecret;
    return headers;
  }
}

export class PassthroughProvider implements AuthProvider {
  readonly mode = "passthrough";
  constructor(private cfg: Config) {}
  async getToken(ctx?: RequestContext): Promise<string> {
    if (!ctx?.ownerToken) {
      throw new Error(
        "passthrough auth mode requires an ownerToken (set DUALITY_SESSION_TOKEN on the HTTP session, or pass ownerToken to the tool)."
      );
    }
    return ctx.ownerToken;
  }
  async getHeaders(ctx?: RequestContext): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.getToken(ctx)}` };
    if (this.cfg.internalSecret) headers["x-internal-secret"] = this.cfg.internalSecret;
    return headers;
  }
}

export function buildAuthProvider(cfg: Config): AuthProvider {
  switch (cfg.authMode) {
    case "dev-token":
      return new DevTokenProvider(cfg);
    case "passthrough":
      return new PassthroughProvider(cfg);
    case "configured":
    default:
      return new ConfiguredTokenProvider(cfg);
  }
}
