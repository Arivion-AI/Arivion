// Minimal SSE client for the lab's GET /api/stream endpoint. Auth is via the
// ?token= query (EventSource can't set headers; the API supports ?token=).

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface CollectOptions {
  baseUrl: string;
  token: string;
  topics?: string;
  symbols?: string;
  maxEvents?: number;
  timeoutMs?: number;
}

/** Open the SSE stream, collect up to maxEvents (or until timeoutMs), then close. */
export async function collectStream(opts: CollectOptions): Promise<SseEvent[]> {
  const url = new URL("/api/stream", opts.baseUrl);
  if (opts.topics) url.searchParams.set("topics", opts.topics);
  if (opts.symbols) url.searchParams.set("symbols", opts.symbols);
  url.searchParams.set("token", opts.token);

  const maxEvents = opts.maxEvents ?? 10;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events: SseEvent[] = [];

  try {
    const resp = await fetch(url.toString(), { headers: { Accept: "text/event-stream" }, signal: controller.signal });
    if (!resp.ok || !resp.body) throw new Error(`SSE connect failed: HTTP ${resp.status}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (events.length < maxEvents) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        let ev = "message";
        let data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (ev === "heartbeat") continue;
        let parsed: unknown = data;
        try {
          parsed = JSON.parse(data);
        } catch {
          /* keep raw */
        }
        events.push({ event: ev, data: parsed });
        if (events.length >= maxEvents) break;
      }
    }
    reader.cancel().catch(() => undefined);
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  } finally {
    clearTimeout(timer);
  }
  return events;
}
