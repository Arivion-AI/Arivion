"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { Archivo, Chakra_Petch, Orbitron, Share_Tech_Mono } from "next/font/google";
import "./nexa.css";
import { copilotGet, copilotPost, copilotDelete, streamRun, type CopilotEvent, type ThreadResponse } from "@/lib/copilot/api";
import {
  fmtPct,
  getGmxOhlcvEnsured,
  getGmxFundingEnsured,
  netrunnersGet,
  netrunnersPost,
  netrunnersPostResult,
  seriesToPoints,
  type PaperRuntimeResult,
  type PortfolioResult,
} from "@/lib/netrunners/api";
import GlobeCloud from "@/components/copilot/GlobeCloud";
import NexaBoard, { PHASE_DEFS, phaseOf, type BoardWidget, type WidgetKind } from "@/components/copilot/NexaBoard";
import PortfolioPanel from "@/components/copilot/PortfolioPanel";
import { StockMarketsTerminal } from "@/components/netrunners/StockMarketsTerminal";
import { BacktestReportModal } from "@/components/copilot/BacktestReportModal";
import { TokenIcon, splitSymbol } from "@/components/netrunners/TokenIcon";
import { netrunnersFetch } from "@/lib/netrunners/privy-auth";
import { registerPrivyTokenFetcher, setPrivyToken } from "@/lib/netrunners/privy-token";

// ---- Nexa: three-pane agentic console. Left nav · center board (globe → flowchart of widgets) ·
// right conversation. Agent activity (run.step / truth_card SSE) becomes draggable board widgets.

type Msg = { role: "user" | "assistant"; content: string };
type ChatStep = { id: string; label: string; state: string; widgetId?: string; kind?: string };
type LinkedWallet = { wallet_address: string; chain_id: number; chain_name?: string; verified_at?: string; label?: string | null };
type AgentWalletInfo = {
  address: string; chainId: number; ethBalanceRh: string; ethBalanceArb: string;
  tokens?: { robinhood?: { mockUsdG?: string }; arbitrumSepolia?: { dUSDC?: string; dWETH?: string } };
};
type WalletSession = { ready: boolean; authenticated: boolean; label: string | null };

const chakraPetch = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
});

const orbitron = Orbitron({
  subsets: ["latin"],
  weight: ["500", "700", "800", "900"],
  variable: "--font-numeric",
});

const shareTechMono = Share_Tech_Mono({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-mono",
});

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-ui",
});

const TITLE: Record<string, string> = {
  data_coverage: "Data coverage", get_candles: "Fetch candles", ensure_candles: "Backfill data", list_symbols: "Symbols", load_regime: "Load regime", get_regime_bars: "Regime bars",
  scan_market: "Scan market", market_overview: "Market overview", analyze_symbol: "Analyze symbol", create_bot_spec: "Build strategy",
  build_and_backtest: "Backtest", run_bot_backtest: "Run backtest", run_portfolio: "Portfolio backtest", validate_portfolio: "Validate basket",
  setup_multiasset: "Multiasset setup", start_multiasset_paper: "Go live (paper)", optimizer_sweep: "Optimise", optimizer_run: "Optimise",
  token_news: "Token news", research_web: "Web research", open_managed_position: "Open position",
};

const SUGGESTIONS = [
  "How is the market right now?",
  "What are the best tokens to trade now?",
  "Detailed analysis on Arbitrum",
  "Create a multiasset setup for $500",
];

const RH_CHAIN_ID = 46630;
const ARB_SEPOLIA_CHAIN_ID = 421614;
const PRIVY_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const COPILOT_THREAD_KEY = "duality:nexa:thread";

function shortAddr(addr: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";
}

function explorerUrl(chainId: number, address: string): string {
  if (chainId === ARB_SEPOLIA_CHAIN_ID) return `https://sepolia.arbiscan.io/address/${address}`;
  if (chainId === RH_CHAIN_ID) return `https://explorer.testnet.chain.robinhood.com/address/${address}`;
  return `https://etherscan.io/address/${address}`;
}

// Multiasset elicitation is the AGENT's job now (it asks risk → duration → markets via ask_user, one
// at a time, then runs setup_multiasset). The old keyword-triggered UI wizard below is retained only
// as a fallback type/shape; submit() no longer auto-routes into it (that mis-fired on any message
// mentioning "basket"/"portfolio", hijacking the user's real intent).
type Opt = { label: string; caption?: string };
const STOCK_CLASS = "x" + "stock";
const WIZARD_STEPS: { key: string; q: string; options: Opt[]; multi: boolean }[] = [
  { key: "risk", q: "What's your risk appetite?", multi: false, options: [
    { label: "Conservative", caption: "Low drawdown, fewer rebalances, large-caps, no leverage." },
    { label: "Moderate", caption: "Balanced return vs. drawdown — a sensible default." },
    { label: "Aggressive", caption: "Higher turnover, smaller caps, leverage & shorts allowed." },
  ] },
  { key: "duration", q: "Holding horizon?", multi: false, options: [
    { label: "Days (short)", caption: "~2 weeks · 4h bars, tighter rebalancing." },
    { label: "Weeks (medium)", caption: "~45 days · 4h bars." },
    { label: "Months (long)", caption: "~4 months · daily bars, slow rebalancing." },
  ] },
  { key: "markets", q: "Which markets? (pick one or more)", multi: true, options: [
    { label: "Spot", caption: "Cash spot allocation, long-only." },
    { label: "Perps", caption: "Perpetual futures — leverage allowed in paper." },
    { label: "Stocks", caption: "Tokenized stock exposure, long-only." },
  ] },
];
const DUR_DAYS: Record<string, number> = { "Days (short)": 14, "Weeks (medium)": 45, "Months (long)": 120 };
const MARKET_CLASS: Record<string, string> = { Spot: "spot", Perps: "linear", Stocks: STOCK_CLASS };

// Markdown [label](url) + bare URLs → clickable links; everything else plain text.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>)\]]+)/g;
function rich(text: string): ReactNode[] {
  const out: ReactNode[] = []; let last = 0; let m: RegExpExecArray | null; let k = 0; LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const url = m[2] ?? m[3]; let host = url; try { host = new URL(url).hostname.replace(/^www\./, "") + " ↗"; } catch { /* */ }
    out.push(<a key={k++} href={url} target="_blank" rel="noopener noreferrer">{m[1] ?? host}</a>);
    last = LINK_RE.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Icon({ d }: { d: ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
}
const NAV = [
  { id: "console", label: "Console", icon: <path d="M3 5h18v14H3zM3 9h18M7 13h6" /> },
  { id: "markets", label: "Markets", icon: <path d="M4 19V5m0 14h16M8 15l3-4 3 2 5-7" /> },
  { id: "portfolio", label: "Portfolio", icon: <><path d="M3 13a9 9 0 0 1 9-9v9z" /><path d="M12 4a9 9 0 1 1-8.5 12" /></> },
  { id: "live", label: "Live Trading", icon: <path d="M5 19V5m0 14h14M8 15l3-3 3 2 4-7M17 5h2v2" /> },
  { id: "saved", label: "Saved", icon: <path d="M6 3h12v18l-6-4-6 4V3Z" /> },
  { id: "quants", label: "Quants Lab", icon: <path d="M4 17h16M7 17V8m5 9V4m5 13v-6M4 20h16" /> },
  { id: "about", label: "About", icon: <><circle cx="12" cy="8" r="3.2" /><path d="M5 20a7 7 0 0 1 14 0" /></> },
] as const;

type LabTab = "dashboard" | "strategy" | "bots" | "portfolio" | "optimizer" | "data" | "paper" | "runs";
const QUANTS_TABS: Array<{ id: LabTab; label: string; desc: string; prompt: string }> = [
  { id: "dashboard", label: "Dashboard", desc: "GMX, stock sleeve, LP and risk state in one command view.", prompt: "Give me a GMX and stocks market dashboard with LP context, Dune analytics, risk gates and the best next action." },
  { id: "strategy", label: "Strategy Lab", desc: "Create GMX-first strategies, compare LP, and include stocks.", prompt: "Create and backtest a GMX-first strategy for $500 with LP and Robinhood stock sleeves. Include Dune analytics and improve the plan if metrics are weak." },
  { id: "bots", label: "Bot OS", desc: "Configure paper bots for GMX logic, LP monitoring and stock holds.", prompt: "Design Bot OS rules for the current GMX strategy, LP sleeve and stock sleeve. Use paper/testnet only and show risk controls." },
  { id: "portfolio", label: "Portfolio", desc: "Compose allocations across GMX trading, LP and Robinhood stocks.", prompt: "Build a multiasset portfolio for $500 using GMX trading, LP exposure and Robinhood stocks. Show all three sleeves no matter what." },
  { id: "optimizer", label: "Optimizer", desc: "Sweep weights, rebalance thresholds and drawdown gates.", prompt: "Optimize the current GMX + LP + stock portfolio. Sweep rebalance thresholds and report return, Sharpe, max drawdown and rebalances." },
  { id: "data", label: "Data", desc: "Inspect candles, GMX market data, Dune, pools and stock quotes.", prompt: "Audit data coverage for GMX, LP pools, Dune analytics and Robinhood stocks. Show missing sources honestly." },
  { id: "runs", label: "Run History", desc: "Review backtests, truth cards and published strategy evidence.", prompt: "Summarize recent strategy runs, truth cards, metrics and what should be improved next." },
] as const;

function Burst() {
  const rays = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2; const r1 = 7, r2 = 18;
    const coord = (value: number) => value.toFixed(3);
    return <line key={i} x1={coord(20 + Math.cos(a) * r1)} y1={coord(20 + Math.sin(a) * r1)} x2={coord(20 + Math.cos(a) * r2)} y2={coord(20 + Math.sin(a) * r2)} />;
  });
  return <svg className="nx-burst" viewBox="0 0 40 40" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="20" cy="20" r="4.5" fill="currentColor" stroke="none" />{rays}</svg>;
}

type Setup = { id: string; name: string; status: string; last_run_id?: string; spec: Record<string, unknown>; updated_at?: string };
type ThreadSummary = { id: string; title: string | null; autonomy_level?: string; created_at?: string };
type SnapshotEvent = { run_id: string; seq: number; event_type: string; payload: Record<string, unknown> | null; emitted_at?: string };
type ThreadSnapshot = { thread?: ThreadSummary; messages?: Msg[]; runs?: Array<Record<string, unknown>>; events?: SnapshotEvent[] };

type StrategyRow = { id: string; name: string; description: string; params: Record<string, unknown> };
type BotTemplate = { bot_type?: string; display_name?: string; description?: string; category?: string; default_params?: Record<string, unknown>; eligibility_hint?: string };
type Cockpit = { risk_score?: number; risk_class?: string; hard_blocks?: string[]; modules?: Record<string, Record<string, unknown>>; spec_hash?: string };
type BotParamValue = string | number | boolean | null | Record<string, unknown> | unknown[];
type PortfolioLeg = { symbol: string; asset_class: "crypto" | "equity"; category: "linear" | "spot"; target_weight: number; leverage: number; allow_short: boolean; strategy_id: string; bot_type?: string };
type AxisRow = { name: string; min: string; max: string; step: string };
type OptimizerCandidate = { candidate_rank?: number; params_json?: Record<string, unknown>; params?: Record<string, unknown>; vector_metrics_json?: Record<string, unknown>; vector_metrics?: Record<string, unknown>; parity_json?: Record<string, unknown>; parity?: Record<string, unknown> };
type ChoicePickerKind = "category" | "interval" | "scheme" | "method";
type SymbolPickerTarget = { kind: "strategy" } | { kind: "botParam"; key: string } | { kind: "portfolioLeg"; index: number } | { kind: "liveSymbol" };
type AssetOption = { symbol: string; label: string; detail: string; kind: "crypto" | "equity"; price?: string | number; liquidity?: string | number; funding?: string | number };
type GmxDirection = "long" | "short";
type GmxOrderType = "market" | "limit";
type GmxPolicy = { canPrepare?: boolean; canSubmit?: boolean; errors?: string[]; warnings?: string[]; requiredEnv?: string[] };
type LiveDraft = { symbol?: string; strategyId?: string; botType?: string; direction?: GmxDirection; source?: "strategy" | "bot-os" | "manual" };
type GmxTicket = {
  symbol?: string;
  direction?: GmxDirection;
  orderType?: GmxOrderType;
  collateralUsd?: number;
  leverage?: number;
  sizeUsd?: number;
  slippageBps?: number;
  strategyId?: string;
  botType?: string;
  risk?: { maxCollateralUsd?: number; maxLeverage?: number; warnings?: string[] };
};
type GmxPrepareResponse = { ok?: boolean; ticket?: GmxTicket; policy?: GmxPolicy; error?: string; detail?: unknown };
type GmxLaunchResponse = GmxPrepareResponse & { account?: string; requestId?: string; status?: string; submitted?: unknown; truth?: Record<string, unknown> };
type GmxLiveOrder = {
  id: string;
  account?: string;
  request_id?: string;
  status?: string;
  symbol?: string;
  strategy_id?: string;
  bot_type?: string;
  direction?: string;
  collateral_usd?: number;
  leverage?: number;
  size_usd?: number;
  created_at?: string;
};
type GmxAccountResponse = { positions?: unknown[]; orders?: unknown[]; trades?: { trades?: unknown[] } | unknown[]; balances?: unknown; error?: string; detail?: string };
type LaunchLeg = { symbol?: string; allocation?: number; weight?: number; target_weight?: number; sleeve?: string; asset_class?: string; category?: string; venue?: string; bot?: string; bot_type?: string };
type LaunchRequest = { requestedUsd?: number; depositUsd?: number; text?: string; legs?: LaunchLeg[] };
type LaunchPreflight = {
  ok?: boolean;
  executionEnabled?: boolean;
  requestedUsd?: number;
  executionUsd?: number;
  capped?: boolean;
  capUsd?: number;
  agent?: string;
  balances?: {
    robinhood?: { eth?: string; mockUsdG?: string; nonce?: number; marketOpen?: boolean; rthOnly?: boolean };
    arbitrumSepolia?: { eth?: string; dWETH?: string; dUSDC?: string; lpShares?: string; nonce?: number; pool?: Record<string, string> };
  };
  required?: { robinhoodUsd?: number; arbitrumUsd?: number; gas?: { robinhoodEth?: string; arbitrumSepoliaEth?: string } };
  legs?: Array<LaunchLeg & { usd?: number; chain?: string; route?: string }>;
  chainlink?: { prices?: Array<Record<string, unknown>>; errors?: Record<string, string> };
  activities?: Array<{ chain?: string; summary?: string; detail?: string }>;
  warnings?: string[];
  truth?: Record<string, unknown>;
  error?: string;
  detail?: string;
};
type LaunchPlan = LaunchPreflight & {
  actions?: Array<{ id?: string; kind?: string; chainId?: number; from?: string; to?: string; symbol?: string; usd?: number; reason?: string; endpoint?: string }>;
  summary?: string;
  results?: Array<Record<string, unknown>>;
  status?: string;
  executed?: number;
  total?: number;
};

// GMX-perp-only strategy set. Market-making logic (pmm/avellaneda) is omitted because GMX is an
// oracle-priced GM-pool AMM with no order book to post passive maker quotes into.
const DEFAULT_STRATEGIES: StrategyRow[] = [
  { id: "trend_ema_cross", name: "GMX Trend EMA Cross", description: "Fast/slow EMA cross with ATR trailing stop for perps.", params: { ema_fast: 20, ema_slow: 50, atr_len: 14, order_qty: "0.1", trail_atr_mult: "3.0" } },
  { id: "funding_fade", name: "GMX Funding Mean Reversion", description: "Fades crowded funding gated by a slow-trend filter.", params: { funding_z_threshold: "1.75", ema_slow_len: 80, atr_len: 14, stop_atr_mult: "1.8", tp_atr_mult: "2.4", order_qty: "0.1", max_holding_bars: 96 } },
  { id: "twap", name: "GMX TWAP Executor", description: "Equal-slice time-weighted execution over GMX perps.", params: { total_qty: "1.0", side: "buy", n_slices: 10 } },
  { id: "grid", name: "GMX Static Grid · approximate fills", description: "Range grid execution. GMX has no maker book, so fills are an approximate (liquidity-free) upper bound.", params: { spacing_bps: 30, num_levels: 5, qty_per_level: "0.01", refresh_each_bar: false } },
];
// GMX-runnable strategy ids the UI is allowed to surface from /api/strategies/registry.
const GMX_STRATEGY_ALLOWLIST = new Set(["trend_ema_cross", "funding_fade", "twap", "grid"]);
// GMX-runnable bot_types the UI is allowed to surface from /api/bots/templates. Grid variants are
// kept but flagged approximate; spot/equity/market-making/spot-hedge bots are dropped.
const GMX_BOT_ALLOWLIST = new Set([
  "futures_dca", "futures_martingale", "futures_combo", "twap", "vp_pov", "futures_grid",
  "gmx_trend_perp", "gmx_funding_carry", "gmx_breakout_guard", "gmx_grid",
]);
const GMX_APPROXIMATE_BOTS = new Set(["futures_grid", "gmx_grid"]);
const DEFAULT_PORTFOLIO_LEGS: PortfolioLeg[] = [
  { symbol: "BTCUSDT", asset_class: "crypto", category: "linear", target_weight: 0.6, leverage: 1, allow_short: true, strategy_id: "trend_ema_cross", bot_type: "gmx_trend_perp" },
  { symbol: "ETHUSDT", asset_class: "crypto", category: "linear", target_weight: 0.4, leverage: 1, allow_short: true, strategy_id: "grid", bot_type: "gmx_grid" },
];
const DEFAULT_AXES: AxisRow[] = [
  { name: "ema_fast", min: "10", max: "30", step: "5" },
  { name: "ema_slow", min: "40", max: "80", step: "10" },
  { name: "trail_atr_mult", min: "2", max: "4", step: "1" },
];
const SYMBOL_PARAM_KEYS = new Set(["symbol", "perp_symbol", "spot_symbol", "base_symbol", "quote_symbol"]);
const BOT_MODE_OPTIONS: Record<string, string[]> = {
  mode: ["threshold_or_time", "threshold_only", "time_only"],
  direction: ["neutral", "long", "short"],
  side: ["long", "short"],
  order_type: ["market", "limit"],
};
const FALLBACK_GMX_ASSETS: AssetOption[] = ["BTC", "ETH", "SOL", "ARB", "LINK", "DOGE", "BNB", "AAVE"].map((s) => ({
  symbol: `${s}USDT`,
  label: s,
  detail: "GMX perp market",
  kind: "crypto",
}));
const LAUNCH_INTENT_RE = /\b(launch|deploy|execute|start|go\s+live|run)\b[\s\S]{0,80}\b(setup|basket|portfolio|strategy|bot|trade|trading|plan)\b/i;
const STRATEGY_GUIDE: Record<string, { best: string; risk: string; graph: "trend" | "grid" | "maker" | "carry" }> = {
  trend_ema_cross: { best: "Directional GMX perp momentum when the market is trending.", risk: "Can chop in ranges; use ATR trail and drawdown gates.", graph: "trend" },
  funding_fade: { best: "Fade crowded GMX funding back toward the mean, gated by a slow-trend filter.", risk: "A strong directional move can overwhelm the funding edge; keep stops tight.", graph: "carry" },
  twap: { best: "Systematic time-sliced execution into a GMX perp without signal risk.", risk: "No alpha of its own; only as good as the entry it is splitting.", graph: "trend" },
  grid: { best: "Mean-reversion range trading when price oscillates inside a band.", risk: "GMX has no maker book — fills are an approximate upper bound; breakouts inventory one side.", graph: "grid" },
  gmx_trend_perp: { best: "GMX-native EMA trend replay with funding and borrow modeled.", risk: "Leverage magnifies both the trend and drawdown.", graph: "trend" },
  gmx_funding_carry: { best: "Hold the side that receives GMX funding when the carry is attractive.", risk: "Directional move can overwhelm funding income.", graph: "carry" },
};

