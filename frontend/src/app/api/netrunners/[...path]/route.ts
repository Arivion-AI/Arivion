import { runtimeNetrunnersConfig } from "@/lib/netrunners/config";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

let cachedDevToken: { value: string; expiresAt: number } | null = null;
// §25 — internal owner tokens obtained by exchanging a Privy access token, keyed by the Privy token.
const ownerTokenByPrivy = new Map<string, { value: string; expiresAt: number }>();
// Bound the cache: Privy access tokens rotate (~hourly), so without eviction this Map grows
// unbounded over the life of the server process. Sweep expired entries on each exchange, and cap
// the total size (dropping the oldest, since Map preserves insertion order) as a hard backstop.
const OWNER_TOKEN_CACHE_MAX = 1000;
function sweepOwnerTokenCache(now: number): void {
  for (const [k, v] of ownerTokenByPrivy) {
    if (v.expiresAt <= now) ownerTokenByPrivy.delete(k);
  }
  while (ownerTokenByPrivy.size > OWNER_TOKEN_CACHE_MAX) {
    const oldest = ownerTokenByPrivy.keys().next().value;
    if (oldest === undefined) break;
    ownerTokenByPrivy.delete(oldest);
  }
}

// §25 P1 — exchange a Privy access token (sent by the browser as `x-privy-token`) for the internal
// owner token via POST /auth/session. The browser never holds the internal token; the proxy does.
async function exchangePrivyToken(privyToken: string): Promise<string | null> {
  const now = Date.now();
  sweepOwnerTokenCache(now);
  const cached = ownerTokenByPrivy.get(privyToken);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const sessionUrl = new URL("/auth/session", runtimeNetrunnersConfig.baseUrl);
  const resp = await fetch(sessionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ privyToken }),
    cache: "no-store",
  });
  if (!resp.ok) {
    // Surface WHY the Privy token-exchange failed (PRIVY_TOKEN_INVALID / _EXPIRED / NOT_CONFIGURED …)
    // instead of swallowing it — shows up in the dev server console for diagnosis.
    const body = await resp.text().catch(() => "");
    console.warn(`[netrunners proxy] /auth/session exchange failed: HTTP ${resp.status} ${body}`);
    return null; // expired/invalid Privy token -> client should getAccessToken() again.
  }
  const json = (await resp.json()) as { ownerToken?: string };
  if (!json.ownerToken) {
    return null;
  }
  ownerTokenByPrivy.set(privyToken, { value: json.ownerToken, expiresAt: Date.now() + 5 * 60_000 });
  return json.ownerToken;
}

async function resolveAuthHeader(req: Request): Promise<string | null> {
  // 1) Real users: a Privy access token from the browser -> token-exchange.
  const privyToken = req.headers.get("x-privy-token");
  if (privyToken) {
    const ownerToken = await exchangePrivyToken(privyToken);
    return ownerToken ? `Bearer ${ownerToken}` : null;
  }

  // 2) A pre-supplied static token (e.g. server-to-server).
  if (runtimeNetrunnersConfig.staticToken) {
    return `Bearer ${runtimeNetrunnersConfig.staticToken}`;
  }

  // 3) Dev/CI fallback: mint a dev token. Gated to dev by the API (ALLOW_DEV_TOKEN + non-default
  //    secret); disable in prod by setting NETRUNNERS_DISABLE_DEV_TOKEN.
  if (process.env.NETRUNNERS_DISABLE_DEV_TOKEN === "true") {
    return null;
  }
  if (cachedDevToken && cachedDevToken.expiresAt > Date.now()) {
    return `Bearer ${cachedDevToken.value}`;
  }

  const tokenUrl = new URL("/auth/dev-token", runtimeNetrunnersConfig.baseUrl);
  tokenUrl.searchParams.set("ownerId", runtimeNetrunnersConfig.ownerId);

  const tokenResponse = await fetch(tokenUrl, { cache: "no-store" });
  if (!tokenResponse.ok) {
    return null;
  }

  const tokenJson = (await tokenResponse.json()) as { token?: string };
  if (!tokenJson.token) {
    return null;
  }

  cachedDevToken = {
    value: tokenJson.token,
    expiresAt: Date.now() + 5 * 60_000,
  };
  return `Bearer ${tokenJson.token}`;
}

function buildTargetUrl(pathParts: string[], req: Request): URL {
  const joined = pathParts.join("/");
  const target = new URL(`/${joined}`, runtimeNetrunnersConfig.baseUrl);

  const requestUrl = new URL(req.url);
  requestUrl.searchParams.forEach((value, key) => {
    target.searchParams.append(key, value);
  });

  return target;
}

async function proxyToNetrunners(req: Request, pathParts: string[]): Promise<Response> {
  const targetUrl = buildTargetUrl(pathParts, req);
  const upstreamHeaders = new Headers();

  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower)) {
      upstreamHeaders.set(key, value);
    }
  });

  if (!upstreamHeaders.has("authorization")) {
    const authHeader = await resolveAuthHeader(req);
    if (authHeader) {
      upstreamHeaders.set("authorization", authHeader);
    }
  }
  // The Privy token is consumed for exchange only — never forwarded upstream.
  upstreamHeaders.delete("x-privy-token");

  const method = req.method.toUpperCase();
  const canHaveBody = method !== "GET" && method !== "HEAD";
  const body = canHaveBody ? await req.arrayBuffer() : undefined;

  const upstream = await fetch(targetUrl, {
    method,
    headers: upstreamHeaders,
    body: body ? body : undefined,
    redirect: "manual",
  });

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export async function GET(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const params = await context.params;
  return proxyToNetrunners(req, params.path ?? []);
}

export async function POST(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const params = await context.params;
  return proxyToNetrunners(req, params.path ?? []);
}

export async function PUT(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const params = await context.params;
  return proxyToNetrunners(req, params.path ?? []);
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const params = await context.params;
  return proxyToNetrunners(req, params.path ?? []);
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const params = await context.params;
  return proxyToNetrunners(req, params.path ?? []);
}

export async function OPTIONS(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const params = await context.params;
  return proxyToNetrunners(req, params.path ?? []);
}
