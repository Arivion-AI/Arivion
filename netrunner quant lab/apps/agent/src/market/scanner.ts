import { config } from "../config.js";
import { logger } from "../logger.js";
import { getArbitrumUniverse } from "./arbitrumUniverse.js";

// Phase 19 — real-time MARKET AWARENESS. A Bybit-native, full-universe screener so the agent actually
// knows "how is the market right now" and "what are the best tokens now" — not just the curated set
// of symbols the Lab has ingested. Uses Bybit's public v5 tickers (no auth): 24h %, turnover, funding,
// open interest, high/low. This is the live market surface; the Lab's candles remain the backtest source.

export interface Ticker {
  symbol: string;
  base: string;
  last: number;
  pct24h: number; // 24h price change %
  turnover24h: number; // 24h quote turnover (USD-ish)
  volume24h: number;
  funding: number | null;
  oi_value: number | null;
  high24h: number;
  low24h: number;
  range24h: number; // (high-low)/last — intraday range as a volatility proxy
}

// A clean USDT perp/spot symbol (drop dated-expiry contracts like MNTUSDT-12JUN26, PERP aliases, etc.).
const CLEAN = /^[A-Z0-9]+USDT$/;

export async function fetchTickers(category: "linear" | "spot"): Promise<Ticker[]> {
  const resp = await fetch(`${config.bybitBaseUrl}/v5/market/tickers?category=${category}`, {
    headers: { "User-Agent": "DualityCopilot/1.0" }, signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`bybit tickers ${category} -> ${resp.status}`);
  const json = (await resp.json()) as { result?: { list?: Array<Record<string, string>> } };
  const list = json.result?.list ?? [];
  const out: Ticker[] = [];
  for (const t of list) {
    const symbol = t.symbol ?? "";
    if (!CLEAN.test(symbol)) continue;
    const last = Number(t.lastPrice);
    if (!Number.isFinite(last) || last <= 0) continue;
    const high = Number(t.highPrice24h) || last;
    const low = Number(t.lowPrice24h) || last;
    out.push({
      symbol, base: symbol.replace(/USDT$/, ""), last,
      pct24h: (Number(t.price24hPcnt) || 0) * 100,
      turnover24h: Number(t.turnover24h) || 0, volume24h: Number(t.volume24h) || 0,
      funding: t.fundingRate != null && t.fundingRate !== "" ? Number(t.fundingRate) : null,
      oi_value: t.openInterestValue != null ? Number(t.openInterestValue) : null,
      high24h: high, low24h: low, range24h: last > 0 ? (high - low) / last : 0,
    });
  }
  return out;
}

export function regimeOf(pct24h: number, range24h: number): string {
  const vol = range24h > 0.08 ? "high_vol" : range24h > 0.03 ? "normal_vol" : "low_vol";
  const dir = pct24h > 3 ? "up" : pct24h < -3 ? "down" : "flat";
  return `${dir}/${vol}`;
}

export type ScanSort = "volume" | "gainers" | "losers" | "volatility" | "funding" | "best";

export interface ScanResult {
  category: string;
  sort: ScanSort;
  as_of_note: string;
  universe: number;
  liquid: number;
  results: Array<Ticker & { regime: string; score?: number }>;
}

// Rank the live universe. "best" = a composite of momentum × liquidity (high turnover + strong 24h
// move), which is the closest honest answer to "what's hot right now"; the other sorts are explicit.
export async function scanMarket(opts: { category?: "linear" | "spot"; sort?: ScanSort; top?: number; minTurnover?: number } = {}): Promise<ScanResult> {
  const category = opts.category ?? "linear";
  const sort = opts.sort ?? "best";
  const top = Math.min(opts.top ?? 15, 50);
  const minTurnover = opts.minTurnover ?? 5_000_000; // drop illiquid microcaps by default
  const all = await fetchTickers(category);
  // Linear (crypto perps) is scoped to coins tradeable on Arbitrum + ETH; spot (tokenized equities) is left as-is.
  const arb = category === "linear" ? await getArbitrumUniverse() : null;
  const liquid = all.filter((t) => t.turnover24h >= minTurnover && (!arb?.size || arb.has(t.base)));
  const ranked = liquid.map((t) => ({ ...t, regime: regimeOf(t.pct24h, t.range24h) }));
  const cmp: Record<ScanSort, (a: typeof ranked[number], b: typeof ranked[number]) => number> = {
    volume: (a, b) => b.turnover24h - a.turnover24h,
    gainers: (a, b) => b.pct24h - a.pct24h,
    losers: (a, b) => a.pct24h - b.pct24h,
    volatility: (a, b) => b.range24h - a.range24h,
    funding: (a, b) => Math.abs(b.funding ?? 0) - Math.abs(a.funding ?? 0),
    best: (a, b) => score(b) - score(a),
  };
  function score(t: typeof ranked[number]): number {
    // momentum (signed 24h move) weighted by liquidity (log turnover), with a small vol bonus.
    return (t.pct24h / 5) * Math.log10(Math.max(10, t.turnover24h)) + t.range24h * 2;
  }
  const results = ranked.slice().sort(cmp[sort]).slice(0, top).map((t) => sort === "best" ? { ...t, score: Number(score(t).toFixed(3)) } : t);
  const as_of_note = arb ? "Bybit live tickers · Arbitrum-listed coins (24h rolling)" : "Bybit live tickers (24h rolling)";
  return { category, sort, as_of_note, universe: all.length, liquid: liquid.length, results };
}

export interface MarketOverview {
  category: string;
  as_of_note: string;
  liquid_symbols: number;
  advancers: number;
  decliners: number;
  breadth_pct_up: number;
  median_24h_pct: number;
  total_turnover_24h: number;
  btc_24h_pct: number | null;
  eth_24h_pct: number | null;
  vol_regime: string;
  top_gainer: { symbol: string; pct24h: number } | null;
  top_loser: { symbol: string; pct24h: number } | null;
}

// A one-glance read of "how is the market right now": breadth, median move, BTC/ETH, and a vol regime.
export async function marketOverview(opts: { category?: "linear" | "spot"; minTurnover?: number } = {}): Promise<MarketOverview> {
  const category = opts.category ?? "linear";
  const minTurnover = opts.minTurnover ?? 5_000_000;
  const all = await fetchTickers(category);
  // Linear breadth is read over the Arbitrum-listed coin set + ETH; spot stays full-universe.
  const arb = category === "linear" ? await getArbitrumUniverse() : null;
  const liquid = all.filter((t) => t.turnover24h >= minTurnover && (!arb?.size || arb.has(t.base)));
  const up = liquid.filter((t) => t.pct24h > 0);
  const pcts = liquid.map((t) => t.pct24h).sort((a, b) => a - b);
  const median = pcts.length ? pcts[Math.floor(pcts.length / 2)] : 0;
  const avgAbs = liquid.length ? liquid.reduce((s, t) => s + Math.abs(t.pct24h), 0) / liquid.length : 0;
  const vol_regime = avgAbs > 7 ? "volatile" : avgAbs > 3 ? "normal" : "calm";
  const byGain = liquid.slice().sort((a, b) => b.pct24h - a.pct24h);
  const btc = liquid.find((t) => t.symbol === "BTCUSDT");
  const eth = liquid.find((t) => t.symbol === "ETHUSDT");
  return {
    category, as_of_note: "Bybit live tickers (24h rolling)", liquid_symbols: liquid.length,
    advancers: up.length, decliners: liquid.length - up.length,
    breadth_pct_up: liquid.length ? Number(((up.length / liquid.length) * 100).toFixed(1)) : 0,
    median_24h_pct: Number(median.toFixed(2)),
    total_turnover_24h: Math.round(liquid.reduce((s, t) => s + t.turnover24h, 0)),
    btc_24h_pct: btc ? Number(btc.pct24h.toFixed(2)) : null,
    eth_24h_pct: eth ? Number(eth.pct24h.toFixed(2)) : null,
    vol_regime,
    top_gainer: byGain[0] ? { symbol: byGain[0].symbol, pct24h: Number(byGain[0].pct24h.toFixed(2)) } : null,
    top_loser: byGain.length ? { symbol: byGain[byGain.length - 1].symbol, pct24h: Number(byGain[byGain.length - 1].pct24h.toFixed(2)) } : null,
  };
}

// Resolve a free-text token (e.g. "arbitrum", "ARB", "ARBUSDT") to a clean Bybit symbol + a live snapshot.
export async function resolveTicker(query: string, category: "linear" | "spot" = "linear"): Promise<(Ticker & { regime: string }) | null> {
  const q = query.toUpperCase().replace(/USDT$/, "").replace(/[^A-Z0-9]/g, "");
  try {
    const all = await fetchTickers(category);
    const hit = all.find((t) => t.base === q) ?? all.find((t) => t.symbol === `${q}USDT`);
    return hit ? { ...hit, regime: regimeOf(hit.pct24h, hit.range24h) } : null;
  } catch (e) {
    logger.warn("resolveTicker failed", { query, message: (e as Error).message });
    return null;
  }
}