function assetBase(symbol: string): string {
  return splitSymbol(symbol).base || symbol.replace(/USDT?$/i, "").toUpperCase();
}

function fmtCompact(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtUsdSmall(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(n >= 100 ? 0 : 2)}` : "--";
}

function gmxPolicyText(policy?: GmxPolicy): string {
  const errors = policy?.errors ?? [];
  if (!errors.length) return "GMX preflight clear";
  if (errors.includes("REAL_TRADER_DISABLED")) return "Blocked by DUALITY_ENABLE_REAL_TRADER";
  if (errors.includes("AGENT_GMX_PRIVATE_KEY_MISSING")) return "Missing AGENT_GMX_PRIVATE_KEY";
  return errors.join(" / ");
}

// Map a GMX order status to a status-pill tone (cyan=executed, gold=in-flight, orange=failed).
function livePillTone(status?: string): "ok" | "live" | "warn" | "" {
  const s = String(status ?? "").toLowerCase();
  if (s.includes("execut")) return "ok";
  if (s.includes("cancel") || s.includes("fail") || s.includes("revert")) return "warn";
  if (s.includes("clos") || s.includes("submit") || s.includes("pending") || s.includes("partial")) return "live";
  return "";
}

function accountCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (isPlainObject(value) && Array.isArray(value.trades)) return value.trades.length;
  return 0;
}

function amountFromText(text: string): number | undefined {
  const m = text.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : undefined;
}


function shortJson(value: unknown, empty: string): string {
  if (value == null) return empty;
  try { return JSON.stringify(value, null, 2).slice(0, 2600); } catch { return String(value); }
}

function StrategyVisual({ mode }: { mode: "trend" | "grid" | "maker" | "carry" }) {
  if (mode === "grid") return <svg className="nx-picker-visual" viewBox="0 0 260 120"><path d="M18 28H242M18 48H242M18 68H242M18 88H242" /><path className="hot" d="M22 78C52 34 82 102 112 54S174 38 206 73s26 4 34-9" /></svg>;
  if (mode === "maker") return <svg className="nx-picker-visual" viewBox="0 0 260 120"><path d="M34 25v72M226 25v72" /><path className="hot" d="M70 42h48l18 36h54" /><path className="cool" d="M70 80h42l20-36h58" /></svg>;
  if (mode === "carry") return <svg className="nx-picker-visual" viewBox="0 0 260 120"><path d="M24 80h212" /><path className="hot" d="M34 88c22-36 38-48 62-35 22 12 32 28 58 10 20-14 37-42 72-25" /><path className="cool" d="M36 34h48M176 88h48" /></svg>;
  return <svg className="nx-picker-visual" viewBox="0 0 260 120"><path className="cool" d="M22 88C58 78 82 56 112 58s55 22 88-12c16-17 27-21 39-18" /><path className="hot" d="M22 72c41 11 68 3 95-14s52-37 122-30" /><circle cx="123" cy="55" r="6" /></svg>;
}

function StrategyPickerModal({ strategies, currentId, onPick, onClose }: { strategies: StrategyRow[]; currentId: string; onPick: (id: string) => void; onClose: () => void }) {
  const [focus, setFocus] = useState(currentId);
  const selected = strategies.find((s) => s.id === focus) ?? strategies[0];
  const guide = STRATEGY_GUIDE[selected?.id ?? ""] ?? { best: selected?.description ?? "Configurable strategy template.", risk: "Review fees, drawdown and execution assumptions before paper launch.", graph: "trend" as const };
  return (
    <div className="nx-picker-back" role="dialog" aria-modal="true">
      <div className="nx-picker-modal wide">
        <div className="nx-picker-head"><div><span>Strategy Selector</span><b>{selected?.name || selected?.id}</b></div><button onClick={onClose}>×</button></div>
        <div className="nx-picker-layout">
          <div className="nx-picker-list">
            {strategies.map((s) => <button key={s.id} className={focus === s.id ? "on" : ""} onClick={() => setFocus(s.id)}><b>{s.name || s.id}</b><small>{s.description || "Backtestable strategy"}</small></button>)}
          </div>
          <div className="nx-picker-detail">
            <StrategyVisual mode={guide.graph} />
            <div className="nx-picker-copy"><b>Best used when</b><p>{guide.best}</p><b>Watch outs</b><p>{guide.risk}</p></div>
            <div className="nx-picker-param-row">{Object.entries(selected?.params ?? {}).slice(0, 8).map(([k, v]) => <span key={k}>{k}: {String(v)}</span>)}</div>
            <button className="nx-picker-primary" onClick={() => { onPick(selected.id); onClose(); }}>Use this strategy</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChoicePickerModal({ title, choices, current, onPick, onClose }: { title: string; choices: Array<{ value: string; label: string; desc: string; graph?: "trend" | "grid" | "maker" | "carry" }>; current: string; onPick: (value: string) => void; onClose: () => void }) {
  const [focus, setFocus] = useState(current);
  const selected = choices.find((c) => c.value === focus) ?? choices[0];
  return (
    <div className="nx-picker-back" role="dialog" aria-modal="true">
      <div className="nx-picker-modal">
        <div className="nx-picker-head"><div><span>{title}</span><b>{selected.label}</b></div><button onClick={onClose}>×</button></div>
        <div className="nx-picker-detail single">
          <StrategyVisual mode={selected.graph ?? "trend"} />
          <div className="nx-choice-grid">{choices.map((c) => <button key={c.value} className={focus === c.value ? "on" : ""} onClick={() => setFocus(c.value)}><b>{c.label}</b><small>{c.desc}</small></button>)}</div>
          <button className="nx-picker-primary" onClick={() => { onPick(selected.value); onClose(); }}>Apply selection</button>
        </div>
      </div>
    </div>
  );
}

function PickerTrigger({ title, value, detail, icon, onClick }: { title: string; value: string; detail?: string; icon?: ReactNode; onClick: () => void }) {
  return <button type="button" className="nx-picker-trigger" onClick={onClick}>{icon}<span><b>{value}</b><em>{detail ?? title}</em></span></button>;
}

function SymbolPickerModal({ options, targetLabel, onPick, onClose }: { options: AssetOption[]; targetLabel: string; onPick: (option: AssetOption) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const rows = options.filter((o) => `${o.symbol} ${o.label} ${o.detail}`.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  return (
    <div className="nx-picker-back" role="dialog" aria-modal="true">
      <div className="nx-picker-modal wide">
        <div className="nx-picker-head"><div><span>Symbol Search</span><b>{targetLabel}</b></div><button onClick={onClose}>×</button></div>
        <input className="nx-symbol-search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Search BTC, ETH, TSLA..." />
        <div className="nx-symbol-grid">
          {rows.map((o) => <button key={`${o.kind}-${o.symbol}`} onClick={() => { onPick(o); onClose(); }}>
            <TokenIcon symbol={o.symbol} kind={o.kind} size={24} />
            <span><b>{o.symbol}</b><small>{o.label} · {o.detail}</small></span>
            <em>{fmtCompact(o.liquidity) || (o.price ? `$${Number(o.price).toFixed(2)}` : o.kind === "crypto" ? "GMX" : "Stock")}</em>
          </button>)}
        </div>
      </div>
    </div>
  );
}

function coerceParam(original: unknown, raw: string): unknown {
  if (typeof original === "boolean") return raw === "true";
  if (typeof original === "number") return raw === "" ? 0 : Number(raw);
  const n = Number(raw);
  return raw !== "" && !Number.isNaN(n) && /^-?\d*\.?\d+$/.test(raw) ? n : raw;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function coerceDeepParam(value: unknown): unknown {
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, coerceDeepParam(v)]));
  }
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  const n = Number(value);
  return value !== "" && !Number.isNaN(n) && /^-?\d*\.?\d+$/.test(value) ? n : value;
}

function displayParam(value: unknown): string {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function humanizeParam(key: string): string {
  return key.replace(/_/g, " ");
}

function seedTemplateParams(tpl: BotTemplate | undefined): Record<string, BotParamValue> {
  const next: Record<string, BotParamValue> = {};
  for (const [k, v] of Object.entries(tpl?.default_params ?? {})) {
    next[k] = SYMBOL_PARAM_KEYS.has(k) ? "BTCUSDT" : isPlainObject(v) ? { ...v } : (v as BotParamValue);
  }
  return next;
}

function botCompatibility(tpl: BotTemplate | undefined, botType: string): { label: string; detail: string; tone: "ok" | "warn" | "bad" } {
  const text = `${botType} ${tpl?.display_name ?? ""} ${tpl?.description ?? ""} ${tpl?.category ?? ""}`.toLowerCase();
  // Grid bots have no maker book on GMX, so fills are an approximate (liquidity-free) upper bound.
  if (GMX_APPROXIMATE_BOTS.has(botType)) return { label: "GMX approximate fills", detail: "Runs on GMX, but GMX has no maker order book — grid fills are an approximate upper bound, not maker-rebate economics.", tone: "warn" };
  if (/tokenized stock|equity|stock/.test(text)) return { label: "Not GMX live", detail: "Stock bots can be simulated here but need a Robinhood execution adapter, not GMX.", tone: "bad" };
  if (/spot/.test(text) && !/perp|future|funding|gmx/.test(text)) return { label: "Needs GMX adapter", detail: "Spot-only logic must be mapped to GMX swaps/perps before live launch.", tone: "warn" };
  if (/perp|future|funding|grid|trend|twap|gmx/.test(text)) return { label: "GMX paper-ready", detail: "Compatible with GMX market data and paper validation; live trading still requires the execution adapter gate.", tone: "ok" };
  return { label: "Unknown", detail: "Validate and backtest before using this template with GMX.", tone: "warn" };
}

// Poll a submitted GMX express order until it reaches a terminal state (or attempts run out).
// Used after a close/decrease submit so the UI can confirm collateral has been returned.
const GMX_TERMINAL_STATUSES = new Set(["executed", "cancelled", "relay_failed", "relay_reverted"]);
async function pollGmxOrderStatus(requestId: string, attempts = 8): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const r = await netrunnersGet<{ status?: unknown }>(`/api/gmx/live/order-status/${encodeURIComponent(requestId)}`);
    const raw = r?.status;
    const status = typeof raw === "string" ? raw : (raw as { status?: string } | null)?.status;
    if (status && GMX_TERMINAL_STATUSES.has(String(status).toLowerCase())) return String(status);
    await new Promise((res) => setTimeout(res, 1500));
  }
  return "pending";
}

// Map a GMX bot template onto a registry strategy the paper runtime knows. Only GMX-runnable
// strategies are referenced (no pmm/avellaneda); unmapped bots default to directional trend.
function strategyForBot(botType: string): string {
  const s = botType.toLowerCase();
  if (s.includes("funding")) return "funding_fade";
  if (s.includes("twap") || s.includes("vp_pov") || s.includes("pov")) return "twap";
  if (s.includes("grid")) return "grid";
  if (s.includes("trend") || s.includes("ema")) return "trend_ema_cross";
  return "trend_ema_cross";
}

function BotParamEditor({ name, value, onChange, onPickSymbol }: { name: string; value: BotParamValue; onChange: (value: BotParamValue) => void; onPickSymbol: () => void }) {
  if (SYMBOL_PARAM_KEYS.has(name)) {
    const s = displayParam(value) || "BTCUSDT";
    return <PickerTrigger title={name} value={s} detail="Search GMX/stock universe" icon={<TokenIcon symbol={s} kind={/TSLA|AMZN|PLTR|NVDA|AMD|HOOD/i.test(s) ? "equity" : "crypto"} size={20} />} onClick={onPickSymbol} />;
  }
  // Arrays (e.g. portfolio `symbols`) have no flat-field representation — edit them as JSON.
  if (Array.isArray(value)) {
    return <JsonParamEditor value={value} onChange={onChange} />;
  }
  if (isPlainObject(value)) {
    return (
      <div className="nx-param-object">
        {Object.entries(value).map(([sub, subValue]) => (
          <div key={sub} className="nx-param-row">
            <span>{humanizeParam(sub)}</span>
            <BotParamScalar name={sub} value={subValue as BotParamValue} onChange={(next) => onChange({ ...value, [sub]: next })} />
          </div>
        ))}
      </div>
    );
  }
  return <BotParamScalar name={name} value={value} onChange={onChange} />;
}

function BotParamScalar({ name, value, onChange }: { name: string; value: BotParamValue; onChange: (value: BotParamValue) => void }) {
  const options = BOT_MODE_OPTIONS[name];
  if (typeof value === "boolean") {
    return <div className="nx-segment"><button className={value ? "on" : ""} onClick={() => onChange(true)}>On</button><button className={!value ? "on" : ""} onClick={() => onChange(false)}>Off</button></div>;
  }
  // Nested objects/arrays can't be a single scalar field — edit them as JSON.
  if (value !== null && typeof value === "object") {
    return <JsonParamEditor value={value} onChange={onChange} />;
  }
  if (options) {
    const current = displayParam(value) || options[0];
    return <div className="nx-segment">{options.map((o) => <button key={o} className={current === o ? "on" : ""} onClick={() => onChange(o)}>{o.replace(/_/g, " ")}</button>)}</div>;
  }
  const raw = displayParam(value);
  const numeric = typeof value === "number" || /fraction|hours|bps|qty|size|threshold|leverage|max|min|interval|period|lookback|levels|spread|mult|limit/i.test(name);
  return <input type={numeric ? "number" : "text"} step={numeric ? "any" : undefined} value={raw} onChange={(e) => onChange(e.target.value)} />;
}

/** JSON editor for structured bot params (arrays / nested objects). Keeps raw text while typing
 *  so mid-edit invalid states aren't clobbered; parses to a real value on each valid edit. The
 *  parent remounts this (via a seed-nonce key) when a new template is selected, so initial text
 *  always reflects the active template. */
function JsonParamEditor({ value, onChange }: { value: BotParamValue; onChange: (value: BotParamValue) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="nx-param-json">
      <textarea spellCheck={false} value={text} rows={Math.min(10, Math.max(3, text.split("\n").length))}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          try { onChange(JSON.parse(t) as BotParamValue); setErr(null); } catch (ex) { setErr((ex as Error).message); }
        }} />
      {err ? <span className="nx-param-json-err">invalid JSON · {err}</span> : null}
    </div>
  );
}

function metric(v: unknown, pct = false): string {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : undefined;
  return typeof n === "number" && !Number.isNaN(n) ? (pct ? fmtPct(n) : n.toFixed(2)) : "--";
}

function MiniCurve({ values }: { values?: Array<string | number> }) {
  const pts = seriesToPoints(values ?? [], 110, 8);
  if (!pts.length) return <div className="nx-lab-empty">Run to draw an equity curve.</div>;
  const d = pts.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  return <svg className="nx-lab-curve" viewBox="0 0 600 110" preserveAspectRatio="none"><path d={d} /></svg>;
}

function LabField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="nx-lab-field"><span>{label}</span>{children}</label>;
}

function QuantsLabPanel({
  active,
  onSelect,
  onRun,
  onOpenLiveDraft,
}: {
  active: LabTab;
  onSelect: (id: LabTab) => void;
  onRun: (prompt: string) => void;
  onOpenLiveDraft: (draft: LiveDraft) => void;
}) {
  const current = QUANTS_TABS.find((t) => t.id === active) ?? QUANTS_TABS[0];
  const [strategies, setStrategies] = useState<StrategyRow[]>(DEFAULT_STRATEGIES);
  const [strategyId, setStrategyId] = useState(DEFAULT_STRATEGIES[0].id);
  const [strategyParams, setStrategyParams] = useState<Record<string, string>>({});
  const [strategySymbol, setStrategySymbol] = useState("BTCUSDT");
  const [strategyCategory, setStrategyCategory] = useState("linear");
  const [strategyInterval, setStrategyInterval] = useState("60");
  const [strategyEquity, setStrategyEquity] = useState("10000");
  const [strategyStatus, setStrategyStatus] = useState("Ready. Configure a GMX strategy and run the backtest.");
  const [strategyResult, setStrategyResult] = useState<PaperRuntimeResult | null>(null);
  const [strategyRunning, setStrategyRunning] = useState(false);
  const [strategyPickerOpen, setStrategyPickerOpen] = useState(false);
  const [choicePicker, setChoicePicker] = useState<ChoicePickerKind | null>(null);
  const [symbolPickerTarget, setSymbolPickerTarget] = useState<SymbolPickerTarget | null>(null);
  const [reportTarget, setReportTarget] = useState<"strategy" | "bot" | null>(null);
  const [gmxAssets, setGmxAssets] = useState<AssetOption[]>(FALLBACK_GMX_ASSETS);

  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [botType, setBotType] = useState("");
  const [botName, setBotName] = useState("GMX risk bot");
  const [botParams, setBotParams] = useState<Record<string, BotParamValue>>({});
  const [botSeedNonce, setBotSeedNonce] = useState(0);
  const [cockpit, setCockpit] = useState<Cockpit | null>(null);
  const [botStatus, setBotStatus] = useState("Load or edit a bot spec, then validate the risk cockpit.");
  const [botBacktestStatus, setBotBacktestStatus] = useState("Backtest a bot spec after selecting a GMX-compatible template.");
  const [botBacktestResult, setBotBacktestResult] = useState<PaperRuntimeResult | null>(null);
  const [botBacktestRunning, setBotBacktestRunning] = useState(false);

  const [legs, setLegs] = useState<PortfolioLeg[]>(DEFAULT_PORTFOLIO_LEGS);
  const [scheme, setScheme] = useState("risk_parity");
  const [schemes, setSchemes] = useState(["fixed", "equal", "inverse_vol", "risk_parity", "momentum"]);
  const [portfolioStatus, setPortfolioStatus] = useState("Ready. GMX trading + Robinhood stock sleeve are editable by hand.");
  const [portfolioResult, setPortfolioResult] = useState<PortfolioResult | null>(null);
  const [portfolioRunning, setPortfolioRunning] = useState(false);

  const [axes, setAxes] = useState<AxisRow[]>(DEFAULT_AXES);
  const [method, setMethod] = useState("grid");
  const [topN, setTopN] = useState("3");
  const [optimizerStatus, setOptimizerStatus] = useState("Ready. Sweep GMX strategy parameters.");
  const [optimizerRunning, setOptimizerRunning] = useState(false);
  const [optimizerCandidates, setOptimizerCandidates] = useState<OptimizerCandidate[]>([]);

  const [dataStatus, setDataStatus] = useState("Check coverage before trusting metrics.");
  const [dataRows, setDataRows] = useState<Array<Record<string, unknown>>>([]);

  const [liveSymbol, setLiveSymbol] = useState("ETH/USD [WETH-USDC]");
  const [liveDirection, setLiveDirection] = useState<GmxDirection>("long");
  const [liveOrderType, setLiveOrderType] = useState<GmxOrderType>("market");
  const [liveCollateralUsd, setLiveCollateralUsd] = useState("25");
  const [liveLeverage, setLiveLeverage] = useState("1.5");
  const [liveSlippageBps, setLiveSlippageBps] = useState("30");
  const [liveTriggerPriceUsd, setLiveTriggerPriceUsd] = useState("");
  const [liveStrategyId, setLiveStrategyId] = useState("gmx_trend_perp");
  const [liveBotType, setLiveBotType] = useState("none");
  const [liveConfirm, setLiveConfirm] = useState("");
  const [liveStatus, setLiveStatus] = useState("Run a strategy or bot backtest, then arm a GMX live ticket.");
  const [livePrepare, setLivePrepare] = useState<GmxPrepareResponse | null>(null);
  const [liveLaunch, setLiveLaunch] = useState<GmxLaunchResponse | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveOrders, setLiveOrders] = useState<GmxLiveOrder[]>([]);
  const [liveMonitorAddress, setLiveMonitorAddress] = useState("");
  const [liveAccount, setLiveAccount] = useState<GmxAccountResponse | null>(null);
  const [liveStopResult, setLiveStopResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    let mounted = true;
    netrunnersGet<{ strategies?: StrategyRow[] }>("/api/strategies/registry").then((r) => {
      if (!mounted || !r?.strategies?.length) return;
      // Surface only GMX-runnable strategies; market-making logic can't run on GMX's AMM.
      const gmxStrategies = r.strategies.filter((s) => GMX_STRATEGY_ALLOWLIST.has(s.id));
      const rows = gmxStrategies.length ? gmxStrategies : DEFAULT_STRATEGIES;
      setStrategies(rows);
      if (!rows.some((s) => s.id === strategyId)) setStrategyId(rows[0].id);
    });
    netrunnersGet<{ templates?: BotTemplate[] }>("/api/bots/templates").then((r) => {
      if (!mounted) return;
      // Surface only GMX-runnable bot templates (drops spot/equity/market-making/spot-hedge bots).
      const rows = (r?.templates ?? []).filter((t) => GMX_BOT_ALLOWLIST.has(t.bot_type ?? ""));
      setTemplates(rows);
      const gmxLike = rows.find((t) => /futures|perp|funding/i.test(`${t.bot_type} ${t.display_name}`))
        ?? rows.find((t) => /trend|grid/i.test(`${t.bot_type} ${t.display_name}`))
        ?? rows[0];
      if (gmxLike) {
        setBotType(gmxLike.bot_type ?? "");
        setBotParams(seedTemplateParams(gmxLike));
        setBotSeedNonce((n) => n + 1);
      }
    });
    netrunnersGet<{ weighting_schemes?: string[] }>("/api/portfolio/schemes").then((r) => {
      if (mounted && r?.weighting_schemes?.length) setSchemes(r.weighting_schemes);
    });
    return () => { mounted = false; };
  }, [strategyId]);

  useEffect(() => {
    let mounted = true;
    fetch("/api/gmx/pairs?limit=120", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((json: { pairs?: Array<Record<string, unknown>> } | null) => {
      if (!mounted || !json?.pairs?.length) return;
      const rows = json.pairs.map((p) => {
        const base = String(p.base_currency ?? String(p.ticker_id ?? "").split("/")[0] ?? "").toUpperCase();
        return {
          symbol: `${base}USDT`,
          label: base,
          detail: String(p.ticker_id ?? "GMX perp market"),
          kind: "crypto" as const,
          price: p.price as string | number | undefined,
          liquidity: (p.open_interest ?? p.liquidity) as string | number | undefined,
          funding: p.funding_rate as string | number | undefined,
        };
      }).filter((p) => p.label);
      if (rows.length) setGmxAssets(rows);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  const refreshLiveOrders = useCallback(async () => {
    const r = await netrunnersGet<{ orders?: GmxLiveOrder[]; policy?: GmxPolicy }>("/api/gmx/live/sessions");
    const rows = r?.orders ?? [];
    setLiveOrders(rows);
    const account = rows.find((o) => o.account)?.account;
    if (account && !liveMonitorAddress) setLiveMonitorAddress(account);
    if (r?.policy?.errors?.length) setLiveStatus(gmxPolicyText(r.policy));
  }, [liveMonitorAddress]);

  useEffect(() => { void refreshLiveOrders(); }, [refreshLiveOrders]);

  const selectedStrategy = useMemo(() => strategies.find((s) => s.id === strategyId) ?? strategies[0], [strategies, strategyId]);
  const selectedBot = useMemo(() => templates.find((t) => t.bot_type === botType), [templates, botType]);
  const botCompat = useMemo(() => botCompatibility(selectedBot, botType), [selectedBot, botType]);
  const totalWeight = useMemo(() => legs.reduce((s, l) => s + l.target_weight, 0), [legs]);
  const symbolOptions = useMemo(() => gmxAssets, [gmxAssets]);
  const choiceChoices = useMemo(() => {
    if (choicePicker === "category") return [
      { value: "linear", label: "GMX Perp", desc: "Use GMX perpetual markets and native OHLCV replay.", graph: "trend" as const },
    ];
    if (choicePicker === "interval") return [
      { value: "60", label: "1 hour", desc: "More trades, faster feedback, noisier signals.", graph: "maker" as const },
      { value: "240", label: "4 hours", desc: "Balanced GMX backtest cadence for swing logic.", graph: "trend" as const },
      { value: "D", label: "1 day", desc: "Slow strategic replay with cleaner regime context.", graph: "carry" as const },
    ];
    if (choicePicker === "method") return [
      { value: "grid", label: "Grid", desc: "Exhaustive sweep across every axis step.", graph: "grid" as const },
      { value: "random", label: "Random", desc: "Fast sampling when the space is wide.", graph: "maker" as const },
      { value: "sobol", label: "Sobol", desc: "Low-discrepancy sampling for broad coverage.", graph: "trend" as const },
    ];
    return schemes.map((s, i) => ({ value: s, label: s.replace(/_/g, " "), desc: i === 0 ? "Fixed user-provided weights." : "Quant engine allocation scheme.", graph: (s.includes("vol") ? "carry" : s.includes("momentum") ? "trend" : "grid") as "trend" | "grid" | "maker" | "carry" }));
  }, [choicePicker, schemes]);

  function currentChoiceValue(kind: ChoicePickerKind): string {
    if (kind === "category") return strategyCategory;
    if (kind === "interval") return strategyInterval;
    if (kind === "method") return method;
    return scheme;
  }

  function applyChoice(kind: ChoicePickerKind, value: string) {
    if (kind === "category") setStrategyCategory(value);
    else if (kind === "interval") setStrategyInterval(value);
    else if (kind === "method") setMethod(value);
    else setScheme(value);
  }

  function applySymbol(option: AssetOption) {
    const nextSymbol = option.kind === "crypto" ? `${assetBase(option.symbol)}USDT` : option.symbol.toUpperCase();
    if (!symbolPickerTarget || symbolPickerTarget.kind === "strategy") {
      setStrategySymbol(nextSymbol);
      setStrategyCategory(option.kind === "crypto" ? "linear" : "spot");
      return;
    }
    if (symbolPickerTarget.kind === "botParam") {
      setBotParams((p) => ({ ...p, [symbolPickerTarget.key]: nextSymbol }));
      return;
    }
    if (symbolPickerTarget.kind === "liveSymbol") {
      setLiveSymbol(nextSymbol);
      return;
    }
    updateLeg(symbolPickerTarget.index, {
      symbol: nextSymbol,
      asset_class: option.kind,
      category: option.kind === "equity" ? "spot" : "linear",
      leverage: option.kind === "equity" ? 1 : legs[symbolPickerTarget.index]?.leverage ?? 1,
      allow_short: option.kind === "equity" ? false : legs[symbolPickerTarget.index]?.allow_short ?? true,
      strategy_id: option.kind === "equity" ? "hold" : (legs[symbolPickerTarget.index]?.strategy_id === "hold" ? strategyId : legs[symbolPickerTarget.index]?.strategy_id ?? strategyId),
      bot_type: option.kind === "equity" ? "stock_hold" : (legs[symbolPickerTarget.index]?.bot_type ?? "gmx_trend_perp"),
    });
  }

  function strategyParamValue(key: string, base: unknown): string {
    return key in strategyParams ? strategyParams[key] : typeof base === "boolean" || typeof base === "number" ? String(base) : String(base ?? "");
  }

  async function runStrategyBacktest() {
    if (!selectedStrategy || strategyRunning) return;
    setStrategyRunning(true);
    setStrategyResult(null);
    setStrategyStatus(`Fetching GMX-native OHLCV + funding for ${strategySymbol}...`);
    const symbolUpper = strategySymbol.toUpperCase();
    const native = await getGmxOhlcvEnsured(symbolUpper, strategyInterval, 120);
    const bars = native.bars ?? [];
    if (bars.length < 30) {
      setStrategyStatus(`${symbolUpper} has only ${bars.length} GMX candles. ${native.error ?? "Data source is missing, so no metric is shown."}`);
      setStrategyRunning(false);
      return;
    }
    const funding_rows = await getGmxFundingEnsured(symbolUpper, strategyInterval, bars);
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(selectedStrategy.params ?? {})) params[k] = coerceParam(v, strategyParamValue(k, v));
    const payload = {
      symbol: symbolUpper,
      strategy_id: selectedStrategy.id,
      strategy_params: params,
      starting_equity: strategyEquity,
      bars,
      funding_rows,
      fee_bps_taker: "5.5",
      fee_bps_maker: "1.0",
      slippage_bps_one_way: "2.0",
      interval_minutes: strategyInterval === "D" ? 1440 : Number(strategyInterval) || 60,
      // GMX is an oracle-priced AMM with no order book: label the run as DEX/AMM-modeled so the
      // worker skips Bybit L2 assumptions and reports APPROXIMATE_FILLS (liquidity-free upper bound).
      venue: "gmx",
      data_source: "dex",
      execution_fidelity: "amm_mid_only",
      risk: { max_position_fraction: "1.0", max_total_exposure_fraction: "3.0" },
    };
    setStrategyStatus(`Running ${selectedStrategy.id} on ${bars.length} GMX bars (${native.requestSymbol ?? symbolUpper}) · ${funding_rows.length} funding rows...`);
    const r = await netrunnersPost<PaperRuntimeResult, typeof payload>("/api/paper/runtime/run", payload);
    setStrategyRunning(false);
    if (!r) return setStrategyStatus("Backtest endpoint unreachable.");
    if (r.error) return setStrategyStatus(`Backtest failed: ${r.error}`);
    setStrategyResult(r);
    setStrategyStatus(`Completed · ${bars.length} GMX bars · ${funding_rows.length} funding rows · ${(r.fills ?? []).length} fills`);
  }

  function seedBot(tpl: BotTemplate) {
    setBotType(tpl.bot_type ?? "");
    setBotParams(seedTemplateParams(tpl));
    setBotSeedNonce((n) => n + 1);
    setCockpit(null);
    setBotBacktestResult(null);
    setBotBacktestStatus("Backtest a bot spec after selecting a GMX-compatible template.");
  }

  function buildBotParams(): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(botParams)) params[k] = coerceDeepParam(v);
    return params;
  }

  async function validateBot() {
    const params = buildBotParams();
    const symbol = String(params.symbol ?? params.perp_symbol ?? strategySymbol).toUpperCase();
    setBotStatus("Computing GMX bot risk cockpit...");
    const r = await netrunnersPost<Cockpit & { error?: string }, Record<string, unknown>>("/api/bots/cockpit", {
      spec: { bot_type: botType, name: botName, symbols: [symbol], params: { ...params, venue: "gmx" }, risk: {}, accounting: {} },
      coverage: {},
    });
    if (!r) return setBotStatus("Cockpit endpoint unreachable.");
    if ((r as { detail?: unknown }).detail || r.error) return setBotStatus(`Spec invalid: ${r.error ?? "check params"}`);
    setCockpit(r);
    setBotStatus(`risk ${r.risk_class ?? "--"} · score ${metric(r.risk_score)} · ${r.spec_hash?.slice(0, 10) ?? "no hash"}`);
  }

  async function backtestBot() {
    if (botBacktestRunning) return;
    const params = buildBotParams();
    const symbol = String(params.symbol ?? params.perp_symbol ?? strategySymbol).toUpperCase();
    const mapped = strategyForBot(botType);
    const strategy = strategies.find((s) => s.id === mapped) ?? strategies.find((s) => s.id === "trend_ema_cross") ?? strategies[0];
    if (!strategy) return setBotBacktestStatus("No strategy registry is available for bot backtesting.");
    setBotBacktestRunning(true);
    setBotBacktestResult(null);
    setBotBacktestStatus(`Fetching GMX-native history + funding for ${symbol}...`);
    const native = await getGmxOhlcvEnsured(symbol, strategyInterval, 120);
    const bars = native.bars ?? [];
    if (bars.length < 30) {
      setBotBacktestRunning(false);
      return setBotBacktestStatus(`${symbol} has only ${bars.length} GMX candles. ${native.error ?? "No bot metrics shown until history exists."}`);
    }
    const funding_rows = await getGmxFundingEnsured(symbol, strategyInterval, bars);
    const payload = {
      symbol,
      strategy_id: strategy.id,
      strategy_params: { ...strategy.params, ...params },
      starting_equity: strategyEquity,
      bars,
      funding_rows,
      fee_bps_taker: "5.5",
      fee_bps_maker: "1.0",
      slippage_bps_one_way: "2.0",
      interval_minutes: strategyInterval === "D" ? 1440 : Number(strategyInterval) || 60,
      venue: "gmx",
      data_source: "dex",
      execution_fidelity: "amm_mid_only",
      risk: { max_position_fraction: "1.0", max_total_exposure_fraction: "3.0" },
    };
    setBotBacktestStatus(`Running ${botType || strategy.id} through ${strategy.id} on ${bars.length} GMX bars · ${funding_rows.length} funding rows...`);
    const r = await netrunnersPost<PaperRuntimeResult, typeof payload>("/api/paper/runtime/run", payload);
    setBotBacktestRunning(false);
    if (!r) return setBotBacktestStatus("Bot backtest endpoint unreachable.");
    if (r.error) return setBotBacktestStatus(`Bot backtest failed: ${r.error}`);
    setBotBacktestResult(r);
    setBotBacktestStatus(`Completed · mapped to ${strategy.id} · ${bars.length} GMX bars · ${(r.fills ?? []).length} fills`);
  }

  function updateLeg(index: number, patch: Partial<PortfolioLeg>) {
    setLegs((prev) => prev.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)));
  }

  function legPayload(withBars: Array<{ leg: PortfolioLeg; bars: unknown[] }> | null) {
    return (withBars ?? legs.map((leg) => ({ leg, bars: [] }))).map(({ leg, bars }) => ({
      symbol: leg.symbol.toUpperCase(), asset_class: leg.asset_class, category: leg.category,
      target_weight: String(leg.target_weight), leverage: String(leg.leverage), allow_short: leg.allow_short,
      strategy_id: leg.strategy_id, bot_type: leg.bot_type, bars,
    }));
  }

  async function validatePortfolio() {
    const r = await netrunnersPost<{ valid?: boolean; errors?: string[]; error?: string }, Record<string, unknown>>("/api/portfolio/validate", { legs: legPayload(null), weighting: scheme });
    if (!r) return setPortfolioStatus("Validation endpoint unreachable.");
    if (r.error) return setPortfolioStatus(`Validation failed: ${r.error}`);
    setPortfolioStatus(r.valid ? "Validation passed. Portfolio can run." : `Invalid: ${(r.errors ?? []).join(", ")}`);
  }

  async function runPortfolio() {
    setPortfolioRunning(true);
    setPortfolioResult(null);
    setPortfolioStatus("Fetching GMX-native candles for each perp leg...");
    const withBars: Array<{ leg: PortfolioLeg; bars: unknown[] }> = [];
    for (const leg of legs) {
      // GMX-perp-only: every leg sources GMX-native OHLCV. No Bybit-spot or equity fallback.
      const native = await getGmxOhlcvEnsured(leg.symbol.toUpperCase(), "60", 120);
      withBars.push({ leg, bars: native.bars ?? [] });
    }
    const thin = withBars.filter((w) => w.bars.length < 30);
    if (thin.length) {
      setPortfolioStatus(`Missing usable candle data for ${thin.map((t) => t.leg.symbol).join(", ")}. Metrics are blocked until data exists.`);
      setPortfolioRunning(false);
      return;
    }
    const payload = {
      legs: legPayload(withBars), weighting: scheme, total_equity: "100000",
      fee_bps_taker: "5.5", slippage_bps_one_way: "2.0", rebalance_threshold: "0.05",
      lookback_bars: 48, top_n: 3, interval_minutes: 60,
      risk: { max_position_fraction: "1.0", max_total_exposure_fraction: "3.0" },
    };
    const r = await netrunnersPost<PortfolioResult, typeof payload>("/api/portfolio/run", payload);
    setPortfolioRunning(false);
    if (!r) return setPortfolioStatus("Portfolio endpoint unreachable.");
    if (r.error) return setPortfolioStatus(`Portfolio failed: ${r.error}${r.errors ? " · " + r.errors.join(", ") : ""}`);
    setPortfolioResult(r);
    setPortfolioStatus(`Completed · ${(r.equity_curve ?? []).length} steps · ${r.rebalances ?? 0} rebalances`);
  }

  async function runOptimizer() {
    setOptimizerRunning(true);
    setOptimizerCandidates([]);
    const searchSpace: Record<string, { min: number; max: number; step: number }> = {};
    for (const a of axes) if (a.name.trim()) searchSpace[a.name.trim()] = { min: Number(a.min), max: Number(a.max), step: Number(a.step) || 1 };
    setOptimizerStatus("Generating candidates and scoring GMX strategy params...");
    const run = await netrunnersPost<{ runId?: string; error?: string }, Record<string, unknown>>("/api/optimizer/runs", {
      strategyVersionId: "sv_trend_ema_cross_live", method, topN: Number(topN) || 3, searchSpace,
    });
    if (!run?.runId) {
      setOptimizerRunning(false);
      return setOptimizerStatus(`Optimizer failed: ${run?.error ?? "no run id"}`);
    }
    const detail = await netrunnersGet<{ candidates?: OptimizerCandidate[] }>(`/api/optimizer/runs/${run.runId}`);
    const rows = detail?.candidates ?? [];
    setOptimizerCandidates(rows);
    setOptimizerStatus(`Run ${run.runId.slice(0, 8)} · ${rows.length} finalists scored`);
    setOptimizerRunning(false);
  }

  async function checkData() {
    setDataStatus("Checking GMX candles, funding, pools and health...");
    const symbolUpper = strategySymbol.toUpperCase();
    const [health, pools, candles, funding] = await Promise.all([
      netrunnersGet<{ rows?: Array<Record<string, unknown>>; symbols?: Array<Record<string, unknown>> }>("/api/data/health"),
      netrunnersGet<{ pools?: Array<Record<string, unknown>> }>("/api/dex/pools?chainId=42161&limit=8"),
      getGmxOhlcvEnsured(symbolUpper, strategyInterval, 120),
      getGmxFundingEnsured(symbolUpper, strategyInterval, []),
    ]);
    const candleBars = candles.bars ?? [];
    const rows = [
      { source: "GMX strategy candles", status: candleBars.length >= 30 ? "ok" : "missing", detail: `${candleBars.length} bars for ${symbolUpper}${candles.requestSymbol ? ` via ${candles.requestSymbol}` : ""}` },
      { source: "GMX funding history", status: funding.length >= 1 ? "ok" : "missing", detail: `${funding.length} funding rows for ${symbolUpper} (source=gmx)` },
      { source: "LP pools", status: (pools?.pools ?? []).length ? "ok" : "missing", detail: `${pools?.pools?.length ?? 0} pools from Arbitrum` },
      { source: "Data health", status: health ? "ok" : "missing", detail: `${health?.rows?.length ?? health?.symbols?.length ?? 0} rows` },
      { source: "Dune analytics", status: "agent widget", detail: "Run a Dune panel from Copilot; no fake rows are emitted." },
    ];
    setDataRows(rows);
    setDataStatus("Coverage check complete. Missing sources block metrics instead of showing zero.");
  }

  function livePayload() {
    return {
      symbol: liveSymbol,
      direction: liveDirection,
      orderType: liveOrderType,
      collateralUsd: Number(liveCollateralUsd),
      leverage: Number(liveLeverage),
      slippageBps: Number(liveSlippageBps),
      triggerPriceUsd: liveOrderType === "limit" && liveTriggerPriceUsd ? Number(liveTriggerPriceUsd) : undefined,
      strategyId: liveStrategyId,
      botType: liveBotType === "none" ? undefined : liveBotType,
    };
  }

  function armLiveFromStrategy() {
    const lastFill = [...(strategyResult?.fills ?? [])].reverse().find((f) => f.side);
    const inferred = String(lastFill?.side ?? "").toLowerCase().includes("sell") ? "short" : "long";
    onOpenLiveDraft({
      symbol: strategySymbol.toUpperCase(),
      strategyId: selectedStrategy?.id ?? strategyId,
      direction: inferred,
      source: "strategy",
    });
  }

  function armLiveFromBot() {
    const params = buildBotParams();
    const symbol = String(params.symbol ?? params.perp_symbol ?? strategySymbol).toUpperCase();
    onOpenLiveDraft({
      symbol,
      strategyId: strategyForBot(botType),
      botType: botType || "custom_bot",
      direction: String(params.side ?? params.direction ?? "").toLowerCase().includes("short") ? "short" : "long",
      source: "bot-os",
    });
  }

  async function prepareLiveTicket() {
    setLiveBusy(true);
    setLiveLaunch(null);
    setLiveStopResult(null);
    setLiveStatus("Preparing GMX live ticket...");
    const r = await netrunnersPostResult<GmxPrepareResponse, ReturnType<typeof livePayload>>("/api/gmx/live/prepare", livePayload());
    const data = r.data ?? { ok: false, error: `HTTP ${r.status}` };
    setLivePrepare(data);
    setLiveStatus(data.ok ? `Prepared ${data.ticket?.symbol ?? liveSymbol} · ${fmtUsdSmall(data.ticket?.sizeUsd)} notional` : `Prepare blocked: ${data.error ?? gmxPolicyText(data.policy)}`);
    setLiveBusy(false);
  }

  async function launchLiveTicket() {
    setLiveBusy(true);
    setLiveStatus("Submitting GMX express order...");
    const r = await netrunnersPostResult<GmxLaunchResponse, ReturnType<typeof livePayload> & { confirm: string }>("/api/gmx/live/launch", {
      ...livePayload(),
      confirm: liveConfirm,
    });
    const data = r.data ?? { ok: false, error: `HTTP ${r.status}` };
    setLiveLaunch(data);
    setLiveStatus(data.ok ? `Submitted · request ${data.requestId ?? "pending"}` : `Launch blocked: ${data.error ?? gmxPolicyText(data.policy)}`);
    if (data.account) setLiveMonitorAddress(data.account);
    await refreshLiveOrders();
    setLiveBusy(false);
  }

  async function refreshLiveAccount(address = liveMonitorAddress) {
    const target = address.trim();
    if (!target) {
      setLiveStatus("Enter a GMX account address or submit a live order first.");
      return;
    }
    setLiveBusy(true);
    setLiveStatus(`Reading GMX account ${target.slice(0, 6)}...${target.slice(-4)}...`);
    const state = await netrunnersGet<GmxAccountResponse>(`/api/gmx/live/account?address=${encodeURIComponent(target)}`);
    setLiveAccount(state ?? { error: "GMX account endpoint unreachable" });
    setLiveStatus(state?.error ? `Account read failed: ${state.error}` : "GMX account monitor refreshed.");
    setLiveBusy(false);
  }

  async function stopLiveOrder(order?: GmxLiveOrder) {
    const requestId = order?.request_id ?? liveLaunch?.requestId;
    if (!requestId) {
      setLiveStatus("No live order selected to close.");
      return;
    }
    setLiveBusy(true);
    setLiveStatus("Submitting GMX close (decrease) order...");
    const r = await netrunnersPostResult<{ ok?: boolean; requestId?: string; status?: string; error?: string; policy?: GmxPolicy }, Record<string, unknown>>("/api/gmx/live/stop", {
      requestId,
      orderId: order?.id,
      confirm: "STOP_GMX_MAINNET",
    });
    const data = r.data ?? { ok: false, error: `HTTP ${r.status}` };
    setLiveStopResult(data);
    if (data.ok && data.requestId) {
      setLiveStatus(`Close submitted · request ${data.requestId}. Polling status...`);
      const status = await pollGmxOrderStatus(data.requestId);
      await refreshLiveOrders();
      if (liveMonitorAddress) await refreshLiveAccount(liveMonitorAddress);
      setLiveStatus(`Close ${status} · collateral returns to the GMX account wallet once executed.`);
    } else {
      setLiveStatus(`Close blocked: ${data.error ?? gmxPolicyText(data.policy)}`);
    }
    setLiveBusy(false);
  }

  const strategyPerf = strategyResult?.performance;
  const botPerf = botBacktestResult?.performance;
  const portfolioMetrics = (portfolioResult as unknown as { metrics?: Record<string, unknown> })?.metrics;

  return (
    <div className="nx-quants-panel">
      <div className="nx-quants-eyebrow"><b /> GMX + Stocks Configurable Lab</div>
      <h2>{current.label}</h2>
      <p>{current.desc} Configure by hand, run the quant engine directly, then ask Nexa to explain or iterate.</p>
      <div className="nx-quants-tabs">
        {QUANTS_TABS.map((tab) => <button key={tab.id} className={active === tab.id ? "on" : ""} onClick={() => onSelect(tab.id)}>{tab.label}</button>)}
      </div>

      {active === "dashboard" || active === "data" ? (
        <div className="nx-lab-grid">
          <div className="nx-lab-card wide">
            <div className="nx-lab-card-head"><span>Data Coverage</span><button onClick={checkData}>Check Sources</button></div>
            <p>{dataStatus}</p>
            <div className="nx-lab-table">
              {(dataRows.length ? dataRows : [
                { source: "GMX strategy candles", status: "unchecked", detail: strategySymbol },
                { source: "LP pools", status: "unchecked", detail: "GMX + Uniswap context" },
                { source: "Dune analytics", status: "agent widget", detail: "Click Dune run below" },
                { source: "Robinhood stocks", status: "unchecked", detail: "Manual stock sleeve" },
              ]).map((r) => <div key={String(r.source)}><b>{String(r.source)}</b><span>{String(r.status)}</span><em>{String(r.detail)}</em></div>)}
            </div>
          </div>
          <div className="nx-lab-card">
            <div className="nx-lab-card-head"><span>Dune Analytics</span><button onClick={() => onRun("Run the Dune analytics widget for the selected GMX/LP markets and show configured query status, provenance, rows and missing-source reasons.")}>Run With AI</button></div>
            <p>Dune belongs on the board as a provenance widget. If the query/key is missing, it should say so instead of pretending.</p>
          </div>
          <div className="nx-lab-card">
            <div className="nx-lab-card-head"><span>Ask Nexa</span><button onClick={() => onRun(current.prompt)}>Analyze Lab</button></div>
            <p>Use the AI for explanation and iteration after the manual run has produced real outputs.</p>
          </div>
        </div>
      ) : null}

      {active === "strategy" ? (
        <div className="nx-lab-grid">
          <div className="nx-lab-card wide">
            <div className="nx-lab-card-head"><span>Strategy Runner</span><button disabled={strategyRunning} onClick={runStrategyBacktest}>{strategyRunning ? "Running" : "Run Backtest"}</button></div>
            <div className="nx-lab-form three">
              <LabField label="strategy"><PickerTrigger title="strategy" value={selectedStrategy?.name || strategyId} detail="Open explanation, risks and visual" onClick={() => setStrategyPickerOpen(true)} /></LabField>
              <LabField label="symbol"><PickerTrigger title="symbol" value={strategySymbol} detail="Search GMX markets" icon={<TokenIcon symbol={strategySymbol} kind="crypto" size={22} />} onClick={() => setSymbolPickerTarget({ kind: "strategy" })} /></LabField>
              <LabField label="category"><PickerTrigger title="category" value="GMX perp" detail="GMX perpetual markets" onClick={() => setChoicePicker("category")} /></LabField>
              <LabField label="interval"><PickerTrigger title="interval" value={strategyInterval === "D" ? "1d" : strategyInterval === "240" ? "4h" : "1h"} detail="Pick candle timeframe" onClick={() => setChoicePicker("interval")} /></LabField>
              <LabField label="starting equity"><input value={strategyEquity} onChange={(e) => setStrategyEquity(e.target.value)} /></LabField>
            </div>
            <div className="nx-lab-param-grid">
              {Object.entries(selectedStrategy?.params ?? {}).map(([k, v]) => <LabField key={k} label={k}><input value={strategyParamValue(k, v)} onChange={(e) => setStrategyParams((p) => ({ ...p, [k]: e.target.value }))} /></LabField>)}
            </div>
            <p>{selectedStrategy?.description}</p>
            <p>{strategyStatus}</p>
          </div>
          <div className="nx-lab-card">
            <span className="nx-lab-metric">Return <b>{metric(strategyPerf?.total_return, true)}</b></span>
            <span className="nx-lab-metric">Sharpe <b>{metric(strategyPerf?.sharpe)}</b></span>
            <span className="nx-lab-metric">Max DD <b>{metric(strategyPerf?.max_drawdown, true)}</b></span>
            <div className="nx-result-table">
              <div><span>Final equity</span><b>{strategyResult?.final_equity ? `$${Number(strategyResult.final_equity).toFixed(2)}` : "--"}</b></div>
              <div><span>Fills</span><b>{strategyResult?.fills?.length ?? "--"}</b></div>
              <div><span>Venue</span><b>{String(strategyResult?.venue?.venue ?? strategyResult?.venue?.name ?? "gmx/paper")}</b></div>
              <div><span>Fill model</span><b>{String(strategyResult?.fill_model?.mode ?? strategyResult?.fill_model?.name ?? "approximate")} · {String(strategyResult?.truth_card?.result_tier ?? "LOCAL ONLY")}</b></div>
            </div>
            <MiniCurve values={strategyResult?.equity_curve} />
            <button className="nx-lab-detail-btn" disabled={!strategyResult} onClick={() => setReportTarget("strategy")}>View Detailed Backtest →</button>
            <div className="nx-lab-actions">
              <button className="nx-lab-ghost" onClick={() => onRun(`Review this GMX backtest result and suggest parameter changes: ${strategyStatus}`)}>Ask Nexa to Improve</button>
              <button className="nx-lab-primary" disabled={!strategyResult} onClick={armLiveFromStrategy}>Open Live Ticket</button>
            </div>
          </div>
        </div>
      ) : null}

      {active === "bots" ? (
        <div className="nx-lab-grid">
          <div className="nx-lab-card wide">
            <div className="nx-lab-card-head"><span>Bot OS Spec</span><div><button onClick={validateBot}>Validate Spec</button><button disabled={botBacktestRunning} onClick={backtestBot}>{botBacktestRunning ? "Running" : "Backtest Bot"}</button></div></div>
            <div className="nx-lab-template-row">
              {templates.slice(0, 10).map((tpl) => <button key={tpl.bot_type} className={botType === tpl.bot_type ? "on" : ""} onClick={() => seedBot(tpl)}>{tpl.bot_type}</button>)}
            </div>
            <div className="nx-lab-form two">
              <LabField label="name"><input value={botName} onChange={(e) => setBotName(e.target.value)} /></LabField>
              <LabField label="bot type"><input value={botType} onChange={(e) => setBotType(e.target.value)} /></LabField>
            </div>
            <div className="nx-lab-param-grid">
              {Object.entries(botParams).map(([k, v]) => (
                <LabField key={`${k}-${botSeedNonce}`} label={k}>
                  <BotParamEditor name={k} value={v} onPickSymbol={() => setSymbolPickerTarget({ kind: "botParam", key: k })} onChange={(next) => setBotParams((p) => ({ ...p, [k]: next }))} />
                </LabField>
              ))}
            </div>
            <p>{selectedBot?.description ?? "Templates load from Bot OS. You can still type a custom GMX bot type and params."}</p>
            <p>{botStatus}</p>
            <p>{botBacktestStatus}</p>
          </div>
          <div className="nx-lab-card">
            <div className={`nx-compat ${botCompat.tone}`}><b>{botCompat.label}</b><span>{botCompat.detail}</span></div>
            <span className="nx-lab-metric">Risk Score <b>{metric(cockpit?.risk_score)}</b></span>
            <span className="nx-lab-metric">Risk Class <b>{cockpit?.risk_class ?? "--"}</b></span>
            <span className="nx-lab-metric">Bot Return <b>{metric(botPerf?.total_return, true)}</b></span>
            <span className="nx-lab-metric">Bot Sharpe <b>{metric(botPerf?.sharpe)}</b></span>
            <MiniCurve values={botBacktestResult?.equity_curve} />
            <div className="nx-lab-table compact">{(cockpit?.hard_blocks ?? ["No cockpit run yet"]).map((b) => <div key={b}><b>block</b><span>{b}</span></div>)}</div>
            <button className="nx-lab-detail-btn" disabled={!botBacktestResult} onClick={() => setReportTarget("bot")}>View Detailed Backtest →</button>
            <button className="nx-lab-primary" disabled={!botBacktestResult || botCompat.tone === "bad"} onClick={armLiveFromBot}>Open Live Ticket</button>
          </div>
        </div>
      ) : null}

      {active === "portfolio" ? (
        <div className="nx-lab-grid">
          <div className="nx-lab-card wide">
            <div className="nx-lab-card-head"><span>Portfolio Legs</span><div><button onClick={validatePortfolio}>Validate</button><button disabled={portfolioRunning} onClick={runPortfolio}>{portfolioRunning ? "Running" : "Run"}</button></div></div>
            <div className="nx-lab-form two">
              <LabField label="weighting"><PickerTrigger title="weighting" value={scheme.replace(/_/g, " ")} detail="Open allocation method guide" onClick={() => setChoicePicker("scheme")} /></LabField>
              <div className="nx-lab-weight">Weight sum <b>{totalWeight.toFixed(2)}</b></div>
            </div>
            <div className="nx-lab-leg-table">
              {legs.map((leg, i) => (
                <div key={`${leg.symbol}-${i}`}>
                  <PickerTrigger title="leg symbol" value={leg.symbol} detail={leg.asset_class === "equity" ? "Robinhood stock" : "GMX market"} icon={<TokenIcon symbol={leg.symbol} kind={leg.asset_class} size={20} />} onClick={() => setSymbolPickerTarget({ kind: "portfolioLeg", index: i })} />
                  <select value={leg.asset_class} onChange={(e) => { const ac = e.target.value as "crypto" | "equity"; updateLeg(i, { asset_class: ac, category: ac === "equity" ? "spot" : "linear", leverage: ac === "equity" ? 1 : leg.leverage, allow_short: ac === "equity" ? false : leg.allow_short, strategy_id: ac === "equity" ? "hold" : strategyId, bot_type: ac === "equity" ? "stock_hold" : "gmx_trend_perp" }); }}><option value="crypto">GMX crypto</option><option value="equity">Robinhood stock</option></select>
                  <select value={leg.strategy_id} onChange={(e) => updateLeg(i, { strategy_id: e.target.value, bot_type: leg.asset_class === "equity" ? "stock_hold" : `gmx_${e.target.value}` })}>
                    {leg.asset_class === "equity" ? <option value="hold">Stock hold</option> : null}
                    {strategies.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
                  </select>
                  <input type="number" step="0.01" min="0" max="1" value={leg.target_weight} onChange={(e) => updateLeg(i, { target_weight: Number(e.target.value) })} />
                  <input type="number" min="1" value={leg.leverage} disabled={leg.asset_class === "equity"} onChange={(e) => updateLeg(i, { leverage: Number(e.target.value) })} />
                  <button onClick={() => setLegs((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
                </div>
              ))}
            </div>
            <button className="nx-lab-ghost" onClick={() => setLegs((p) => [...p, { symbol: "AMZN", asset_class: "equity", category: "spot", target_weight: 0.1, leverage: 1, allow_short: false, strategy_id: "hold", bot_type: "stock_hold" }])}>Add Leg</button>
            <p>{portfolioStatus}</p>
          </div>
          <div className="nx-lab-card">
            <span className="nx-lab-metric">Return <b>{metric(portfolioMetrics?.total_return, true)}</b></span>
            <span className="nx-lab-metric">Sharpe <b>{metric(portfolioMetrics?.sharpe)}</b></span>
            <span className="nx-lab-metric">Rebalances <b>{portfolioResult?.rebalances ?? "--"}</b></span>
            <MiniCurve values={portfolioResult?.equity_curve} />
          </div>
        </div>
      ) : null}

      {active === "optimizer" ? (
        <div className="nx-lab-grid">
          <div className="nx-lab-card">
            <div className="nx-lab-card-head"><span>Param Sweep</span><button disabled={optimizerRunning} onClick={runOptimizer}>{optimizerRunning ? "Running" : "Run Optimizer"}</button></div>
            <div className="nx-lab-form two"><LabField label="method"><PickerTrigger title="method" value={method} detail="Open sweep method guide" onClick={() => setChoicePicker("method")} /></LabField><LabField label="top n"><input value={topN} onChange={(e) => setTopN(e.target.value)} /></LabField></div>
            {axes.map((axis, i) => <div className="nx-lab-axis" key={i}><input value={axis.name} onChange={(e) => setAxes((p) => p.map((a, idx) => idx === i ? { ...a, name: e.target.value } : a))} /><input value={axis.min} onChange={(e) => setAxes((p) => p.map((a, idx) => idx === i ? { ...a, min: e.target.value } : a))} /><input value={axis.max} onChange={(e) => setAxes((p) => p.map((a, idx) => idx === i ? { ...a, max: e.target.value } : a))} /><input value={axis.step} onChange={(e) => setAxes((p) => p.map((a, idx) => idx === i ? { ...a, step: e.target.value } : a))} /></div>)}
            <button className="nx-lab-ghost" onClick={() => setAxes((p) => [...p, { name: "param", min: "0", max: "1", step: "1" }])}>Add Axis</button>
            <p>{optimizerStatus}</p>
          </div>
          <div className="nx-lab-card wide">
            <div className="nx-lab-table">{optimizerCandidates.length ? optimizerCandidates.map((c, i) => {
              const vm = c.vector_metrics_json ?? c.vector_metrics ?? {};
              return <div key={i}><b>#{c.candidate_rank ?? i + 1}</b><span>{metric(vm.total_return, true)} return</span><em>{JSON.stringify(c.params_json ?? c.params ?? {})}</em></div>;
            }) : <div><b>No candidates</b><span>Run optimizer</span><em>Results will show here.</em></div>}</div>
          </div>
        </div>
      ) : null}

      {active === "paper" ? (
        <div className="nx-lab-grid live">
          <div className="nx-lab-card wide">
            <div className="nx-lab-card-head"><span>GMX Live Ticket</span><div><button disabled={liveBusy} onClick={prepareLiveTicket}>Prepare</button><button disabled={liveBusy || liveConfirm !== "LAUNCH_GMX_MAINNET"} onClick={launchLiveTicket}>Broadcast</button></div></div>
            <div className="nx-live-ribbon">
              <span>Arbitrum One</span>
              <span>GMX v2 express</span>
              <span>USDC collateral</span>
              <span>Mainnet gated</span>
            </div>
            <div className="nx-lab-form three">
              <LabField label="symbol"><PickerTrigger title="symbol" value={liveSymbol} detail="Search GMX markets" icon={<TokenIcon symbol={liveSymbol} kind="crypto" size={22} />} onClick={() => setSymbolPickerTarget({ kind: "liveSymbol" })} /></LabField>
              <LabField label="strategy"><select value={liveStrategyId} onChange={(e) => setLiveStrategyId(e.target.value)}>{strategies.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}</select></LabField>
              <LabField label="bot"><input value={liveBotType} onChange={(e) => setLiveBotType(e.target.value)} /></LabField>
              <LabField label="side"><select value={liveDirection} onChange={(e) => setLiveDirection(e.target.value as GmxDirection)}><option value="long">Long</option><option value="short">Short</option></select></LabField>
              <LabField label="order"><select value={liveOrderType} onChange={(e) => setLiveOrderType(e.target.value as GmxOrderType)}><option value="market">Market</option><option value="limit">Limit</option></select></LabField>
              <LabField label="collateral"><input type="number" value={liveCollateralUsd} onChange={(e) => setLiveCollateralUsd(e.target.value)} /></LabField>
              <LabField label="leverage"><input type="number" step="0.1" value={liveLeverage} onChange={(e) => setLiveLeverage(e.target.value)} /></LabField>
              <LabField label="slippage bps"><input type="number" value={liveSlippageBps} onChange={(e) => setLiveSlippageBps(e.target.value)} /></LabField>
              <LabField label="limit trigger"><input type="number" disabled={liveOrderType !== "limit"} value={liveTriggerPriceUsd} onChange={(e) => setLiveTriggerPriceUsd(e.target.value)} /></LabField>
            </div>
            <div className="nx-live-ticket">
              <div><span>Size</span><b>{fmtUsdSmall(livePrepare?.ticket?.sizeUsd ?? Number(liveCollateralUsd) * Number(liveLeverage || 0))}</b></div>
              <div><span>Policy</span><b>{gmxPolicyText(livePrepare?.policy)}</b></div>
              <div><span>Request</span><b>{liveLaunch?.requestId ?? "--"}</b></div>
              <div><span>Status</span><b>{liveLaunch?.status ?? (livePrepare?.ticket ? "prepared" : "draft")}</b></div>
            </div>
            <p>{liveStatus}</p>
            <div className="nx-live-confirm">
              <span>Type LAUNCH_GMX_MAINNET to broadcast. GMX live is not testnet; testnet actions remain on Robinhood Chain / Arbitrum Sepolia.</span>
              <input value={liveConfirm} onChange={(e) => setLiveConfirm(e.target.value)} placeholder="LAUNCH_GMX_MAINNET" />
            </div>
          </div>
          <div className="nx-lab-card">
            <div className="nx-lab-card-head"><span>Prepared Request</span><button onClick={() => onRun(`Review this GMX live ticket and explain the risks before launch: ${JSON.stringify(livePrepare?.ticket ?? livePayload()).slice(0, 1200)}`)}>Ask Nexa</button></div>
            <pre className="nx-live-code">{livePrepare?.ticket ? JSON.stringify(livePrepare.ticket, null, 2) : "No prepared ticket yet."}</pre>
          </div>
          <div className="nx-lab-card wide">
            <div className="nx-lab-card-head"><span>Monitor Current Strategies / Bots</span><button disabled={liveBusy} onClick={() => void refreshLiveAccount()}>Refresh Account</button></div>
            <div className="nx-lab-form two">
              <LabField label="GMX account"><input value={liveMonitorAddress} onChange={(e) => setLiveMonitorAddress(e.target.value)} placeholder="0x..." /></LabField>
              <div className="nx-live-stats">
                <span>positions <b>{accountCount(liveAccount?.positions)}</b></span>
                <span>orders <b>{accountCount(liveAccount?.orders)}</b></span>
                <span>trades <b>{accountCount(liveAccount?.trades)}</b></span>
              </div>
            </div>
            <div className="nx-live-order-grid">
              {liveOrders.length ? liveOrders.slice(0, 6).map((o) => (
                <div key={o.id} className="nx-live-order">
                  <b>{o.symbol ?? "GMX"}</b>
                  <span>{o.strategy_id ?? "strategy"} · {o.bot_type ?? "manual"} · {o.status ?? "submitted"}</span>
                  <em>{fmtUsdSmall(o.size_usd)} · {o.direction ?? "--"} · {o.request_id ?? "no request id"}</em>
                  <button disabled={liveBusy} onClick={() => void stopLiveOrder(o)}>Close position</button>
                </div>
              )) : <div className="nx-live-order empty">No GMX live launches recorded for this owner yet.</div>}
            </div>
          </div>
          <div className="nx-lab-card">
            <div className="nx-lab-card-head"><span>Close & Collateral Return</span><button disabled={liveBusy} onClick={() => void stopLiveOrder()}>Close latest</button></div>
            <p>Stopping must submit a real GMX decrease/close order so collateral returns to the GMX account wallet. The backend refuses to fake this until the close adapter is verified.</p>
            <pre className="nx-live-code small">{liveStopResult ? JSON.stringify(liveStopResult, null, 2) : liveAccount ? JSON.stringify(liveAccount, null, 2).slice(0, 2200) : "Refresh a GMX account to inspect positions, orders, trades and balances."}</pre>
          </div>
        </div>
      ) : null}

      {active === "runs" ? (
        <div className="nx-lab-grid">
          <div className="nx-lab-card wide">
            <div className="nx-lab-card-head"><span>Run Review</span><button onClick={() => onRun(current.prompt)}>Ask Nexa</button></div>
            <p>Recent direct-run outputs stay in each lab tab. Ask Nexa to summarize evidence and next parameter changes.</p>
            <div className="nx-quants-grid">
              <div className="nx-quants-card"><span>Strategy</span><strong>{strategyPerf ? metric(strategyPerf.total_return, true) : "--"}</strong><em>{strategyStatus}</em></div>
              <div className="nx-quants-card"><span>Bot</span><strong>{cockpit?.risk_class ?? "--"}</strong><em>{botStatus}</em></div>
              <div className="nx-quants-card"><span>Portfolio</span><strong>{portfolioResult?.rebalances ?? "--"}</strong><em>{portfolioStatus}</em></div>
            </div>
          </div>
        </div>
      ) : null}

      {strategyPickerOpen ? (
        <StrategyPickerModal
          strategies={strategies}
          currentId={strategyId}
          onPick={(id) => { setStrategyId(id); setStrategyParams({}); }}
          onClose={() => setStrategyPickerOpen(false)}
        />
      ) : null}
      {choicePicker ? (
        <ChoicePickerModal
          title={choicePicker === "category" ? "Market Category" : choicePicker === "interval" ? "Candle Timeframe" : choicePicker === "method" ? "Optimizer Method" : "Weighting Scheme"}
          choices={choiceChoices}
          current={currentChoiceValue(choicePicker)}
          onPick={(value) => applyChoice(choicePicker, value)}
          onClose={() => setChoicePicker(null)}
        />
      ) : null}
      {reportTarget === "strategy" && strategyResult ? (
        <BacktestReportModal result={strategyResult} title={`${selectedStrategy?.name || strategyId} · ${strategySymbol}`} startEquity={Number(strategyEquity) || 10000} onClose={() => setReportTarget(null)} />
      ) : null}
      {reportTarget === "bot" && botBacktestResult ? (
        <BacktestReportModal result={botBacktestResult} title={`${botName || botType} · ${botType}`} startEquity={10000} onClose={() => setReportTarget(null)} />
      ) : null}
      {symbolPickerTarget ? (
        <SymbolPickerModal
          options={symbolPickerTarget.kind === "portfolioLeg" || symbolPickerTarget.kind === "botParam" ? symbolOptions : gmxAssets}
          targetLabel={symbolPickerTarget.kind === "strategy" ? "Strategy symbol" : symbolPickerTarget.kind === "liveSymbol" ? "Live ticket symbol" : symbolPickerTarget.kind === "botParam" ? symbolPickerTarget.key : `Portfolio leg ${symbolPickerTarget.index + 1}`}
          onPick={applySymbol}
          onClose={() => setSymbolPickerTarget(null)}
        />
      ) : null}
    </div>
  );
}

type LiveTab = "running" | "account" | "risk";

function LiveTradingPanel({ draft, onRun, userWallet, agentWallet }: { draft: LiveDraft | null; onRun: (prompt: string) => void; userWallet?: string; agentWallet?: string }) {
  const [tab, setTab] = useState<LiveTab>("running");
  const [policy, setPolicy] = useState<GmxPolicy | undefined>();
  const [status, setStatus] = useState("Live trading monitor ready. GMX broadcasts are mainnet-gated.");
  const [orders, setOrders] = useState<GmxLiveOrder[]>([]);
  const [accountAddress, setAccountAddress] = useState("");
  const [account, setAccount] = useState<GmxAccountResponse | null>(null);
  const [stopResult, setStopResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  // The two inspectable accounts. The GMX agent wallet (where positions/collateral live) is taken
  // from a recorded launch when present, else the known agent wallet address; the user's Privy
  // wallet is the second account.
  const agentAddr = useMemo(() => orders.find((o) => o.account)?.account ?? agentWallet ?? "", [orders, agentWallet]);

  const refreshOrders = useCallback(async () => {
    const r = await netrunnersGet<{ orders?: GmxLiveOrder[]; policy?: GmxPolicy }>("/api/gmx/live/sessions");
    setOrders(r?.orders ?? []);
    if (r?.policy) setPolicy(r.policy);
    if (r?.policy?.errors?.length) setStatus(gmxPolicyText(r.policy));
  }, []);

  const refreshAccount = useCallback(async (address: string) => {
    const target = address.trim();
    if (!target) {
      setStatus("Select the agent or your wallet, or paste a GMX address.");
      return;
    }
    setBusy(true);
    setStatus(`Reading GMX account ${shortAddr(target)}...`);
    const state = await netrunnersGet<GmxAccountResponse>(`/api/gmx/live/account?address=${encodeURIComponent(target)}`);
    setAccount(state ?? { error: "GMX account endpoint unreachable" });
    setStatus(state?.error ? `Account read failed: ${state.error}` : "GMX account monitor refreshed.");
    setBusy(false);
  }, []);

  function selectWallet(addr?: string) {
    if (!addr) return;
    setAccountAddress(addr);
    void refreshAccount(addr);
  }

  useEffect(() => { void refreshOrders(); }, [refreshOrders]);

  // Pre-fill the Account tab with the agent wallet (positions live there); fall back to the user's
  // Privy wallet, so both accounts are ready without manual entry.
  useEffect(() => {
    if (accountAddress) return;
    const def = agentAddr || userWallet;
    if (def) setAccountAddress(def);
  }, [accountAddress, agentAddr, userWallet]);

  useEffect(() => {
    if (!draft) return;
    setStopResult(null);
    setStatus(`Loaded ${draft.source === "bot-os" ? "Bot OS" : "Strategy Lab"} ${draft.symbol ?? "draft"} — monitor exposure and close from here.`);
    setTab("running");
  }, [draft]);

  async function stopLiveOrder(order?: GmxLiveOrder) {
    const target = order ?? orders[0];
    const requestId = target?.request_id;
    if (!requestId) {
      setStatus("No live order to close.");
      return;
    }
    setBusy(true);
    setStatus("Submitting GMX close (decrease) order...");
    const r = await netrunnersPostResult<{ ok?: boolean; requestId?: string; status?: string; error?: string; policy?: GmxPolicy }, Record<string, unknown>>("/api/gmx/live/stop", {
      requestId,
      orderId: target?.id,
      confirm: "STOP_GMX_MAINNET",
    });
    const data = r.data ?? { ok: false, error: `HTTP ${r.status}` };
    setStopResult(data);
    setTab("risk");
    if (data.ok && data.requestId) {
      setStatus(`Close submitted · request ${data.requestId}. Polling status...`);
      const status = await pollGmxOrderStatus(data.requestId);
      await refreshOrders();
      if (accountAddress) await refreshAccount(accountAddress);
      setStatus(`Close ${status} · collateral returns to the GMX account wallet once executed.`);
    } else {
      setStatus(`Close blocked: ${data.error ?? gmxPolicyText(data.policy)}`);
    }
    setBusy(false);
  }

  const gateOk = policy?.canSubmit === true;
  const positionsN = accountCount(account?.positions);
  const ordersN = accountCount(account?.orders);
  const tradesN = accountCount(account?.trades);
  const lastRequest = orders[0]?.request_id ?? "";

  return (
    <div className="nx-quants-panel nx-lt">
      <div className="nx-lt-top">
        <div className="nx-lt-headline">
          <div className="nx-quants-eyebrow"><b /> Copilot · Live Trading</div>
          <h2 className="nx-lt-title">GMX Live</h2>
          <p className="nx-lt-sub">Broadcast tested Strategy Lab and Bot OS drafts onto GMX v2, monitor open exposure in real time, and close positions back to your wallet — all from one Copilot surface.</p>
        </div>
        <div className={`nx-lt-gate ${gateOk ? "ok" : "gated"}`}>
          <span className="nx-lt-gate-dot" />
          <div>
            <b>{gateOk ? "Submit enabled" : "Mainnet gated"}</b>
            <em>{gmxPolicyText(policy)}</em>
          </div>
        </div>
      </div>

      <div className="nx-lt-ribbon">
        <span><i />Arbitrum One</span>
        <span><i />GMX v2 express</span>
        <span><i />USDC collateral</span>
        <span className={gateOk ? "" : "warn"}><i />{gateOk ? "Real trader live" : "Mainnet gated"}</span>
      </div>

      <div className="nx-lt-kpis">
        <div className="nx-lt-kpi"><span>Recorded launches</span><b>{orders.length}</b></div>
        <div className="nx-lt-kpi"><span>Open positions</span><b>{positionsN}</b></div>
        <div className="nx-lt-kpi"><span>Pending orders</span><b>{ordersN}</b></div>
        <div className="nx-lt-kpi"><span>Last request</span><b className="mono">{lastRequest ? shortAddr(lastRequest) : "—"}</b></div>
        <div className="nx-lt-kpi"><span>Policy errors</span><b className={policy?.errors?.length ? "warn" : ""}>{policy?.errors?.length ?? 0}</b></div>
      </div>

      <div className="nx-quants-tabs nx-lt-tabs">
        {[
          ["running", "Running"],
          ["account", "Account"],
          ["risk", "Risk & Stops"],
        ].map(([id, label]) => <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id as LiveTab)}>{label}</button>)}
      </div>

      {tab === "running" ? (
        <div className="nx-lt-body">
          <div className="nx-lt-main">
            <div className="nx-lt-card">
              <div className="nx-lt-card-head"><span>Live strategies &amp; bots</span><button className="nx-lt-ghost" disabled={busy} onClick={() => void refreshOrders()}>Refresh</button></div>
              <div className="nx-lt-orders">
                {orders.length ? orders.map((o) => {
                  const side = String(o.direction ?? "long").toLowerCase() === "short" ? "short" : "long";
                  return (
                    <article key={o.id} className="nx-lt-order">
                      <header>
                        <div className="nx-lt-order-id">
                          <b>{o.symbol ?? "GMX"}</b>
                          <span className={`nx-lt-side ${side}`}>{side}</span>
                        </div>
                        <span className={`nx-lt-pill ${livePillTone(o.status)}`}>{o.status ?? "submitted"}</span>
                      </header>
                      <div className="nx-lt-order-metrics">
                        <div><span>Size</span><b>{fmtUsdSmall(o.size_usd)}</b></div>
                        <div><span>Collateral</span><b>{fmtUsdSmall(o.collateral_usd)}</b></div>
                        <div><span>Leverage</span><b>{o.leverage ? `${o.leverage}×` : "—"}</b></div>
                        <div><span>Logic</span><b>{o.strategy_id ?? o.bot_type ?? "manual"}</b></div>
                      </div>
                      <footer>
                        <span>{o.account ? shortAddr(o.account) : "no account"} · {o.created_at ? new Date(o.created_at).toLocaleString() : "no timestamp"}</span>
                        <div className="nx-lt-order-actions">
                          <button className="nx-lt-ghost" disabled={!o.account || busy} onClick={() => { if (o.account) { setAccountAddress(o.account); setTab("account"); void refreshAccount(o.account); } }}>Inspect</button>
                          <button className="nx-lt-danger" disabled={busy} onClick={() => void stopLiveOrder(o)}>Close</button>
                        </div>
                      </footer>
                    </article>
                  );
                }) : (
                  <div className="nx-lt-empty">
                    <b>No live launches yet</b>
                    <span>Broadcast a tested strategy or bot from Quants Lab — your GMX launches appear here to monitor and close.</span>
                    <button className="nx-lt-ghost" onClick={() => setTab("account")}>Inspect account</button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <aside className="nx-lt-side-col">
            <div className="nx-lt-card">
              <div className="nx-lt-card-head"><span>Monitor</span><button className="nx-lt-ghost" onClick={() => onRun("Review my current GMX live trading ledger, account risk, stop semantics and missing execution gates.")}>Ask Nexa</button></div>
              <p className="nx-lt-status"><i className={busy ? "spin" : ""} />{status}</p>
              <div className="nx-lt-mini-stats">
                <span>positions <b>{positionsN}</b></span>
                <span>orders <b>{ordersN}</b></span>
                <span>trades <b>{tradesN}</b></span>
              </div>
              <pre className="nx-live-code small">{shortJson(account?.positions ?? account?.orders, "Open the Account tab to load detailed GMX positions, orders, trades and balances.")}</pre>
            </div>
          </aside>
        </div>
      ) : null}

      {tab === "account" ? (
        <div className="nx-lt-body">
          <div className="nx-lt-main">
            <div className="nx-lt-card">
              <div className="nx-lt-card-head"><span>GMX account</span><button className="nx-lt-ghost" disabled={busy || !accountAddress} onClick={() => void refreshAccount(accountAddress)}>Refresh account</button></div>
              <div className="nx-lt-wallets">
                <button className={`nx-lt-wallet ${accountAddress === agentAddr && agentAddr ? "on" : ""}`} disabled={!agentAddr} onClick={() => selectWallet(agentAddr)}>
                  <span>Agent wallet</span>
                  <b>{agentAddr ? shortAddr(agentAddr) : "pending"}</b>
                  <em>Places GMX trades · holds collateral</em>
                </button>
                <button className={`nx-lt-wallet ${accountAddress === userWallet && userWallet ? "on" : ""}`} disabled={!userWallet} onClick={() => selectWallet(userWallet)}>
                  <span>My wallet</span>
                  <b>{userWallet ? shortAddr(userWallet) : "not linked"}</b>
                  <em>Privy-linked user wallet</em>
                </button>
              </div>
              <div className="nx-lt-account-bar">
                <LabField label="account address"><input value={accountAddress} onChange={(e) => setAccountAddress(e.target.value)} placeholder="0x…" /></LabField>
                <div className="nx-lt-mini-stats">
                  <span>positions <b>{positionsN}</b></span>
                  <span>orders <b>{ordersN}</b></span>
                  <span>trades <b>{tradesN}</b></span>
                </div>
              </div>
              <div className="nx-lt-account-grid">
                <div className="nx-lt-detail"><b>Positions</b><span>Open perp exposures from the GMX account reader.</span><pre className="nx-live-code small">{shortJson(account?.positions, "No positions loaded.")}</pre></div>
                <div className="nx-lt-detail"><b>Orders</b><span>Pending / in-flight GMX orders.</span><pre className="nx-live-code small">{shortJson(account?.orders, "No orders loaded.")}</pre></div>
                <div className="nx-lt-detail"><b>Trades</b><span>Recent fills when available.</span><pre className="nx-live-code small">{shortJson(account?.trades, "No trades loaded.")}</pre></div>
                <div className="nx-lt-detail"><b>Balances</b><span>Wallet / collateral balances.</span><pre className="nx-live-code small">{shortJson(account?.balances, "No balances loaded.")}</pre></div>
              </div>
            </div>
          </div>
          <aside className="nx-lt-side-col">
            <div className="nx-lt-card">
              <div className="nx-lt-card-head"><span>Account health</span><button className="nx-lt-ghost" onClick={() => onRun(`Analyze this GMX account state for liquidation, exposure and bot risks: ${JSON.stringify(account ?? {}).slice(0, 1600)}`)}>Ask Nexa</button></div>
              <p className="nx-lt-status"><i className={busy ? "spin" : ""} />{account?.error ? `Account error: ${account.error}` : status}</p>
              <pre className="nx-live-code small">{shortJson(account, "Refresh an address to inspect the full account payload.")}</pre>
            </div>
          </aside>
        </div>
      ) : null}

      {tab === "risk" ? (
        <div className="nx-lt-body">
          <div className="nx-lt-main">
            <div className="nx-lt-card">
              <div className="nx-lt-card-head"><span>Risk gates</span><button className="nx-lt-ghost" onClick={() => onRun("Explain the GMX live trading risk gates, required env vars, stop semantics and which bot types are allowed.")}>Ask Nexa</button></div>
              <div className="nx-lt-gaterow">
                <div className={`nx-lt-gatecell ${policy?.canPrepare === false ? "bad" : "ok"}`}><span>Prepare</span><b>{policy?.canPrepare === false ? "Blocked" : "Allowed"}</b></div>
                <div className={`nx-lt-gatecell ${policy?.canSubmit ? "ok" : "bad"}`}><span>Submit</span><b>{policy?.canSubmit ? "Enabled" : "Gated"}</b></div>
                <div className={`nx-lt-gatecell ${policy?.errors?.length ? "bad" : "ok"}`}><span>Errors</span><b>{policy?.errors?.length ?? 0}</b></div>
                <div className={`nx-lt-gatecell ${policy?.warnings?.length ? "warn" : "ok"}`}><span>Warnings</span><b>{policy?.warnings?.length ?? 0}</b></div>
              </div>
              <div className="nx-lt-rows">
                {(policy?.errors?.length ? policy.errors : ["No policy errors returned yet."]).map((e) => (
                  <div key={e} className={policy?.errors?.length ? "nx-lt-row error" : "nx-lt-row"}>
                    <span className="nx-lt-row-tag">{policy?.errors?.length ? "error" : "ok"}</span>
                    <div><b>{e}</b><em>{e === "REAL_TRADER_DISABLED" ? "Set DUALITY_ENABLE_REAL_TRADER=true only when ready for mainnet." : e === "AGENT_GMX_PRIVATE_KEY_MISSING" ? "Backend needs AGENT_GMX_PRIVATE_KEY to broadcast." : "Review backend policy before launch."}</em></div>
                  </div>
                ))}
                {(policy?.warnings ?? []).map((w) => (
                  <div key={w} className="nx-lt-row warning">
                    <span className="nx-lt-row-tag">warning</span>
                    <div><b>{w}</b><em>Warning returned by GMX live policy.</em></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <aside className="nx-lt-side-col">
            <div className="nx-lt-card">
              <div className="nx-lt-card-head"><span>Close &amp; collateral return</span><button className="nx-lt-danger" disabled={busy} onClick={() => void stopLiveOrder()}>Close latest</button></div>
              <p className="nx-lt-card-copy">Closing submits a real GMX decrease order so collateral returns to your account wallet as USDC. The latest recorded launch is closed; poll status confirms execution.</p>
              <pre className="nx-live-code small">{stopResult ? JSON.stringify(stopResult, null, 2) : "Close a running order to broadcast a GMX decrease order; collateral returns to the account wallet on execution."}</pre>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function usd(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "--";
}

function tokenAmt(v: unknown, digits = 4): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "--";
}

type LaunchAction = NonNullable<LaunchPlan["actions"]>[number];
type StepStatus = "pending" | "running" | "done" | "failed";
type StepState = { status: StepStatus; explorer?: string | null; error?: string | null };

const CHAIN_LABEL: Record<number, string> = { 46630: "Robinhood Chain", 421614: "Arbitrum Sepolia" };
function chainLabel(id?: number, fallback?: string): string {
  if (id && CHAIN_LABEL[id]) return CHAIN_LABEL[id];
  if (fallback === "arbitrum_sepolia") return "Arbitrum Sepolia";
  if (fallback === "robinhood_testnet") return "Robinhood Chain";
  return id ? `Chain ${id}` : "testnet";
}
function stepTitle(a: LaunchAction): string {
  switch (a.kind) {
    case "bridge": return `Bridge funds → ${a.to === "robinhood_testnet" ? "Robinhood Chain" : "Arbitrum Sepolia"}`;
    case "buy_stock": return `Buy ${a.symbol ?? "stock"} on Robinhood Chain`;
    case "provide_lp": return `Provide ${a.symbol ?? "dWETH/dUSDC"} liquidity`;
    case "swap_hold": return `Swap into ${a.symbol ?? "dWETH"}`;
    default: return String(a.kind ?? "action").replace(/_/g, " ");
  }
}
function stepIcon(kind?: string) {
  if (kind === "bridge") return <path d="M4 8h12l-3-3M20 16H8l3 3" />;
  if (kind === "buy_stock") return <path d="M4 19V5m0 14h16M8 15l3-4 3 2 5-7" />;
  if (kind === "provide_lp") return <path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11Z" />;
  return <path d="M7 7h11l-3-3M17 17H6l3 3" />; // swap
}
function pickExplorer(r: Record<string, unknown>): string | null {
  return (r.explorer as string) ?? (r.releaseExplorer as string) ?? (r.lockExplorer as string)
    ?? (typeof r.tx === "string" ? `https://sepolia.arbiscan.io/tx/${r.tx}` : null) ?? null;
}

