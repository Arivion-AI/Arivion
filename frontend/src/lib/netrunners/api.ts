import { NETRUNNERS_PROXY_PREFIX } from "@/lib/netrunners/config";
import { getOwnerToken } from "@/lib/netrunners/session";

async function parseJsonSafe<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// Attach the internal owner JWT (from the MetaMask SIWE sign-in) as `x-owner-token` so the Next
// proxy forwards it as a Bearer. No-op server-side / pre-login.
function withOwnerToken(headers: Record<string, string> = {}): Record<string, string> {
  const tok = getOwnerToken();
  return tok ? { ...headers, "x-owner-token": tok } : headers;
}

async function proxyFetch(path: string, init: RequestInit, baseHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${NETRUNNERS_PROXY_PREFIX}${path}`, { ...init, headers: withOwnerToken(baseHeaders), cache: "no-store" });
}

export async function netrunnersGet<T>(path: string): Promise<T | null> {
  const res = await proxyFetch(path, {});
  if (!res.ok) {
    return null;
  }
  return parseJsonSafe<T>(res);
}

export async function netrunnersGetResult<T>(path: string): Promise<{ ok: boolean; status: number; data: T | null }> {
  const res = await proxyFetch(path, {});
  return { ok: res.ok, status: res.status, data: await parseJsonSafe<T>(res) };
}

export async function netrunnersPost<T, B = unknown>(
  path: string,
  body: B,
): Promise<T | null> {
  const res = await proxyFetch(
    path,
    { method: "POST", body: JSON.stringify(body) },
    { "Content-Type": "application/json" },
  );
  if (!res.ok) {
    return null;
  }
  return parseJsonSafe<T>(res);
}

export async function netrunnersPostResult<T, B = unknown>(
  path: string,
  body: B,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const res = await proxyFetch(
    path,
    { method: "POST", body: JSON.stringify(body) },
    { "Content-Type": "application/json" },
  );
  return { ok: res.ok, status: res.status, data: await parseJsonSafe<T>(res) };
}

export async function netrunnersSend<T>(path: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
  const res = await proxyFetch(
    path,
    { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    body !== undefined ? { "Content-Type": "application/json" } : {},
  );
  return { ok: res.ok, status: res.status, data: await parseJsonSafe<T>(res) };
}

export type HealthResponse = {
  ok?: boolean;
  time?: string;
  service?: string;
};

export type ConcurrencyStats = {
  owner_inflight?: number;
  owner_cap?: number;
  global_inflight?: number;
  global_cap?: number;
  queued_peak?: number;
  p99_ms?: number;
  rejected_total?: number;
};

export type DataHealthRow = {
  symbol: string;
  ageMs: number;
  status: string;
};

export type LivePaperSession = {
  id: string;
  strategy_id?: string;
  symbol?: string;
  status?: string;
  live_return?: number;
  live_pnl?: number;
  live_fills?: number;
  bars_seen?: number;
};

export type LeaderboardRow = {
  card_id?: string;
  title?: string;
  tier?: string;
  rank_score?: number;
  sharpe?: number;
  max_drawdown?: number;
};

export function fmtPct(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }
  return `${(value * 100).toFixed(2)}%`;
}

export function fmtNum(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function fmtUsd(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}`;
}

/** Map a numeric series (e.g. an equity curve) into SparkAreaChart {x,y} points,
 *  scaled into the chart's 600×height viewBox (y inverted so up = profit). */
export function seriesToPoints(
  values: Array<number | string>,
  height = 170,
  pad = 10,
): Array<{ x: number; y: number }> {
  const nums = values
    .map((v) => (typeof v === "string" ? Number(v) : v))
    .filter((v) => typeof v === "number" && !Number.isNaN(v)) as number[];
  if (nums.length === 0) return [];
  if (nums.length === 1) return [{ x: 0, y: height / 2 }, { x: 600, y: height / 2 }];
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const usable = height - pad * 2;
  return nums.map((v, i) => ({
    x: (i / (nums.length - 1)) * 600,
    y: pad + (1 - (v - min) / span) * usable,
  }));
}

/** Subscribe to the live SSE stream through the Next proxy. Returns a close fn. */
export function subscribeStream(
  opts: { topics?: string; symbols?: string; onMessage: (type: string, data: unknown) => void; onError?: () => void },
): () => void {
  const params = new URLSearchParams();
  if (opts.topics) params.set("topics", opts.topics);
  if (opts.symbols) params.set("symbols", opts.symbols);
  const url = `${NETRUNNERS_PROXY_PREFIX}/api/stream?${params.toString()}`;
  const es = new EventSource(url);
  const handler = (ev: MessageEvent) => {
    let parsed: unknown = ev.data;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      /* keep raw */
    }
    opts.onMessage((ev as MessageEvent & { type: string }).type || "message", parsed);
  };
  es.onmessage = handler;
  for (const t of ["price", "bar", "barclose", "session", "prices", "bars", "sessions"]) {
    es.addEventListener(t, handler as EventListener);
  }
  if (opts.onError) es.onerror = () => opts.onError?.();
  return () => es.close();
}

// ---- shared result types used across pages ----
export type Performance = {
  total_return?: number;
  sharpe?: number;
  sortino?: number;
  calmar?: number;
  max_drawdown?: number;
};

