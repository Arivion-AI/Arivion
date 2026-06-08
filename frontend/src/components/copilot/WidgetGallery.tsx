"use client";

// Design/preview surface: renders EVERY Copilot widget kind with realistic mock data, so widgets can
// be reviewed + iterated in isolation. Reuses the REAL renderers + theme + modal from NexaBoard, so a
// card here looks/opens exactly like one on the Copilot board.
import { useEffect, useState } from "react";
import NexaBoard, { type BoardWidget, type WidgetKind } from "./NexaBoard";

function mk(kind: WidgetKind, title: string, data: Record<string, unknown>, rationale?: string): BoardWidget {
  return { id: kind, kind, title, state: "done", rationale, data, x: 0, y: 0 };
}

const MOCK: BoardWidget[] = [
  mk("intake", "Let's design your setup", { questions: [
    { key: "capitalUsd", label: "How much are you putting to work? (USD)", type: "number" },
    { key: "objective", label: "What's the goal?", type: "select", options: ["Grow aggressively", "Steady income & yield", "Preserve & beat inflation", "Express a view"] },
    { key: "drawdownTolerancePct", label: "A bad month draws down ~__% and you'd still hold", type: "slider", min: 5, max: 50, default: 15 },
    { key: "involvement", label: "How involved?", type: "select", options: ["Active", "Check weekly", "Set-and-forget"] },
  ] }, "A few quick questions so I can reason about the best approach."),
  mk("objective", "Your objective", { statement: "Maximize realized yield (fees + carry) net of IL & gas, with max drawdown ≤ 15% — prefer market-neutral, low-babysit structures, keep some long-ETH beta.", weights: { yield: 0.55, growth: 0.1, drawdown: 0.25, simplicity: 0.1 }, hardConstraints: { maxDrawdownPct: 15, maxLeverage: 2, allowShorts: false, allowLp: true }, preferMarketNeutral: true }),
  mk("screen", "Screen — best assets now", { picks: [
    { rank: 1, symbol: "ETHUSDT", composite: 0.88 }, { rank: 2, symbol: "ARBUSDT", composite: 0.74 },
    { rank: 3, symbol: "WLDUSDT", composite: 0.66 }, { rank: 4, symbol: "NEARUSDT", composite: 0.58 },
  ], xstocks: [{ symbol: "TSLAUSDT" }, { symbol: "NVDAUSDT" }] }, "#1 ETH (88)"),
  mk("factors", "Factor heatmap", { tokens: [
    { symbol: "ETH", composite: 0.88 }, { symbol: "ARB", composite: 0.74 }, { symbol: "WLD", composite: 0.66 }, { symbol: "NEAR", composite: 0.58 },
  ] }),
  mk("hold_vs_trade_vs_lp", "Hold · Trade · LP — ETH", { recommended: "lp", experiments: [
    { mode: "hold", total_return: -0.16, sharpe: 0.21, max_drawdown: -0.31 },
    { mode: "leverage", total_return: 0.42, sharpe: 0.55, max_drawdown: -0.48 },
    { mode: "lp", total_return: 0.11, sharpe: 0.9, max_drawdown: -0.05 },
  ] }),
  mk("mode_router", "Expression · ETH", { recommended: "lp", rationale: "LP best matches a yield-first, low-drawdown objective.", experiments: [
    { mode: "hold", total_return: -0.16 }, { mode: "leverage", total_return: 0.42 }, { mode: "lp", total_return: 0.11 },
  ] }),
  mk("reasoning", "Reasoning · ETH", { recommended: "lp", objectiveFit: 0.83, source: "llm",
    rationale: "Uniswap v3 ETH/USDC 0.05% delivers ~18% fee APR with max-drawdown −4.9% (< 15% cap); time-in-range 98.9% suits weekly involvement. Beats naked hold (−16% / −31% DD) and leverage (too much DD for the objective).",
    rejected: [{ mode: "hold" }, { mode: "leverage" }] }),
  mk("lp_compare", "Liquidity pools — ETH", { candidates: [
    { venue: "uniswap", feeTierPct: 0.05, feeAprPct: 18.2, score: 0.92, rationale: "highest fee APR, acceptable IL" },
    { venue: "gmx_glv", feeTierPct: null, feeAprPct: 14.1, score: 0.78 },
    { venue: "gmx_gm", feeTierPct: null, feeAprPct: 12.7, score: 0.71 },
    { venue: "uniswap", feeTierPct: 0.3, feeAprPct: 9.4, score: 0.55 },
    { venue: "uniswap", feeTierPct: 1, feeAprPct: 6.1, score: 0.34 },
  ] }),
  mk("lp_pool", "Pool — ETH/USDC 0.05%", { venue: "uniswap", feeAprPct: 18.2, tvlUsd: 41_000_000, ilRisk: "med" }),
  mk("il_curve", "IL / range — ETH/USDC", { band: { lowerPct: -7, upperPct: 7 }, timeInRangePct: 82, capitalEfficiency: 6.4, realizedVolAnnualPct: 58, ilCurve: [{ il: 0 }, { il: -0.3 }, { il: -1.1 }, { il: -2.4 }, { il: -4.2 }, { il: -2.4 }, { il: -1.1 }, { il: -0.3 }, { il: 0 }] }),
  mk("lp_backtest", "LP backtest — ETH/USDC", { metrics: { total_return: 0.11, sharpe: 0.9, max_drawdown: -0.05 }, fee_apr_pct: 18.2, il_drag_pct: 3.1, time_in_range_pct: 89, rebalances: 4, truth: { result_tier: "DEX REPLAY" }, equity_curve: [1, 1.01, 1.03, 1.02, 1.05, 1.07, 1.06, 1.09, 1.11] }),
  mk("funding_carry", "Funding carry — ETH", { netYield: { netAprPct: 21.4, grossFeeAprPct: 18.2, ilDragAprPct: 3.1 }, carry: { fundingRateAnnualPct: 6.3, hedgeNote: "GMX short funding is +6.3%/yr — a delta-neutral LP+short pays you to hedge." } }),
  mk("gmx_market", "GMX market — ETH/USD", { name: "ETH/USD [WETH-USDC]", indexPriceUsd: 3120.44, fundingAnnualPct: 6.3, oiLongUsd: 38_400_000, oiShortUsd: 31_900_000, availableLiquidityUsd: 12_500_000, listingDate: "2024-08-01" }),
  mk("glv_vault", "GLV vault — WETH/USDC", { totalUsd: 9_800_000, longSymbol: "WETH", shortSymbol: "USDC", listingDate: "2024-11-01", markets: [{ balanceUsd: 5_100_000, sharePct: 52 }, { balanceUsd: 2_900_000, sharePct: 30 }, { balanceUsd: 1_800_000, sharePct: 18 }] }),
  mk("venue_route", "Venue route — ETH LP", { venue: "uniswap", mode: "lp", why: "Deepest ETH/USDC liquidity + best fee/TVL turnover; routed to the 0.05% tier.", liquidity_usd: 41_000_000 }),
  mk("dune_panel", "Dune — ETH pool fees (30d)", { status: "ok", columns: ["day", "feesUSD", "volumeUSD", "tvlUSD"], rows: [
    { day: "2026-06-08", feesUSD: 210400, volumeUSD: 420800000, tvlUSD: 41200000 },
    { day: "2026-06-09", feesUSD: 198100, volumeUSD: 396200000, tvlUSD: 41050000 },
    { day: "2026-06-10", feesUSD: 233700, volumeUSD: 467400000, tvlUSD: 41600000 },
  ], row_count: 30, cached: false, query_id: 4821553 }),
  mk("multiasset", "Composed portfolio · crypto + LP + Robinhood stocks", { selected_symbols: ["ETHUSDT", "ARBUSDT"], legs: [
    { symbol: "ETHUSDT", sleeve: "lp", mode: "lp", venue: "uniswap", allocation: 0.35 },
    { symbol: "ARBUSDT", sleeve: "crypto", mode: "hold", venue: "bybit", allocation: 0.25 },
    { symbol: "dTSLA", sleeve: "stock", mode: "hold", venue: "robinhood_testnet", price_usd: 387.7, allocation: 0.2 },
    { symbol: "dNVDA", sleeve: "stock", mode: "hold", venue: "robinhood_testnet", price_usd: 132.4, allocation: 0.2 },
  ], metrics: { total_return: 0.14, sharpe: 0.82, max_drawdown: -0.09 } }),
  mk("backtest", "Backtest · recent", { metrics: { total_return: 0.14, sharpe: 0.82, max_drawdown: -0.09 }, rebalances: 6, window: "90d", symbols: ["ETHUSDT", "ARBUSDT"], equity_curve: [1, 1.02, 1.01, 1.04, 1.06, 1.05, 1.08, 1.11, 1.14] }),
  mk("truth", "Truth card", { result_tier: "DEX MODELED", data_source: "blended", execution_fidelity: "amm_quote_snapshot", can_execute_real_money: false }, "Paper/sim — testnet only. Crypto priced via Chainlink (Arb Sepolia); stocks via Chainlink-stand-in oracle."),
  mk("sentiment_gauge", "News sentiment — ETH", { score: 0.62, items: [{ title: "ETF inflows hit record", source: "CoinDesk" }] }, "Net positive sentiment from 6 trusted feeds."),
  mk("news", "Headlines — ETH", { items: [
    { title: "Ethereum L2 activity hits ATH", source: "The Block", link: "https://example.com" },
    { title: "Spot ETH ETF sees $300M inflow", source: "CoinDesk", link: "https://example.com" },
  ] }),
];

