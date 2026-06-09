import { randomUUID } from "node:crypto";
import { config, USD_TO_MICRO } from "../config.js";
import { logger } from "../logger.js";
import { connectMcp } from "../mcp/client.js";
import { mintInternalToken } from "../internalToken.js";
import { executePlan, type ToolCaller } from "../orchestrator/runner.js";
import { createRun, getSteps, createThread } from "../chat/store.js";
import { recordBudgetEvent } from "../budget/index.js";
import { getRiskState } from "../risk/index.js";
import { screenTokens, type ScreenEmit } from "../analysis/engine.js";
import { tryFetchKlines, fetchKlinesPaged, toEngineBars } from "../analysis/klines.js";
import { detectRegimes, aggregateReturns, type RegimeSegment } from "../analysis/regimes.js";
import { maxDrawdown, realizedVol, sharpeLike } from "../analysis/indicators.js";
import { buildAndBacktestPlan, defaultBotFor } from "../playbooks/buildAndBacktest.js";
import type { AgentPlan } from "../orchestrator/plan.js";

// Phase 18 — multi-asset ("multiasset") setup orchestration. This is the trusted, code-driven flow
// behind the conversational request "create a multiasset trading setup for $X":
//   1. compose a basket from the user's risk appetite / duration / asset classes
//   2. BACKTEST it on recent data, then CROSS-VALIDATE the crypto core across a labelled BULL (2021)
//      and BEAR (2022) regime — not every backtest is good; the point is to see how it holds up
//   3. OPTIMIZE the portfolio's rebalance threshold (a backtest sweep, best by Sharpe)
//   4. hand back an explainable proposal (outcomes per scenario) for the user to confirm
//   5. on confirmation, START a forward multi-asset paper session through the typed playbook
// The backtest/optimize calls are read+backtest research (deterministic, fixed code) issued via the
// owner-scoped MCP client; the only LIVE mutation (start_multiasset_paper) goes through a typed plan
// with the L2 + approval guardrails (setup_multiasset_paper playbook).

export type RiskAppetite = "conservative" | "moderate" | "aggressive";
export type AssetClass = "spot" | "linear" | "xstock";
export type SelectionStyle = "quality" | "balanced" | "momentum";

export interface MultiassetParams {
  budgetUsd: number;
  risk: RiskAppetite;
  style?: SelectionStyle; // quality | balanced | momentum — how legs are screened (the agent asks)
  durationDays?: number;
  assetClasses: AssetClass[]; // subset of spot|linear|xstock (NO options — unsupported by the venue)
  symbols?: string[]; // optional explicit universe; else a sensible default per class
  weights?: Record<string, number>; // optional per-symbol target weight (fraction); set by an edited basket
  bots?: Record<string, string>; // optional per-symbol Bot-OS bot type (e.g. futures_grid); else a default
  withBots?: boolean; // run a Bot-OS bot per leg (build + backtest each) — the "distinct bots" phase
  botsOnlyMapped?: boolean; // only backtest legs present in `bots` (skip the rest — no blanket spot_grid)
}

export interface ScenarioResult {
  name: string;
  window: string;
  symbols: string[];
  metrics: { total_return: number; sharpe: number; max_drawdown: number; bars?: number };
  rebalances: number;
  risk_state: Record<string, unknown>;
  equity_curve?: number[];
  error?: string;
}

