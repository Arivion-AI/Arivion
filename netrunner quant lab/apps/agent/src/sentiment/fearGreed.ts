import { logger } from "../logger.js";

// Crypto FEAR & GREED index adapter (alternative.me — free, no key). Returns the current reading + the
// prior day's so the briefing can show the trend (↑/↓). Honest-by-construction: a dark/failed feed
// returns null (the consumer omits the line) rather than a fabricated number. Cached in-process.

export interface FearGreed {
  value: number;                 // 0..100
  classification: string;        // e.g. "Greed", "Extreme Fear"
  previous: number | null;       // yesterday's value (for the trend arrow)
  trend: "up" | "down" | "flat";
  as_of: string;
}

const TTL_MS = 10 * 60_000; // F&G updates ~daily; 10-min cache is plenty.
let cache: { at: number; value: FearGreed | null } | null = null;

export async function getFearGreed(): Promise<FearGreed | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=2&format=json", {
      headers: { "User-Agent": "DualityCopilot/1.0" }, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`fng HTTP ${res.status}`);
    const j = (await res.json()) as { data?: Array<{ value: string; value_classification: string; timestamp: string }> };
    const rows = j.data ?? [];
    if (!rows.length) throw new Error("fng empty");
    const value = Number(rows[0].value);
    const previous = rows[1] != null ? Number(rows[1].value) : null;
    const fg: FearGreed = {
      value,
      classification: rows[0].value_classification ?? "",
      previous: Number.isFinite(previous as number) ? previous : null,
      trend: previous == null ? "flat" : value > previous ? "up" : value < previous ? "down" : "flat",
      as_of: new Date().toISOString(),
    };
    cache = { at: Date.now(), value: fg };
    return fg;
  } catch (e) {
    logger.warn("fear&greed fetch failed", { message: (e as Error).message });
    cache = { at: Date.now(), value: null }; // negative-cache so we don't hammer a dark feed
    return null;
  }
}