export type PaperRuntimeResult = {
  status?: string;
  strategy_id?: string;
  symbol?: string;
  final_equity?: string;
  fill_model?: Record<string, unknown>;
  venue?: Record<string, unknown>;
  truth_card?: Record<string, unknown>;
  events?: Array<{ ts: string; type: string; payload: Record<string, unknown> }>;
  fills?: Array<{ side: string; qty: string; price: string; fee: string; ts: string; is_maker?: boolean }>;
  equity_curve?: string[];
  trade_pnls?: string[];
  performance?: Performance;
  error?: string;
};

export type CandleBar = { ts: number; open: string; high: string; low: string; close: string; volume: string };
export type GmxOhlcvResponse = {
  symbol?: string;
  requestSymbol?: string;
  timeframe?: string;
  source?: "gmx_api";
  bars?: CandleBar[];
  warnings?: string[];
  error?: string;
};
export type StockOhlcvResponse = {
  symbol?: string;
  source?: "yahoo_chart";
  bars?: CandleBar[];
  warnings?: string[];
  error?: string;
};

/** Fetch candles for a symbol, auto-backfilling from Bybit on demand if we don't hold enough.
 *  Returns the bars (possibly empty if the symbol genuinely has no Bybit data). */
export async function getCandlesEnsured(
  symbol: string, category: string, interval: string, minBars = 200,
): Promise<CandleBar[]> {
  const url = `/api/candles?symbol=${encodeURIComponent(symbol)}&category=${category}&interval=${interval}&limit=400`;
  let c = await netrunnersGet<{ bars?: CandleBar[] }>(url);
  let bars = c?.bars ?? [];
  if (bars.length < minBars) {
    await netrunnersPost<{ ok?: boolean; count?: number }, Record<string, unknown>>(
      "/api/candles/ensure", { symbol, category, interval, minBars },
    );
    c = await netrunnersGet<{ bars?: CandleBar[] }>(url);
    bars = c?.bars ?? [];
  }
  return bars;
}

export async function getGmxOhlcvEnsured(symbol: string, interval: string, minBars = 120): Promise<GmxOhlcvResponse> {
  const timeframe = interval === "D" ? "1d" : interval === "240" ? "4h" : interval === "60" ? "1h" : interval;
  const res = await fetch(`/api/gmx/ohlcv?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=400`, { cache: "no-store" });
  const json = await parseJsonSafe<GmxOhlcvResponse>(res);
  if (res.ok && (json?.bars?.length ?? 0) >= Math.min(30, minBars)) return json ?? { bars: [] };
  return json ?? { bars: [], error: `GMX OHLCV HTTP ${res.status}` };
}

/** A funding-rate sample in the shape the worker's paper runtime expects (`funding_rows`). */
export type GmxFundingRow = { id: string; timestamp: number; funding_rate: string };

/** Fetch GMX-native funding history for a perp, auto-backfilling (source='gmx') on demand.
 *  Returns rows aligned to the requested timeframe; empty if GMX funding coverage is missing.
 *  `bars` is the OHLCV series the run will use — when non-empty we ensure funding covers it. */
export async function getGmxFundingEnsured(symbol: string, interval: string, bars: CandleBar[]): Promise<GmxFundingRow[]> {
  const timeframe = interval === "D" ? "1d" : interval === "240" ? "4h" : interval === "60" ? "1h" : interval;
  // Align funding rows to the candle window so the runtime applies funding on the backtested bars.
  const range = bars.length ? `&from=${bars[0].ts}&to=${bars[bars.length - 1].ts}` : "";
  const url = `/api/gmx/funding?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=400${range}`;
  let res = await fetch(url, { cache: "no-store" });
  let json = await parseJsonSafe<{ rows?: GmxFundingRow[] }>(res);
  let rows = json?.rows ?? [];
  // Backfill when a run needs funding coverage we don't yet hold for this symbol/timeframe.
  if (rows.length < Math.min(30, bars.length)) {
    await fetch("/api/gmx/funding/ensure", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, timeframe, minRows: Math.min(bars.length, 400) }),
    }).catch(() => undefined);
    res = await fetch(url, { cache: "no-store" });
    json = await parseJsonSafe<{ rows?: GmxFundingRow[] }>(res);
    rows = json?.rows ?? [];
  }
  return rows;
}

export async function getStockOhlcvEnsured(symbol: string, minBars = 120): Promise<StockOhlcvResponse> {
  const res = await fetch(`/api/stocks/ohlcv?symbol=${encodeURIComponent(symbol)}&range=2y&interval=1d`, { cache: "no-store" });
  const json = await parseJsonSafe<StockOhlcvResponse>(res);
  if (res.ok && (json?.bars?.length ?? 0) >= Math.min(30, minBars)) return json ?? { bars: [] };
  return json ?? { symbol, bars: [], error: `Stock OHLCV HTTP ${res.status}` };
}

export type PortfolioResult = {
  final_equity?: number | string;
  equity_curve?: Array<number | string>;
  rebalances?: number;
  weights_history?: Array<Record<string, unknown>>;
  fills?: Array<Record<string, unknown>>;
  risk_notes?: string[];
  errors?: string[];
  error?: string;
};
