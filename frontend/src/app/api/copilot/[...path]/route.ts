import { runtimeCopilotConfig } from "@/lib/copilot/config";

// Copilot proxy. Mirrors the /api/netrunners/[...path] proxy: the browser sends the internal owner
// JWT (minted by SIWE sign-in) as `x-owner-token`; the proxy forwards it as a Bearer to the AGENT
// service. Supports SSE (streamed response bodies pass straight through). The owner token verifies
// on the agent because both share JWT_SECRET.

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailers", "transfer-encoding", "upgrade", "host", "content-length",
]);

let cachedDevToken: { value: string; expiresAt: number } | null = null;

async function resolveAuthHeader(req: Request): Promise<string | null> {
  const ownerToken = req.headers.get("x-owner-token");
  if (ownerToken) return `Bearer ${ownerToken}`;
  if (runtimeCopilotConfig.staticToken) return `Bearer ${runtimeCopilotConfig.staticToken}`;
  if (process.env.COPILOT_DISABLE_DEV_TOKEN === "true" || process.env.NETRUNNERS_DISABLE_DEV_TOKEN === "true") return null;
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
  upstreamHeaders.delete("x-owner-token");

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
