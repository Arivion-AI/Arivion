import { config } from "../config.js";
import { logger } from "../logger.js";
import { fetchTickers, regimeOf, type Ticker } from "../market/scanner.js";
import { getArbitrumUniverse } from "../market/arbitrumUniverse.js";
import { tryFetchKlines } from "./klines.js";
import { sma, rsi, macd, realizedVol, sharpeLike, returnOver, maxDrawdown } from "./indicators.js";
import { rankCandidates, type TokenRaw, type ScoredToken, type RiskAppetite, type SelectionStyle } from "./factors.js";
import { scoreNewsSentiment } from "./sentiment.js";
import type { ToolCaller } from "../orchestrator/runner.js";

// Phase 29 — the multi-factor token ANALYSIS & SELECTION engine. This is the real research the agent
// runs instead of "just call Bybit's top movers": it screens the live universe, computes per-token
// technicals from historical candles, scores derivatives positioning (funding/OI), folds in LLM-scored
// NEWS SENTIMENT for the finalists, and produces a risk-weighted, explainable ranking — plus a parallel
// xStocks (tokenized-equity) screen so the agent always has an equities suggestion. Each stage streams a
// board widget to the Nexa UI. Read-only/analysis — it never touches the order path.

export type ScreenEmit = (w: { id?: string; kind: string; title: string; state: "running" | "done" | "error"; rationale?: string; data?: unknown }) => void;

export interface ScreenPick {
  symbol: string;
  base: string;
  rank: number;
  composite: number;
  factors: ScoredToken["factors"];
  rationale: string;
  regime: string;
  // raw highlights surfaced for the UI / answer
  last: number;
  pct24h: number;
  ret7d: number | null;
  ret30d: number | null;
  rsi: number | null;
  turnover24h: number;
  funding: number | null;
  realized_vol: number | null;
  news_score: number | null;
  news: Array<{ title: string; source: string; published: string | null; link: string }>;
}

export interface ScreenResult {
  risk: RiskAppetite;
  style: SelectionStyle;
  category: "linear" | "spot";
  as_of_note: string;
  universe: number;
  liquid: number;
  candidates: number;
  factor_keys: string[];
  picks: ScreenPick[];
  xstocks: ScreenPick[];
}

export interface ScreenOpts {
  risk?: RiskAppetite;
  style?: SelectionStyle;
  category?: "linear" | "spot";
  top?: number;
  includeXstocks?: boolean;
  useNews?: boolean;
  useWeb?: boolean;
}

const FACTOR_KEYS = ["momentum", "trend", "rsi_health", "liquidity", "low_vol", "risk_adj", "carry", "sentiment"];

function minTurnoverFor(risk: RiskAppetite): number {
  if (risk === "conservative") return 50_000_000;
  if (risk === "aggressive") return 5_000_000;
  return 20_000_000;
}

// Pre-rank for the shortlist that gets a (per-symbol) kline fetch. Momentum style pre-ranks by
// momentum×liquidity (chase movers); quality/balanced pre-rank by LIQUIDITY ALONE so the deep factor
// scan sees a broad, unbiased slice of the market — NOT just today's top gainers.
function shortlistScore(t: Ticker, style: SelectionStyle): number {
  if (style === "momentum") return (t.pct24h / 5) * Math.log10(Math.max(10, t.turnover24h)) + t.range24h * 2;
  return Math.log10(Math.max(10, t.turnover24h));
}

// Quality floor: for quality/balanced, drop parabolic / blow-off names BEFORE ranking so we never buy
// the top of a pump. (Momentum style keeps them — that's the point of momentum.) Equity/xstock-safe:
// funding/OI absence doesn't matter here.
function passesQualityFloor(r: TokenRaw, style: SelectionStyle): boolean {
  if (style === "momentum") return true;
  if (r.pct24h > 40) return false; // up >40% in 24h → too hot to chase
  if (r.rsi != null && r.rsi > 85) return false; // blow-off-top overbought
  if (r.realizedVol != null && r.realizedVol > 0.18) return false; // ~18%/day realized vol — too wild
  return true;
}

