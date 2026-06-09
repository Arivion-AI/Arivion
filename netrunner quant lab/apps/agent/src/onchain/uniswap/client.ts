import { config } from "../../config.js";
import { logger } from "../../logger.js";

// Uniswap v3/v4 pool data via The Graph subgraph (read-only GraphQL). No execution. Absent endpoint ⇒
// an honest "unavailable" result, never fabricated pools. Results normalize to plain numbers + a
// fee-APR estimate the LP analyzers consume. Source/as_of carried through for the Truth Card.

export interface UniPool {
  id: string;                 // pool address
  feeTier: number;            // in bps (e.g. 500 = 0.05%)
  token0: string;
  token1: string;
  tvlUsd: number;
  volume24hUsd: number;
  fees24hUsd: number;
  feeAprPct: number;          // trailing realized fee APR (7d avg fees/TVL · 365 · 100) — stable, not 1-day noise
  feeApr7dPct: number;        // 7-day trailing
  feeApr30dPct: number;       // 30-day trailing
  volTvl: number;             // volume/TVL turnover (fee-generation efficiency)
  priceToken1PerToken0: number | null;
  source: "uniswap";
  as_of: string;
}
export interface UniPoolDay { date: number; tvlUsd: number; volumeUsd: number; feesUsd: number; close: number }
export interface UniResult<T> { status: "ok" | "unavailable" | "error"; reason?: string; data: T }

interface CacheEntry { at: number; value: unknown }
const cache = new Map<string, CacheEntry>();

function endpoint(): string | null {
  if (!config.uniswapSubgraphUrl) return null;
  // Support The Graph's gateway URL templating with {key} if a key is configured.
  return config.theGraphApiKey ? config.uniswapSubgraphUrl.replace("{key}", config.theGraphApiKey) : config.uniswapSubgraphUrl;
}

async function gql<T>(query: string, variables: Record<string, unknown>, cacheKey?: string): Promise<UniResult<T>> {
  const url = endpoint();
  if (!url) return { status: "unavailable", reason: "Uniswap subgraph not configured (set UNISWAP_SUBGRAPH_URL).", data: null as T };
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < config.uniswapCacheTtlMs) return { status: "ok", data: hit.value as T };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(config.uniswapTimeoutMs),
    });
    if (!res.ok) return { status: "error", reason: `subgraph HTTP ${res.status}`, data: null as T };
    const j = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (j.errors?.length) return { status: "error", reason: j.errors.map((e) => e.message).join("; "), data: null as T };
    if (cacheKey && j.data) cache.set(cacheKey, { at: Date.now(), value: j.data });
    return { status: "ok", data: (j.data ?? null) as T };
  } catch (e) {
    logger.warn("uniswap subgraph failed", { message: (e as Error).message });
    return { status: "error", reason: (e as Error).message, data: null as T };
  }
}

const nz = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// On-chain pools denominate the natives in their WRAPPED form (WETH, WBTC). A query for "ETH"/"BTC"
// must match those, so expand a symbol to its on-chain aliases (both cased + uppercased).
const WRAP_ALIAS: Record<string, string[]> = {
  ETH: ["WETH", "ETH"], WETH: ["WETH", "ETH"],
  BTC: ["WBTC", "BTC"], WBTC: ["WBTC", "BTC"],
  BNB: ["WBNB", "BNB"], MATIC: ["WMATIC", "MATIC", "POL"], POL: ["WMATIC", "POL"],
  AVAX: ["WAVAX", "AVAX"], S: ["WS", "S"],
};
function symbolAliases(sym: string): string[] {
  const up = sym.toUpperCase();
  return WRAP_ALIAS[up] ?? [up];
}

// Trailing realized fee APR over the last `window` day-rows: mean(daily fees)/mean(TVL) · 365 · 100.
// Averaging kills the 1-day annualization noise (one busy day no longer implies a 300% APR).
function trailingApr(days: Array<{ tvlUsd: number; feesUsd: number }>, window: number): number {
  const rows = days.filter((d) => d.tvlUsd > 0).slice(-window);
  if (!rows.length) return 0;
  const avgFees = rows.reduce((s, d) => s + d.feesUsd, 0) / rows.length;
  const avgTvl = rows.reduce((s, d) => s + d.tvlUsd, 0) / rows.length;
  return avgTvl > 0 ? (avgFees / avgTvl) * 365 * 100 : 0;
}