// Down-sample an equity curve to ~n points for the UI chart (real engine output, just thinned).
function sampleCurve(raw: unknown, n = 64): number[] {
  const a = (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (a.length <= n) return a;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(a[Math.round((i / (n - 1)) * (a.length - 1))]);
  return out;
}

export interface MultiassetProposal {
  budget_usd: number;
  risk: RiskAppetite;
  duration_days: number;
  weighting: string;
  interval_minutes: number;
  legs: Array<Record<string, unknown>>;
  selected_symbols: string[];
  auto_selected: boolean; // true = legs chosen by a live market scan (pass selected_symbols to go live)
  risk_gates: Record<string, string>;
  scenarios: ScenarioResult[];
  optimization: { knob: string; tested: Array<{ rebalance_threshold: number; sharpe: number; total_return: number }>; chosen: number };
  regime_report?: RegimeReport; // full bull/bear-season cross-validation across all available history
  l2_note: string;
  recommendation: string;
  warnings: string[];
}

// Crypto fallback universe ONLY when a live scan is unavailable (the primary path screens the market).
// Nothing is hardcoded for xStocks or regimes — those are fetched from the Lab at runtime.
const CRYPTO_FALLBACK: Record<"linear" | "spot", string[]> = {
  linear: ["BTCUSDT", "ETHUSDT"],
  spot: ["BTCUSDT", "ETHUSDT"],
};

// Bybit xStocks use tokenized-equity symbols (TSLAXUSDT, AMZNXUSDT, ...), while users naturally type
// underlying tickers (TSLA, AMZN). Keep that mapping explicit so multiasset requests don't accidentally
// turn equities into fake crypto perps like TSLAUSDT.
const XSTOCK_BY_UNDERLYING: Record<string, string> = {
  AAPL: "AAPLXUSDT",
  NVDA: "NVDAXUSDT",
  TSLA: "TSLAXUSDT",
  META: "METAXUSDT",
  AMZN: "AMZNXUSDT",
  GOOGL: "GOOGLXUSDT",
  GOOG: "GOOGLXUSDT",
  HOOD: "HOODXUSDT",
  CRCL: "CRCLXUSDT",
  COIN: "COINXUSDT",
  MCD: "MCDXUSDT",
};

function cleanSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function xstockSymbol(symbol: string): string | null {
  const raw = cleanSymbol(symbol);
  if (/^[A-Z]+XUSDT$/.test(raw)) return raw;
  if (/^[A-Z]+X$/.test(raw)) return `${raw}USDT`;
  const underlying = raw.replace(/^D(?=[A-Z]{2,6}$)/, "").replace(/USDT$/i, "");
  return XSTOCK_BY_UNDERLYING[underlying] ?? null;
}

function inferExplicitClass(symbol: string, classes: AssetClass[]): AssetClass {
  if (classes.includes("xstock") && xstockSymbol(symbol)) return "xstock";
  if (classes.includes("linear")) return "linear";
  if (classes.includes("spot")) return "spot";
  return classes[0] ?? "linear";
}

// xStock universe from the Lab's live catalog (bot-enabled, full *USDT symbols). Never hardcoded.
async function fetchXstockUniverse(mcp: ToolCaller, limit: number): Promise<string[]> {
  const r = await mcp.callTool("xstocks_catalog", {}).catch(() => null);
  if (!r) return [];
  const o = asObj(r);
  const xs = (o.xstocks ?? (o.result as Record<string, unknown>)?.xstocks ?? []) as Array<Record<string, unknown>>;
  return xs.filter((x) => x.bot_enabled !== false && x.symbol).map((x) => String(x.symbol)).slice(0, limit);
}

// Self-source bars for a leg straight from Bybit (best-effort). Used both as the recent-scenario
// fallback when the Lab backfill is still in flight, and to fetch a labelled regime WINDOW for any
// token. Returns [] when Bybit has nothing (e.g. the token didn't exist in that window) — honest skip.
async function bybitBars(symbol: string, category: string, interval: string, limit: number, window?: { start: number; end: number }): Promise<unknown[]> {
  const cat = category === "linear" ? "linear" : "spot";
  const series = await tryFetchKlines(symbol, cat, interval, limit, window);
  return series.bars.length ? toEngineBars(series) : [];
}

function riskGates(risk: RiskAppetite): Record<string, string> {
  if (risk === "conservative") return { max_position_fraction: "0.34", max_total_exposure_fraction: "1.0", max_daily_loss_fraction: "0.03", max_drawdown_kill_fraction: "0.10" };
  if (risk === "aggressive") return { max_position_fraction: "0.6", max_total_exposure_fraction: "2.5", max_daily_loss_fraction: "0.08", max_drawdown_kill_fraction: "0.30" };
  return { max_position_fraction: "0.5", max_total_exposure_fraction: "1.5", max_daily_loss_fraction: "0.05", max_drawdown_kill_fraction: "0.18" };
}

function pickWeighting(risk: RiskAppetite): string {
  return risk === "conservative" ? "inverse_vol" : risk === "aggressive" ? "momentum" : "equal";
}

function intervalForDuration(days: number): number {
  if (days <= 7) return 60; // hourly for short horizons
  if (days <= 60) return 240; // 4h for medium
  return 1440; // daily for long
}

// Turn {symbol, class} pairs into legs with risk-appropriate leverage / shorting and the xStock venue
// rules (spot, long-only, lev 1). Equal-weight by default, or use explicit per-symbol weights (from an
// edited basket), normalized to sum to 1. Shared by the explicit and scan-based paths.
function finalizeLegs(pairs: Array<{ symbol: string; cls: AssetClass }>, risk: RiskAppetite, weights?: Record<string, number>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const picked = pairs.filter((x) => (seen.has(x.symbol) ? false : (seen.add(x.symbol), true)));
  const useW = weights && Object.keys(weights).length > 0;
  const total = useW ? picked.reduce((s, p) => s + (weights![p.symbol] ?? 0), 0) || 1 : 0;
  const equal = picked.length ? 1 / picked.length : 0;
  const lev = risk === "aggressive" ? "2" : "1";
  const allowShort = risk === "aggressive";
  return picked.map(({ symbol, cls }) => {
    const isX = cls === "xstock";
    // Bybit spot/linear symbols are quoted pairs (BTCUSDT). Screened picks arrive as base tickers
    // (e.g. "HYPE") — append USDT so candle fetches resolve instead of silently returning NO_BARS.
    const venueSym = isX || /(USDT|USDC|USD)$/i.test(symbol) ? symbol : `${symbol}USDT`;
    const w = useW ? (weights![symbol] ?? 0) / total : equal;
    return {
      symbol: venueSym, asset_class: isX ? "equity" : "crypto", category: isX ? "spot" : cls,
      target_weight: w.toFixed(4), leverage: isX ? "1" : lev, allow_short: isX ? false : allowShort,
    };
  });
}

// Compose legs from EXPLICIT symbols (or the curated default universe). Deterministic. Honors per-symbol
// weights (→ "fixed" weighting) when provided.
export function composeLegs(p: MultiassetParams): { legs: Array<Record<string, unknown>>; weighting: string; intervalMinutes: number; durationDays: number } {
  const durationDays = p.durationDays ?? 30;
  const classes: AssetClass[] = p.assetClasses.length ? p.assetClasses : ["linear"];
  const pairs: Array<{ symbol: string; cls: AssetClass }> = [];
  if (p.symbols && p.symbols.length) {
    for (const s of p.symbols) {
      const cls = inferExplicitClass(s, classes);
      pairs.push({ symbol: cls === "xstock" ? (xstockSymbol(s) ?? cleanSymbol(s)) : cleanSymbol(s), cls });
    }
  } else {
    for (const cls of classes) {
      const syms = cls === "xstock" ? [] : CRYPTO_FALLBACK[cls];
      for (const s of syms) pairs.push({ symbol: s.toUpperCase(), cls });
    }
  }
  const hasW = p.weights && Object.keys(p.weights).length > 0;
  return { legs: finalizeLegs(pairs, p.risk, p.weights), weighting: hasW ? "fixed" : pickWeighting(p.risk), intervalMinutes: intervalForDuration(durationDays), durationDays };
}

// How many legs suit each risk appetite (factor weighting itself is handled inside screenTokens).
function selectionPlan(risk: RiskAppetite): { count: number } {
  if (risk === "conservative") return { count: 2 }; // most liquid majors
  if (risk === "aggressive") return { count: 4 }; // momentum movers
  return { count: 3 }; // balanced
}

// Compose legs by SCREENING the live market (used when the user gives no explicit symbols). Crypto
// legs come from the multi-factor analysis engine (screenTokens — momentum/trend/RSI/MACD/funding/OI/
// vol + news sentiment, risk-weighted), and xStock legs from the same engine's tokenized-equity screen.
// Nothing is hardcoded — the only static fallback is the two crypto majors if the screen errors entirely.
export async function selectLegs(ownerId: number, p: MultiassetParams, mcp?: ToolCaller, emit?: ScreenEmit): Promise<{ legs: Array<Record<string, unknown>>; weighting: string; intervalMinutes: number; durationDays: number; auto_selected: boolean }> {
  const durationDays = p.durationDays ?? 30;
  if (p.symbols && p.symbols.length) {
    return { ...composeLegs(p), auto_selected: false };
  }
  const classes: AssetClass[] = p.assetClasses.length ? p.assetClasses : ["linear"];
  const cryptoCat: "linear" | "spot" | null = classes.includes("linear") ? "linear" : classes.includes("spot") ? "spot" : null;
  const wantXstock = classes.includes("xstock");
  const plan = selectionPlan(p.risk);
  const pairs: Array<{ symbol: string; cls: AssetClass }> = [];
  try {
    // One deep screen yields the factor-ranked crypto picks AND (always) the xStock picks; we take the
    // legs the basket's asset classes call for. Streams the factor heatmap into the proposal board.
    const screen = await screenTokens(ownerId, { risk: p.risk, style: p.style, category: cryptoCat ?? "linear", top: plan.count, includeXstocks: wantXstock }, mcp, emit);
    if (cryptoCat) for (const pk of screen.picks.slice(0, plan.count)) pairs.push({ symbol: pk.symbol, cls: cryptoCat });
    if (wantXstock) for (const pk of screen.xstocks.slice(0, plan.count)) pairs.push({ symbol: pk.symbol, cls: "xstock" });
  } catch (e) {
    logger.warn("multiasset factor screen failed — using fallback", { message: (e as Error).message });
    if (cryptoCat) for (const s of CRYPTO_FALLBACK[cryptoCat]) pairs.push({ symbol: s, cls: cryptoCat });
    if (wantXstock && mcp) for (const s of await fetchXstockUniverse(mcp, plan.count).catch(() => [])) pairs.push({ symbol: s, cls: "xstock" });
  }
  if (!pairs.length) for (const s of CRYPTO_FALLBACK.linear) pairs.push({ symbol: s, cls: "linear" });
  return { legs: finalizeLegs(pairs, p.risk), weighting: pickWeighting(p.risk), intervalMinutes: intervalForDuration(durationDays), durationDays, auto_selected: true };
}

function num(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// Parse a (possibly summarized) MCP text/json result into an object.
function asObj(r: { raw?: unknown; text?: string }): Record<string, unknown> {
  if (r.raw && typeof r.raw === "object") return r.raw as Record<string, unknown>;
  try { return JSON.parse(r.text ?? "{}"); } catch { return {}; }
}

function barsCloseSeries(leg: Record<string, unknown>): number[] {
  const a = Array.isArray(leg.bars) ? (leg.bars as Array<Record<string, unknown>>) : [];
  return a.map((b) => num(b.close ?? b.c ?? b.closePrice, Number.NaN)).filter((x) => Number.isFinite(x) && x > 0);
}

function hasMovingPrices(legs: Array<Record<string, unknown>>): boolean {
  return legs.some((leg) => {
    const closes = barsCloseSeries(leg);
    if (closes.length < 3 || closes[0] <= 0) return false;
    return Math.abs(closes[closes.length - 1] / closes[0] - 1) > 0.002;
  });
}

function looksFlat(metrics: ScenarioResult["metrics"], rebalances: number, curve: number[]): boolean {
  const eps = 1e-8;
  const flatMetrics = Math.abs(metrics.total_return || 0) < eps
    && Math.abs(metrics.sharpe || 0) < eps
    && Math.abs(metrics.max_drawdown || 0) < eps;
  const flatCurve = curve.length >= 2 && Math.max(...curve) - Math.min(...curve) < eps;
  return flatMetrics && (rebalances === 0 || flatCurve);
}

function weightedHoldReplay(
  name: string,
  window: string,
  legs: Array<Record<string, unknown>>,
  totalEquity: number,
  intervalMinutes: number,
): ScenarioResult | null {
  const series = legs.map((leg) => ({ leg, closes: barsCloseSeries(leg), weight: Math.max(0, num(leg.target_weight, 0)), leverage: Math.max(1, num(leg.leverage, 1)) }))
    .filter((x) => x.closes.length >= 3);
  if (!series.length) return null;
  const weightTotal = series.reduce((s, x) => s + x.weight, 0) || series.length;
  const minLen = Math.min(...series.map((x) => x.closes.length));
  if (minLen < 3) return null;
  const equity: number[] = [totalEquity];
  for (let i = 1; i < minLen; i++) {
    let r = 0;
    for (const s of series) {
      const offset = s.closes.length - minLen;
      const prev = s.closes[offset + i - 1];
      const cur = s.closes[offset + i];
      if (prev > 0) r += (s.weight || 1 / series.length) / weightTotal * ((cur / prev - 1) * s.leverage);
    }
    equity.push(equity[equity.length - 1] * Math.max(0, 1 + r));
  }
  const totalReturn = equity[equity.length - 1] / equity[0] - 1;
  const sh = sharpeLike(equity);
  const dd = maxDrawdown(equity);
  return {
    name,
    window: `${window} · weighted hold replay`,
    symbols: series.map((s) => String(s.leg.symbol)),
    metrics: {
      total_return: Number(totalReturn.toFixed(6)),
      sharpe: sh == null ? 0 : Number((sh * Math.sqrt((365 * 24 * 60) / Math.max(1, intervalMinutes))).toFixed(4)),
      max_drawdown: dd == null ? 0 : Number(Math.abs(dd).toFixed(6)),
      bars: equity.length,
    },
    rebalances: 0,
    risk_state: { fallback: "weighted_hold_replay", reason: "portfolio engine returned no usable moving equity curve" },
    equity_curve: sampleCurve(equity),
  };
}

async function getBars(mcp: ToolCaller, tool: string, args: Record<string, unknown>): Promise<unknown[]> {
  const r = await mcp.callTool(tool, args).catch(() => null);
  if (!r) return [];
  const o = asObj(r);
  const bars = (o.bars ?? (o.result as Record<string, unknown>)?.bars) as unknown[] | undefined;
  return Array.isArray(bars) ? bars : [];
}

async function runScenario(
  mcp: ToolCaller, name: string, window: string,
  legs: Array<Record<string, unknown>>, weighting: string, totalEquity: number,
  intervalMinutes: number, risk: Record<string, string>, rebalanceThreshold: number,
): Promise<ScenarioResult> {
  if (!legs.length || !legs.some((l) => Array.isArray(l.bars) && (l.bars as unknown[]).length)) {
    return { name, window, symbols: legs.map((l) => String(l.symbol)), metrics: { total_return: Number.NaN, sharpe: Number.NaN, max_drawdown: Number.NaN }, rebalances: 0, risk_state: {}, error: "NO_BARS" };
  }
  const r = await mcp.callTool("run_portfolio", {
    legs, weighting, total_equity: String(totalEquity), interval_minutes: intervalMinutes,
    risk, rebalance_threshold: String(rebalanceThreshold),
  }).catch((e) => ({ raw: { error: (e as Error).message }, text: "" }));
  const o = asObj(r as { raw?: unknown; text?: string });
  if (o.error) return { name, window, symbols: legs.map((l) => String(l.symbol)), metrics: { total_return: Number.NaN, sharpe: Number.NaN, max_drawdown: Number.NaN }, rebalances: 0, risk_state: {}, error: String(o.error) };
  const m = (o.metrics ?? {}) as Record<string, unknown>;
  const metrics = { total_return: num(m.total_return), sharpe: num(m.sharpe), max_drawdown: num(m.max_drawdown), bars: num(m.bars) };
  const equity_curve = sampleCurve(o.equity_curve);
  if (looksFlat(metrics, num(o.rebalances), equity_curve) && hasMovingPrices(legs)) {
    const replay = weightedHoldReplay(name, window, legs, totalEquity, intervalMinutes);
    if (replay) return replay;
  }
  return {
    name, window, symbols: legs.map((l) => String(l.symbol)),
    metrics,
    rebalances: num(o.rebalances), risk_state: (o.risk_state ?? {}) as Record<string, unknown>,
    equity_curve,
  };
}

// Optional board-widget emitter (streams structured nodes to the UI flowchart in real time).
export type MultiassetEmit = (w: { id?: string; kind: string; title: string; state: "running" | "done" | "error"; rationale?: string; data?: unknown }) => void;

// Available Bot-OS bot types from the Lab (for the per-leg bot selector). Never hardcoded.
async function fetchBotTypes(mcp: ToolCaller): Promise<string[]> {
  const r = await mcp.callTool("list_bot_templates", {}).catch(() => null);
  if (!r) return [];
  const o = asObj(r);
  const t = (o.templates ?? o.bot_templates ?? (Array.isArray(o) ? o : [])) as Array<unknown>;
  const names = t.map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>)?.bot_type ?? (x as Record<string, unknown>)?.botType ?? (x as Record<string, unknown>)?.name ?? ""))).filter(Boolean);
  return [...new Set(names)];
}

