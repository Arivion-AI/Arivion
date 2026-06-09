import { discoverPools } from "./lp/discover.js";
import { getPoolDepth } from "./uniswap/poolDepth.js";
import { resolveLpPricePath } from "./lp/pricePath.js";
import { getGmxMarketBySymbol } from "./gmx/client.js";
import { sentimentDigest } from "../sentiment/digest.js";

// L4 — ON-CHAIN CONTEXT PACK. Assembles the on-chain facts a human LP/perp analyst checks first —
// best pool + realized fee APR + active depth, GMX OI skew/funding/borrow/utilization, and blended
// sentiment — into one compact block injected into the reasoning firm's prompt (analyze_symbol +
// portfolioReasoner). Turns the reasoner from "price + its own history" into "reasons WITH on-chain
// facts". Read-only; honest (missing venues simply drop their line). Surfaced as the onchain_context widget.

export interface OnchainContext {
  symbol: string;
  pool: { label: string; pair: string; feeTierPct: number | null; tvlUsd: number; feeAprPct: number; activeLiquidityUsd: number | null; priceSource: string } | null;
  gmx: { market: string; indexPriceUsd: number | null; oiLongUsd: number; oiShortUsd: number; oiSkewPct: number; fundingAnnualPct: number; borrowAnnualPct: number | null; utilizationPct: number } | null;
  sentiment: { score: number; label: string } | null;
  as_of: string;
}

export async function buildOnchainContext(symbol: string): Promise<OnchainContext> {
  const base = symbol.replace(/USDT?$/i, "").toUpperCase();
  const [compare, path, gm, dig] = await Promise.all([
    discoverPools({ symbol: base }).catch(() => null),
    resolveLpPricePath(base, 90).catch(() => null),
    getGmxMarketBySymbol(base).catch(() => null),
    sentimentDigest(base).catch(() => null),
  ]);

  let pool: OnchainContext["pool"] = null;
  const pick = compare?.pick && compare.pick.venue === "uniswap" ? compare.pick : compare?.candidates.find((c) => c.venue === "uniswap") ?? null;
  if (pick) {
    const depth = pick.id ? await getPoolDepth(pick.id).catch(() => null) : null;
    pool = {
      label: pick.label, pair: pick.pair, feeTierPct: pick.feeTierPct,
      tvlUsd: pick.tvlUsd, feeAprPct: Number((path?.feeAprPct ?? pick.feeAprPct).toFixed(2)),
      activeLiquidityUsd: depth?.activeLiquidityUsd ?? null, priceSource: path?.source ?? "estimate",
    };
  }

  let gmx: OnchainContext["gmx"] = null;
  if (gm) {
    const oiTotal = gm.oiLongUsd + gm.oiShortUsd;
    gmx = {
      market: gm.name, indexPriceUsd: gm.indexPriceUsd,
      oiLongUsd: gm.oiLongUsd, oiShortUsd: gm.oiShortUsd,
      oiSkewPct: oiTotal > 0 ? Number(((gm.oiNetUsd / oiTotal) * 100).toFixed(0)) : 0,
      fundingAnnualPct: Number(gm.fundingAnnualPct.toFixed(1)), borrowAnnualPct: gm.borrowAnnualPct != null ? Number(gm.borrowAnnualPct.toFixed(1)) : null,
      utilizationPct: oiTotal + gm.availableLiquidityUsd > 0 ? Number(((oiTotal / (oiTotal + gm.availableLiquidityUsd)) * 100).toFixed(0)) : 0,
    };
  }

  return {
    symbol: base, pool, gmx,
    sentiment: dig ? { score: dig.score, label: dig.label } : null,
    as_of: new Date().toISOString(),
  };
}

// Compact prompt block for the reasoning firm. "" when nothing on-chain is available.
export function renderOnchainContext(c: OnchainContext): string {
  const lines: string[] = [];
  if (c.pool) lines.push(`LP: ${c.pool.pair}${c.pool.feeTierPct != null ? ` ${c.pool.feeTierPct}%` : ""} · TVL $${fmt(c.pool.tvlUsd)} · realized fee APR ~${c.pool.feeAprPct}%${c.pool.activeLiquidityUsd ? ` · active depth $${fmt(c.pool.activeLiquidityUsd)}` : ""} (${c.pool.priceSource})`);
  if (c.gmx) {
    const skewSide = c.gmx.oiSkewPct > 10 ? "LONG-skewed (GM LPs are short that)" : c.gmx.oiSkewPct < -10 ? "SHORT-skewed" : "balanced";
    lines.push(`GMX ${c.gmx.market}: OI ${skewSide} (${c.gmx.oiSkewPct >= 0 ? "+" : ""}${c.gmx.oiSkewPct}%) · funding ~${c.gmx.fundingAnnualPct}%/yr${c.gmx.borrowAnnualPct != null ? ` · borrow ~${c.gmx.borrowAnnualPct}%/yr` : ""} · util ${c.gmx.utilizationPct}%`);
  }
  if (c.sentiment) lines.push(`Sentiment: ${c.sentiment.label} (${c.sentiment.score})`);
  return lines.length ? `On-chain context for ${c.symbol}:\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}