// Build a TokenRaw from a live ticker + its historical candles (closes oldest→newest).
function rawFromTicker(t: Ticker, closes: number[], highs: number[], lows: number[]): TokenRaw {
  const m = macd(closes);
  return {
    symbol: t.symbol, base: t.base, last: t.last, pct24h: t.pct24h, turnover24h: t.turnover24h,
    range24h: t.range24h, funding: t.funding, oiValue: t.oi_value,
    ret7d: returnOver(closes, 7), ret30d: returnOver(closes, 30),
    sma20: sma(closes, 20), sma50: sma(closes, 50), rsi: rsi(closes, 14),
    macdHist: m ? m.hist : null, realizedVol: realizedVol(closes),
    sharpe: sharpeLike(closes), maxDrawdown: maxDrawdown(closes),
    sentiment: null, regime: regimeOf(t.pct24h, t.range24h),
  };
}

function toPick(s: ScoredToken): ScreenPick {
  const r = s.raw;
  return {
    symbol: s.symbol, base: s.base, rank: s.rank, composite: s.composite, factors: s.factors,
    rationale: s.rationale, regime: r.regime ?? "",
    last: r.last, pct24h: Number(r.pct24h.toFixed(2)), ret7d: r.ret7d, ret30d: r.ret30d, rsi: r.rsi != null ? Number(r.rsi.toFixed(1)) : null,
    turnover24h: Math.round(r.turnover24h), funding: r.funding, realized_vol: r.realizedVol,
    news_score: r.sentiment, news: [],
  };
}

// Fetch candles for a set of tickers and assemble their TokenRaw rows. Fanned out in small CHUNKS (not
// one giant Promise.all) so we don't trip Bybit's public rate limit on a big candidate set.
async function assembleRaws(tickers: Ticker[], category: "linear" | "spot"): Promise<TokenRaw[]> {
  const lookback = config.analysisKlineLookback;
  const CHUNK = 6;
  const series: Awaited<ReturnType<typeof tryFetchKlines>>[] = [];
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const batch = tickers.slice(i, i + CHUNK);
    series.push(...(await Promise.all(batch.map((t) => tryFetchKlines(t.symbol, category, "D", lookback)))));
  }
  return tickers.map((t, i) => rawFromTicker(t, series[i].closes, series[i].highs, series[i].lows));
}

// Run the LLM news-sentiment pass over the finalists (top by quant composite) and fold the score back
// into their raw metrics so the final re-rank reflects narrative. Attaches headlines to the picks map.
async function applySentiment(
  ownerId: number, scored: ScoredToken[], n: number, useWeb: boolean,
): Promise<Map<string, { score: number; items: ScreenPick["news"] }>> {
  const finalists = scored.slice(0, n);
  const out = new Map<string, { score: number; items: ScreenPick["news"] }>();
  await Promise.all(
    finalists.map(async (s) => {
      const sent = await scoreNewsSentiment(ownerId, s.base, s.symbol, { useWeb });
      s.raw.sentiment = sent.score; // mutate so rankCandidates re-scores with sentiment
      out.set(s.symbol, { score: sent.score, items: sent.items });
    }),
  );
  return out;
}