// number-or-null: distinguishes "engine reported 0" from "engine reported nothing" so the UI can show
// "—" instead of a fabricated 0% / -100%.
function numN(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface BotMetrics { total_return: number | null; sharpe: number | null; max_drawdown: number | null }

// Pull the backtest metrics out of a completed build_and_backtest_bot run's steps (real engine output).
// Prefer the engine's OWN performance.total_return (the canonical figure) over recomputing it from
// equity — the old recompute defaulted a missing final_equity to 0 and reported a bogus -100%.
export function botMetricsFromSteps(steps: unknown[]): { metrics: BotMetrics; result_tier: string; equity_curve: number[] } {
  const bt = steps.find((s) => (s as { tool?: string }).tool === "run_bot_backtest") as { result?: Record<string, unknown> } | undefined;
  const r = (bt?.result ?? {}) as Record<string, unknown>;
  const perf = (r.performance ?? r.metrics ?? {}) as Record<string, unknown>;
  // 1) engine's reported return; 2) else derive from equity ONLY if both endpoints are present; 3) else null.
  let total_return = numN(perf.total_return ?? perf.total_return_after_fees_funding ?? perf.return);
  if (total_return === null) {
    const fe = numN(r.final_equity);
    const se = numN(r.starting_equity);
    if (fe !== null && se !== null && se > 0) total_return = (fe - se) / se;
  }
  const md = numN(perf.max_drawdown ?? perf.max_dd);
  return {
    metrics: { total_return, sharpe: numN(perf.sharpe ?? perf.sharpe_ratio), max_drawdown: md !== null ? Math.abs(md) : null },
    result_tier: String(r.result_tier ?? perf.result_tier ?? "unverified"),
    equity_curve: sampleCurve(r.equity_curve ?? (perf as Record<string, unknown>).equity_curve),
  };
}

// Numeric closes out of a leg's attached bars (handles get_candles + Bybit-sourced shapes).
function closesOf(leg: Record<string, unknown>): number[] {
  const a = Array.isArray(leg.bars) ? (leg.bars as Array<Record<string, unknown>>) : [];
  return a.map((b) => num(b.close ?? b.c ?? b.closePrice)).filter((x) => Number.isFinite(x) && x > 0);
}

// Price-CORRECT grid bounds for a leg, mirroring quant_core recommender._seed_params: bracket the last
// price by a vol-scaled width. Without this the bot inherits BTC's hardcoded 60000–70000 grid and never
// trades on a $5 / $0.x token (the "every bot is 0.00%" bug). Returns {} for non-grid bot types.
function gridParamsFor(botType: string, closes: number[]): Record<string, unknown> {
  if (!["spot_grid", "futures_grid", "scaled_order"].includes(botType) || !closes.length) return {};
  const last = closes[closes.length - 1];
  const vol = realizedVol(closes);
  const width = Math.min(0.6, Math.max(0.08, (vol ?? 0.02) * 8)); // recommender uses vol*8, floor 2–8%
  const round = (x: number) => (x >= 1 ? Number(x.toFixed(2)) : Number(x.toPrecision(5)));
  return { lower_price: String(round(last * (1 - width))), upper_price: String(round(last * (1 + width))) };
}

// The DISTINCT-BOTS phase: build + backtest a Bot-OS bot per leg (each leg is its own strategy). Emits a
// "bot" widget per leg with its assigned bot type + real backtest metrics. botsMap overrides the default.
async function runPerLegBots(ownerId: number, legs: Array<Record<string, unknown>>, mcp: ToolCaller, intervalMinutes: number, e: MultiassetEmit, botsMap?: Record<string, string>, onlyMapped?: boolean): Promise<Array<{ symbol: string; bot: string; metrics: BotMetrics; ok: boolean }>> {
  const threadId = (await createThread(ownerId, "Per-leg bots")).id;
  const botInterval = String(intervalMinutes >= 1440 ? 240 : intervalMinutes); // bots backtest intraday
  const out: Array<{ symbol: string; bot: string; metrics: BotMetrics; ok: boolean }> = [];
  // botsMap may be keyed by base (HYPE) or pair (HYPEUSDT); match on either.
  const mapFor = (s: string): string | undefined => botsMap?.[s] ?? botsMap?.[s.replace(/USDT?$/i, "").toUpperCase()];
  for (const leg of legs) {
    const symbol = String(leg.symbol);
    const category = (String(leg.category) === "linear" ? "linear" : "spot") as "spot" | "linear";
    const mapped = mapFor(symbol);
    // onlyMapped: skip legs the caller didn't explicitly assign a bot — avoids a blanket spot_grid that
    // contradicts the per-asset reasoner (e.g. a leg it chose for LP/hold isn't a CEX bot at all).
    if (onlyMapped && !mapped) continue;
    // Default to spot_grid for the per-leg illustrative backtest: it needs only candles, whereas
    // futures_grid requires funding-rate coverage that brand-new tokens don't have (→ the bot was
    // rejected with FUNDING_COVERAGE_REQUIRED and showed 0). botsMap can still override per leg.
    const botType = mapped ?? "spot_grid";
    // Seed grid bounds from THIS token's real price so the grid actually brackets price and trades.
    const seededParams = gridParamsFor(botType, closesOf(leg));
    e({ id: `bot-${symbol}`, kind: "bot", title: `${symbol} bot`, state: "running", rationale: `Building + backtesting a ${botType} bot…` });
    let res: { metrics: BotMetrics; result_tier: string; equity_curve: number[] } = { metrics: { total_return: null, sharpe: null, max_drawdown: null }, result_tier: "unverified", equity_curve: [] };
    let ok = false;
    try {
      const plan = buildAndBacktestPlan({ ownerId, threadId, symbol, category, interval: botInterval, autonomy: "L2", botParams: { botType, params: seededParams } });
      const run = await createRun(ownerId, threadId, `bot ${symbol}`, plan.playbook_id, plan);
      const outcome = await executePlan({ plan, mcp, runId: run.id, agentAction: `bot ${symbol}` });
      ok = outcome.status === "completed";
      res = botMetricsFromSteps(await getSteps(ownerId, run.id));
    } catch (err) { logger.warn("per-leg bot failed", { symbol, message: (err as Error).message }); }
    e({ id: `bot-${symbol}`, kind: "bot", title: `${symbol} · ${botType}`, state: ok ? "done" : "error", rationale: ok ? undefined : "backtest unavailable", data: { symbol, bot: botType, ...res } });
    out.push({ symbol, bot: botType, metrics: res.metrics, ok });
  }
  return out;
}

export interface SeasonResult {
  type: "bull" | "bear";
  label: string;
  days: number;
  market_return: number; // BTC move over the season (the regime clock)
  basket_return: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  n_legs: number;
  symbols: string[];
  error?: string;
}
export interface RegimeAgg { kind: "bull" | "bear"; aggregate: ReturnType<typeof aggregateReturns>; avg_sharpe: number; worst_drawdown: number }
export interface PerTokenSeasons {
  symbol: string;
  bull_count: number;
  bear_count: number;
  bull_avg: number; // avg buy&hold return across the token's own bull seasons
  bear_avg: number;
  span: string;
}
export interface RegimeReport {
  market: string; // clock source, e.g. "basket index (3 tokens)" or "BTC (fallback)"
  threshold: number;
  span: string;
  seasons_detected: number;
  symbols: string[];
  seasons: SeasonResult[];
  bull: RegimeAgg;
  bear: RegimeAgg;
  per_token: PerTokenSeasons[]; // each token's OWN bull/bear seasons (the per-asset breakdown)
}

const avg = (xs: number[]): number => (xs.length ? Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(4)) : 0);

