import { config } from "../config.js";
import { logger } from "../logger.js";

// Phase 29 — Bybit v5 public historical candles for the analysis engine. Same venue + auth posture as
// market/scanner.ts (public, no key). Bybit returns klines NEWEST-FIRST; we reverse to oldest→newest
// so the indicator math (indicators.ts, which expects chronological series) is correct.

export interface Kline {
  ts: number; // open time (ms)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KlineSeries {
  symbol: string;
  category: "linear" | "spot";
  interval: string;
  bars: Kline[];
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
}

// Fetch up to `limit` candles (Bybit caps at 1000). `interval`: "D" daily, "240" 4h, "60" 1h, etc.
// Optional `window` {start,end} (ms) pulls a specific historical range — used to self-source labelled
// bull/bear regime windows directly from Bybit for ANY token that traded then (not just the catalog).
export async function fetchKlines(
  symbol: string,
  category: "linear" | "spot",
  interval = "D",
  limit = 90,
  window?: { start?: number; end?: number },
): Promise<KlineSeries> {
  const range = `${window?.start ? `&start=${window.start}` : ""}${window?.end ? `&end=${window.end}` : ""}`;
  const url = `${config.bybitBaseUrl}/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${Math.min(limit, 1000)}${range}`;
  const resp = await fetch(url, { headers: { "User-Agent": "DualityCopilot/1.0" }, signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`bybit kline ${symbol} ${category} -> ${resp.status}`);
  const json = (await resp.json()) as { result?: { list?: string[][] } };
  // Each row: [startTime, open, high, low, close, volume, turnover] — strings, newest first.
  const rows = (json.result?.list ?? []).slice().reverse();
  const bars: Kline[] = [];
  for (const r of rows) {
    const ts = Number(r[0]);
    const open = Number(r[1]);
    const high = Number(r[2]);
    const low = Number(r[3]);
    const close = Number(r[4]);
    const volume = Number(r[5]);
    if (!Number.isFinite(close) || close <= 0) continue;
    bars.push({ ts, open, high, low, close, volume });
  }
  return {
    symbol, category, interval, bars,
    opens: bars.map((b) => b.open),
    highs: bars.map((b) => b.high),
    lows: bars.map((b) => b.low),
    closes: bars.map((b) => b.close),
    volumes: bars.map((b) => b.volume),
  };
}

// Best-effort variant: never throws (returns an empty series on failure) so the engine can fan out
// across many candidates without one bad symbol aborting the whole screen.
export async function tryFetchKlines(symbol: string, category: "linear" | "spot", interval = "D", limit = 90, window?: { start?: number; end?: number }): Promise<KlineSeries> {
  try {
    return await fetchKlines(symbol, category, interval, limit, window);
  } catch (e) {
    logger.warn("kline fetch failed", { symbol, category, interval, message: (e as Error).message });
    return { symbol, category, interval, bars: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
  }
}

// Convert Bybit candles to the `run_portfolio` leg-bar shape (RuntimeBarPayload: ts:int + OHLCV as
// strings). Lets the multiasset engine self-source bars from Bybit when the Lab has none.
export function toEngineBars(s: KlineSeries): Array<Record<string, unknown>> {
  return s.bars.map((b) => ({ ts: b.ts, open: String(b.open), high: String(b.high), low: String(b.low), close: String(b.close), volume: String(b.volume) }));
}

function seriesFrom(symbol: string, category: "linear" | "spot", interval: string, bars: Kline[]): KlineSeries {
  return {
    symbol, category, interval, bars,
    opens: bars.map((b) => b.open), highs: bars.map((b) => b.high), lows: bars.map((b) => b.low),
    closes: bars.map((b) => b.close), volumes: bars.map((b) => b.volume),
  };
}

// Fetch a token's FULL available history by paging backwards (Bybit caps each call at 1000). Used for
// regime detection across all years. Best-effort; returns oldest→newest, deduped. `maxBars` bounds it.
export async function fetchKlinesPaged(symbol: string, category: "linear" | "spot", interval = "D", maxBars = 2500): Promise<KlineSeries> {
  const byTs = new Map<number, Kline>();
  let end: number | undefined;
  for (let page = 0; page < Math.ceil(maxBars / 1000) + 2 && byTs.size < maxBars; page++) {
    const s = await tryFetchKlines(symbol, category, interval, 1000, end ? { end } : undefined);
    if (!s.bars.length) break;
    for (const b of s.bars) byTs.set(b.ts, b);
    if (s.bars.length < 1000) break; // reached the listing start
    end = s.bars[0].ts - 1; // page older
  }
  const bars = [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-maxBars);
  return seriesFrom(symbol, category, interval, bars);
}
