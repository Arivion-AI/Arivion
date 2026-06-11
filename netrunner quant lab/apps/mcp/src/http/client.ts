import type { Config } from "../config.js";
import type { AuthProvider, RequestContext } from "../auth/provider.js";
import { explainCode } from "../kb/errorCodes.js";

export interface ApiError extends Error {
  status: number;
  body: unknown;
  hint?: string;
}

function makeError(status: number, body: unknown, where: string): ApiError {
  let codeHint: string | undefined;
  // Try to decode a machine error code from the response body for actionable guidance.
  const b = body as Record<string, unknown> | undefined;
  const code =
    (typeof b?.error === "string" && b.error) ||
    (typeof b?.reason === "string" && b.reason) ||
    undefined;
  if (code) {
    const decoded = explainCode(code);
    if (decoded) codeHint = `${code}: ${decoded.meaning} Fix: ${decoded.fix}`;
  }
  let msg = `${where} -> HTTP ${status}`;
  if (status === 429) {
    msg +=
      " (rate limited). Likely OWNER_CONCURRENCY_LIMIT or SERVER_BUSY — back off and retry; heavy jobs are owner-fair + globally capped (§17).";
  }
  if (codeHint) msg += ` | ${codeHint}`;
  const err = new Error(msg) as ApiError;
  err.status = status;
  err.body = body;
  err.hint = codeHint;
  return err;
}

/** Typed fetch wrapper for one of the lab services. */
export class ServiceClient {
  constructor(
    private baseUrl: string,
    private cfg: Config,
    private auth: AuthProvider,
    private opts: { withAuth: boolean } = { withAuth: true }
  ) {}

  private async headers(ctx?: RequestContext, extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const base: Record<string, string> = { "Content-Type": "application/json", ...extra };
    if (this.opts.withAuth) Object.assign(base, await this.auth.getHeaders(ctx));
    else if (this.cfg.internalSecret) base["x-internal-secret"] = this.cfg.internalSecret;
    return base;
  }

  private url(path: string, query?: Record<string, unknown>): string {
    const u = new URL(path, this.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async parse(resp: Response): Promise<unknown> {
    const text = await resp.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  async request(
    method: string,
    path: string,
    { query, body, ctx }: { query?: Record<string, unknown>; body?: unknown; ctx?: RequestContext } = {}
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    try {
      const resp = await fetch(this.url(path, query), {
        method,
        headers: await this.headers(ctx),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await this.parse(resp);
      if (!resp.ok) throw makeError(resp.status, data, `${method} ${path}`);
      return data;
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw new Error(`${method} ${path} timed out after ${this.cfg.requestTimeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  get(path: string, query?: Record<string, unknown>, ctx?: RequestContext): Promise<unknown> {
    return this.request("GET", path, { query, ctx });
  }
  post(path: string, body?: unknown, ctx?: RequestContext): Promise<unknown> {
    return this.request("POST", path, { body, ctx });
  }
  del(path: string, ctx?: RequestContext): Promise<unknown> {
    return this.request("DELETE", path, { ctx });
  }
}

export interface Clients {
  api: ServiceClient;
  verifier: ServiceClient;
  ingestor: ServiceClient;
  sandbox: ServiceClient;
}

export function buildClients(cfg: Config, auth: AuthProvider): Clients {
  return {
    api: new ServiceClient(cfg.apiUrl, cfg, auth, { withAuth: true }),
    // Internal services sit behind the API normally; they accept x-internal-secret
    // but not the owner JWT. We send the JWT too (harmless) plus the internal secret.
    verifier: new ServiceClient(cfg.verifierUrl, cfg, auth, { withAuth: false }),
    ingestor: new ServiceClient(cfg.ingestorUrl, cfg, auth, { withAuth: false }),
    sandbox: new ServiceClient(cfg.sandboxUrl, cfg, auth, { withAuth: false }),
  };
}