function TestnetLaunchModal({
  request,
  onClose,
  onPlanReady,
}: {
  request: LaunchRequest | null;
  onClose: () => void;
  onPlanReady: (plan: LaunchPlan) => void;
}) {
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [stepStates, setStepStates] = useState<Record<string, StepState>>({});
  const [status, setStatus] = useState("Building the testnet execution plan…");
  const onPlanReadyRef = useRef(onPlanReady);
  onPlanReadyRef.current = onPlanReady;

  // One fetch (launch-preview) returns balances + legs + the ordered action plan — so the steps show
  // immediately, no separate "continue" click.
  useEffect(() => {
    if (!request) return;
    let alive = true;
    setBusy(true); setPlan(null); setDone(false); setStepStates({});
    setStatus("Building the testnet execution plan…");
    netrunnersPostResult<LaunchPlan, LaunchRequest>("/api/exec/launch-preview", request).then((r) => {
      if (!alive) return;
      const data = r.data ?? { ok: false, error: `HTTP ${r.status}` };
      setPlan(data);
      onPlanReadyRef.current(data);
      setStatus(data.actions?.length ? "Review the steps below, then execute." : `No executable steps: ${data.error ?? data.detail ?? "nothing to do"}`);
      setBusy(false);
    });
    return () => { alive = false; };
  }, [request]);

  if (!request) return null;

  const actions = plan?.actions ?? [];
  const enabled = plan?.executionEnabled !== false;

  async function executePlan() {
    if (!actions.length) return;
    setBusy(true); setRunning(true);
    setStepStates(Object.fromEntries(actions.map((a) => [a.id ?? "", { status: "running" as StepStatus }])));
    setStatus("Executing on testnet…");
    const r = await netrunnersPostResult<LaunchPlan, LaunchRequest>("/api/exec/launch-plan", request ?? {});
    const data = r.data ?? { ok: false, error: `HTTP ${r.status}` };
    const map: Record<string, StepState> = {};
    for (const res of (data.results ?? [])) {
      const id = (res.action as { id?: string } | undefined)?.id;
      if (!id) continue;
      map[id] = { status: res.ok ? "done" : "failed", explorer: pickExplorer(res), error: res.ok ? null : String((res as { error?: unknown }).error ?? "failed") };
    }
    // Prefer the specific server detail over the generic wrapper code.
    const failMsg = data.detail ?? data.error ?? data.status ?? `HTTP ${r.status}`;
    // Any action with no returned result (e.g. whole-call throw) → failed, showing the real reason.
    for (const a of actions) if (a.id && !map[a.id]) map[a.id] = { status: data.ok ? "pending" : "failed", error: failMsg };
    setStepStates(map);
    setRunning(false); setDone(true); setBusy(false);
    setStatus(data.ok ? `Executed ${data.executed ?? 0}/${data.total ?? actions.length} steps on testnet.` : `Execution blocked: ${failMsg}`);
  }

  const bal = plan?.balances;

  return (
    <div className="nx-launch-back" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="nx-xlaunch" onClick={(e) => e.stopPropagation()}>
        <header className="nx-xlaunch-head">
          <div>
            <span className="nx-pill"><b />Testnet Launch</span>
            <h2>Execute Trading Setup</h2>
            <p>Robinhood Chain testnet + Arbitrum Sepolia only · capped to {usd(plan?.capUsd ?? 20)}. No mainnet, no real funds.</p>
          </div>
          <button className="nx-modal-x" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="nx-xlaunch-summary">
          <div><span>Launch size</span><b>{usd(plan?.executionUsd)}</b></div>
          <div><span>Legs</span><b>{plan?.legs?.length ?? "—"}</b></div>
          <div><span>Steps</span><b>{actions.length || "—"}</b></div>
          <div><span>Execution</span><b className={enabled ? "ok" : "warn"}>{enabled ? "Enabled" : "Preview only"}</b></div>
        </div>

        <section className="nx-xsteps">
          <div className="nx-md-h">Execution steps</div>
          {actions.length ? (
            <div className="nx-xstep-list">
              {actions.map((a, i) => {
                const st = stepStates[a.id ?? ""] ?? { status: "pending" as StepStatus };
                return (
                  <div key={a.id ?? `${a.kind}-${i}`} className={`nx-xstep ${st.status}`}>
                    <span className="nx-xstep-marker">
                      {st.status === "done" ? "✓" : st.status === "failed" ? "✕" : st.status === "running"
                        ? <span className="nx-xstep-spin" />
                        : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{stepIcon(a.kind)}</svg>}
                    </span>
                    <div className="nx-xstep-body">
                      <div className="nx-xstep-title"><b>{stepTitle(a)}</b><span className="nx-xstep-amt">{usd(a.usd)}</span></div>
                      <div className="nx-xstep-sub">{a.from && a.to ? `${chainLabel(undefined, a.from)} → ${chainLabel(undefined, a.to)}` : chainLabel(a.chainId, a.from)} · {a.reason}</div>
                      {st.error ? <div className="nx-xstep-err">{st.error}</div> : null}
                      {st.explorer ? <a className="nx-xstep-link" href={st.explorer} target="_blank" rel="noreferrer">View transaction ↗</a> : null}
                    </div>
                    <span className="nx-xstep-idx">{i + 1}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="nx-xstep-empty">{busy ? "Planning…" : "No executable steps for this basket (GMX legs are blocked until the adapter is wired)."}</div>
          )}
        </section>

        {bal ? (
          <section className="nx-xbal">
            <div className="nx-xbal-col"><span>Robinhood Chain</span><b>{tokenAmt(bal.robinhood?.mockUsdG, 2)} MockUSDG</b><em>{tokenAmt(bal.robinhood?.eth, 4)} ETH gas</em></div>
            <div className="nx-xbal-col"><span>Arbitrum Sepolia</span><b>{tokenAmt(bal.arbitrumSepolia?.dUSDC, 2)} dUSDC</b><em>{tokenAmt(bal.arbitrumSepolia?.eth, 4)} ETH gas</em></div>
            <div className="nx-xbal-col"><span>Agent wallet</span><b>{plan?.agent ? shortAddr(plan.agent) : "—"}</b><em>auto-funded</em></div>
          </section>
        ) : null}

        {plan?.warnings?.length ? <div className="nx-launch-warn">{plan.warnings.map((w) => <span key={w}>{w}</span>)}</div> : null}
        <p className="nx-xstatus">{status}</p>

        <footer className="nx-launch-actions">
          <button onClick={onClose}>{done ? "Done" : "Cancel"}</button>
          <button className="nx-lab-primary" disabled={busy || !enabled || !actions.length || done} onClick={() => void executePlan()}>
            {running ? "Executing…" : done ? "Executed" : `Execute ${actions.length || ""} step${actions.length === 1 ? "" : "s"}`.trim()}
          </button>
        </footer>
      </div>
    </div>
  );
}

// Saved setups: revisit a finalized basket, re-open it to edit, or launch it as a live-paper session.
function SavedSetups({
  refreshKey,
  threads,
  onOpen,
  onLaunch,
  onOpenThread,
}: {
  refreshKey: number;
  threads: ThreadSummary[];
  onOpen: (s: Setup) => void;
  onLaunch: (s: Setup) => void;
  onOpenThread: (id: string) => void;
}) {
  const [setups, setSetups] = useState<Setup[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setLoading(true); const r = await copilotGet<{ setups: Setup[] }>("/setups"); setSetups(r?.setups ?? []); setLoading(false); }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);
  return (
    <div className="nx-saved">
      <h2>Saved setups</h2>
      <div className="nx-saved-sub">Finalized baskets you can re-open to edit, or launch as a live-paper session.</div>
      {loading ? <div className="nx-saved-empty">Loading…</div> : !setups.length ? <div className="nx-saved-empty">No saved setups yet. Build one in the Console and hit “Save setup”.</div> : (
        <div className="nx-saved-grid">
          {setups.map((s) => {
            const spec = s.spec as Record<string, unknown>;
            const legs = (spec.legs as Array<Record<string, unknown>>) ?? [];
            return (
              <div className="nx-saved-card" key={s.id}>
                <h3>{s.name}</h3>
                <div className="nx-saved-meta">${String(spec.budget_usd ?? "—")} · {String(spec.risk ?? "")} · {String(spec.weighting ?? "")}{s.status === "launched" ? " · launched" : ""}</div>
                <div className="nx-saved-legs">{legs.slice(0, 8).map((l, i) => <span key={i}>{String(l.symbol).replace(/USDT$/, "")} {Math.round((Number(l.allocation) || 0) * 100)}%</span>)}</div>
                <div className="nx-saved-actions">
                  <button className="go" onClick={() => onLaunch(s)}>Launch ▶</button>
                  <button onClick={() => onOpen(s)}>Open</button>
                  <button onClick={async () => { await copilotDelete(`/setups/${s.id}`); void load(); }}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="nx-thread-history">
        <h2>Recent chats</h2>
        <div className="nx-saved-sub">Reopen a Copilot thread with its persisted messages and board widgets.</div>
        {!threads.length ? <div className="nx-saved-empty">No previous Copilot threads found yet.</div> : (
          <div className="nx-saved-grid">
            {threads.slice(0, 12).map((t) => (
              <div className="nx-saved-card" key={t.id}>
                <h3>{t.title || "Untitled chat"}</h3>
                <div className="nx-saved-meta">{t.created_at ? new Date(t.created_at).toLocaleString() : t.id}</div>
                <div className="nx-saved-actions">
                  <button className="go" onClick={() => onOpenThread(t.id)}>Open chat</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WalletAuthCompact({ onStatus }: { onStatus: (s: WalletSession) => void }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const label = user?.email?.address ?? user?.wallet?.address ?? null;

  useEffect(() => {
    registerPrivyTokenFetcher(authenticated ? () => getAccessToken() : null);
    return () => registerPrivyTokenFetcher(null);
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    onStatus({ ready, authenticated, label });
  }, [authenticated, label, onStatus, ready]);

  const onLogin = useCallback(async () => {
    await login();
    const token = await getAccessToken();
    setPrivyToken(token ?? null);
  }, [getAccessToken, login]);

  const onLogout = useCallback(async () => {
    try { await netrunnersFetch("/api/netrunners/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    setPrivyToken(null);
    await logout();
  }, [logout]);

  if (!ready) return <span className="nx-wallet-auth-line">Checking session…</span>;
  if (!authenticated) return <button className="nx-wallet-auth-btn" onClick={onLogin}>Connect / sign in</button>;
  return (
    <div className="nx-wallet-auth-compact">
      <span><b>Signed in</b><em>{label ?? "active session"}</em></span>
      <button className="nx-wallet-auth-btn" onClick={onLogout}>Log out</button>
    </div>
  );
}

// Seeded gradient avatar (no dep) for the WalletConnect-style account header.
function identiconStyle(addr: string): { background: string } {
  const s = (addr || "0x000000000000").replace(/^0x/, "").padEnd(12, "0");
  const h = (i: number) => parseInt(s.slice(i, i + 2), 16) || 0;
  return { background: `radial-gradient(circle at 30% 25%, hsl(${h(0) * 1.41} 85% 62%), hsl(${h(2) * 1.41} 75% 48%) 55%, hsl(${h(4) * 1.41} 70% 33%))` };
}
function fmtToken(v?: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 2 : 6 });
}

function WalletDock({
  wallets,
  agentWallet,
  credits,
  session,
  open,
  prompt,
  onOpen,
  onClose,
  onRefresh,
  onSession,
}: {
  wallets: LinkedWallet[];
  agentWallet: AgentWalletInfo | null;
  credits: { managedBalanceUsd: number; status: string } | null;
  session: WalletSession;
  open: boolean;
  prompt: boolean;
  onOpen: () => void;
  onClose: () => void;
  onRefresh: () => void;
  onSession: (s: WalletSession) => void;
}) {
  const [net, setNet] = useState<number>(ARB_SEPOLIA_CHAIN_ID);
  const [copied, setCopied] = useState(false);
  const connected = wallets.length > 0;
  const signedIn = session.authenticated;
  const primary = wallets[0];
  const idAddr = primary?.wallet_address ?? agentWallet?.address ?? "";
  const credit = credits?.managedBalanceUsd ?? 0;
  const creditPct = Math.max(4, Math.min(100, (credit / 25) * 100));
  const cardTitle = connected ? "Wallet linked" : signedIn ? "Signed in · link pending" : "Connect wallet";
  const cardSub = connected
    ? `${shortAddr(primary.wallet_address)} · agent ${agentWallet ? shortAddr(agentWallet.address) : "pending"}`
    : signedIn ? `${session.label ?? "email session"}` : "User wallet + agent wallet";
  const isArb = net === ARB_SEPOLIA_CHAIN_ID;
  const t = agentWallet?.tokens;
  const tokenRows = isArb
    ? [{ sym: "ETH", amt: agentWallet?.ethBalanceArb }, { sym: "dUSDC", amt: t?.arbitrumSepolia?.dUSDC }, { sym: "dWETH", amt: t?.arbitrumSepolia?.dWETH }]
    : [{ sym: "ETH", amt: agentWallet?.ethBalanceRh }, { sym: "MockUSDG", amt: t?.robinhood?.mockUsdG }];
  const totalUsd = isArb ? Number(t?.arbitrumSepolia?.dUSDC ?? 0) : Number(t?.robinhood?.mockUsdG ?? 0);
  const showAccount = signedIn || connected;
  const copyAddr = async () => {
    try { await navigator.clipboard.writeText(idAddr); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* ignore */ }
  };
  return (
    <>
      {PRIVY_ENABLED ? <span className="nx-wallet-session-bridge"><WalletAuthCompact onStatus={onSession} /></span> : null}
      <button className={`nx-wallet-card ${connected ? "on" : ""}`} onClick={onOpen}>
        <span className="nx-wallet-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16v12H4z" /><path d="M16 11h4v4h-4z" /><path d="M6 7V5h11v2" /></svg>
        </span>
        <span className="nx-wallet-copy">
          <b>{cardTitle}</b>
          <em>{cardSub}</em>
        </span>
      </button>
      {(open || prompt) ? (
        <div className="nx-wallet-back" onClick={onClose}>
          <div className="nx-wc-modal" onClick={(e) => e.stopPropagation()}>
            {showAccount ? (
              <>
                <header className="nx-wc-head">
                  <span className="nx-wc-ident" style={identiconStyle(idAddr)} />
                  <div className="nx-wc-id">
                    <b>{idAddr ? shortAddr(idAddr) : (session.label ?? "account")}</b>
                    <em>{connected ? "Execution wallet" : (session.label ?? "email session")}</em>
                  </div>
                  <div className="nx-wc-head-actions">
                    <button className="nx-wc-iconbtn" onClick={() => void copyAddr()} title="Copy address" disabled={!idAddr}>{copied ? "✓" : "⧉"}</button>
                    {idAddr ? <a className="nx-wc-iconbtn" href={explorerUrl(net, idAddr)} target="_blank" rel="noreferrer" title="View on explorer">↗</a> : null}
                    <button className="nx-wc-iconbtn nx-wc-close" onClick={onClose} aria-label="Close">✕</button>
                  </div>
                </header>

                <div className="nx-wc-nets">
                  {[{ id: ARB_SEPOLIA_CHAIN_ID, label: "Arbitrum Sepolia" }, { id: RH_CHAIN_ID, label: "Robinhood Chain" }].map((n) => (
                    <button key={n.id} className={net === n.id ? "on" : ""} onClick={() => setNet(n.id)}><span className="nx-wc-netdot" />{n.label}</button>
                  ))}
                </div>

                <section className="nx-wc-balance">
                  <span className="nx-wc-balance-l">Total balance</span>
                  <span className="nx-wc-balance-v">{fmtUsdSmall(totalUsd)}</span>
                  <div className="nx-wc-tokens">
                    {tokenRows.map((tk) => (
                      <div className="nx-wc-token" key={tk.sym}><span>◇ {tk.sym}</span><b>{fmtToken(tk.amt)}</b></div>
                    ))}
                  </div>
                  {!agentWallet ? <p className="nx-wc-muted">Balances populate once the agent wallet is created.</p> : null}
                </section>

                <section className="nx-wc-agent">
                  <span className="nx-wc-section-h">Agent wallet</span>
                  {agentWallet ? (
                    <a className="nx-wc-row" href={explorerUrl(net, agentWallet.address)} target="_blank" rel="noreferrer">
                      <span>{shortAddr(agentWallet.address)}</span>
                      <b>{isArb ? agentWallet.ethBalanceArb : agentWallet.ethBalanceRh} ETH</b>
                      <em>↗</em>
                    </a>
                  ) : <div className="nx-wc-empty">Pending creation.</div>}
                </section>

                <section className="nx-wc-credit">
                  <div className="nx-wc-credit-head"><span>Copilot credit</span><b>${credit.toFixed(2)} · {credits?.status ?? "—"}</b></div>
                  <div className="nx-credit-bar"><i style={{ width: `${creditPct}%` }} /></div>
                </section>

                <footer className="nx-wc-foot">
                  <button className="nx-wc-refresh" onClick={onRefresh}>Refresh</button>
                  {PRIVY_ENABLED ? <WalletAuthCompact onStatus={onSession} /> : <span className="nx-wc-muted">Login disabled (no Privy app id).</span>}
                </footer>
              </>
            ) : (
              <div className="nx-wc-connect">
                <span className="nx-wc-ident lg" style={identiconStyle("0x5a1f2ea0")} />
                <h2>Connect your wallet</h2>
                <p>Sign in, then link a chain wallet to approve testnet execution. Your account and an auto-funded agent wallet appear here.</p>
                {PRIVY_ENABLED ? <WalletAuthCompact onStatus={onSession} /> : <span className="nx-wc-muted">Privy app id is not set in this build.</span>}
                <button className="nx-wc-close-text" onClick={onClose}>Close</button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

function ChatStepGroups({
  steps,
  expanded,
  onToggle,
  onFocus,
}: {
  steps: ChatStep[];
  expanded: Record<string, boolean>;
  onToggle: (key: string) => void;
  onFocus: (id: string) => void;
}) {
  const groups = PHASE_DEFS.map((phase, i) => ({
    ...phase,
    i,
    items: steps.filter((s) => s.widgetId && s.kind && phaseOf(s.kind as WidgetKind) === i),
  })).filter((g) => g.items.length > 0);
  if (!groups.length) return null;
  return (
    <div className="nx-step-groups" aria-label="Agent widget groups">
      {groups.map((g) => {
        const open = expanded[g.key] === true;
        const running = g.items.some((s) => s.state === "running");
        return (
          <section key={g.key} className={`nx-step-group ${open ? "open" : ""}`}>
            <button className="nx-step-group-head" onClick={() => onToggle(g.key)}>
              <span><b>{g.i + 1}</b>{g.label}</span>
              <em>{g.items.length} widget{g.items.length === 1 ? "" : "s"} · {running ? "running" : "ready"}</em>
            </button>
            {open ? (
              <div className="nx-step-group-list">
                {g.items.map((s) => (
                  <button key={s.id} className={`nx-step-chip clickable ${s.state}`} onClick={() => s.widgetId && onFocus(s.widgetId)}>
                    <span>{s.state}</span>
                    <b>{s.label}</b>
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export default function NexaWorkspace() {
  const [view, setView] = useState<string>("console");
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [widgets, setWidgets] = useState<BoardWidget[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [credits, setCredits] = useState<{ managedBalanceUsd: number; status: string } | null>(null);
  const [chatSteps, setChatSteps] = useState<ChatStep[]>([]);
  const [expandedStepGroups, setExpandedStepGroups] = useState<Record<string, boolean>>({});
  const [focusWidgetId, setFocusWidgetId] = useState<string | null>(null);
  const [wallets, setWallets] = useState<LinkedWallet[]>([]);
  const [agentWallet, setAgentWallet] = useState<AgentWalletInfo | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletPrompt, setWalletPrompt] = useState(false);
  const [walletSession, setWalletSession] = useState<WalletSession>({ ready: !PRIVY_ENABLED, authenticated: false, label: null });
  const [walletChecked, setWalletChecked] = useState(false);
  const [question, setQuestion] = useState<{ id: string; question: string; options: Opt[]; multi: boolean } | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [wizard, setWizard] = useState<{ budget: number; step: number; answers: Record<string, string> } | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const [labTab, setLabTab] = useState<LabTab>("dashboard");
  const [recentThreads, setRecentThreads] = useState<ThreadSummary[]>([]);
  const [hydratingThread, setHydratingThread] = useState(false);
  const [liveDraft, setLiveDraft] = useState<LiveDraft | null>(null);
  const [launchRequest, setLaunchRequest] = useState<LaunchRequest | null>(null);
  const threadId = useRef<string | null>(null);
  const wIdx = useRef(0);
  const abortRef = useRef<null | (() => void)>(null);
  const convoRef = useRef<HTMLDivElement | null>(null);

  const refreshWalletSurface = useCallback(async () => {
    const [w, aw, c] = await Promise.all([
      netrunnersGet<{ wallets: LinkedWallet[] }>("/api/wallets").catch(() => null),
      netrunnersGet<AgentWalletInfo>("/api/exec/agent-wallet").catch(() => null),
      copilotGet<{ managedBalanceUsd: number; status: string }>("/credits").catch(() => null),
    ]);
    setWallets(w?.wallets ?? []);
    if (aw) setAgentWallet(aw);
    if (c) setCredits(c);
    setWalletChecked(true);
  }, []);

  useEffect(() => { void refreshWalletSurface(); }, [refreshWalletSurface]);
  useEffect(() => {
    if (walletChecked && wallets.length === 0) setWalletPrompt(true);
  }, [walletChecked, wallets.length]);
  useEffect(() => { convoRef.current?.scrollTo({ top: convoRef.current.scrollHeight, behavior: "smooth" }); }, [messages, status, chatSteps]);

  const focusWidget = useCallback((id: string) => {
    setView("console");
    setStarted(true);
    setFocusWidgetId(null);
    window.setTimeout(() => setFocusWidgetId(id), 0);
  }, []);

  const toggleStepGroup = useCallback((key: string) => {
    setExpandedStepGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const recordStep = useCallback((step: ChatStep) => {
    setChatSteps((prev) => {
      const next = prev.filter((s) => s.id !== step.id);
      next.push(step);
      return next.slice(-80);
    });
  }, []);

  const moveWidget = useCallback((id: string, x: number, y: number) => {
    setWidgets((prev) => prev.map((w) => (w.id === id ? { ...w, x, y } : w)));
  }, []);

  // Upsert a board widget by id (explicit "widget" SSE events carry kind/title/state/data).
  const upsertWidget = useCallback((w: { id: string; kind: WidgetKind; title: string; state: "running" | "done" | "error"; rationale?: string; data?: Record<string, unknown> }) => {
    setWidgets((prev) => {
      const idx = prev.findIndex((x) => x.id === w.id);
      if (idx >= 0) {
        const copy = [...prev];
        // A fresh agent event owns the whole payload. Merging kept stale fields between repeated runs
        // when widgets reused ids (for example ma-data/ma-summary), which made the board look fixed.
        copy[idx] = { ...copy[idx], kind: w.kind, title: w.title, state: w.state, rationale: w.rationale ?? copy[idx].rationale, data: { ...(w.data ?? {}), _dirty: false } };
        return copy;
      }
      const i = wIdx.current++;
      // Compact 3-column grid so widgets spawn next to each other (not strung far down the canvas).
      const COLS = 3, CW = 272, CH = 212;
      return [...prev, { id: w.id, kind: w.kind, title: w.title, state: w.state, rationale: w.rationale, data: { ...(w.data ?? {}), _dirty: false }, x: 40 + (i % COLS) * CW, y: 36 + Math.floor(i / COLS) * CH }];
    });
  }, []);

  // Edit a basket leg: allocation (auto-rebalance the UNLOCKED legs to 100%), bot type, or lock toggle.
  const editAllocation = useCallback((widgetId: string, symbol: string, patch: { allocation?: number; bot?: string; locked?: boolean }) => {
    setWidgets((prev) => prev.map((w) => {
      if (w.id !== widgetId || w.kind !== "basket") return w;
      const legs = ((w.data?.legs as Array<Record<string, unknown>>) ?? []).map((l) => ({ ...l }));
      const i = legs.findIndex((l) => l.symbol === symbol);
      if (i < 0) return w;
      if (patch.bot !== undefined) legs[i].bot = patch.bot;
      if (patch.locked !== undefined) legs[i].locked = patch.locked;
      if (patch.allocation !== undefined) {
        const v = Math.max(0, Math.min(1, patch.allocation));
        const lockedSum = legs.reduce((s, l, j) => (j !== i && l.locked ? s + (Number(l.allocation) || 0) : s), 0);
        const room = Math.max(0, 1 - lockedSum); // capital available to the edited + unlocked legs
        const vClamped = Math.min(v, room);
        const unlockedSum = legs.reduce((s, l, j) => (j !== i && !l.locked ? s + (Number(l.allocation) || 0) : s), 0) || 1;
        const remaining = room - vClamped;
        legs.forEach((l, j) => { if (j === i) l.allocation = vClamped; else if (!l.locked) l.allocation = remaining * ((Number(l.allocation) || 0) / unlockedSum); });
      }
      return { ...w, data: { ...w.data, legs, _dirty: true } };
    }));
  }, []);

  const dirtyBasket = widgets.find((w) => w.kind === "basket" && (w.data as Record<string, unknown>)?._dirty);

  // The basket to execute. PREFER the final 3-sleeve basket (id "basket": GMX + LP + Robinhood stocks)
  // over the earlier "ma-basket" crypto-candidate widget — otherwise launch sees only crypto swap legs
  // and drops the LP/stock steps. Fall back to the most recent basket-with-legs.
  const executableBasket = useMemo(() => {
    const hasLegs = (w: BoardWidget) => Array.isArray((w.data as Record<string, unknown>)?.legs) && ((w.data as Record<string, unknown>).legs as unknown[]).length > 0;
    const final = widgets.find((w) => w.id === "basket" && hasLegs(w));
    return final ?? [...widgets].reverse().find((w) => w.kind === "basket" && hasLegs(w));
  }, [widgets]);

  const buildLaunchRequest = useCallback((text: string): LaunchRequest => {
    const basket = executableBasket;
    const data = (basket?.data ?? {}) as Record<string, unknown>;
    const rawLegs = Array.isArray(data.legs) ? data.legs as Array<Record<string, unknown>> : [];
    const legs: LaunchLeg[] = rawLegs.map((l) => ({
      symbol: String(l.symbol ?? ""),
      allocation: Number(l.allocation ?? l.weight ?? l.target_weight ?? 0),
      sleeve: String(l.sleeve ?? ""),
      asset_class: String(l.asset_class ?? ""),
      category: String(l.category ?? ""),
      venue: String(l.venue ?? ""),
      bot: l.bot ? String(l.bot) : undefined,
      bot_type: l.bot_type ? String(l.bot_type) : undefined,
    })).filter((l) => l.symbol);
    const requestedUsd = amountFromText(text) ?? Number(data.budget_usd ?? data.depositUsd ?? 20);
    return { requestedUsd, depositUsd: requestedUsd, text, legs };
  }, [executableBasket]);

  const handleEvent = useCallback((ev: CopilotEvent) => {
    const d = ev.data ?? {};
    if (ev.event === "widget" && typeof d.id === "string") {
      const id = d.id as string;
      const kind = (d.kind as WidgetKind) ?? "think";
      const title = String(d.title ?? "Step");
      const state = (d.state as "running" | "done" | "error") ?? "done";
      upsertWidget({ id, kind, title, state, rationale: d.rationale as string | undefined, data: (d.data as Record<string, unknown>) ?? {} });
      recordStep({ id, label: title, state, widgetId: id, kind });
    } else if (ev.event === "question" && typeof d.id === "string") {
      const opts: Opt[] = (Array.isArray(d.options) ? d.options : []).map((o) => (typeof o === "string" ? { label: o } : (o as Opt)));
      setQuestion({ id: d.id as string, question: String(d.question ?? ""), options: opts, multi: d.multi === true });
      setPicks([]); setStatus(null); setBusy(false);
    } else if (ev.event === "truth_card") {
      const i = wIdx.current++;
      setWidgets((prev) => [...prev, { id: `truth-${i}`, kind: "truth", title: "Truth card", state: "done", x: 40 + (i % 3) * 272, y: 36 + Math.floor(i / 3) * 212, data: (d.honesty as Record<string, unknown>) ?? d }]);
    } else if (ev.event === "message" && d.role === "assistant") {
      setMessages((m) => [...m, { role: "assistant", content: String(d.content ?? "") }]);
      setStatus(null);
    } else if (ev.event === "run.done" || ev.event === "run.error") {
      setBusy(false); setStatus(null);
      setWidgets((prev) => prev.map((w) => (w.state === "running" ? { ...w, state: "done" } : w)));
      void refreshWalletSurface();
    } else if (ev.event === "run.step") {
      if (typeof d.tool === "string" && d.tool !== "llm_gateway.complete") {
        recordStep({ id: `tool-${d.tool}`, label: TITLE[d.tool] ?? d.tool, state: String(d.state ?? "running") });
      }
      setStatus(d.state === "llm_call" ? "reasoning…" : typeof d.tool === "string" ? `${TITLE[d.tool] ?? d.tool}…` : "working…");
    }
  }, [recordStep, refreshWalletSurface, upsertWidget]);

  const loadRecentThreads = useCallback(async () => {
    const r = await copilotGet<{ threads?: ThreadSummary[] }>("/threads");
    setRecentThreads(r?.threads ?? []);
  }, []);

  const hydrateThread = useCallback(async (id: string) => {
    setHydratingThread(true);
    const snap = await copilotGet<ThreadSnapshot>(`/threads/${id}/snapshot`);
    if (!snap?.thread) {
      setHydratingThread(false);
      setStatus("could not reopen that chat");
      return;
    }
    abortRef.current?.();
    threadId.current = snap.thread.id;
    try { localStorage.setItem(COPILOT_THREAD_KEY, snap.thread.id); } catch { /* ignore */ }
    wIdx.current = 0;
    setStarted(true);
    setView("console");
    setBusy(false);
    setStatus(null);
    setQuestion(null);
    setWizard(null);
    setMessages((snap.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant"));
    setWidgets([]);
    setChatSteps([]);
    setExpandedStepGroups({});
    setFocusWidgetId(null);

    for (const ev of snap.events ?? []) {
      const d = ev.payload ?? {};
      if (ev.event_type === "widget" && typeof d.id === "string") {
        const kind = (d.kind as WidgetKind) ?? "think";
        const state = (d.state as "running" | "done" | "error") ?? "done";
        const title = String(d.title ?? "Step");
        upsertWidget({ id: d.id as string, kind, title, state, rationale: d.rationale as string | undefined, data: (d.data as Record<string, unknown>) ?? {} });
        recordStep({ id: `${ev.run_id}-${ev.seq}`, label: title, state, widgetId: d.id as string, kind });
      } else if (ev.event_type === "truth_card") {
        const i = wIdx.current++;
        setWidgets((prev) => [...prev, { id: `truth-${ev.run_id}-${ev.seq}`, kind: "truth", title: "Truth card", state: "done", x: 40 + (i % 3) * 272, y: 36 + Math.floor(i / 3) * 212, data: (d.honesty as Record<string, unknown>) ?? d }]);
      } else if (ev.event_type === "run.step" && typeof d.tool === "string" && d.tool !== "llm_gateway.complete") {
        recordStep({ id: `${ev.run_id}-${ev.seq}-${d.tool}`, label: TITLE[d.tool] ?? d.tool, state: String(d.state ?? "done") });
      }
    }
    setHydratingThread(false);
  }, [recordStep, upsertWidget]);

  useEffect(() => {
    void loadRecentThreads();
    const stored = typeof window !== "undefined" ? localStorage.getItem(COPILOT_THREAD_KEY) : null;
    if (stored && !threadId.current) void hydrateThread(stored);
  }, [hydrateThread, loadRecentThreads]);

  // "Nexa Analyze": re-run the whole flow with the edited basket weights (deterministic + streamed).
  const analyze = useCallback(async () => {
    const b = widgets.find((w) => w.kind === "basket" && (w.data as Record<string, unknown>)?._dirty);
    if (!b || busy) return;
    const data = b.data as Record<string, unknown>;
    const legs = (data.legs as Array<Record<string, unknown>>) ?? [];
    const weights: Record<string, number> = {}; const symbols: string[] = []; const bots: Record<string, string> = {};
    for (const l of legs) { weights[String(l.symbol)] = Number(l.allocation) || 0; symbols.push(String(l.symbol)); if (l.bot) bots[String(l.symbol)] = String(l.bot); }
    const assetClasses = [...new Set(legs.map((l) => (l.asset_class === "equity" ? STOCK_CLASS : String(l.category ?? "linear"))))];
    const summary = legs.map((l) => `${l.symbol} ${Math.round((Number(l.allocation) || 0) * 100)}%${l.bot ? ` (${l.bot})` : ""}`).join(", ");
    setWidgets((prev) => prev.map((w) => (w.kind === "basket" ? { ...w, data: { ...w.data, _dirty: false } } : w)));
    setBusy(true); setStatus("re-analyzing your edits…"); setChatSteps([]); setExpandedStepGroups({}); setFocusWidgetId(null);
    setMessages((m) => [...m, { role: "user", content: `Re-analyze with my edits: ${summary}` }]);
    const r = await copilotPost<{ runId: string }>("/multiasset/rerun", {
      budget_usd: Number(data.budget_usd ?? 500), risk: String(data.risk ?? "moderate"),
      asset_classes: assetClasses.length ? assetClasses : ["linear"], symbols, weights, bots, with_bots: true,
      rationale: `user set ${summary}`, thread_id: threadId.current ?? undefined,
    });
    if (!r?.runId) { setBusy(false); setStatus("re-run failed — is the agent up?"); return; }
    abortRef.current?.(); abortRef.current = streamRun(r.runId, handleEvent).abort;
  }, [widgets, busy, handleEvent]);

  const hasBasket = widgets.some((w) => w.kind === "basket");
  const inQuantsLab = view === "quants";
  const inMarkets = view === "markets";
  const inPortfolio = view === "portfolio";
  const inLiveTrading = view === "live";
  const railOff = view !== "console";
  const boardActive = view === "console" && widgets.length > 0;

  // Save the current basket as a reusable setup (revisit + launch later).
  const saveSetup = useCallback(async () => {
    const b = widgets.find((w) => w.kind === "basket"); if (!b) return;
    const data = b.data as Record<string, unknown>;
    const legs = ((data.legs as Array<Record<string, unknown>>) ?? []).map((l) => ({ symbol: String(l.symbol), allocation: Number(l.allocation) || 0, price: l.price ?? null, category: l.category, asset_class: l.asset_class }));
    if (!legs.length) return;
    const summary = (widgets.find((w) => w.kind === "multiasset")?.data as Record<string, unknown>) ?? {};
    const name = window.prompt("Name this setup", `${String(data.risk ?? "moderate")} basket · $${data.budget_usd ?? 500}`);
    if (!name) return;
    const assetClasses = (Array.isArray(data.asset_classes) ? data.asset_classes : [...new Set(legs.map((l) => (l.asset_class === "equity" ? STOCK_CLASS : String(l.category ?? "linear"))))]) as string[];
    setStatus("saving setup…");
    const r = await copilotPost("/setups", { name, spec: {
      budget_usd: Number(data.budget_usd ?? 500), risk: String(data.risk ?? "moderate"), asset_classes: assetClasses, legs,
      weighting: summary.weighting, rebalance_threshold: typeof summary.chosen === "number" ? summary.chosen : undefined,
      summary: summary.scenarios ? { scenarios: summary.scenarios } : undefined,
    } });
    setStatus(r ? "setup saved ✓" : "save failed"); setSavedTick((t) => t + 1);
  }, [widgets]);

  // Re-open a saved setup onto the board (just the basket) so it can be edited + re-analyzed.
  const openSetup = useCallback((s: Setup) => {
    const spec = s.spec as Record<string, unknown>;
    abortRef.current?.(); threadId.current = null; wIdx.current = 0;
    setView("console"); setStarted(true); setBusy(false); setStatus(null); setQuestion(null); setWizard(null);
    setMessages([{ role: "assistant", content: `Loaded "${s.name}". Edit allocations and hit Nexa Analyze to re-run the flow, or launch it from Saved.` }]);
    setWidgets([{ id: "ma-basket", kind: "basket", title: "Saved strategy basket", state: "done", x: 40, y: 36, data: { ...spec, _dirty: false } }]);
  }, []);

  const launchSetup = useCallback((setup: Setup) => {
    const spec = setup.spec as Record<string, unknown>;
    const legs = (Array.isArray(spec.legs) ? spec.legs as Array<Record<string, unknown>> : []).map((l) => ({
      symbol: String(l.symbol ?? ""),
      allocation: Number(l.allocation ?? l.weight ?? 0),
      sleeve: String(l.sleeve ?? ""),
      asset_class: String(l.asset_class ?? ""),
      category: String(l.category ?? ""),
      venue: String(l.venue ?? ""),
      bot: l.bot ? String(l.bot) : undefined,
      bot_type: l.bot_type ? String(l.bot_type) : undefined,
    })).filter((l) => l.symbol);
    const requestedUsd = Number(spec.budget_usd ?? 20);
    setLaunchRequest({ requestedUsd, depositUsd: requestedUsd, text: `Launch saved setup ${setup.name}`, legs });
    setView("console");
  }, []);

  // Send a message to the agent and stream the run (drives the board + rail). `silent` skips the user
  // bubble (used after the wizard, where the convo already shows the chosen answers).
  const runAgent = useCallback(async (content: string, opts: { silent?: boolean } = {}) => {
    setStarted(true); setBusy(true); setStatus("thinking…"); setQuestion(null); setPicks([]);
    setChatSteps([]); setExpandedStepGroups({}); setFocusWidgetId(null);
    if (!opts.silent) setMessages((m) => [...m, { role: "user", content }]);
    if (!threadId.current) {
      const th = await copilotPost<ThreadResponse>("/threads", { title: content.slice(0, 60) });
      if (!th) { setBusy(false); setStatus("connection failed — is the agent running?"); return; }
      threadId.current = th.id;
      try { localStorage.setItem(COPILOT_THREAD_KEY, th.id); } catch { /* ignore */ }
      void loadRecentThreads();
    }
    const r = await copilotPost<{ runId: string }>(`/threads/${threadId.current}/message`, { content });
    if (!r?.runId) { setBusy(false); setStatus("the agent didn't accept the message"); return; }
    abortRef.current?.();
    abortRef.current = streamRun(r.runId, handleEvent).abort;
  }, [handleEvent, loadRecentThreads]);

  // Advance the deterministic multiasset wizard; on the last step compose one request to the agent.
  const answerWizard = useCallback((choice: string) => {
    if (!wizard) return;
    const step = WIZARD_STEPS[wizard.step];
    const answers = { ...wizard.answers, [step.key]: choice };
    setMessages((m) => [...m, { role: "user", content: choice }]);
    if (wizard.step < WIZARD_STEPS.length - 1) {
      const next = WIZARD_STEPS[wizard.step + 1];
      setWizard({ ...wizard, step: wizard.step + 1, answers });
      setQuestion({ id: `wiz-${wizard.step + 1}`, question: next.q, options: next.options, multi: next.multi });
      setPicks([]);
      setMessages((m) => [...m, { role: "assistant", content: next.q }]);
      return;
    }
    // complete → compose a fully-specified request and hand off to the agent
    setWizard(null); setQuestion(null); setPicks([]);
    const risk = (answers.risk ?? "Moderate").toLowerCase();
    const days = DUR_DAYS[answers.duration ?? ""] ?? 30;
    const classes = [...new Set((answers.markets ?? "Perps").split(",").map((s) => MARKET_CLASS[s.trim()] ?? "linear"))];
    void runAgent(`Run a ${risk} multi-asset setup for $${wizard.budget} over ${days} days on ${classes.join(", ")} markets. Use setup_multiasset now — do not ask any more questions.`, { silent: true });
  }, [wizard, runAgent]);

  // Entry point for the composer + suggestions: ALWAYS hand the message to the agent. The agent is the
  // decision-maker — it screens, analyzes, backtests, or elicits multiasset params (one-at-a-time via
  // ask_user) as the conversation demands. We deliberately do NOT keyword-hijack into a fixed wizard:
  // that mis-fired whenever a message merely *mentioned* "basket"/"portfolio"/"multiasset" (e.g. when
  // the user pasted back the assistant's own option list), overriding their actual intent.
  const submit = useCallback((text: string) => {
    const t = text.trim();
    if (!t || busy || wizard) return;
    setInput("");
    if (LAUNCH_INTENT_RE.test(t)) {
      setLaunchRequest(buildLaunchRequest(t));
      return;
    }
    void runAgent(t);
  }, [buildLaunchRequest, busy, wizard, runAgent]);

  return (
    <div className={`nexa ${chakraPetch.variable} ${orbitron.variable} ${shareTechMono.variable} ${archivo.variable} ${boardActive ? "board-active" : ""} ${inQuantsLab || inLiveTrading ? "lab-view" : ""} ${railOff ? "rail-off" : ""}`}>
      {/* ---- Sidebar (collapses once the agent starts placing widgets) ---- */}
      <aside className="nx-side">
        <div className="nx-brand"><Burst /><div><div className="nx-brand-name">Nexa</div><div className="nx-brand-sub">Agentic Quant</div></div></div>
        <nav className="nx-nav">
          {NAV.map((n) => (
            <button key={n.id} className={`nx-nav-item ${view === n.id ? "on" : ""}`} onClick={() => setView(n.id)}>
              <Icon d={n.icon} /><span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="nx-side-foot">
          <WalletDock
            wallets={wallets}
            agentWallet={agentWallet}
            credits={credits}
            session={walletSession}
            open={walletOpen}
            prompt={walletPrompt}
            onOpen={() => setWalletOpen(true)}
            onClose={() => { setWalletOpen(false); setWalletPrompt(false); }}
            onRefresh={() => void refreshWalletSurface()}
            onSession={setWalletSession}
          />
        </div>
      </aside>

      {/* ---- Center stage: globe → board ---- */}
      <main className="nx-stage">
        <div className="nx-stage-label"><b />{inPortfolio ? "Portfolio" : inLiveTrading ? "Live trading" : inQuantsLab ? "Quants lab" : inMarkets ? "Robinhood markets" : view === "saved" ? "Saved setups" : started ? "Trading setup" : "Data in motion"}</div>
        {inPortfolio ? (
          <PortfolioPanel wallets={wallets} agentWallet={agentWallet} />
        ) : view === "saved" ? (
          <SavedSetups refreshKey={savedTick} threads={recentThreads} onOpen={openSetup} onLaunch={launchSetup} onOpenThread={(id) => void hydrateThread(id)} />
        ) : inLiveTrading ? (
          <LiveTradingPanel draft={liveDraft} onRun={(prompt) => void runAgent(prompt)} userWallet={wallets[0]?.wallet_address} agentWallet={agentWallet?.address} />
        ) : inQuantsLab ? (
          <QuantsLabPanel
            active={labTab}
            onSelect={setLabTab}
            onRun={(prompt) => void runAgent(prompt)}
            onOpenLiveDraft={(draft) => {
              setLiveDraft(draft);
              setView("live");
            }}
          />
        ) : inMarkets ? (
          <StockMarketsTerminal
            variant="embedded"
            onCopilot={(prompt) => {
              setView("console");
              setStarted(true);
              void runAgent(prompt);
            }}
          />
        ) : (
          <>
            <div className={`nx-globe ${started ? "morph" : ""}`}><GlobeCloud /></div>
            <div className={`nx-board ${started ? "on" : ""}`}>
              {started ? <NexaBoard widgets={widgets} onMove={moveWidget} focusWidgetId={focusWidgetId} onEditAllocation={editAllocation} onIntakeSubmit={(t) => void runAgent(t)} /> : null}
            </div>
            {started && hasBasket ? <button className="nx-save" disabled={busy} onClick={() => void saveSetup()}>Save setup</button> : null}
            {started ? (
              <button className={`nx-fab ${dirtyBasket ? "on" : ""}`} disabled={!dirtyBasket || busy} onClick={() => void analyze()}>
                <span className="nx-fab-dot" /> Nexa Analyze
              </button>
            ) : null}
          </>
        )}
      </main>

      {/* ---- Right conversation rail: console-only ---- */}
      {view === "console" ? <section className="nx-rail">
        {!started ? (
          <>
            <span className="nx-pill"><b />Data Intelligence</span>
            <div className="nx-hero">
              <h1>Trade.<br />In Motion.</h1>
              <p>Watch complexity organize itself into clarity. Nexa reasons like a quant desk — analyzing, backtesting and optimizing in front of you.</p>
            </div>
            <div className="nx-hero-stats">
              <div className="nx-hs"><div className="v">693</div><div className="l">Live symbols screened</div></div>
              <div className="nx-hs"><div className="v">Paper</div><div className="l">No real-money risk</div></div>
            </div>
          </>
        ) : (
          <div className="nx-convo" ref={convoRef}>
            {messages.map((m, i) => (
              <div key={i} className={`nx-msg ${m.role}`}>
                <span className="nx-msg-role">{m.role === "user" ? "You" : "Nexa"}</span>
                <div className="nx-msg-body">{m.role === "assistant" ? rich(m.content) : m.content}</div>
              </div>
            ))}
            <ChatStepGroups steps={chatSteps} expanded={expandedStepGroups} onToggle={toggleStepGroup} onFocus={focusWidget} />
            {hydratingThread ? <div className="nx-status"><span className="spin" />reopening saved chat…</div> : null}
            {status ? <div className="nx-status"><span className="spin" />{status}</div> : null}
          </div>
        )}

        <div className="nx-composer">
          {question ? (
            <div className="nx-ask">
              <div className="nx-ask-q">{question.question}</div>
              <div className="nx-ask-opts">
                {question.options.map((opt) => {
                  const on = picks.includes(opt.label);
                  const isWiz = question.id.startsWith("wiz");
                  return (
                    <button key={opt.label} className={`nx-ask-opt ${on ? "on" : ""}`}
                      onClick={() => {
                        if (question.multi) setPicks((p) => (p.includes(opt.label) ? p.filter((x) => x !== opt.label) : [...p, opt.label]));
                        else if (isWiz) answerWizard(opt.label);
                        else { setQuestion(null); void runAgent(opt.label); }
                      }}>
                      <span className="nx-ask-opt-l">{opt.label}{question.multi && on ? " ✓" : ""}</span>
                      {opt.caption ? <span className="nx-ask-opt-c">{opt.caption}</span> : null}
                    </button>
                  );
                })}
                {question.multi ? (
                  <button className="nx-ask-confirm" disabled={!picks.length}
                    onClick={() => { const ans = picks.join(", "); if (question.id.startsWith("wiz")) answerWizard(ans); else { setQuestion(null); void runAgent(ans); } }}>Confirm{picks.length ? ` (${picks.length})` : ""}</button>
                ) : null}
              </div>
            </div>
          ) : null}
          {executableBasket ? (
            <div className="nx-execute-bar">
              <div className="nx-execute-bar-copy">
                <b>Setup ready</b>
                <em>Run the composed 3-sleeve basket on testnet</em>
              </div>
              <button
                className="nx-execute"
                disabled={busy}
                onClick={() => setLaunchRequest(buildLaunchRequest("Execute the composed 3-sleeve plan on testnet"))}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4l14 8-14 8V4z" /></svg>
                Execute
              </button>
            </div>
          ) : null}
          <div className="nx-composer-row">
            <textarea
              rows={1} value={input} placeholder="Ask Nexa to analyze, scan, backtest…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(input); } }}
            />
            <button className="nx-send" disabled={busy || !input.trim()} onClick={() => submit(input)} aria-label="Send">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
          </div>
          {!started ? (
            <div className="nx-suggest">{SUGGESTIONS.map((s) => <button key={s} onClick={() => submit(s)}>{s}</button>)}</div>
          ) : null}
        </div>
      </section> : null}
      <TestnetLaunchModal
        request={launchRequest}
        onClose={() => setLaunchRequest(null)}
        onPlanReady={(plan) => {
          setStarted(true);
          setMessages((m) => [...m, {
            role: "assistant",
            content: `Testnet launch plan ready: ${plan.summary ?? "review the launch popup"}`,
          }]);
        }}
      />
    </div>
  );
}