// Daily close history per symbol (full, paged from Bybit). Cached module-wide so a basket re-run / the
// auto-iterate loop don't re-paginate the same tokens (and avoids Bybit rate-limits).
const _histCache = new Map<string, { ts: number; series: { ts: number; close: number }[] }>();
const HIST_TTL_MS = 6 * 3600 * 1000;
async function legHistory(symbol: string): Promise<{ ts: number; close: number }[]> {
  const c = _histCache.get(symbol);
  if (c && Date.now() - c.ts < HIST_TTL_MS) return c.series;
  let k = await fetchKlinesPaged(symbol, "linear", "D", 2500).catch(() => null);
  if (!k || k.bars.length < 30) { await new Promise((r) => setTimeout(r, 600)); k = await fetchKlinesPaged(symbol, "linear", "D", 2500).catch(() => null); }
  const series = k ? k.bars.map((b) => ({ ts: b.ts, close: b.close })) : [];
  if (series.length) _histCache.set(symbol, { ts: Date.now(), series });
  return series;
}

// Build one equal-weight basket INDEX from the legs' histories (listing-age-aware: each day averages
// the daily returns of whichever tokens existed that day). This is the regime clock — the basket's OWN
// cycles, not BTC's.
function buildBasketIndex(histories: { ts: number; close: number }[][]): { ts: number[]; closes: number[] } {
  const maps = histories.map((h) => new Map(h.map((b) => [b.ts, b.close])));
  const allTs = [...new Set(histories.flatMap((h) => h.map((b) => b.ts)))].sort((a, b) => a - b);
  const ts: number[] = []; const closes: number[] = [];
  let level = 1;
  for (let i = 0; i < allTs.length; i++) {
    if (i > 0) {
      const t = allTs[i]; const tp = allTs[i - 1]; const rets: number[] = [];
      for (const m of maps) { const cu = m.get(t); const pr = m.get(tp); if (cu != null && pr != null && pr > 0) rets.push((cu - pr) / pr); }
      if (rets.length) level *= 1 + rets.reduce((s, x) => s + x, 0) / rets.length;
    }
    ts.push(allTs[i]); closes.push(Number(level.toFixed(6)));
  }
  return { ts, closes };
}

