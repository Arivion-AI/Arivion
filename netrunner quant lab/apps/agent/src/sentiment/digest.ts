import { getFearGreed, type FearGreed } from "./fearGreed.js";
import { getFundingSentiment, type FundingSentiment } from "./funding.js";
import { getSocialSentiment, getOnchainFlowSentiment, type SentimentSignal } from "./social.js";

// A1 — the blended SENTIMENT DIGEST. Combines the available sources across timeframes into one market-
// level (and optional per-token) reading with provenance, feeding both the Market Briefing and the
// reasoning sentiment analyst. Multi-source by design (the research-backed stack): fear-greed (crowd),
// funding/OI (positioning), social (narrative), on-chain flow. Honest: only the sources that are live
// contribute; the rest are listed as "unavailable" and don't move the score.

export interface SentimentComponent { source: string; status: "ok" | "unavailable"; score: number | null; detail: string }
export interface SentimentDigest {
  symbol: string | null;
  score: number;              // -1..1 blended (positive = bullish/greedy)
  label: string;              // human label
  fearGreed: FearGreed | null;
  funding: FundingSentiment | null;
  components: SentimentComponent[];
  regimeTag: string;          // compact tag stamped onto episodes for learnable context
  as_of: string;
}

function fgScore(fg: FearGreed | null): number | null {
  return fg ? (fg.value - 50) / 50 : null; // 0..100 → -1..1 (greed positive)
}

export async function sentimentDigest(symbol?: string): Promise<SentimentDigest> {
  const [fg, funding, social, flow] = await Promise.all([
    getFearGreed(),
    getFundingSentiment(symbol),
    symbol ? getSocialSentiment(symbol) : Promise.resolve<SentimentSignal>({ source: "lunarcrush", status: "unavailable", score: null, magnitude: null, detail: "no symbol", as_of: new Date().toISOString() }),
    symbol ? getOnchainFlowSentiment(symbol) : Promise.resolve<SentimentSignal>({ source: "santiment", status: "unavailable", score: null, magnitude: null, detail: "no symbol", as_of: new Date().toISOString() }),
  ]);

  const components: SentimentComponent[] = [];
  const weighted: Array<{ s: number; w: number }> = [];
  const fgs = fgScore(fg);
  if (fgs != null) { components.push({ source: "fear_greed", status: "ok", score: Number(fgs.toFixed(2)), detail: `${fg!.value} (${fg!.classification})` }); weighted.push({ s: fgs, w: 0.4 }); }
  else components.push({ source: "fear_greed", status: "unavailable", score: null, detail: "feed dark" });
  if (funding) { components.push({ source: "funding_positioning", status: "ok", score: funding.marketScore, detail: funding.label }); weighted.push({ s: funding.marketScore, w: 0.35 }); }
  else components.push({ source: "funding_positioning", status: "unavailable", score: null, detail: "feed dark" });
  for (const sig of [social, flow]) {
    components.push({ source: sig.source, status: sig.status, score: sig.score, detail: sig.detail });
    if (sig.status === "ok" && sig.score != null) weighted.push({ s: sig.score, w: 0.25 });
  }

  const wsum = weighted.reduce((a, b) => a + b.w, 0);
  const score = wsum > 0 ? weighted.reduce((a, b) => a + b.s * b.w, 0) / wsum : 0;
  const label = score > 0.4 ? "greedy / risk-on" : score > 0.15 ? "leaning bullish" : score < -0.4 ? "fearful / risk-off" : score < -0.15 ? "leaning bearish" : "neutral";
  const regimeTag = `sent=${label.split(" ")[0]}|fg=${fg ? fg.classification.replace(/\s+/g, "_") : "na"}|fund=${funding ? (funding.marketScore > 0.33 ? "crowdedLong" : funding.marketScore < -0.33 ? "crowdedShort" : "balanced") : "na"}`;

  return {
    symbol: symbol ? symbol.replace(/USDT?$/i, "").toUpperCase() : null,
    score: Number(score.toFixed(2)), label, fearGreed: fg, funding, components, regimeTag, as_of: new Date().toISOString(),
  };
}