export async function screenTokens(ownerId: number, opts: ScreenOpts = {}, mcp?: ToolCaller, emit?: ScreenEmit): Promise<ScreenResult> {
  const e: ScreenEmit = emit ?? (() => {});
  const risk = opts.risk ?? "moderate";
  const style: SelectionStyle = opts.style ?? "balanced";
  const category = opts.category ?? "linear";
  const top = Math.min(opts.top ?? 5, 15);
  const useNews = opts.useNews !== false;
  const useWeb = opts.useWeb === true;

  // 1) Universe + liquidity filter.
  e({ id: "scr-universe", kind: "scan", title: "Universe", state: "running", rationale: "Pulling the live Bybit universe…" });
  const all = await fetchTickers(category);
  const minTurnover = minTurnoverFor(risk);
  // Linear (crypto) is scoped to coins tradeable on Arbitrum + ETH; spot (tokenized equities) stays full.
  const arb = category === "linear" ? await getArbitrumUniverse() : null;
  const liquid = all.filter((t) => t.turnover24h >= minTurnover && (!arb?.size || arb.has(t.base)));
  const up = liquid.filter((t) => t.pct24h > 0).length;
  e({ id: "scr-universe", kind: "scan", title: "Universe screened", state: "done",
    rationale: `${liquid.length}/${all.length} liquid · ${liquid.length ? Math.round((up / liquid.length) * 100) : 0}% advancing · ${style} style`,
    data: { universe: all.length, liquid: liquid.length, breadth_pct_up: liquid.length ? Number(((up / liquid.length) * 100).toFixed(1)) : 0, min_turnover: minTurnover, style } });

  // 2) Shortlist (style-aware) → 3) deep factor pass → quality floor. Widen the net and re-scan if too
  // few names clear the floor, so we "screen many until enough good ones pass" rather than forcing N.
  e({ id: "scr-factors", kind: "factors", title: "Factor analysis", state: "running", rationale: `Deep factor analysis (${style})…` });
  const seen = new Set<string>();
  let kept: TokenRaw[] = [];
  let scanned = 0;
  for (const poolMult of [1, 2, 3]) {
    const poolSize = config.analysisCandidatePool * poolMult;
    const shortlist = liquid.slice().sort((a, b) => shortlistScore(b, style) - shortlistScore(a, style)).slice(0, poolSize).filter((t) => !seen.has(t.symbol));
    shortlist.forEach((t) => seen.add(t.symbol));
    if (!shortlist.length) break;
    scanned += shortlist.length;
    const raws = await assembleRaws(shortlist, category);
    kept = kept.concat(raws.filter((r) => passesQualityFloor(r, style)));
    if (kept.length >= Math.max(top * 2, config.analysisFinalists)) break; // enough quality names — stop widening
  }
  if (!kept.length) kept = (await assembleRaws(liquid.slice().sort((a, b) => shortlistScore(b, style) - shortlistScore(a, style)).slice(0, config.analysisCandidatePool), category)); // floor too strict → fall back
  const raws = kept;
  let scored = rankCandidates(raws, risk, style);
  e({ id: "scr-factors", kind: "factors", title: "Factor analysis", state: "done", rationale: `${scored.length} quality names from ${scanned} scanned · ${FACTOR_KEYS.length} factors (${style})`,
    data: { factor_keys: FACTOR_KEYS, style, scanned, tokens: scored.slice(0, 12).map((s) => ({ symbol: s.symbol, composite: s.composite, factors: s.factors, rationale: s.rationale, pct24h: Number(s.raw.pct24h.toFixed(2)), rsi: s.raw.rsi != null ? Number(s.raw.rsi.toFixed(0)) : null })) } });

  // 4) Sentiment pass over the finalists (LLM-scored news) → fold back + re-rank.
  let newsMap = new Map<string, { score: number; items: ScreenPick["news"] }>();
  if (useNews) {
    e({ id: "scr-sentiment", kind: "news", title: "News sentiment", state: "running", rationale: `Scoring news for the top ${Math.min(config.analysisFinalists, scored.length)}…` });
    newsMap = await applySentiment(ownerId, scored, config.analysisFinalists, useWeb).catch((err) => {
      logger.warn("sentiment pass failed", { message: (err as Error).message });
      return new Map();
    });
    scored = rankCandidates(raws, risk, style); // re-rank now that sentiment is populated
    const items = [...newsMap.entries()].flatMap(([sym, v]) => v.items.slice(0, 2).map((it) => ({ ...it, symbol: sym })));
    e({ id: "scr-sentiment", kind: "news", title: "News sentiment", state: "done", rationale: `${newsMap.size} tokens scored`, data: { items } });
  }

  // 5) Final picks (attach headlines).
  const picks = scored.slice(0, top).map((s) => {
    const p = toPick(s);
    const nm = newsMap.get(s.symbol);
    if (nm) { p.news = nm.items; p.news_score = nm.score; }
    return p;
  });

  // 6) xStocks — always screen a parallel tokenized-equity basket (reduced factor set; no funding/OI).
  let xstocks: ScreenPick[] = [];
  if (opts.includeXstocks !== false) {
    xstocks = await screenXstocks(ownerId, mcp, Math.min(top, 5), risk, style, useNews).catch((err) => {
      logger.warn("xstock screen failed", { message: (err as Error).message });
      return [];
    });
  }

  e({ id: "scr-result", kind: "screen", title: `Top tokens · ${risk} · ${style}`, state: "done",
    rationale: picks.length ? `#1 ${picks[0].symbol} (${(picks[0].composite * 100).toFixed(0)})` : "no liquid candidates",
    data: { risk, style, category, factor_keys: FACTOR_KEYS, picks, xstocks } });

  return {
    risk, style, category, as_of_note: "Bybit live tickers + daily candles; news from trusted RSS",
    universe: all.length, liquid: liquid.length, candidates: scanned,
    factor_keys: FACTOR_KEYS, picks, xstocks,
  };
}

