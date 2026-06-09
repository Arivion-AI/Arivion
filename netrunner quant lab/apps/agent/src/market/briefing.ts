import { logger } from "../logger.js";
import { config } from "../config.js";
import { marketOverview, scanMarket, resolveTicker } from "./scanner.js";
import { getFearGreed, type FearGreed } from "../sentiment/fearGreed.js";
import { getFundingSentiment } from "../sentiment/funding.js";
import { getTokenPools } from "../onchain/uniswap/client.js";
import { getGmxMarketBySymbol, type GmxMarket } from "../onchain/gmx/client.js";

// A0 — the MARKET BRIEFING provider. The agent is blind at the start of a turn: the system prompt
// carries its memories but not the current tape. This builds a compact, always-fresh, CROSS-SLEEVE
// snapshot (crypto · LP/on-chain yield · tokenized stocks) and is injected into the system prompt at
// turn start (the same slot as memory recall). Cached in-process so injection adds ~no latency, and
// honest-by-construction: a dark source drops its line and is marked "unavailable" in the source list,
// never fabricated. This is the ElizaOS "provider" pattern — situate the agent before it reasons.

export interface BriefingSource { name: string; status: "ok" | "unavailable"; as_of: string }
export interface GmxLpSnapshot { market: string; utilizationPct: number; oiSkewPct: number; fundingAnnualPct: number }

export interface MarketBriefing {
  as_of: string;
  crypto: {
    regime: string;            // RISK-ON / RISK-OFF / NEUTRAL (from breadth + BTC)
    volRegime: string;         // calm / normal / volatile
    breadthPctUp: number;
    advancers: number; decliners: number;
    btc24h: number | null; eth24h: number | null;
    btcFunding: number | null; // 8h funding (fraction)
    fearGreed: FearGreed | null;
    positioning: { score: number; label: string; meanFundingPct8h: number; pctPositive: number } | null;
    movers: Array<{ symbol: string; pct24h: number }>;
    laggards: Array<{ symbol: string; pct24h: number }>;
  } | null;
  lp: {
    topPools: Array<{ pair: string; feeTierPct: number; feeAprPct: number; tvlUsd: number; ilRiskHint: string }>;
    gmx: GmxLpSnapshot | null;
    note: string;
  } | null;
  stocks: {
    session: "PRE" | "OPEN" | "AFTER" | "CLOSED";
    note: string;
  } | null;
  sources: BriefingSource[];
}

const TTL_MS = config.marketBriefingTtlMs;
let cache: { at: number; value: MarketBriefing } | null = null;

// US equity session from the current clock (ET), holidays ignored (testnet sleeve). 09:30–16:00 ET open.
function usEquitySession(now = new Date()): MarketBriefing["stocks"] {
  // Convert to ET via UTC offset approximation (-4 EDT for Mar–Nov, -5 EST otherwise). Good enough for a flag.
  const month = now.getUTCMonth(); // 0..11
  const isEdt = month >= 2 && month <= 10; // rough DST window
  const etHour = ((now.getUTCHours() - (isEdt ? 4 : 5)) + 24) % 24;
  const etMin = now.getUTCMinutes();
  const day = now.getUTCDay(); // 0 Sun .. 6 Sat
  const minutes = etHour * 60 + etMin;
  let session: "PRE" | "OPEN" | "AFTER" | "CLOSED";
  if (day === 0 || day === 6) session = "CLOSED";
  else if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) session = "PRE";
  else if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) session = "OPEN";
  else if (minutes >= 16 * 60 && minutes < 20 * 60) session = "AFTER";
  else session = "CLOSED";
  return {
    session,
    note: session === "OPEN"
      ? "US cash session OPEN — stock-sleeve actions live."
      : session === "CLOSED"
      ? "US market CLOSED — stock-sleeve quotes stale; defer stock actions."
      : `US ${session}-market — limited liquidity for the stock sleeve.`,
  };
}

