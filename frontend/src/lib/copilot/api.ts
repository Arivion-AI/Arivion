import { COPILOT_PROXY_PREFIX } from "@/lib/copilot/config";
import { getOwnerToken } from "@/lib/netrunners/session";

// Client helpers for the Copilot proxy. The owner JWT (from MetaMask SIWE) is attached as
// x-owner-token so the proxy forwards it as a Bearer. SSE uses fetch + a stream reader (NOT
// EventSource, which can't set the auth header).

function withAuth(headers: Record<string, string> = {}): Record<string, string> {
  const tok = getOwnerToken();
  return tok ? { ...headers, "x-owner-token": tok } : headers;
}

export async function copilotGet<T>(path: string): Promise<T | null> {
  const res = await fetch(`${COPILOT_PROXY_PREFIX}${path}`, { headers: withAuth(), cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

export async function copilotPost<T, B = unknown>(path: string, body: B): Promise<T | null> {
  const res = await fetch(`${COPILOT_PROXY_PREFIX}${path}`, {
    method: "POST",
    headers: withAuth({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

export async function copilotPut<T, B = unknown>(path: string, body: B): Promise<T | null> {
  const res = await fetch(`${COPILOT_PROXY_PREFIX}${path}`, {
    method: "PUT",
    headers: withAuth({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

export async function copilotDelete<T, B = unknown>(path: string, body?: B): Promise<T | null> {
  const res = await fetch(`${COPILOT_PROXY_PREFIX}${path}`, {
    method: "DELETE",
    headers: withAuth({ "Content-Type": "application/json" }),
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

export interface CopilotEvent {
  event: string;
  data: Record<string, unknown>;
}

// Stream a run's SSE trace. Calls onEvent for each frame; resolves when the stream ends. Returns an
// abort function.
export function streamRun(
  runId: string,
  onEvent: (ev: CopilotEvent) => void,
): { done: Promise<void>; abort: () => void } {
  const controller = new AbortController();
  const done = (async () => {
    const headers = withAuth();
    const res = await fetch(`${COPILOT_PROXY_PREFIX}/stream?runId=${encodeURIComponent(runId)}`, {
      headers,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseFrame(frame);
        if (ev) onEvent(ev);
      }
    }
  })().catch(() => {});
  return { done, abort: () => controller.abort() };
}

function parseFrame(frame: string): CopilotEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    // lines beginning with ':' are comments (e.g. the initial ": connected") — ignore.
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
  } catch {
    return null;
  }
}

// --- typed response shapes ---
export interface CreditsResponse {
  managedBalanceMicroUsd: number;
  managedBalanceUsd: number;
  lifetimeSpendMicroUsd: number;
  status: string;
}
export interface ThreadResponse {
  id: string;
  title: string | null;
  autonomy_level: string;
}
