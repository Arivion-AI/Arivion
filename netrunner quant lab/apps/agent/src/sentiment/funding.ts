import { fetchTickers } from "../market/scanner.js";
import { logger } from "../logger.js";

// A1 — DERIVATIVES-POSITIONING sentiment (free, from Bybit). Funding rate is a positioning signal:
// persistently positive funding ⇒ crowded longs paying to stay long ⇒ greedy/fragile (squeeze risk);
// negative ⇒ crowded shorts. We aggregate the liquid universe into a market-level bias and also expose
// a per-symbol read. This is "what are traders positioned for", complementary to price + F&G.

export interface FundingSentiment {
  marketScore: number;          // -1..1 (positive ⇒ crowded longs / greedy positioning)
  meanFundingPct8h: number;     // mean 8h funding across liquid perps (%)
  pctPositive: number;          // share of liquid perps with positive funding
  symbol?: { name: string; funding8hPct: number | null; oiUsd: number | null; bias: string } | null;
  label: string;
  as_of: string;
}

const TTL_MS = 90_000;
let cache: { at: number; value: FundingSentiment } | null = null;

export async function getFundingSentiment(symbol?: string): Promise<FundingSentiment | null> {
  if (!symbol && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const tickers = await fetchTickers("linear");
    const liquid = tickers.filter((t) => t.turnover24h >= 5_000_000 && t.funding != null);
    if (!liquid.length) return null;
    const fundings = liquid.map((t) => t.funding as number);
    const mean = fundings.reduce((s, f) => s + f, 0) / fundings.length;
    const pctPos = liquid.filter((t) => (t.funding as number) > 0).length / liquid.length;
    // Normalize: typical 8h funding is ~±0.01% (0.0001). Map mean funding to -1..1 with a soft scale,
    // blended with breadth of positive funding (how broad the crowding is).
    const fundingScore = Math.max(-1, Math.min(1, mean / 0.0003));
    const breadthScore = (pctPos - 0.5) * 2;
    const marketScore = Math.max(-1, Math.min(1, 0.6 * fundingScore + 0.4 * breadthScore));

    let sym: FundingSentiment["symbol"] = null;
    if (symbol) {
      const base = symbol.replace(/USDT?$/i, "").toUpperCase();
      const t = tickers.find((x) => x.base === base);
      if (t) {
        const f = t.funding;
        sym = {
          name: base, funding8hPct: f != null ? Number((f * 100).toFixed(4)) : null, oiUsd: t.oi_value,
          bias: f == null ? "n/a" : f > 0.0002 ? "crowded long (funding hot)" : f < -0.0002 ? "crowded short" : "balanced",
        };
      }
    }
    const label = marketScore > 0.33 ? "crowded long / greedy positioning"
      : marketScore < -0.33 ? "crowded short / fearful positioning" : "balanced positioning";
    const out: FundingSentiment = {
      marketScore: Number(marketScore.toFixed(2)),
      meanFundingPct8h: Number((mean * 100).toFixed(4)),
      pctPositive: Number((pctPos * 100).toFixed(0)),
      symbol: sym, label, as_of: new Date().toISOString(),
    };
    if (!symbol) cache = { at: Date.now(), value: out };
    return out;
  } catch (e) {
    logger.warn("funding sentiment failed", { message: (e as Error).message });
    return null;
  }
}
