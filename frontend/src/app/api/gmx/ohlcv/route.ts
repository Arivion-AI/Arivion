export const dynamic = "force-dynamic";

type RawBar = Record<string, unknown>;
type GmxPair = {
  ticker_id?: string;
  base_currency?: string;
  product_type?: string;
  liquidity?: string | number;
  open_interest?: string | number;
};

const BASES = ["https://arbitrum.gmxapi.io/v1", "https://arbitrum.gmxapi.ai/v1"];

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeBase(symbol: string): string {
  return (symbol || "BTC").replace(/\[[^\]]+\]/g, "").replace(/\/USD.*/i, "").replace(/USDT?$/i, "").replace(/PERP$/i, "").trim().toUpperCase();
}

function timeframeOf(raw: string | null): string {
  const v = (raw || "1h").toLowerCase();
  if (v === "d" || v === "1d" || v === "day") return "1d";
  if (v === "240" || v === "4h") return "4h";
  if (v === "60" || v === "1h") return "1h";
  if (v === "15" || v === "15m") return "15m";
  if (v === "5" || v === "5m") return "5m";
  return v;
}

async function gmxGet<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  let last = "";
  for (const base of BASES) {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
    try {
      const res = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
      if (!res.ok) {
        last = `${res.status} ${await res.text().catch(() => "")}`;
        continue;
      }
      return (await res.json()) as T;
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(last || `GMX ${path} unavailable`);
}

async function bestPair(base: string): Promise<string | null> {
  const pairs = await gmxGet<GmxPair[]>("/pairs").catch(() => []);
  const matches = pairs.filter((p) => String(p.base_currency ?? "").toUpperCase() === base || String(p.ticker_id ?? "").toUpperCase().startsWith(`${base}/USD`));
  matches.sort((a, b) => num(b.open_interest ?? b.liquidity) - num(a.open_interest ?? a.liquidity));
  return matches[0]?.ticker_id ?? null;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const base = normalizeBase(url.searchParams.get("symbol") ?? "BTC");
  const timeframe = timeframeOf(url.searchParams.get("timeframe") ?? url.searchParams.get("interval"));
  const limit = Math.max(30, Math.min(1000, Number(url.searchParams.get("limit") ?? 400) || 400));
  const pair = await bestPair(base);
  const candidates = Array.from(new Set([base, pair, `${base}/USD`].filter(Boolean))) as string[];
  const warnings: string[] = [];

  for (const requestSymbol of candidates) {
    try {
      const raw = await gmxGet<RawBar[]>("/prices/ohlcv", { symbol: requestSymbol, timeframe, limit });
      const bars = (raw ?? []).map((b) => ({
        ts: num(b.timestamp ?? b.t ?? b.time),
        open: String(num(b.open ?? b.o)),
        high: String(num(b.high ?? b.h)),
        low: String(num(b.low ?? b.l)),
        close: String(num(b.close ?? b.c)),
        volume: String(num(b.volume ?? b.v)),
      })).filter((b) => b.ts && Number(b.close) > 0).sort((a, b) => a.ts - b.ts);
      if (bars.length) {
        return Response.json({ symbol: base, requestSymbol, timeframe, source: "gmx_api", bars, warnings });
      }
      warnings.push(`${requestSymbol}: empty`);
    } catch (e) {
      warnings.push(`${requestSymbol}: ${(e as Error).message}`);
    }
  }

  return Response.json({ symbol: base, timeframe, source: "gmx_api", bars: [], warnings, error: `No GMX OHLCV for ${base}` }, { status: 404 });
}