function spanOf(segs: RegimeSegment[]): string {
  return segs.length ? `${segs[0].label.split(" → ")[0]} → ${segs[segs.length - 1].label.split(" → ")[1]}` : "";
}
function displayRegimeAvg(agg: RegimeAgg, perToken: PerTokenSeasons[], key: "bull_avg" | "bear_avg"): number {
  if (Math.abs(agg.aggregate.avg_return) > 1e-9) return agg.aggregate.avg_return;
  const vals = perToken.map((p) => p[key]).filter((x) => Number.isFinite(x));
  return vals.length ? avg(vals) : agg.aggregate.avg_return;
}
function displayRegimeCount(agg: RegimeAgg, perToken: PerTokenSeasons[], key: "bull_count" | "bear_count"): number {
  if (agg.aggregate.n > 0) return agg.aggregate.n;
  return perToken.reduce((s, p) => s + (Number(p[key]) || 0), 0);
}

// Detect EVERY bull/bear season from the BASKET'S OWN index across all available history, backtest the
// crypto core over each, AND report each token's own seasons. Falls back to BTC if the basket is too new.
async function runRegimeCrossVal(
  mcp: ToolCaller, legs: Array<Record<string, unknown>>, weighting: string, budgetUsd: number,
  risk: Record<string, string>, chosen: number, e: MultiassetEmit, warnings: string[], maxSeasons?: number,
): Promise<RegimeReport> {
  const symbols = legs.filter((l) => l.asset_class === "crypto").map((l) => String(l.symbol));
  const mk = (kind: "bull" | "bear", arr: SeasonResult[]): RegimeAgg => ({
    kind, aggregate: aggregateReturns(arr.map((s) => s.basket_return as number)),
    avg_sharpe: avg(arr.map((s) => s.sharpe ?? 0)), worst_drawdown: arr.length ? Math.max(...arr.map((s) => s.max_drawdown ?? 0)) : 0,
  });
  const empty: RegimeReport = { market: "—", threshold: 0.2, span: "", seasons_detected: 0, symbols, seasons: [], bull: mk("bull", []), bear: mk("bear", []), per_token: [] };
  if (!symbols.length) { warnings.push("no crypto legs to cross-validate across regimes"); return empty; }

  e({ id: "ma-regime", kind: "regime", title: "Regime cross-validation", state: "running", rationale: "Building the basket index + detecting its bull/bear seasons across all history…" });

  // Fetch each leg's full history once → basket index (clock) + per-token seasons.
  const histories = await Promise.all(symbols.map((s) => legHistory(s)));
  const perToken: PerTokenSeasons[] = symbols.map((sym, i) => {
    const h = histories[i];
    const segs = h.length >= 30 ? detectRegimes(h.map((b) => b.close), h.map((b) => b.ts), 0.2).filter((s) => s.days >= config.analysisSeasonMinDays) : [];
    const bull = segs.filter((s) => s.type === "bull"); const bear = segs.filter((s) => s.type === "bear");
    return { symbol: sym, bull_count: bull.length, bear_count: bear.length, bull_avg: avg(bull.map((s) => s.return)), bear_avg: avg(bear.map((s) => s.return)), span: spanOf(segs) };
  });

  const nonEmpty = histories.filter((h) => h.length >= 30);
  let clockSource = `basket index (${nonEmpty.length} tokens)`;
  let segsAll: RegimeSegment[] = [];
  if (nonEmpty.length) {
    const index = buildBasketIndex(nonEmpty);
    if (index.ts.length >= 120) segsAll = detectRegimes(index.closes, index.ts, 0.2);
  }
  if (segsAll.length < 2) { // basket too young → fall back to the BTC market clock
    const btc = await legHistory("BTCUSDT");
    if (btc.length >= 50) { segsAll = detectRegimes(btc.map((b) => b.close), btc.map((b) => b.ts), 0.2); clockSource = "BTC (basket too young for its own clock)"; }
  }
  const segs = segsAll.filter((s) => s.days >= config.analysisSeasonMinDays).slice(-(maxSeasons ?? config.analysisMaxSeasons));
  if (!segs.length) {
    warnings.push("could not detect regime seasons (insufficient history)");
    e({ id: "ma-regime", kind: "regime", title: "Regime cross-validation", state: "error", rationale: "insufficient history", data: { per_token: perToken } });
    return { ...empty, market: clockSource, per_token: perToken };
  }

  const seasons: SeasonResult[] = [];
  for (const seg of segs) {
    const cryptoLegs: Array<Record<string, unknown>> = [];
    for (const leg of legs) {
      if (leg.asset_class !== "crypto") continue;
      const bars = await bybitBars(String(leg.symbol), "linear", "D", 1000, { start: seg.startMs, end: seg.endMs });
      if (bars.length >= 5) cryptoLegs.push({ ...leg, category: "linear", bars });
    }
    if (!cryptoLegs.length) {
      seasons.push({ type: seg.type, label: seg.label, days: seg.days, market_return: Number(seg.return.toFixed(4)), basket_return: null, sharpe: null, max_drawdown: null, n_legs: 0, symbols: [], error: "no leg history in this season" });
      continue;
    }
    const w = (1 / cryptoLegs.length).toFixed(4);
    cryptoLegs.forEach((l) => (l.target_weight = w));
    const res = await runScenario(mcp, seg.type, seg.label, cryptoLegs, weighting, budgetUsd, 1440, risk, chosen);
    seasons.push({
      type: seg.type, label: seg.label, days: seg.days, market_return: Number(seg.return.toFixed(4)),
      basket_return: res.error ? null : res.metrics.total_return, sharpe: res.error ? null : res.metrics.sharpe,
      max_drawdown: res.error ? null : res.metrics.max_drawdown, n_legs: cryptoLegs.length, symbols: cryptoLegs.map((l) => String(l.symbol)), error: res.error,
    });
  }

  const bull = mk("bull", seasons.filter((s) => s.type === "bull" && s.basket_return != null));
  const bear = mk("bear", seasons.filter((s) => s.type === "bear" && s.basket_return != null));
  const span = spanOf(segs);
  const report: RegimeReport = { market: clockSource, threshold: 0.2, span, seasons_detected: segsAll.length, symbols, seasons, bull, bear, per_token: perToken };
  const newer = seasons.filter((s) => s.n_legs < symbols.length && s.n_legs > 0);
  if (newer.length) warnings.push(`${newer.length} season(s) ran on a partial basket (some legs hadn't listed yet)`);
  const bullAvgDisplay = displayRegimeAvg(bull, perToken, "bull_avg");
  const bearAvgDisplay = displayRegimeAvg(bear, perToken, "bear_avg");
  const bullNDisplay = displayRegimeCount(bull, perToken, "bull_count");
  const bearNDisplay = displayRegimeCount(bear, perToken, "bear_count");

  e({ id: "ma-regime", kind: "regime", title: `Regime report · ${seasons.length} seasons`, state: "done",
    rationale: `Clock: ${clockSource}. Bull avg ${(bullAvgDisplay * 100).toFixed(1)}% (${bullNDisplay}) · Bear avg ${(bearAvgDisplay * 100).toFixed(1)}% (${bearNDisplay}) · span ${span}`,
    data: report });
  return report;
}

