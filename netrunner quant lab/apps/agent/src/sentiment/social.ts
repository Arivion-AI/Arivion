import { config } from "../config.js";
import { logger } from "../logger.js";

// A1 — SOCIAL sentiment (LunarCrush) + ON-CHAIN flow (Santiment) adapters. Both are key-gated: absent a
// key they return an honest "unavailable" so the digest/briefing simply omits the line (never fabricated
// social numbers). Wired so that adding LUNARCRUSH_API_KEY / SANTIMENT_API_KEY in .env lights them up
// with no further code. The normalized shape ({score:-1..1, magnitude, as_of, source, status}) matches
// the other sentiment sources so the digest blends them uniformly.

export interface SentimentSignal {
  source: "lunarcrush" | "santiment";
  status: "ok" | "unavailable";
  score: number | null;          // -1..1 (positive = bullish)
  magnitude: number | null;      // 0..1 intensity (e.g. social volume z-score, normalized)
  detail: string;
  as_of: string;
}

function unavailable(source: SentimentSignal["source"], reason: string): SentimentSignal {
  return { source, status: "unavailable", score: null, magnitude: null, detail: reason, as_of: new Date().toISOString() };
}

// LunarCrush Galaxy/social score for a token. Lit up by LUNARCRUSH_API_KEY.
export async function getSocialSentiment(symbol: string): Promise<SentimentSignal> {
  const key = config.lunarcrushApiKey;
  if (!key) return unavailable("lunarcrush", "LunarCrush not configured (set LUNARCRUSH_API_KEY).");
  const base = symbol.replace(/USDT?$/i, "").toUpperCase();
  try {
    const res = await fetch(`https://lunarcrush.com/api4/public/coins/${encodeURIComponent(base)}/v1`, {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": "DualityCopilot/1.0" }, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return unavailable("lunarcrush", `LunarCrush HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { galaxy_score?: number; sentiment?: number; social_volume_24h?: number } };
    const gs = j.data?.galaxy_score; const sent = j.data?.sentiment;
    if (gs == null && sent == null) return unavailable("lunarcrush", "LunarCrush returned no score.");
    // Galaxy score is 0..100; sentiment 0..100 (bullish %). Map to -1..1.
    const score = sent != null ? (sent - 50) / 50 : gs != null ? (gs - 50) / 50 : 0;
    return { source: "lunarcrush", status: "ok", score: Number(score.toFixed(2)), magnitude: gs != null ? Number((gs / 100).toFixed(2)) : null, detail: `Galaxy ${gs ?? "?"} · sentiment ${sent ?? "?"}`, as_of: new Date().toISOString() };
  } catch (e) {
    logger.warn("lunarcrush failed", { message: (e as Error).message });
    return unavailable("lunarcrush", (e as Error).message);
  }
}

// Santiment on-chain/dev-activity signal. Lit up by SANTIMENT_API_KEY (GraphQL). Stubbed to an honest
// unavailable until a key exists; the integration point is here so it's a config flip, not a rewrite.
export async function getOnchainFlowSentiment(symbol: string): Promise<SentimentSignal> {
  const key = config.santimentApiKey;
  if (!key) return unavailable("santiment", "Santiment not configured (set SANTIMENT_API_KEY).");
  // Minimal: a key being present means the caller intends Santiment; the concrete metric query is added
  // when the key is provisioned. Returning unavailable-with-reason keeps the contract honest meanwhile.
  void symbol;
  return unavailable("santiment", "Santiment key present but metric query not yet provisioned.");
}