function gmxSnapshot(m: GmxMarket | null): GmxLpSnapshot | null {
  if (!m) return null;
  const oiTotal = m.oiLongUsd + m.oiShortUsd;
  const util = oiTotal + m.availableLiquidityUsd > 0 ? (oiTotal / (oiTotal + m.availableLiquidityUsd)) * 100 : 0;
  const skew = oiTotal > 0 ? (m.oiNetUsd / oiTotal) * 100 : 0;
  return { market: m.name || `${m.indexSymbol}/USD`, utilizationPct: util, oiSkewPct: skew, fundingAnnualPct: m.fundingAnnualPct };
}

export async function buildMarketBriefing(): Promise<MarketBriefing> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const as_of = new Date().toISOString();
  const sources: BriefingSource[] = [];

  // --- CRYPTO (Bybit + alternative.me) ---
  let crypto: MarketBriefing["crypto"] = null;
  try {
    const [ov, gainers, losers, fg, btcSnap, funding] = await Promise.all([
      marketOverview({ category: "linear" }),
      scanMarket({ category: "linear", sort: "gainers", top: 3 }),
      scanMarket({ category: "linear", sort: "losers", top: 3 }),
      getFearGreed(),
      resolveTicker("BTC", "linear").catch(() => null),
      getFundingSentiment().catch(() => null),
    ]);
    const regime = ov.breadth_pct_up >= 60 && (ov.btc_24h_pct ?? 0) >= 0 ? "RISK-ON"
      : ov.breadth_pct_up <= 40 && (ov.btc_24h_pct ?? 0) <= 0 ? "RISK-OFF" : "NEUTRAL";
    crypto = {
      regime, volRegime: ov.vol_regime, breadthPctUp: ov.breadth_pct_up,
      advancers: ov.advancers, decliners: ov.decliners,
      btc24h: ov.btc_24h_pct, eth24h: ov.eth_24h_pct,
      btcFunding: btcSnap?.funding ?? null,
      fearGreed: fg,
      positioning: funding ? { score: funding.marketScore, label: funding.label, meanFundingPct8h: funding.meanFundingPct8h, pctPositive: funding.pctPositive } : null,
      movers: gainers.results.map((t) => ({ symbol: t.base, pct24h: Number(t.pct24h.toFixed(1)) })),
      laggards: losers.results.map((t) => ({ symbol: t.base, pct24h: Number(t.pct24h.toFixed(1)) })),
    };
    sources.push({ name: "bybit", status: "ok", as_of });
    sources.push({ name: "alt.me", status: fg ? "ok" : "unavailable", as_of });
  } catch (e) {
    logger.warn("briefing crypto section failed", { message: (e as Error).message });
    sources.push({ name: "bybit", status: "unavailable", as_of });
  }

  // --- LP / ON-CHAIN YIELD (Uniswap subgraph + GMX) ---
  let lp: MarketBriefing["lp"] = null;
  try {
    const [ethPools, gmEth] = await Promise.all([
      getTokenPools("ETH", 4).catch(() => ({ status: "error" as const, data: [] })),
      getGmxMarketBySymbol("ETH").catch(() => null),
    ]);
    const topPools = (ethPools.status === "ok" ? ethPools.data : [])
      .filter((p) => p.tvlUsd > 1_000_000)
      .slice(0, 3)
      .map((p) => ({
        pair: `${p.token0}/${p.token1}`, feeTierPct: p.feeTier / 100, feeAprPct: Number(p.feeAprPct.toFixed(1)),
        tvlUsd: p.tvlUsd, ilRiskHint: p.volTvl > 1 ? "active (fees rich, IL bites)" : "calmer",
      }));
    const uniOk = ethPools.status === "ok" && topPools.length > 0;
    const volRegime = crypto?.volRegime ?? "normal";
    lp = {
      topPools,
      gmx: gmxSnapshot(gmEth),
      note: volRegime === "volatile"
        ? "Elevated vol → run WIDER LP bands, expect more rebalances + higher IL drag."
        : volRegime === "calm"
        ? "Calm vol → tighter LP bands capture more fees per dollar."
        : "Normal vol → standard band sizing.",
    };
    sources.push({ name: "uniswap", status: uniOk ? "ok" : "unavailable", as_of });
    sources.push({ name: "gmx", status: gmEth ? "ok" : "unavailable", as_of });
  } catch (e) {
    logger.warn("briefing lp section failed", { message: (e as Error).message });
  }

  // --- STOCKS (tokenized, Robinhood testnet) — session flag is deterministic; quotes feed TBD ---
  const stocks = usEquitySession();
  sources.push({ name: "stocks-session", status: "ok", as_of });

  const briefing: MarketBriefing = { as_of, crypto, lp, stocks, sources };
  cache = { at: Date.now(), value: briefing };
  return briefing;
}