// A single scalar to compare baskets: recent return + across-cycle bull strength + Sharpe, penalized by
// the worst bear drawdown. Higher = better.
function basketScore(recent: ScenarioResult, regime: RegimeReport): number {
  const rr = recent && !recent.error ? recent.metrics.total_return : -1;
  const sh = recent && !recent.error ? recent.metrics.sharpe : -2;
  return rr * 1.0 + regime.bull.aggregate.avg_return * 0.5 + sh * 0.05 - regime.bear.worst_drawdown * 0.5;
}
// Is a basket bad enough to try to improve? Negative recent, non-positive bull cycles, a bear DD that
// breaches the kill switch, or a negative Sharpe.
function isPoorBasket(recent: ScenarioResult, regime: RegimeReport, risk: Record<string, string>): boolean {
  const rr = recent && !recent.error ? recent.metrics.total_return : -1;
  const sh = recent && !recent.error ? recent.metrics.sharpe : -2;
  return rr < 0 || regime.bull.aggregate.avg_return <= 0 || regime.bear.worst_drawdown > num(risk.max_drawdown_kill_fraction) || sh < 0;
}
// Drop the crypto leg with the worst across-cycle behavior (lowest bull_avg+bear_avg from the per-token
// regime breakdown). Keeps ≥2 legs. Returns the trimmed legs + which symbol was dropped, or null.
function dropWorstLeg(legs: Array<Record<string, unknown>>, regime: RegimeReport): { legs: Array<Record<string, unknown>>; dropped: string } | null {
  const crypto = legs.filter((l) => l.asset_class === "crypto");
  if (crypto.length <= 2) return null;
  const score = new Map(regime.per_token.map((pt) => [pt.symbol, pt.bull_avg + pt.bear_avg]));
  const worst = crypto.slice().sort((a, b) => (score.get(String(a.symbol)) ?? -9) - (score.get(String(b.symbol)) ?? -9))[0];
  return { legs: legs.filter((l) => l !== worst), dropped: String(worst.symbol) };
}

// Lightweight re-evaluation of a candidate basket during the auto-improve loop: attach recent bars,
// run the recent backtest, and a (capped) regime cross-val. Reuses the ma-recent/ma-regime widget ids
// so the board shows the FINAL chosen basket. Skips the bots/optimise/basket widgets (heavy + cosmetic).
async function evaluateLegsLight(
  ownerId: number, mcp: ToolCaller, legs: Array<Record<string, unknown>>, weighting: string, budgetUsd: number,
  intervalMinutes: number, intervalStr: string, risk: Record<string, string>, chosen: number, e: MultiassetEmit, warnings: string[],
): Promise<{ recent: ScenarioResult; regime: RegimeReport }> {
  const withBars: Array<Record<string, unknown>> = [];
  for (const leg of legs) {
    let bars = await getBars(mcp, "get_candles", { symbol: leg.symbol, category: leg.category, interval: intervalStr, limit: 1000, full: true });
    if (!bars.length) bars = await bybitBars(String(leg.symbol), String(leg.category), intervalStr, 1000);
    withBars.push({ ...leg, bars });
  }
  e({ id: "ma-recent", kind: "backtest", title: "Backtest · recent", state: "running", rationale: "Re-backtesting the improved basket…" });
  const recent = await runScenario(mcp, "recent", `last ${withBars[0] && (withBars[0].bars as unknown[])?.length || 0} bars`, withBars, weighting, budgetUsd, intervalMinutes, risk, chosen);
  e({ id: "ma-recent", kind: "backtest", title: "Backtest · recent", state: recent.error ? "error" : "done", rationale: recent.error, data: { metrics: recent.metrics, rebalances: recent.rebalances, window: recent.window, symbols: recent.symbols, equity_curve: recent.equity_curve } });
  const regime = await runRegimeCrossVal(mcp, legs, weighting, budgetUsd, risk, chosen, e, warnings, 6);
  return { recent, regime };
}

