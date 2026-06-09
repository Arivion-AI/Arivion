import { discoverPools } from "./discover.js";
import { getPoolHistory } from "../uniswap/client.js";
import { getPoolDepth } from "../uniswap/poolDepth.js";
import { optimizeRange, type RangeOptimization } from "./optimize.js";
import { trailingFeeApr } from "./pricePath.js";
import { realizedVol } from "../../analysis/indicators.js";
import type { LpCandidate } from "./types.js";

// L3 — the LP SCREENER (the "screen and analyze LPs" capability). Enumerates every venue an asset can be
// LP'd (Uniswap fee tiers + GMX GM/GLV via discover), then for each Uniswap pool with real history runs
// the range optimizer on the pool's OWN price path to get a defensible NET APR (fees − IL − costs) and
// its optimal band. Ranks by net APR (risk-adjusted by IL risk), pick flagged. Honest: pools without
// usable history fall back to their discover-level metrics and are marked.

export interface ScreenedLp {
  id: string;
  venue: LpCandidate["venue"];
  label: string;
  pair: string;
  feeTierPct: number | null;
  tvlUsd: number;
  grossFeeAprPct: number;       // realized trailing fee APR (pool) or discover estimate
  yieldSource?: LpCandidate["yieldSource"];
  netAprPct: number | null;     // fee − annualized IL − costs at the OPTIMAL band (null if no history)
  optimalBandHalfPct: number | null;
  ilRisk: "low" | "med" | "high";
  activeLiquidityUsd: number | null;
  priceSource: "uniswap_pool" | "uniswap_subgraph_short_history" | "gmx_api" | "estimate";
  historyDays?: number;
  rationale: string;
}

export interface LpScreenResult {
  symbol: string;
  ranked: ScreenedLp[];
  pick: ScreenedLp | null;
  optimizations: RangeOptimization[];  // per-pool curves (for lp_range_opt widgets)
  as_of: string;
  warnings: string[];
}

export async function screenLps(opts: {
  symbol: string; positionUsd?: number; involvement?: "active" | "weekly" | "set_and_forget"; maxPools?: number;
}): Promise<LpScreenResult> {
  const symbol = opts.symbol.replace(/USDT?$/i, "").toUpperCase();
  const maxPools = opts.maxPools ?? 5;
  const warnings: string[] = [];

  const compare = await discoverPools({ symbol });
  const ranked: ScreenedLp[] = [];
  const optimizations: RangeOptimization[] = [];

  // Uniswap candidates → real net-APR via per-pool history + range optimization.
  const uniCands = compare.candidates.filter((c) => c.venue === "uniswap").slice(0, maxPools);
  for (const c of uniCands) {
    let netApr: number | null = null, optimalBand: number | null = null, activeLiq: number | null = null;
    let historyDays = 0;
    let source: ScreenedLp["priceSource"] = "estimate";
    let gross = c.feeAprPct;
    try {
      const hist = await getPoolHistory(c.id, 90);
      const closes = hist.status === "ok" ? hist.data.map((d) => d.close).filter((x) => x > 0) : [];
      historyDays = closes.length;
      if (closes.length >= 10) {
        source = closes.length >= 20 ? "uniswap_pool" : "uniswap_subgraph_short_history";
        gross = trailingFeeApr(hist.data, 7) || c.feeAprPct;
        const depth = await getPoolDepth(c.id).catch(() => null);
        activeLiq = depth?.activeLiquidityUsd ?? null;
        const opt = optimizeRange({
          symbol: `${symbol}-${c.feeTierPct ?? ""}`, closes, grossFeeAprPct: gross,
          positionUsd: opts.positionUsd, activeLiquidityUsd: activeLiq ?? undefined,
          poolDepth: depth ?? undefined, tvlUsd: c.tvlUsd, involvement: opts.involvement,
        });
        optimizations.push(opt);
        netApr = opt.best?.netAprPct ?? null;
        optimalBand = opt.best?.bandHalfWidthPct ?? null;
      } else {
        warnings.push(`${c.label}: ${closes.length} usable day row(s) from The Graph — need ≥10 for range/backtest net APR.`);
      }
    } catch (e) {
      warnings.push(`${c.label}: ${(e as Error).message}`);
    }
    if (source === "estimate" && historyDays < 10) {
      warnings.push(`${c.label}: excluded from ranking because The Graph returned only ${historyDays} usable day row(s); avoiding dust-pool gross APR estimates.`);
      continue;
    }
    ranked.push({
      id: c.id, venue: c.venue, label: c.label, pair: c.pair, feeTierPct: c.feeTierPct, tvlUsd: c.tvlUsd,
      grossFeeAprPct: Number(gross.toFixed(2)), yieldSource: c.yieldSource, netAprPct: netApr != null ? Number(netApr.toFixed(2)) : null,
      optimalBandHalfPct: optimalBand, ilRisk: c.ilRisk, activeLiquidityUsd: activeLiq, priceSource: source, historyDays,
      rationale: netApr != null
        ? `Net ${netApr.toFixed(1)}% APR at ±${optimalBand?.toFixed(1)}% band (gross ${gross.toFixed(1)}% fees, IL risk ${c.ilRisk})`
        : `Gross ~${gross.toFixed(1)}% fee APR · TVL $${fmt(c.tvlUsd)} (${historyDays} usable The Graph day rows; net APR needs ≥10)`,
    });
  }

  // GMX GM/GLV candidates — carried through with their native GMX APY snapshot when available.
  for (const c of compare.candidates.filter((x) => x.venue !== "uniswap")) {
    ranked.push({
      id: c.id, venue: c.venue, label: c.label, pair: c.pair, feeTierPct: c.feeTierPct, tvlUsd: c.tvlUsd,
      grossFeeAprPct: Number(c.feeAprPct.toFixed(2)), yieldSource: c.yieldSource, netAprPct: null, optimalBandHalfPct: null,
      ilRisk: c.ilRisk, activeLiquidityUsd: null, priceSource: c.yieldSource === "gmx_apy" ? "gmx_api" : "estimate",
      rationale: c.yieldSource === "gmx_apy"
        ? `${c.label} · ${c.rationale} (GMX APY snapshot; net APR backtest pending)`
        : `${c.label} · ${c.rationale}`,
    });
  }

  // Rank: pools with a computed net APR first (desc); then the rest by TVL. IL risk breaks ties down.
  ranked.sort((a, b) => {
    if (a.netAprPct != null && b.netAprPct != null) return b.netAprPct - a.netAprPct;
    if (a.netAprPct != null) return -1;
    if (b.netAprPct != null) return 1;
    return b.tvlUsd - a.tvlUsd;
  });

  if (!ranked.length) warnings.push(`No LP venues found for ${symbol}.`);
  return { symbol, ranked, pick: ranked[0] ?? null, optimizations, as_of: new Date().toISOString(), warnings };
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}
