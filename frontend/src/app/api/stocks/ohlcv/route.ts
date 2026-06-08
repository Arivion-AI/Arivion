export const dynamic = "force-dynamic";

type YahooChart = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
    error?: { description?: string };
  };
};

const STOCKS = new Set(["TSLA", "AMZN", "PLTR", "NVDA", "AMD", "HOOD", "AAPL", "MSFT", "GOOGL", "META", "NFLX"]);

function normalizeSymbol(raw: string | null): string {
  const s = (raw || "TSLA").trim().toUpperCase().replace(/[^A-Z.]/g, "");
  return s.startsWith("D") && STOCKS.has(s.slice(1)) ? s.slice(1) : s;
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const symbol = normalizeSymbol(url.searchParams.get("symbol"));
  const range = url.searchParams.get("range") || "2y";
  const interval = url.searchParams.get("interval") || "1d";
  if (!STOCKS.has(symbol)) {
    return Response.json({ symbol, source: "yahoo_chart", bars: [], error: `Unsupported stock symbol ${symbol}` }, { status: 400 });
  }

  const chartUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
  chartUrl.searchParams.set("range", range);
  chartUrl.searchParams.set("interval", interval);

  try {
    const res = await fetch(chartUrl, {
      cache: "no-store",
      headers: { accept: "application/json", "user-agent": "Duality-Netrunners/1.0" },
    });
    const json = (await res.json()) as YahooChart;
    if (!res.ok || json.chart?.error) {
      return Response.json({
        symbol,
        source: "yahoo_chart",
        bars: [],
        error: json.chart?.error?.description ?? `Yahoo HTTP ${res.status}`,
      }, { status: 502 });
    }

    const r = json.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    const bars = (r?.timestamp ?? []).map((t, i) => {
      const open = num(q?.open?.[i]);
      const high = num(q?.high?.[i]);
      const low = num(q?.low?.[i]);
      const close = num(q?.close?.[i]);
      if (open == null || high == null || low == null || close == null) return null;
      return {
        ts: t * 1000,
        open: String(open),
        high: String(high),
        low: String(low),
        close: String(close),
        volume: String(num(q?.volume?.[i]) ?? 0),
      };
    }).filter(Boolean);

    return Response.json({ symbol, source: "yahoo_chart", bars });
  } catch (e) {
    return Response.json({ symbol, source: "yahoo_chart", bars: [], error: (e as Error).message }, { status: 502 });
  }
}
