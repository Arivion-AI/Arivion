import type { CatalogEntry } from "./types.js";

// The 6 algo strategies (LAB_REFERENCE §7.1–7.6), driven by PaperRuntime via
// /api/paper/runtime/run (strategy_id + strategy_params).

export const STRATEGIES: CatalogEntry[] = [
  {
    id: "pmm",
    title: "Pure Market Maker",
    category: "market-making",
    summary:
      "Quotes a bid+ask around mid (bar_close), skewed by inventory toward inventory_target. Re-quotes each bar. Stateless.",
    eligibilityNotes: [
      "Maker fills are an optimistic OHLC upper bound under bar_based fidelity; flagged maker_fills_optimistic. Use l2_queue + recorded L2 for realism.",
    ],
    params: [
      { name: "bid_spread_bps", type: "decimal", default: 5, unit: "bps", description: "Bid offset below mid." },
      { name: "ask_spread_bps", type: "decimal", default: 5, unit: "bps", description: "Ask offset above mid." },
      { name: "order_qty", type: "decimal", default: 0.01, unit: "qty", description: "Quote size per side." },
      { name: "inventory_target", type: "decimal", default: 0, unit: "qty", description: "Signed inventory the maker leans toward." },
      { name: "inventory_skew_bps_per_unit", type: "decimal", default: 50, unit: "bps/unit", description: "Quote skew per unit of inventory deviation." },
      { name: "max_inventory_qty", type: "decimal", default: 1.0, unit: "qty", description: "Won't quote a side that pushes |inventory| past this." },
      { name: "refresh_each_bar", type: "bool", default: true, description: "Cancel-all and re-quote every bar." },
    ],
  },
  {
    id: "avellaneda_stoikov",
    title: "Avellaneda–Stoikov Market Maker",
    category: "market-making",
    summary:
      "Optimal MM: reservation price shifted from mid by inventory risk; spread from volatility (log-return variance) + book-depth proxy k. Stateful (rolling price deque).",
    params: [
      { name: "gamma", type: "decimal", default: 0.1, description: "Risk aversion (used directly in manual mode)." },
      { name: "gamma_mode", type: "enum", default: "manual", enum: ["manual", "auto", "auto_calibrated"], description: "manual uses gamma; auto* binary-searches gamma to hit target_spread_bps." },
      { name: "target_spread_bps", type: "decimal", default: 10, unit: "bps", description: "Target half-spread*2 when gamma_mode is auto*." },
      { name: "sigma_lookback", type: "int", default: 50, unit: "bars", description: "Lookback for log-return variance." },
      { name: "k", type: "decimal", default: 1.5, description: "Order-book depth/liquidity proxy." },
      { name: "order_qty", type: "decimal", default: 0.01, unit: "qty", description: "Quote size per side." },
      { name: "horizon_bars", type: "int", default: 100, unit: "bars", description: "Inventory-risk horizon T." },
    ],
  },
  {
    id: "funding_fade",
    title: "Funding Mean-Reversion",
    category: "carry/mean-reversion",
    summary:
      "Fades crowded funding gated by a slow-trend EMA filter, with ATR bracket and a hold-time stop. Long when funding very negative AND close>EMA; mirror short. Stateful.",
    eligibilityNotes: ["Funding-sensitive: provide funding_rows for a verified run."],
    params: [
      { name: "funding_z_threshold", type: "decimal", default: 1.75, description: "Z-score magnitude to trigger a fade." },
      { name: "funding_z_lookback", type: "int", default: 30, unit: "bars", description: "Lookback for the funding z-score." },
      { name: "ema_slow_len", type: "int", default: 80, unit: "bars", description: "Slow trend filter length." },
      { name: "atr_len", type: "int", default: 14, unit: "bars", description: "ATR length for the bracket." },
      { name: "stop_atr_mult", type: "decimal", default: 1.8, unit: "xATR", description: "Stop distance in ATRs." },
      { name: "tp_atr_mult", type: "decimal", default: 2.4, unit: "xATR", description: "Take-profit distance in ATRs." },
      { name: "order_qty", type: "decimal", default: 0.1, unit: "qty", description: "Entry size." },
      { name: "max_holding_bars", type: "int", default: 96, unit: "bars", description: "Force-close after this many bars." },
    ],
  },
  {
    id: "trend_ema_cross",
    title: "Trend EMA Cross",
    category: "trend",
    summary: "Fast/slow EMA cross with an ATR trailing stop; flips on fresh cross. last_signal debounces. Stateful.",
    params: [
      { name: "ema_fast", type: "int", default: 20, unit: "bars", description: "Fast EMA length." },
      { name: "ema_slow", type: "int", default: 50, unit: "bars", description: "Slow EMA length." },
      { name: "atr_len", type: "int", default: 14, unit: "bars", description: "ATR length for the trailing stop." },
      { name: "order_qty", type: "decimal", default: 0.1, unit: "qty", description: "Position size." },
      { name: "trail_atr_mult", type: "decimal", default: 3.0, unit: "xATR", description: "Trailing-stop offset in ATRs." },
    ],
  },
  {
    id: "grid",
    title: "Static Grid",
    category: "grid",
    summary: "Anchors on first bar close, posts num_levels bids below + asks above at geometric spacing_bps steps. Stateful (anchor).",
    eligibilityNotes: ["Flagged APPROXIMATE_FILLS — resting maker quotes are an optimistic OHLC bound unless run with L2 fidelity."],
    params: [
      { name: "spacing_bps", type: "decimal", default: 30, unit: "bps", description: "Geometric spacing between levels." },
      { name: "num_levels", type: "int", default: 5, description: "Levels each side." },
      { name: "qty_per_level", type: "decimal", default: 0.01, unit: "qty", description: "Order size per level." },
      { name: "refresh_each_bar", type: "bool", default: false, description: "Re-anchor + re-post each bar if true." },
    ],
  },
  {
    id: "twap",
    title: "TWAP Executor",
    category: "execution",
    summary: "Emits one equal market slice (total_qty/n_slices) per bar until n_slices sent, then idles.",
    eligibilityNotes: ["Execution algo — APPROXIMATE_FILLS without recorded L1/L2."],
    params: [
      { name: "total_qty", type: "decimal", default: 1.0, unit: "qty", description: "Total quantity to execute." },
      { name: "side", type: "enum", default: "buy", enum: ["buy", "sell"], description: "Trade direction." },
      { name: "n_slices", type: "int", default: 10, description: "Number of equal slices." },
    ],
  },
];

// The order-helper menu a strategy can use (read-only reference).
export const STRATEGY_ORDER_HELPERS = [
  "buy_market(symbol, qty, tag?, reduce_only=false)",
  "sell_market(symbol, qty, tag?, reduce_only=false)",
  "limit(symbol, side, qty, price, post_only=true, tif=GTC, tag?)",
  "stop_market(symbol, side, qty, stop, reduce_only=true, tag?)",
  "trailing_stop(symbol, side, qty, offset, reduce_only=true, tag?)",
];
