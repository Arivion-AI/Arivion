export const dynamic = "force-dynamic";

// GMX-native funding series for backtests. Mirrors the /api/gmx/ohlcv route: data is fetched live
// from GMX (no Bybit) and returned as `funding_rows` the worker's paper runtime understands
// ({ id, timestamp(ms), funding_rate }). The Quants Lab passes these inline in the run payload, the
// same way it passes GMX candles — so no Bybit funding table is ever touched.
//
// Source of truth: GMX exposes the *current* annualized funding rate per market via the public
// /pairs feed. We project that rate across the requested window at the bar cadence. This is an
// honest, Bybit-free funding model (labeled `gmx_snapshot_projected`). True per-bar historical
// funding lives in the GMX Synthetics Subsquid; see SUBSQUID_NOTE below for the extension point.

type Pair = {
  ticker_id?: string;
  base_currency?: string;
  target_currency?: string;
  funding_rate?: string | number;
};

const BASES = ["https://arbitrum.gmxapi.io/v1", "https://arbitrum.gmxapi.ai/v1"];
const MINUTES_PER_YEAR = 365 * 24 * 60;

// SUBSQUID_NOTE: to replace the projection with real history, query
// https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql for per-interval funding factors
// over [from,to] and emit one row per interval. Until that query is verified against the live
// schema, we keep the snapshot projection rather than risk returning silently-wrong numbers.

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeBase(symbol: string): string {
  return (symbol || "BTC").replace(/\[[^\]]+\]/g, "").replace(/\/USD.*/i, "").replace(/USDT?$/i, "").replace(/PERP$/i, "").trim().toUpperCase();
}

function intervalMinutes(timeframe: string): number {
  const v = (timeframe || "1h").toLowerCase();
  if (v === "1d" || v === "d" || v === "day") return 1440;
  if (v === "4h" || v === "240") return 240;
  if (v === "1h" || v === "60") return 60;
  if (v === "15m" || v === "15") return 15;
  if (v === "5m" || v === "5") return 5;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

async function fetchPairs(): Promise<Pair[]> {
  let last = "";
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/pairs`, { cache: "no-store", headers: { accept: "application/json" } });
      if (!res.ok) {
        last = `${res.status} ${await res.text().catch(() => "")}`;
        continue;
      }
      const json = await res.json();
      return Array.isArray(json) ? (json as Pair[]) : [];
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(last || "GMX pairs unavailable");
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const base = normalizeBase(url.searchParams.get("symbol") ?? "BTC");
  const timeframe = (url.searchParams.get("timeframe") ?? url.searchParams.get("interval") ?? "1h").toLowerCase();
  const stepMin = intervalMinutes(timeframe);
  const stepMs = stepMin * 60_000;
  const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") ?? 400) || 400));
  const from = Number(url.searchParams.get("from") ?? 0) || 0;
  const to = Number(url.searchParams.get("to") ?? 0) || 0;
  const warnings: string[] = [];

  let annualFrac = 0;
  try {
    const pairs = await fetchPairs();
    const match =
      pairs.find((p) => String(p.base_currency ?? "").toUpperCase() === base) ??
      pairs.find((p) => String(p.ticker_id ?? "").toUpperCase().startsWith(`${base}/USD`));
    if (!match) {
      warnings.push(`No GMX pair for ${base}; funding defaults to 0.`);
    } else {
      const raw = num(match.funding_rate);
      // GMX /pairs reports the funding rate; normalize percent-vs-fraction (e.g. 15 ⇒ 0.15/yr).
      annualFrac = Math.abs(raw) > 1 ? raw / 100 : raw;
    }
  } catch (e) {
    warnings.push(`GMX funding unavailable: ${(e as Error).message}; funding defaults to 0.`);
  }

  // Per-interval rate applied at each bar timestamp (longs pay shorts when positive).
  const perInterval = annualFrac * (stepMin / MINUTES_PER_YEAR);

  // Align the funding series to the bar window when the caller passes [from,to]; otherwise emit
  // `limit` rows ending at the most recent step boundary.
  const start = from > 0 ? Math.floor(from / stepMs) * stepMs : Math.floor((to > 0 ? to : Date.now()) / stepMs) * stepMs - (limit - 1) * stepMs;
  const end = to > 0 ? to : start + (limit - 1) * stepMs;
  const rows: Array<{ id: string; timestamp: number; funding_rate: string }> = [];
  for (let ts = start; ts <= end && rows.length < 2000; ts += stepMs) {
    rows.push({ id: `gmx_${base}_${ts}`, timestamp: ts, funding_rate: perInterval.toFixed(12) });
  }

  return Response.json({
    symbol: base,
    timeframe,
    source: "gmx_snapshot_projected",
    annual_funding_fraction: annualFrac,
    per_interval_rate: perInterval,
    rows,
    warnings,
  });
}
