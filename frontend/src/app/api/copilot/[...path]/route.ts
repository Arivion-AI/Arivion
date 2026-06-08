import { runtimeCopilotConfig } from "@/lib/copilot/config";

// Copilot proxy. Mirrors the /api/netrunners/[...path] proxy (Privy access token in x-privy-token →
// internal owner token via the Lab API /auth/session), but forwards the Bearer to the AGENT service.
// The browser never holds the owner token. Supports SSE (streamed response bodies pass straight
// through). The owner token verifies on the agent because both share JWT_SECRET.

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailers", "transfer-encoding", "upgrade", "host", "content-length",
]);

let cachedDevToken: { value: string; expiresAt: number } | null = null;
const ownerTokenByPrivy = new Map<string, { value: string; expiresAt: number }>();
const OWNER_TOKEN_CACHE_MAX = 1000;

function sweep(now: number): void {
  for (const [k, v] of ownerTokenByPrivy) if (v.expiresAt <= now) ownerTokenByPrivy.delete(k);
  while (ownerTokenByPrivy.size > OWNER_TOKEN_CACHE_MAX) {
    const oldest = ownerTokenByPrivy.keys().next().value;
    if (oldest === undefined) break;
    ownerTokenByPrivy.delete(oldest);
  }
}

async function exchangePrivyToken(privyToken: string): Promise<string | null> {
  const now = Date.now();
  sweep(now);
  const cached = ownerTokenByPrivy.get(privyToken);
  if (cached && cached.expiresAt > now) return cached.value;
  const resp = await fetch(new URL("/auth/session", runtimeCopilotConfig.authBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ privyToken }),
    cache: "no-store",
  });
  if (!resp.ok) return null;
  const json = (await resp.json()) as { ownerToken?: string };
  if (!json.ownerToken) return null;
  ownerTokenByPrivy.set(privyToken, { value: json.ownerToken, expiresAt: Date.now() + 5 * 60_000 });
  return json.ownerToken;
}

async function resolveAuthHeader(req: Request): Promise<string | null> {
  const privyToken = req.headers.get("x-privy-token");
  if (privyToken) {
    const ownerToken = await exchangePrivyToken(privyToken);
    return ownerToken ? `Bearer ${ownerToken}` : null;
  }
  if (runtimeCopilotConfig.staticToken) return `Bearer ${runtimeCopilotConfig.staticToken}`;
  if (process.env.NETRUNNERS_DISABLE_DEV_TOKEN === "true") return null;
  if (cachedDevToken && cachedDevToken.expiresAt > Date.now()) return `Bearer ${cachedDevToken.value}`;
  const tokenUrl = new URL("/auth/dev-token", runtimeCopilotConfig.authBaseUrl);
  tokenUrl.searchParams.set("ownerId", runtimeCopilotConfig.ownerId);
  const tokenResponse = await fetch(tokenUrl, { cache: "no-store" });
  if (!tokenResponse.ok) return null;
  const tokenJson = (await tokenResponse.json()) as { token?: string };
  if (!tokenJson.token) return null;
  cachedDevToken = { value: tokenJson.token, expiresAt: Date.now() + 5 * 60_000 };
  return `Bearer ${tokenJson.token}`;
}

function buildTargetUrl(pathParts: string[], req: Request): URL {
  const target = new URL(`/api/copilot/${pathParts.join("/")}`, runtimeCopilotConfig.agentBaseUrl);
  new URL(req.url).searchParams.forEach((value, key) => target.searchParams.append(key, value));
  return target;
}

async function proxy(req: Request, pathParts: string[]): Promise<Response> {
  const targetUrl = buildTargetUrl(pathParts, req);
  const upstreamHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) upstreamHeaders.set(key, value);
  });
  if (!upstreamHeaders.has("authorization")) {
    const authHeader = await resolveAuthHeader(req);
    if (authHeader) upstreamHeaders.set("authorization", authHeader);
  }
  upstreamHeaders.delete("x-privy-token");

  const method = req.method.toUpperCase();
  const canHaveBody = method !== "GET" && method !== "HEAD";
  const body = canHaveBody ? await req.arrayBuffer() : undefined;

  const upstream = await fetch(targetUrl, {
    method,
    headers: upstreamHeaders,
    body: body ? body : undefined,
    redirect: "manual",
    // @ts-expect-error Node fetch streaming flag for SSE responses
    duplex: "half",
  });

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });
  // Stream the body through unbuffered (SSE).
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

type Ctx = { params: Promise<{ path: string[] }> };
const handler = async (req: Request, context: Ctx): Promise<Response> => {
  const params = await context.params;
  return proxy(req, params.path ?? []);
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
export const OPTIONS = handler;