// Normalize a pool. `dayRows` (oldest→newest) drives the trailing fee-APR; when absent we fall back to
// the single embedded volumeUSD/feesUSD (1-day) so callers that only fetched a snapshot still work.
function normalizePool(p: Record<string, unknown>, dayRows?: Array<{ tvlUsd: number; volumeUsd: number; feesUsd: number }>): UniPool {
  const tvl = nz(p.totalValueLockedUSD);
  const vol = nz(p.volumeUSD);            // when sourced from poolDayData this is the latest day's volume
  const fees = nz(p.feesUSD);
  const rows = dayRows ?? (tvl > 0 ? [{ tvlUsd: tvl, volumeUsd: vol, feesUsd: fees }] : []);
  const apr7 = trailingApr(rows, 7);
  const apr30 = trailingApr(rows, 30);
  const feeApr = apr7 || apr30 || (tvl > 0 ? (fees / tvl) * 365 * 100 : 0);
  const t0 = (p.token0 ?? {}) as Record<string, unknown>;
  const t1 = (p.token1 ?? {}) as Record<string, unknown>;
  return {
    id: String(p.id ?? ""),
    feeTier: Math.round(nz(p.feeTier) / 100),  // subgraph feeTier is in hundredths of a bip (e.g. 500)
    token0: String(t0.symbol ?? "?"),
    token1: String(t1.symbol ?? "?"),
    tvlUsd: tvl,
    volume24hUsd: vol,
    fees24hUsd: fees,
    feeAprPct: feeApr,
    feeApr7dPct: apr7,
    feeApr30dPct: apr30,
    volTvl: tvl > 0 ? vol / tvl : 0,
    priceToken1PerToken0: p.token0Price != null ? nz(p.token0Price) : null,
    source: "uniswap",
    as_of: new Date().toISOString(),
  };
}

// All pools (every fee tier) for a token symbol, ranked by TVL. Uses the latest poolDayData for a
// realistic 24h volume/fees snapshot, so the fee-APR estimate reflects recent activity, not lifetime.
export async function getTokenPools(tokenSymbol: string, limit = 8): Promise<UniResult<UniPool[]>> {
  const syms = symbolAliases(tokenSymbol);
  const q = `query($syms:[String!],$n:Int!){
    pools(first:$n, orderBy:totalValueLockedUSD, orderDirection:desc,
          where:{ or:[{token0_:{symbol_in:$syms}},{token1_:{symbol_in:$syms}}] }) {
      id feeTier totalValueLockedUSD token0Price
      token0{symbol} token1{symbol}
      poolDayData(first:30, orderBy:date, orderDirection:desc){ tvlUSD volumeUSD feesUSD }
    }
  }`;
  const r = await gql<{ pools: Array<Record<string, unknown>> }>(q, { syms, n: limit }, `pools:${syms.join("-")}:${limit}`);
  if (r.status !== "ok") return { status: r.status, reason: r.reason, data: [] };
  const pools = (r.data?.pools ?? []).map((p) => {
    const raw = (Array.isArray(p.poolDayData) ? p.poolDayData : []) as Array<Record<string, unknown>>;
    // Subgraph returns newest-first; reverse to oldest→newest for the trailing-APR window.
    const dayRows = raw.map((d) => ({ tvlUsd: nz(d.tvlUSD), volumeUsd: nz(d.volumeUSD), feesUsd: nz(d.feesUSD) })).reverse();
    const latest = raw[0] ?? {};
    return normalizePool({ ...p, volumeUSD: latest.volumeUSD, feesUSD: latest.feesUSD }, dayRows);
  });
  return { status: "ok", data: pools };
}

export async function getPoolOverview(poolId: string): Promise<UniResult<UniPool | null>> {
  const q = `query($id:ID!){ pool(id:$id){ id feeTier totalValueLockedUSD token0Price token0{symbol} token1{symbol}
      poolDayData(first:1, orderBy:date, orderDirection:desc){ volumeUSD feesUSD } } }`;
  const r = await gql<{ pool: Record<string, unknown> | null }>(q, { id: poolId.toLowerCase() }, `pool:${poolId}`);
  if (r.status !== "ok") return { status: r.status, reason: r.reason, data: null };
  if (!r.data?.pool) return { status: "ok", data: null };
  const p = r.data.pool;
  const day = (Array.isArray(p.poolDayData) ? p.poolDayData[0] : {}) as Record<string, unknown>;
  return { status: "ok", data: normalizePool({ ...p, volumeUSD: day.volumeUSD, feesUSD: day.feesUSD }) };
}

// Daily history for a pool (for IL + LP backtests): tvl/volume/fees/close per day, oldest→newest.
export async function getPoolHistory(poolId: string, days = 90): Promise<UniResult<UniPoolDay[]>> {
  const q = `query($id:String!,$n:Int!){ poolDayDatas(first:$n, orderBy:date, orderDirection:desc, where:{pool:$id}){
      date tvlUSD volumeUSD feesUSD token0Price } }`;
  const r = await gql<{ poolDayDatas: Array<Record<string, unknown>> }>(q, { id: poolId.toLowerCase(), n: days }, `hist:${poolId}:${days}`);
  if (r.status !== "ok") return { status: r.status, reason: r.reason, data: [] };
  const rows = (r.data?.poolDayDatas ?? []).map((d) => ({
    date: nz(d.date), tvlUsd: nz(d.tvlUSD), volumeUsd: nz(d.volumeUSD), feesUsd: nz(d.feesUSD), close: nz(d.token0Price),
  })).sort((a, b) => a.date - b.date);
  return { status: "ok", data: rows };
}