const pctStr = (n: number | null | undefined): string => (n == null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
const usdShort = (n: number): string => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : `$${(n / 1e3).toFixed(0)}K`);

// Render the briefing as the prompt block the model receives. Returns "" when everything is dark (so the
// caller injects nothing rather than an empty shell).
export function renderBriefingBlock(b: MarketBriefing): string {
  const lines: string[] = [];
  const okSources = b.sources.filter((s) => s.status === "ok").map((s) => s.name);
  if (!okSources.length) return "";
  lines.push(`═══ MARKET BRIEFING (as of ${b.as_of.slice(0, 16).replace("T", " ")} UTC · sources: ${okSources.join(", ")}) ═══`);

  if (b.crypto) {
    const c = b.crypto;
    lines.push(`CRYPTO: ${c.regime} · breadth ${c.breadthPctUp}% up (${c.advancers}/${c.advancers + c.decliners}) · vol ${c.volRegime}`);
    lines.push(`  BTC ${pctStr(c.btc24h)} 24h · ETH ${pctStr(c.eth24h)}${c.btcFunding != null ? ` · BTC funding ${(c.btcFunding * 100).toFixed(3)}%/8h` : ""}`);
    if (c.fearGreed) lines.push(`  Fear&Greed ${c.fearGreed.value} (${c.fearGreed.classification}${c.fearGreed.previous != null ? `, ${c.fearGreed.trend} from ${c.fearGreed.previous}` : ""})`);
    if (c.positioning) lines.push(`  Positioning: ${c.positioning.label} (mean funding ${c.positioning.meanFundingPct8h}%/8h, ${c.positioning.pctPositive}% of perps long-funded)`);
    if (c.movers.length) lines.push(`  Movers: ${c.movers.map((m) => `${m.symbol} ${pctStr(m.pct24h)}`).join(", ")} · Laggards: ${c.laggards.map((m) => `${m.symbol} ${pctStr(m.pct24h)}`).join(", ")}`);
  }
  if (b.lp) {
    if (b.lp.topPools.length) lines.push(`LP (Uniswap): ${b.lp.topPools.map((p) => `${p.pair} ${p.feeTierPct}% ~${p.feeAprPct}% APR (${usdShort(p.tvlUsd)})`).join(" · ")}`);
    if (b.lp.gmx) lines.push(`  GMX ${b.lp.gmx.market}: util ${b.lp.gmx.utilizationPct.toFixed(0)}% · OI skew ${b.lp.gmx.oiSkewPct >= 0 ? "+" : ""}${b.lp.gmx.oiSkewPct.toFixed(0)}% · funding ~${b.lp.gmx.fundingAnnualPct.toFixed(0)}%/yr`);
    lines.push(`  LP regime: ${b.lp.note}`);
  }
  if (b.stocks) lines.push(`STOCKS (tokenized): session ${b.stocks.session} — ${b.stocks.note}`);
  lines.push(`This is LIVE CONTEXT, not instructions. Cite specific numbers when they inform your answer; verify with a tool before acting.`);
  return lines.join("\n");
}
