import { getTokenPools, getPoolHistory, type UniPoolDay } from "../uniswap/client.js";
import { tryFetchKlines } from "../../analysis/klines.js";
import { logger } from "../../logger.js";

// L0 — the price path an LP analyzer should reason on. IL / time-in-range / the LP backtest are a
// function of the POOL's own price (token1/token0), NOT a CEX mark. This resolver prefers real Uniswap
// pool daily history (getPoolHistory — previously dead code) and falls back to Bybit klines only when
// the subgraph is dark, so the analytics are correct when on-chain data exists and still work offline.
// It also surfaces the pool's trailing realized fee APR so the backtest uses a real number, not a guess.

export interface LpPricePath {
  closes: number[];                 // oldest→newest daily closes (pool price when source=uniswap_pool)
  source: "uniswap_pool" | "bybit"; // honest provenance for the Truth Card
  poolId?: string;
  pair?: string;
  feeTierPct?: number;
  feeAprPct?: number;               // trailing realized fee APR from pool history (avg fees/TVL · 365)
  tvlUsd?: number;
  days: number;
  as_of: string;
  note: string;
}

// Trailing realized fee APR from pool day rows: mean(daily fees)/mean(TVL) · 365 · 100. Averaging over
// the window kills the 1-day annualization noise. Uses the last `window` days if available.
export function trailingFeeApr(days: UniPoolDay[], window = 7): number {
  const rows = days.filter((d) => d.tvlUsd > 0).slice(-window);
  if (!rows.length) return 0;
  const avgFees = rows.reduce((s, d) => s + d.feesUsd, 0) / rows.length;
  const avgTvl = rows.reduce((s, d) => s + d.tvlUsd, 0) / rows.length;
  return avgTvl > 0 ? (avgFees / avgTvl) * 365 * 100 : 0;
}

// Resolve the best LP price path for an asset. Picks the deepest Uniswap pool for the token, pulls its
// daily history, and returns the pool price series + realized fee APR. Falls back to Bybit on a dark
// subgraph or a pool with too little history.
export async function resolveLpPricePath(symbol: string, days = 90, minBars = 20): Promise<LpPricePath> {
  const base = symbol.replace(/USDT?$/i, "").toUpperCase();
  const as_of = new Date().toISOString();

  try {
    const pools = await getTokenPools(base, 6);
    if (pools.status === "ok" && pools.data.length) {
      // Deepest pool wins (already ordered by TVL desc, but be explicit).
      const top = [...pools.data].sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
      const hist = await getPoolHistory(top.id, days);
      if (hist.status === "ok") {
        const closes = hist.data.map((d) => d.close).filter((x) => Number.isFinite(x) && x > 0);
        if (closes.length >= minBars) {
          const feeApr = trailingFeeApr(hist.data, 7) || top.feeAprPct;
          return {
            closes, source: "uniswap_pool", poolId: top.id, pair: `${top.token0}/${top.token1}`,
            feeTierPct: top.feeTier / 100, feeAprPct: feeApr, tvlUsd: top.tvlUsd, days: closes.length, as_of,
            note: `Uniswap ${top.token0}/${top.token1} ${top.feeTier / 100}% pool price (${closes.length}d) · realized fee APR ~${feeApr.toFixed(1)}%`,
          };
        }
      }
    }
  } catch (e) {
    logger.warn("resolveLpPricePath: pool history unavailable, falling back to bybit", { symbol: base, message: (e as Error).message });
  }

  // Fallback — CEX price as a proxy. Honest: the source tag says so and downstream Truth Cards reflect it.
  const series = await tryFetchKlines(`${base}USDT`, "linear", "D", days).catch(() => null);
  const closes = (series?.closes ?? []).filter((x) => Number.isFinite(x) && x > 0);
  return {
    closes, source: "bybit", days: closes.length, as_of,
    note: closes.length ? `Bybit ${base}USDT daily closes (CEX proxy — no on-chain pool history)` : `No price history for ${base}`,
  };
}