// Build the full proposal: backtest recent → cross-validate ALL bull/bear seasons (crypto core) → optimize.
export async function runMultiassetProposal(ownerId: number, p: MultiassetParams, mcp: ToolCaller, emit?: MultiassetEmit): Promise<MultiassetProposal> {
  const e: MultiassetEmit = emit ?? (() => {});
  // No explicit symbols → screen the live market (crypto) + the Lab catalog (xStocks) for the legs.
  e({ id: "ma-select", kind: "strategy", title: "Compose basket", state: "running", rationale: "Selecting legs for your risk appetite…" });
  const { legs, weighting, intervalMinutes, durationDays, auto_selected } = await selectLegs(ownerId, p, mcp, e);
  const risk = riskGates(p.risk);
  const warnings: string[] = [];
  if (auto_selected) warnings.push(`legs auto-selected from a live ${p.risk} market scan — pass selected_symbols to go live with this exact basket`);
  e({ id: "ma-select", kind: "strategy", title: "Basket composed", state: "done", rationale: `${weighting} weighting · ${legs.length} legs`,
    data: { action: weighting, rationale: legs.map((l) => l.symbol).join(", "), legs: legs.map((l) => ({ symbol: l.symbol, weight: l.target_weight, category: l.category, leverage: l.leverage, short: l.allow_short })) } });
  e({ id: "ma-risk", kind: "truth", title: "Risk gates", state: "done", rationale: `${p.risk} profile`, data: { ...risk } });

  const intervalStr = String(intervalMinutes === 1440 ? "D" : intervalMinutes);
  // Attach recent bars per leg for the primary "recent" scenario. Self-provision: ensure_candles
  // triggers a backfill from Bybit so the chosen interval is populated before we read it.
  e({ id: "ma-data", kind: "data", title: "Market data", state: "running", rationale: `Provisioning ${legs.length} legs @ ${intervalStr}m…` });
  const recentLegs: Array<Record<string, unknown>> = [];
  for (const leg of legs) {
    await mcp.callTool("ensure_candles", { symbol: leg.symbol, category: leg.category, interval: intervalStr, minBars: 400 }).catch(() => {});
    let bars = await getBars(mcp, "get_candles", { symbol: leg.symbol, category: leg.category, interval: intervalStr, limit: 1000, full: true });
    // Lab backfill still in flight (or symbol not yet ingested)? Self-source straight from Bybit so the
    // scenario runs now instead of reporting NO_BARS.
    if (!bars.length) {
      bars = await bybitBars(String(leg.symbol), String(leg.category), intervalStr, 1000);
      if (bars.length) warnings.push(`${leg.symbol}: Lab candles not ready — sourced ${bars.length} ${intervalStr} bars from Bybit directly`);
      else warnings.push(`no recent candles for ${leg.symbol} @ ${intervalStr} (not on the Lab or Bybit yet)`);
    }
    recentLegs.push({ ...leg, bars });
  }
  e({ id: "ma-data", kind: "data", title: "Market data", state: "done", rationale: `${legs.length} legs · ${intervalStr}m candles`, data: { legs: recentLegs.map((l) => ({ symbol: l.symbol, bars: Array.isArray(l.bars) ? (l.bars as unknown[]).length : 0, interval: intervalStr, category: l.category, source: "Lab/Bybit" })), interval: intervalStr } });

  // The editable BASKET — tokens/stocks with allocation (weight) + live price (last candle close). The
  // UI lets the user edit allocations; "Nexa Analyze" re-runs with the new weights.
  const lastClose = (bars: unknown): number | null => {
    const a = Array.isArray(bars) ? (bars as Array<Record<string, unknown>>) : [];
    if (!a.length) return null;
    const b = a[a.length - 1];
    return num(b.close ?? b.c ?? b.closePrice);
  };
  const botTypes = await fetchBotTypes(mcp);
  const botFor = (l: Record<string, unknown>): string => p.bots?.[String(l.symbol)] ?? defaultBotFor(String(l.category) === "linear" ? "linear" : "spot").botType;
  e({ id: "ma-basket", kind: "basket", title: "Crypto candidate basket", state: "done", rationale: `${legs.length}-leg crypto candidate basket`, data: {
    budget_usd: p.budgetUsd, risk: p.risk, asset_classes: p.assetClasses, bot_types: botTypes,
    legs: recentLegs.map((l) => ({ symbol: l.symbol, allocation: num(l.target_weight) ?? 0, price: lastClose(l.bars), asset_class: l.asset_class, category: l.category, bot: botFor(l) })),
  } });

  // DISTINCT BOTS — each leg is its own Bot-OS strategy (build + backtest per leg). On by default.
  if (p.withBots !== false) {
    await runPerLegBots(ownerId, recentLegs, mcp, intervalMinutes, e, p.bots, p.botsOnlyMapped).catch((err) => logger.warn("per-leg bots phase failed", { message: (err as Error).message }));
  }

  // --- Optimization: sweep the rebalance threshold on the recent basket, pick best Sharpe ---
  e({ id: "ma-opt", kind: "optimise", title: "Optimise", state: "running", rationale: "Sweeping rebalance threshold…" });
  const tested: Array<{ rebalance_threshold: number; sharpe: number; total_return: number }> = [];
  let chosen = 0.05;
  for (const rt of [0.03, 0.05, 0.1]) {
    const s = await runScenario(mcp, "opt", "recent", recentLegs, weighting, p.budgetUsd, intervalMinutes, risk, rt);
    if (!s.error) tested.push({ rebalance_threshold: rt, sharpe: s.metrics.sharpe, total_return: s.metrics.total_return });
  }
  if (tested.length) chosen = tested.slice().sort((a, b) => b.sharpe - a.sharpe)[0].rebalance_threshold;
  e({ id: "ma-opt", kind: "optimise", title: "Optimise", state: "done", data: { tested, chosen } });

  // --- Scenarios at the chosen threshold ---
  const scenarios: ScenarioResult[] = [];
  e({ id: "ma-recent", kind: "backtest", title: "Backtest · recent", state: "running", rationale: "Backtesting on recent data…" });
  const recentRes = await runScenario(mcp, "recent", `last ${recentLegs[0] && (recentLegs[0].bars as unknown[])?.length || 0} bars`, recentLegs, weighting, p.budgetUsd, intervalMinutes, risk, chosen);
  scenarios.push(recentRes);
  e({ id: "ma-recent", kind: "backtest", title: "Backtest · recent", state: recentRes.error ? "error" : "done", rationale: recentRes.error, data: { metrics: recentRes.metrics, rebalances: recentRes.rebalances, risk_state: recentRes.risk_state, window: recentRes.window, symbols: recentRes.symbols, equity_curve: recentRes.equity_curve } });

  // Cross-validate across EVERY bull & bear season in the basket's available history — not two stale
  // calendar windows. We detect the regimes from BTC's full daily history (the market clock), then
  // backtest the crypto core over each season (legs sourced per-window from Bybit; legs that didn't
  // trade yet are excluded honestly). One consolidated "regime report" instead of per-year guesses.
  let regimeReport = await runRegimeCrossVal(mcp, legs, weighting, p.budgetUsd, risk, chosen, e, warnings);

  // --- Self-improvement: if the auto-selected basket is poor, ITERATE to something better (paper-only).
  // De-risk to 1× leverage, drop the worst across-cycle leg, pull a quality replacement, re-evaluate —
  // up to 2 rounds — and keep the best-scoring basket. We only do this when WE picked the legs (respect
  // an explicit/edited basket). Each round emits a "refine" widget explaining what changed and why.
  let finalLegs = legs;
  let finalRecent = recentRes;
  let finalRegime = regimeReport;
  if (auto_selected && p.withBots !== false /* full proposal */ && isPoorBasket(recentRes, regimeReport, risk)) {
    const cryptoCat: AssetClass = p.assetClasses.includes("linear") ? "linear" : p.assetClasses.includes("spot") ? "spot" : "linear";
    e({ id: "ma-refine-0", kind: "refine", title: "Self-improve", state: "running", rationale: "Initial basket is weak — de-risking, dropping laggards, re-screening quality replacements…" });
    const pool = await screenTokens(ownerId, { risk: p.risk, style: "quality", category: cryptoCat, top: 12, includeXstocks: false }, mcp).catch(() => null);
    let curLegs: Array<Record<string, unknown>> = finalLegs.map((l) => ({ ...l, leverage: "1", allow_short: false })); // de-risk
    let curScore = basketScore(recentRes, regimeReport);
    let bestNote = "";
    let round = 0;
    // Evaluate a candidate basket, emit a refine widget, and keep it if it beats the best so far.
    const tryRound = async (legsCand: Array<Record<string, unknown>>, changed: string) => {
      round += 1;
      const ev = await evaluateLegsLight(ownerId, mcp, legsCand, weighting, p.budgetUsd, intervalMinutes, intervalStr, risk, chosen, e, warnings);
      const note = `${changed} → recent ${ev.recent.error ? "unavailable" : `${(ev.recent.metrics.total_return * 100).toFixed(1)}%`}, bull-cycles avg ${(ev.regime.bull.aggregate.avg_return * 100).toFixed(1)}%, bear worst-DD ${(ev.regime.bear.worst_drawdown * 100).toFixed(1)}%`;
      e({ id: `ma-refine-${round}`, kind: "refine", title: `Refine round ${round}`, state: "done", rationale: note,
        data: { round, changed, legs: legsCand.map((l) => l.symbol), metrics: ev.recent.metrics, bull: ev.regime.bull.aggregate, bear: ev.regime.bear } });
      if (basketScore(ev.recent, ev.regime) > curScore) { curScore = basketScore(ev.recent, ev.regime); finalLegs = legsCand; finalRecent = ev.recent; finalRegime = ev.regime; bestNote = note; }
      return ev;
    };
    // Round 1 is ALWAYS the pure de-risk (1× leverage, shorts off) — works even for a 2-leg basket.
    let ev = await tryRound(curLegs, "De-risked to 1× leverage, shorts off");
    // Then up to 2 more rounds: drop the worst across-cycle leg + add a quality replacement.
    while (round < 3 && isPoorBasket(ev.recent, ev.regime, risk)) {
      const drop = dropWorstLeg(curLegs, finalRegime);
      if (!drop) break;
      const used = new Set(drop.legs.map((l) => String(l.symbol)));
      const repl = (pool?.picks ?? []).map((pk) => pk.symbol).find((s) => !used.has(s));
      const nl = repl ? [...drop.legs, { symbol: repl, asset_class: "crypto", category: cryptoCat, leverage: "1", allow_short: false, target_weight: "0" }] : drop.legs;
      const w = (1 / nl.length).toFixed(4); nl.forEach((l) => (l.target_weight = w));
      curLegs = nl;
      ev = await tryRound(curLegs, `Dropped ${drop.dropped}${repl ? `, added ${repl}` : ""}, 1× leverage`);
    }
    const improved = finalLegs !== legs;
    e({ id: "ma-refine-0", kind: "refine", title: "Self-improve", state: "done",
      rationale: improved ? `Improved the basket — ${bestNote}` : "Couldn't beat the original within 2 rounds; presenting it honestly (still weak)." });
    if (!improved) warnings.push("auto-refinement could not find a materially better basket — treat this setup as weak");
    regimeReport = finalRegime;
  }

  // Rebuild the scenarios list from the FINAL basket (recent + synthesized bull/bear aggregates).
  const scenariosFinal: ScenarioResult[] = [finalRecent];
  for (const agg of [finalRegime.bull, finalRegime.bear] as const) {
    if (agg.aggregate.n > 0) scenariosFinal.push({ name: agg.kind, window: `${agg.aggregate.n} ${agg.kind} season(s)`, symbols: finalRegime.symbols, metrics: { total_return: agg.aggregate.avg_return, sharpe: agg.avg_sharpe, max_drawdown: agg.worst_drawdown }, rebalances: 0, risk_state: {} });
  }

  // L2 honesty: the portfolio engine is bar_based (next-bar-open + slippage). L2 sweep/queue fidelity
  // applies to single-bot/strategy runs, not the basket engine — so it's not used for the portfolio
  // backtest. (A per-leg L2 fidelity check is a fast-follow.)
  const l2_note = "Portfolio backtests use bar_based fills (next-bar-open + slippage). L2 (l2_sweep/l2_queue) fidelity applies to single-leg bot/strategy runs, not the basket engine — so it is not applied here.";

  const bear = scenariosFinal.find((s) => s.name === "bear");
  const recent = scenariosFinal.find((s) => s.name === "recent");
  if (bear && !bear.error && bear.metrics.max_drawdown > num(risk.max_drawdown_kill_fraction)) {
    warnings.push(`bear regime drawdown ${(bear.metrics.max_drawdown * 100).toFixed(1)}% would breach the kill switch (${(num(risk.max_drawdown_kill_fraction) * 100).toFixed(0)}%)`);
  }
  const rr = finalRegime;
  const reco = [
    recent && !recent.error ? `Recent: ${(recent.metrics.total_return * 100).toFixed(1)}% return, Sharpe ${recent.metrics.sharpe.toFixed(2)}, maxDD ${(recent.metrics.max_drawdown * 100).toFixed(1)}%.` : "Recent backtest unavailable.",
    rr.bull.aggregate.n ? `Across ${rr.bull.aggregate.n} bull season(s): avg ${(rr.bull.aggregate.avg_return * 100).toFixed(1)}% (win-rate ${(rr.bull.aggregate.win_rate * 100).toFixed(0)}%).` : "",
    rr.bear.aggregate.n ? `Across ${rr.bear.aggregate.n} bear season(s): avg ${(rr.bear.aggregate.avg_return * 100).toFixed(1)}% (worst maxDD ${(rr.bear.worst_drawdown * 100).toFixed(1)}%).` : "",
    rr.span ? `Regime clock: ${rr.market}, span ${rr.span}.` : "",
  ].filter(Boolean).join(" ");

  e({ id: "ma-summary", kind: "multiasset", title: `Crypto backtest summary · $${p.budgetUsd}`, state: "done", rationale: reco, data: {
    metrics: recent && !recent.error ? recent.metrics : {}, weighting, budget_usd: p.budgetUsd, risk: p.risk, style: p.style ?? "balanced", interval_minutes: intervalMinutes, chosen,
    legs: finalLegs.map((l) => ({ symbol: l.symbol, weight: l.target_weight, category: l.category, leverage: l.leverage })),
    scenarios: scenariosFinal.map((s) => ({ name: s.name, ...s.metrics, rebalances: s.rebalances, error: s.error })),
    optimization: { tested, chosen }, risk_gates: risk, warnings: [...new Set(warnings)], recommendation: reco,
  } });

  return {
    budget_usd: p.budgetUsd, risk: p.risk, duration_days: durationDays, weighting, interval_minutes: intervalMinutes,
    legs: finalLegs, selected_symbols: finalLegs.map((l) => String(l.symbol)), auto_selected, risk_gates: risk, scenarios: scenariosFinal,
    optimization: { knob: "rebalance_threshold", tested, chosen }, regime_report: finalRegime,
    l2_note, recommendation: reco, warnings: [...new Set(warnings)],
  };
}

