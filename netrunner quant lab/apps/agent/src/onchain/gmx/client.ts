import { config } from "../../config.js";
import { logger } from "../../logger.js";

// GMX v2 (Arbitrum) read-only data adapter — markets, prices, OHLCV, GLV vaults. Native fetch against
// GMX's public REST/API; no keys, NO write path (this lane never executes).
// GMX expresses USD prices/values as 30-decimal fixed point: usd = raw / 10^(30 - tokenDecimals).
// We resolve tokenDecimals from /tokens and scale everything to plain USD here so the rest of the
// codebase never deals with GMX's wei-math. Honest-by-construction: each result carries source/as_of.

const BASE = config.gmxApiBase;
const API_V1_BASES = Array.from(new Set([
  config.gmxApiV1Base,
  "https://arbitrum.gmxapi.io/v1",
  "https://arbitrum.gmxapi.ai/v1",
]));

export interface GmxToken { symbol: string; address: string; decimals: number; synthetic?: boolean }
export interface GmxTicker { symbol: string; address: string; priceUsd: number; ts: number }
export interface GmxMarket {
  name: string;
  marketToken: string;
  indexSymbol: string;        // resolved from indexToken address
  longSymbol: string;
  shortSymbol: string;
  isListed: boolean;
  listingDate: string | null;
  indexPriceUsd: number | null;
  oiLongUsd: number;
  oiShortUsd: number;
  oiNetUsd: number;           // long - short (skew)
  availableLiquidityUsd: number;
  fundingRateLong: number;    // annualized funding FRACTION (raw/1e30); sign: + ⇒ longs pay shorts
  fundingAnnualPct: number;   // annualized funding % = (raw/1e30)*100 (verified scale; wide clamp guards outliers)
  borrowingRateLong: number | null;  // annualized borrow FRACTION (raw/1e30)
  borrowAnnualPct: number | null;    // annualized borrow % for longs
  source: "gmx";
  as_of: string;
}
export interface GlvMarketAllocation { address: string; balanceUsd: number; sharePct: number; isDisabled: boolean }
export interface GlvVault {
  name: string;
  glvToken: string;
  longSymbol: string;
  shortSymbol: string;
  isListed: boolean;
  listingDate: string | null;
  totalUsd: number;
  markets: GlvMarketAllocation[];
  source: "gmx";
  as_of: string;
}
export interface GmxApySnapshot {
  markets: Record<string, { apyPct: number; baseApyPct: number; bonusAprPct: number }>;
  glvs: Record<string, { apyPct: number; baseApyPct: number; bonusAprPct: number }>;
  source: "gmx";
  as_of: string;
}
export interface GmxPair {
  ticker_id: string;
  base_currency?: string;
  target_currency?: string;
  product_type?: string;
  price?: string | number;
  liquidity?: string | number;
  open_interest?: string | number;
  funding_rate?: string | number;
}
export interface GmxOhlcvBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  source: "gmx_api";
  symbol: string;
  timeframe: string;
  as_of: string;
}
export interface GmxOhlcvSeries {
  symbol: string;
  requestSymbol: string;
  timeframe: string;
  bars: GmxOhlcvBar[];
  closes: number[];
  source: "gmx_api";
  as_of: string;
  warnings: string[];
}

interface TokenIndex { byAddr: Map<string, GmxToken>; bySym: Map<string, GmxToken> }

let tokenCache: { at: number; idx: TokenIndex } | null = null;
let apyCache: { at: number; data: GmxApySnapshot } | null = null;
let pairCache: { at: number; data: GmxPair[] } | null = null;

