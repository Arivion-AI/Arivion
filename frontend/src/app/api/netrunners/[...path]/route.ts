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

async function resolveAuthHeader(req: Request): Promise<string | null> {
  // 1) Real users: the internal owner JWT minted by SIWE sign-in, sent as `x-owner-token`. The
  //    browser does the /auth/session handshake itself; the proxy just forwards the Bearer.
  const ownerToken = req.headers.get("x-owner-token");
  if (ownerToken) {
    return `Bearer ${ownerToken}`;
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
  const method = req.method.toUpperCase();
  const readOnlyFallback = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (!readOnlyFallback) {
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
  if (pathParts.join("/") === "auth/dev-token") {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }
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
  // The owner token is consumed to build the Authorization header — never forwarded upstream as-is.
  upstreamHeaders.delete("x-owner-token");

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
