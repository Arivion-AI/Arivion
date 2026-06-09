// Shared LP-analysis types. An "LP candidate" is a place you can provide liquidity for an asset —
// a Uniswap pool (a specific fee tier) OR a GMX GM pool / GLV vault — normalized so the discover/rank
// step can compare them side by side regardless of venue.

export type LpVenue = "uniswap" | "gmx_gm" | "gmx_glv";

export interface LpCandidate {
  id: string;                    // pool/vault address or a synthetic id
  venue: LpVenue;
  label: string;                 // human label e.g. "Uniswap v3 ETH/USDC 0.05%" or "GLV [ETH-USDC]"
  pair: string;                  // e.g. "ETH/USDC"
  feeTierPct: number | null;     // Uniswap fee tier %, null for GMX
  tvlUsd: number;
  volume24hUsd: number | null;
  feeAprPct: number;             // estimated annualized fee/yield APR
  yieldSource?: "uniswap_fees" | "gmx_apy" | "estimate" | "unknown";
  volTvl: number | null;         // turnover (fee-gen efficiency); null for GMX
  ilRisk: "low" | "med" | "high";
  // The composite LP score (0..1) and its component breakdown — the "show your work" for the pick.
  score: number;
  factors: { yield: number; depth: number; turnover: number; ilSafety: number };
  rationale: string;
}

export interface LpCompareResult {
  symbol: string;
  candidates: LpCandidate[];     // ranked, best first
  pick: LpCandidate | null;      // the Copilot's choice (candidates[0]) — overridable by the user
  as_of: string;
  warnings: string[];
}