async function gmxFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(config.gmxTimeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GMX ${path} HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function gmxApiV1Fetch<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  let last: Error | null = null;
  for (const base of API_V1_BASES) {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(config.gmxTimeoutMs), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`GMX API ${path} HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e as Error;
      logger.warn("gmx api v1 fetch failed", { base, path, message: last.message });
    }
  }
  throw last ?? new Error(`GMX API ${path} failed`);
}

function nz(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function clampPct(v: number, bound: number): number { return Number.isFinite(v) ? Math.max(-bound, Math.min(bound, v)) : 0; }
// Scale a 30-decimal USD price for one token to plain USD (per whole token).
function priceUsd(raw30: unknown, decimals: number): number { return nz(raw30) / 10 ** (30 - decimals); }
// USD values (OI, liquidity, GLV balances) are already 30-decimal USD ⇒ divide by 1e30.
function usd30(raw: unknown): number { return nz(raw) / 1e30; }
function pctFromFraction(raw: unknown): number {
  const n = nz(raw);
  return Number.isFinite(n) ? n * 100 : 0;
}
function normalizeBase(symbol: string): string {
  return String(symbol || "BTC").replace(/\[[^\]]+\]/g, "").replace(/\/USD.*/i, "").replace(/USDT?$/i, "").replace(/PERP$/i, "").trim().toUpperCase();
}
function timeframeOf(interval: string): string {
  const raw = String(interval || "1d").toLowerCase();
  if (raw === "d" || raw === "1d" || raw === "day") return "1d";
  if (raw === "240" || raw === "4h") return "4h";
  if (raw === "60" || raw === "1h") return "1h";
  if (raw === "15" || raw === "15m") return "15m";
  if (raw === "5" || raw === "5m") return "5m";
  return raw;
}

export async function getGmxTokens(): Promise<TokenIndex> {
  if (tokenCache && Date.now() - tokenCache.at < config.gmxCacheTtlMs) return tokenCache.idx;
  const j = await gmxFetch<{ tokens: GmxToken[] }>("/tokens");
  const byAddr = new Map<string, GmxToken>();
  const bySym = new Map<string, GmxToken>();
  for (const t of j.tokens ?? []) {
    byAddr.set(t.address.toLowerCase(), t);
    if (!bySym.has(t.symbol)) bySym.set(t.symbol, t); // first wins (skip *_deprecated dupes)
  }
  tokenCache = { at: Date.now(), idx: { byAddr, bySym } };
  return tokenCache.idx;
}

export async function getGmxTickers(): Promise<GmxTicker[]> {
  const [idx, raw] = await Promise.all([
    getGmxTokens(),
    gmxFetch<Array<{ tokenAddress: string; tokenSymbol: string; minPrice: string; maxPrice: string; timestamp: number }>>("/prices/tickers"),
  ]);
  return raw.map((t) => {
    const dec = idx.byAddr.get(t.tokenAddress.toLowerCase())?.decimals ?? 18;
    const mid = (nz(t.minPrice) + nz(t.maxPrice)) / 2;
    return { symbol: t.tokenSymbol, address: t.tokenAddress, priceUsd: priceUsd(mid, dec), ts: t.timestamp };
  });
}

export async function getGmxPairs(): Promise<GmxPair[]> {
  if (pairCache && Date.now() - pairCache.at < config.gmxCacheTtlMs) return pairCache.data;
  const data = await gmxApiV1Fetch<GmxPair[]>("/pairs");
  pairCache = { at: Date.now(), data: Array.isArray(data) ? data : [] };
  return pairCache.data;
}

export async function getGmxPairBySymbol(symbol: string): Promise<GmxPair | null> {
  const want = normalizeBase(symbol);
  const pairs = await getGmxPairs().catch((e) => { logger.warn("gmx pairs failed", { message: (e as Error).message }); return [] as GmxPair[]; });
  const matches = pairs.filter((p) => String(p.base_currency ?? "").toUpperCase() === want || String(p.ticker_id ?? "").toUpperCase().startsWith(`${want}/USD`));
  if (!matches.length) return null;
  return matches.sort((a, b) => nz(b.open_interest ?? b.liquidity) - nz(a.open_interest ?? a.liquidity))[0];
}

export async function getGmxOhlcv(symbol: string, interval = "1d", limit = 180): Promise<GmxOhlcvSeries> {
  const base = normalizeBase(symbol);
  const timeframe = timeframeOf(interval);
  const pair = await getGmxPairBySymbol(base).catch(() => null);
  const candidates = Array.from(new Set([base, pair?.ticker_id, `${base}/USD`].filter(Boolean))) as string[];
  const warnings: string[] = [];
  for (const requestSymbol of candidates) {
    try {
      const raw = await gmxApiV1Fetch<Array<Record<string, unknown>>>("/prices/ohlcv", { symbol: requestSymbol, timeframe, limit: Math.max(30, Math.min(1000, limit)) });
      const as_of = new Date().toISOString();
      const bars = (raw ?? []).map((b) => ({
        ts: nz(b.timestamp ?? b.t ?? b.time),
        open: nz(b.open ?? b.o),
        high: nz(b.high ?? b.h),
        low: nz(b.low ?? b.l),
        close: nz(b.close ?? b.c),
        volume: b.volume != null ? nz(b.volume) : undefined,
        source: "gmx_api" as const,
        symbol: base,
        timeframe,
        as_of,
      })).filter((b) => b.ts && b.close > 0).sort((a, b) => a.ts - b.ts);
      if (bars.length) {
        return { symbol: base, requestSymbol, timeframe, bars, closes: bars.map((b) => b.close), source: "gmx_api", as_of, warnings };
      }
      warnings.push(`${requestSymbol}: empty OHLCV`);
    } catch (e) {
      warnings.push(`${requestSymbol}: ${(e as Error).message}`);
    }
  }
  throw new Error(`No GMX OHLCV for ${base}; tried ${candidates.join(", ")}`);
}

export async function getGmxMarkets(): Promise<GmxMarket[]> {
  const [idx, j, tickers] = await Promise.all([
    getGmxTokens(),
    gmxFetch<{ markets: Array<Record<string, unknown>> }>("/markets/info"),
    getGmxTickers().catch(() => [] as GmxTicker[]),
  ]);
  const priceByAddr = new Map(tickers.map((t) => [t.address.toLowerCase(), t.priceUsd]));
  const symOf = (addr: unknown): string => idx.byAddr.get(String(addr).toLowerCase())?.symbol ?? "?";
  const as_of = new Date().toISOString();
  return (j.markets ?? []).filter((m) => m.isListed !== false).map((m) => {
    const oiL = usd30(m.openInterestLong), oiS = usd30(m.openInterestShort);
    return {
      name: String(m.name ?? ""),
      marketToken: String(m.marketToken ?? ""),
      indexSymbol: symOf(m.indexToken),
      longSymbol: symOf(m.longToken),
      shortSymbol: symOf(m.shortToken),
      isListed: m.isListed !== false,
      listingDate: typeof m.listingDate === "string" ? m.listingDate : null,
      indexPriceUsd: priceByAddr.get(String(m.indexToken).toLowerCase()) ?? null,
      oiLongUsd: oiL,
      oiShortUsd: oiS,
      oiNetUsd: oiL - oiS,
      availableLiquidityUsd: usd30(m.availableLiquidityLong) + usd30(m.availableLiquidityShort),
      fundingRateLong: nz(m.fundingRateLong) / 1e30,
      // VERIFIED against the raw /markets/info response: GMX returns funding/borrow as ANNUALIZED rate
      // fractions at 1e30 fixed-point (ETH fundingRateLong≈1.5e29 ⇒ /1e30=0.15 ⇒ 15%/yr; borrowing
      // ≈7.6e28 ⇒ 7.6%/yr) — NOT per-second factors. So annual % = (raw/1e30)*100. Wide clamp guards
      // only against pathological outliers; normal values pass through untouched.
      fundingAnnualPct: clampPct(nz(m.fundingRateLong) / 1e30 * 100, 500),
      borrowingRateLong: m.borrowingRateLong != null ? nz(m.borrowingRateLong) / 1e30 : null,
      borrowAnnualPct: m.borrowingRateLong != null ? clampPct(nz(m.borrowingRateLong) / 1e30 * 100, 500) : null,
      source: "gmx" as const,
      as_of,
    };
  });
}

export async function getGmxApySnapshot(): Promise<GmxApySnapshot> {
  if (apyCache && Date.now() - apyCache.at < config.gmxCacheTtlMs) return apyCache.data;
  const raw = await gmxFetch<{
    markets?: Record<string, { apy?: number; baseApy?: number; bonusApr?: number }>;
    glvs?: Record<string, { apy?: number; baseApy?: number; bonusApr?: number }>;
  }>("/apy");
  const norm = (x?: Record<string, { apy?: number; baseApy?: number; bonusApr?: number }>) => {
    const out: GmxApySnapshot["markets"] = {};
    for (const [addr, v] of Object.entries(x ?? {})) {
      out[addr.toLowerCase()] = {
        apyPct: pctFromFraction(v.apy),
        baseApyPct: pctFromFraction(v.baseApy),
        bonusAprPct: pctFromFraction(v.bonusApr),
      };
    }
    return out;
  };
  const data: GmxApySnapshot = { markets: norm(raw.markets), glvs: norm(raw.glvs), source: "gmx", as_of: new Date().toISOString() };
  apyCache = { at: Date.now(), data };
  return data;
}

// The market whose INDEX token matches `symbol` (e.g. "ETH", "BTC", "ARB"), preferring deepest OI.
export async function getGmxMarketBySymbol(symbol: string): Promise<GmxMarket | null> {
  const want = symbol.replace(/USDT?$/i, "").replace(/PERP$/i, "").toUpperCase();
  const markets = await getGmxMarkets().catch((e) => { logger.warn("gmx markets failed", { message: (e as Error).message }); return [] as GmxMarket[]; });
  const matches = markets.filter((m) => m.indexSymbol.toUpperCase() === want);
  if (!matches.length) return null;
  return matches.sort((a, b) => (b.oiLongUsd + b.oiShortUsd) - (a.oiLongUsd + a.oiShortUsd))[0];
}

export async function getGlvVaults(): Promise<GlvVault[]> {
  const [idx, j] = await Promise.all([
    getGmxTokens(),
    gmxFetch<{ glvs: Array<Record<string, unknown>> }>("/glvs/info"),
  ]);
  const symOf = (addr: unknown): string => idx.byAddr.get(String(addr).toLowerCase())?.symbol ?? "?";
  const as_of = new Date().toISOString();
  return (j.glvs ?? []).map((g) => {
    const mkts = (Array.isArray(g.markets) ? g.markets : []) as Array<Record<string, unknown>>;
    const allocs: GlvMarketAllocation[] = mkts.map((m) => ({ address: String(m.address ?? ""), balanceUsd: usd30(m.balanceUsd), sharePct: usd30(m.share) * 100, isDisabled: m.isDisabled === true }));
    const totalUsd = allocs.reduce((s, a) => s + a.balanceUsd, 0);
    return {
      name: String(g.name ?? ""),
      glvToken: String(g.glvToken ?? ""),
      longSymbol: symOf(g.longToken),
      shortSymbol: symOf(g.shortToken),
      isListed: g.isListed !== false,
      listingDate: typeof g.listingDate === "string" ? g.listingDate : null,
      totalUsd,
      markets: allocs.sort((a, b) => b.balanceUsd - a.balanceUsd),
      source: "gmx" as const,
      as_of,
    };
  });
}