// Lay the mock widgets out across the board canvas in a loose grid; unique ids so drag tracks each.
const COLS = 4;
function laidOut(): BoardWidget[] {
  return MOCK.map((w, i) => ({ ...w, id: `${w.kind}-${i}`, x: 24 + (i % COLS) * 272, y: 24 + Math.floor(i / COLS) * 252 }));
}

export default function WidgetGallery() {
  // Client-only: the renderers format numbers/dates with locale-dependent helpers (SSR↔client
  // mismatch). The real board only mounts after a user action, so we mirror that.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [widgets, setWidgets] = useState<BoardWidget[]>(laidOut());
  const onMove = (id: string, x: number, y: number) => setWidgets((ws) => ws.map((w) => (w.id === id ? { ...w, x, y } : w)));

  if (!mounted) return <div style={{ padding: "28px 32px", color: "var(--ink-3)" }}>Loading widget gallery…</div>;
  return (
    <div style={{ padding: "22px 26px", height: "100vh", display: "flex", flexDirection: "column" }}>
      <h1 style={{ fontSize: 21, fontWeight: 700, marginBottom: 2 }}>Duality — Widget Gallery</h1>
      <p style={{ color: "var(--ink-3)", marginBottom: 14, fontSize: 13 }}>
        Every Copilot widget with mock data on the real board. <b>Drag</b> a card by its header to move it; click <b>expand ⤢</b> for the detail modal. Renderers live in <code>NexaBoard.tsx</code>, mocks in <code>WidgetGallery.tsx</code>.
      </p>
      {/* .nx-stage gives the grid-paper background + a positioned, sized container; NexaBoard renders
          its own scroll/canvas inside and fills it. */}
      <div className="nx-stage" style={{ position: "relative", flex: 1, minHeight: 0, margin: 0 }}>
        <NexaBoard widgets={widgets} onMove={onMove} />
      </div>
    </div>
  );
}
