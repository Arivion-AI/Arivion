import { getPoolDepth, quoteImpactFromDepth } from "../uniswap/poolDepth.js";

// DEPTH / SLIPPAGE analyzer. Used both to size LP entries/exits and to keep leverage-trade execution
// honest. PREFERRED path (L1): real v3 virtual-reserve depth from on-chain pool state (poolDepth.ts) —
// price impact computed against the actual active liquidity. FALLBACK: a conservative √-impact model
// keyed off TVL with a concentration factor, for when the subgraph is dark or the pair isn't USD-anchored.

export interface DepthEstimate { tradeUsd: number; tvlUsd: number; priceImpactBps: number; note: string; source?: "onchain_reserves" | "heuristic" }

export function estimateSlippage(tradeUsd: number, tvlUsd: number, concentration = 3): DepthEstimate {
  if (tvlUsd <= 0) return { tradeUsd, tvlUsd, priceImpactBps: 9999, note: "No liquidity — avoid.", source: "heuristic" };
  // Effective depth near spot ≈ TVL · concentration. Impact ≈ tradeFraction (constant-product-ish),
  // softened by √ for the part of the book that refills. Conservative, not a venue-exact quote.
  const frac = tradeUsd / (tvlUsd * concentration);
  const impact = Math.min(1, frac + Math.sqrt(Math.max(0, frac)) * 0.25);
  const bps = Math.round(impact * 10000);
  return {
    tradeUsd, tvlUsd, priceImpactBps: bps, source: "heuristic",
    note: bps < 10 ? "Negligible impact." : bps < 50 ? "Modest impact." : bps < 200 ? "Material — split the order." : "High impact — pool too shallow for this size.",
  };
}

// Real depth from on-chain pool reserves when a poolId is known; falls back to the TVL heuristic.
export async function estimateSlippageOnchain(poolId: string | null, tradeUsd: number, tvlUsd: number): Promise<DepthEstimate> {
  if (poolId) {
    const depth = await getPoolDepth(poolId).catch(() => null);
    if (depth) {
      const q = quoteImpactFromDepth(depth, tradeUsd, "buy_base");
      return { tradeUsd, tvlUsd: depth.activeLiquidityUsd, priceImpactBps: q.priceImpactBps, note: `${q.note} (active depth $${Math.round(q.depthUsd).toLocaleString()})`, source: "onchain_reserves" };
    }
  }
  return estimateSlippage(tradeUsd, tvlUsd);
}