// Pull the Lab's xStock universe (bot-enabled *USDT tokenized equities). Local copy (avoids importing
// multiasset/setup, which imports THIS module) — same shape as multiasset's fetchXstockUniverse.
async function xstockSymbols(mcp: ToolCaller, limit: number): Promise<string[]> {
  const r = await mcp.callTool("xstocks_catalog", {}).catch(() => null);
  if (!r) return [];
  let o: Record<string, unknown> = {};
  if (r.raw && typeof r.raw === "object") o = r.raw as Record<string, unknown>;
  else { try { o = JSON.parse(r.text ?? "{}"); } catch { o = {}; } }
  const xs = (o.xstocks ?? (o.result as Record<string, unknown>)?.xstocks ?? []) as Array<Record<string, unknown>>;
  return xs.filter((x) => x.bot_enabled !== false && x.symbol).map((x) => String(x.symbol)).slice(0, limit);
}

// Screen tokenized equities on Bybit SPOT with the same factor engine (funding/OI are null → neutral,
// so the score leans on momentum/trend/vol/liquidity/sentiment). Returns the top picks.
export async function screenXstocks(ownerId: number, mcp: ToolCaller | undefined, top: number, risk: RiskAppetite, style: SelectionStyle, useNews: boolean): Promise<ScreenPick[]> {
  if (!mcp) return [];
  const symbols = await xstockSymbols(mcp, config.analysisCandidatePool);
  if (!symbols.length) return [];
  const spot = await fetchTickers("spot");
  const bySym = new Map(spot.map((t) => [t.symbol, t]));
  const tickers = symbols.map((s) => bySym.get(s)).filter((t): t is Ticker => !!t && t.last > 0);
  if (!tickers.length) return [];
  let raws = (await assembleRaws(tickers, "spot")).filter((r) => passesQualityFloor(r, style));
  if (!raws.length) raws = await assembleRaws(tickers, "spot"); // floor too strict for the equity set
  let scored = rankCandidates(raws, risk, style);
  let newsMap = new Map<string, { score: number; items: ScreenPick["news"] }>();
  if (useNews) {
    newsMap = await applySentiment(ownerId, scored, Math.min(config.analysisFinalists, scored.length), false).catch(() => new Map());
    scored = rankCandidates(raws, risk, style);
  }
  return scored.slice(0, top).map((s) => {
    const p = toPick(s);
    const nm = newsMap.get(s.symbol);
    if (nm) { p.news = nm.items; p.news_score = nm.score; }
    return p;
  });
}