// Build the typed plan that starts the forward multi-asset paper session (the real go-live mutation).
function buildStartPlan(ownerId: number, threadId: string, p: MultiassetParams, legs: Array<Record<string, unknown>>, weighting: string, intervalMinutes: number, rebalanceThreshold: number, autonomy: "L2"): AgentPlan {
  return {
    plan_id: `plan_${randomUUID()}`,
    goal_type: "user_request",
    owner_id: ownerId,
    thread_id: threadId,
    autonomy_level: autonomy,
    playbook_id: "setup_multiasset_paper",
    execution_fidelity: "bar_based",
    steps: [
      { step_id: "s1_start", tool: "start_multiasset_paper", rationale: "Start the forward multi-asset paper session for the confirmed basket.", params: { legs, weighting, totalEquity: String(p.budgetUsd), intervalMinutes, risk: riskGates(p.risk), rebalanceThreshold: String(rebalanceThreshold) }, requires_approval: false, expected_artifact: "session" },
    ],
    approval_gates: [],
    budgets: { max_tokens: config.maxOutputTokensPerStep * 2, max_steps: 2, max_runs: 0, max_sweeps: 0, max_live_sessions: 1, max_cost_micro_usd: Math.round(config.maxCostPerRunUsd * USD_TO_MICRO) },
    stop_conditions: ["session started"],
    expected_artifacts: ["session"],
    safety_notes: "Forward multi-asset paper session; the basket's own risk gates (drawdown/daily-loss kill) apply.",
  };
}

export interface StartResult { status: "started" | "blocked"; runId: string; reason?: string; result?: unknown }

// Go live (paper) for a confirmed basket. Requires L2; blocked when the risk circuit-breaker is on.
export async function startMultiassetPaper(opts: {
  ownerId: number; threadId: string; params: MultiassetParams; legs: Array<Record<string, unknown>>;
  weighting: string; intervalMinutes: number; rebalanceThreshold?: number; autonomy: "L1" | "L2"; ownerToken?: string;
}): Promise<StartResult> {
  if (opts.autonomy !== "L2") {
    const run = await createRun(opts.ownerId, opts.threadId, "setup_multiasset_paper (blocked: autonomy)", "setup_multiasset_paper");
    return { status: "blocked", runId: run.id, reason: "multi-asset paper sessions require autonomy L2+" };
  }
  const risk = await getRiskState(opts.ownerId);
  if (risk.state === "halted") {
    const run = await createRun(opts.ownerId, opts.threadId, "setup_multiasset_paper (blocked: risk)", "setup_multiasset_paper");
    return { status: "blocked", runId: run.id, reason: `risk_state=halted: ${risk.reason ?? "new entries paused"}` };
  }
  const plan = buildStartPlan(opts.ownerId, opts.threadId, opts.params, opts.legs, opts.weighting, opts.intervalMinutes, opts.rebalanceThreshold ?? 0.05, "L2");
  const run = await createRun(opts.ownerId, opts.threadId, "setup_multiasset_paper", plan.playbook_id, plan);
  const ownerToken = opts.ownerToken ?? mintInternalToken(opts.ownerId);
  const mcp = await connectMcp(ownerToken);
  try {
    const outcome = await executePlan({ plan, mcp, runId: run.id, agentAction: "setup_multiasset_paper" });
    if (outcome.status !== "completed") return { status: "blocked", runId: run.id, reason: outcome.reason };
    await recordBudgetEvent(opts.ownerId, "live_session", run.id, "setup_multiasset_paper").catch(() => {});
    logger.info("multiasset paper started", { ownerId: opts.ownerId, runId: run.id });
    return { status: "started", runId: run.id, result: outcome.truthCard };
  } finally {
    await mcp.close().catch(() => {});
  }
}
