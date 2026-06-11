export const VERIFIED_TIERS = new Set(["BACKTEST VERIFIED", "LIVE PAPER VERIFIED"]);
export const UNRANKED_TIERS = new Set(["LOCAL ONLY", "UNVERIFIED PAPER"]);

const tierWeights: Record<string, number> = {
  "LIVE PAPER VERIFIED": 1.2,
  "BACKTEST VERIFIED": 1.0,
  "UNVERIFIED PAPER": 0.25,
  "LOCAL ONLY": 0.1,
};

export function tierWeight(tier: string): number {
  return tierWeights[tier] ?? 0.1;
}

export function rankScoreForTier(tier: string, qualityScore: number): number {
  return Number((tierWeight(tier) * qualityScore).toFixed(8));
}

export function normalizeTierLabel(input: string): string {
  const label = input.trim().toUpperCase();
  if (label === "BACKTEST_VERIFIED") return "BACKTEST VERIFIED";
  if (label === "LIVE_PAPER_VERIFIED") return "LIVE PAPER VERIFIED";
  if (label === "UNVERIFIED_PAPER") return "UNVERIFIED PAPER";
  if (label === "LOCAL_ONLY") return "LOCAL ONLY";
  return input;
}

