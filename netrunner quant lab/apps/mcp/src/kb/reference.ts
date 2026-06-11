import type { ParamSpec } from "./types.js";

// Option catalogs + reference data for the non-strategy/bot subsystems.

// ---- Execution fidelity / fill model (§5, §16a) ----
export const FILL_MODES = ["bar_based", "l2_sweep", "l2_queue", "amm_mid_only", "amm_quote_snapshot", "amm_swap_replay", "testnet_actual"] as const;
export const FILL_MODEL_REFERENCE = {
  modes: {
    bar_based: "Default. Candle OHLC only; deterministic, byte-identical to legacy. Maker fills are an optimistic upper bound (flagged).",
    l2_sweep: "Conservative L2 path; maker limits fill only on a strict sweep, with book-snapshot evidence. Needs recorded l2_snapshots.",
    l2_queue: "Full queue path; uses L2 for queue_ahead + public trades for executed through-volume. Needs l2_snapshots + trades.",
    amm_mid_only: "DEX candle-only AMM approximation. No reserve proof near fill time; liquidity-free upper bound is flagged.",
    amm_quote_snapshot: "DEX quote model from a recorded pool snapshot/reserves. DEX-modeled, not a signed on-chain execution.",
    amm_swap_replay: "DEX swap-print replay. Uses real swap prints where available; still a backtest over historical data.",
    testnet_actual: "A recorded testnet transaction/receipt. Testnet only; never evidence of production execution.",
  },
  honestyFlags: [
    "maker_fills_optimistic", "liquidity_free_upper_bound", "l2_provider_used",
    "trade_prints_used", "snapshot_coverage_pct", "trade_coverage_pct", "fallback_reason",
  ],
  determinismToggles: {
    MARKET_IMPACT_COEF: "Square-root market impact; default 0 (OFF) to preserve determinism.",
    MAKER_PARTICIPATION_RATE: "Per-bar limit-fill cap = rate*bar_volume; default 0 (OFF).",
    ENABLE_LATENCY_MODEL: "Deterministic latency model; default OFF.",
  },
  verifyTier:
    "L2-verified requires fill_model.l2_provider_used=true, mode in {l2_sweep,l2_queue}, snapshot_coverage_pct>=threshold. Queue-verified additionally needs trade_prints_used=true and trade_coverage_pct>=threshold.",
};

export const CHAIN_REFERENCE = {
  chains: [
    { chainId: 42161, name: "Arbitrum One", role: "real DEX market-data lane", execution: "disabled unless explicitly feature-flagged later" },
    { chainId: 421614, name: "Arbitrum Sepolia", role: "testnet execution lane", execution: "testnet intents only" },
    { chainId: 46630, name: "Robinhood Chain Testnet", role: "tokenized-stock testnet lane", execution: "testnet intents only" },
  ],
  safety: "Mainnet DEX data can inform models, but real-money execution is disabled. Testnet intent submission requires DUALITY_ENABLE_TESTNET_ACTIONS=true and user wallet approval.",
};

export const DEX_VENUE_REFERENCE = {
  dataLane: "DEX data is additive beside Bybit. Bybit remains the existing centralized venue lane.",
  sources: ["GeckoTerminal REST for discovery/candles/swaps", "RPC/reserve snapshots when configured"],
  venues: ["uniswap_v3", "camelot", "robinhood_testnet"],
  proofFields: ["source", "coverage_score", "latest_snapshot_at", "latest_candle_at", "truth.data_source", "truth.execution_fidelity"],
};

export const AMM_FILL_MODEL_REFERENCE = {
  modes: ["amm_mid_only", "amm_quote_snapshot", "amm_swap_replay", "testnet_actual"],
  caveats: [
    "amm_mid_only is a liquidity-free upper bound.",
    "amm_quote_snapshot uses modeled AMM math from recorded reserves or latest candle price.",
    "amm_swap_replay can use swap prints but is still historical replay, not a production order.",
    "testnet_actual is only for Arbitrum Sepolia / Robinhood Chain Testnet and cannot be ranked as real-money execution.",
  ],
};

export const RUN_COMMON_PARAMS: ParamSpec[] = [
  { name: "starting_equity", type: "decimal", default: "10000", unit: "USDT", description: "Initial equity." },
  { name: "interval_minutes", type: "int", default: 15, unit: "minutes", description: "Bar interval (drives annualization)." },
  { name: "fee_bps_taker", type: "decimal", default: "5.5", unit: "bps", description: "Taker fee." },
  { name: "fee_bps_maker", type: "decimal", default: "1.0", unit: "bps", description: "Maker fee (negative = rebate)." },
  { name: "slippage_bps_one_way", type: "decimal", default: "2.0", unit: "bps", description: "One-way slippage." },
  { name: "execution_fidelity", type: "enum", default: "bar_based", enum: [...FILL_MODES], description: "Fill fidelity mode.", relatedErrorCodes: ["L2_COVERAGE_INSUFFICIENT", "TRADE_COVERAGE_INSUFFICIENT"] },
  { name: "allow_fallback", type: "bool", default: true, description: "Degrade a tier if L2/trade coverage is missing (else reject)." },
  { name: "venue_exact", type: "bool", default: false, description: "Bybit-exact venue layer (tick/qty/fees/semantics). Default OFF." },
  { name: "vip_tier", type: "string", description: "Bybit VIP tier for the fee schedule (e.g. VIP0, PRO3)." },
  { name: "requested_tier", type: "enum", default: "LOCAL ONLY", enum: ["LOCAL ONLY", "BACKTEST_VERIFIED", "LIVE_PAPER_VERIFIED"], description: "Tier to attempt." },
];

// ---- Venue layer (§23a WS-A..G) ----
export const VENUE_REFERENCE = {
  note: "All opt-in, default OFF -> byte-identical to before. All Decimal, no wall-clock/randomness.",
  toggles: {
    venue_exact: "Master switch; loads instrument_snapshots automatically on bot runs.",
    instrument_filter: "WS-A conform_order: tick/qty/min-notional/leverage clamp. Reject reasons: TICK_VIOLATION|MIN_QTY|MAX_QTY|MIN_NOTIONAL|PRICE_BAND.",
    vip_tier: "WS-B resolve_fee_bps: FEE_SCHEDULE by category x vip_tier x maker/taker (negative maker = rebate).",
    liquidation_model: "WS-C: 'simple' (default) | 'mark_price_tiered' (tiered mark-price liq, bankruptcy settlement).",
    risk_tiers: "WS-C tiered margin: from /v5/market/risk-limit (public = fractions). Required for leverage>1 verified.",
    funding_cap_lower: "WS-D clamp lower bound on each funding rate.",
    funding_cap_upper: "WS-D clamp upper bound on each funding rate.",
    enforce_order_semantics: "WS-F: PostOnly-reject-if-crossing, reduceOnly-clamp, IOC/FOK, triggerBy=LastPrice|MarkPrice|IndexPrice.",
  },
  semanticsCodes: ["POST_ONLY_WOULD_CROSS", "REDUCE_ONLY_NO_POSITION", "IOC_REMAINDER", "IOC_FOK_NO_FILL", "FOK_UNFILLED"],
};

// ---- Optimizer (§13) ----
export const OPTIMIZER_REFERENCE = {
  methods: ["grid", "random", "sobol"],
  spaceForms: [
    '{"values":[...]} — explicit candidate values',
    '{"min":..,"max":..,"step":..} — stepped range',
    '{"min":..,"max":..,"n":..,"log":true} — n samples, optional log scale',
  ],
  keyGotcha: "POST /api/optimizer/sweep uses key 'param_space'; POST /api/optimizer/runs uses 'searchSpace' (min/max/step) + optional 'candidates'.",
  robustness: "walk_forward and block_bootstrap are reported as not_computed (never fabricated). parameter_sensitivity is the real finalist-score relative spread.",
  emptyCode: "PARAM_SPACE_EMPTY",
};

// ---- Portfolio engine (§9) ----
export const PORTFOLIO_REFERENCE = {
  weightingSchemes: ["fixed", "equal", "inverse_vol", "risk_parity", "momentum"],
  schemeNotes: {
    fixed: "Normalized leg target weights.",
    equal: "Equal weight across legs.",
    inverse_vol: "w ∝ 1/σ over lookback_bars.",
    risk_parity: "Alias of inverse_vol.",
    momentum: "Top-N by trailing return, equal-weight.",
  },
  legShape: "{symbol, asset_class: crypto|equity, category: linear|spot, target_weight, leverage, allow_short, bars}",
  calendar: "UNION timeline + forward-fill. Crypto trades 24/7; equity legs trade US-RTH only, held flat off-hours (XSTOCK_OFFHOURS_HOLD).",
  constraints: "Equity legs: spot, long-only, leverage 1 (XSTOCK_SPOT_ONLY / _LEVERAGE_NOT_ALLOWED / _SHORT_NOT_ALLOWED).",
  ruinFloor: "equity<=0 -> RUIN_ZERO_EQUITY, flatten all.",
};

// ---- Recommender (§12) ----
export const RECOMMENDER_REFERENCE = {
  regimes: [
    "data_unhealthy", "funding_extreme_pos", "funding_extreme_neg", "volume_spike",
    "sideways_low_vol", "sideways_high_vol", "trend_up_low_vol", "trend_up_high_vol",
    "trend_down_low_vol", "trend_down_high_vol",
  ],
  detection: "trend=(SMA10-SMA30)/SMA30; vol=close-to-close. funding>0.0008 pos / < -0.0008 neg; last_volume>3*median -> spike; |trend|<0.005 -> sideways.",
  riskTolerance: ["low", "moderate", "high"],
  toleranceDenials: {
    low: "denies martingale, snowball, futures_dca, funding_arb",
    moderate: "denies martingale",
    high: "denies none",
  },
  affinityExamples: {
    sideways: "grids, twap, dca",
    trend_up: "dca, snowball, cross_asset_allocator",
    funding_extreme: "funding_arbitrage",
    volume_spike: "twap, vp_pov",
  },
};

// ---- Risk cockpit (§11) ----
export const RISK_COCKPIT_REFERENCE = {
  composite: "0.20 drawdown + 0.15 liquidation + 0.15 cost_fragility + 0.15 param_sensitivity + 0.10 data_quality + 0.10 funding_fragility + 0.10 exposure_concentration + 0.05 complexity",
  classes: "<20 LOW, <40 MODERATE, <60 HIGH, <80 VERY_HIGH, else EXTREME",
  hardBlocks: [
    "MARTINGALE_WITHOUT_STOP_LOSS", "FUTURES_LEVERAGE_WITHOUT_MARGIN_TIERS", "GRID_LOWER_GTE_UPPER",
    "COMBO_GROSS_WEIGHTS_NOT_ONE", "VP_MISSING_VOLUME", "E0_VERIFIED_EXECUTION_REQUIRES_L1_L2",
    "XSTOCK_NO_PERP_OR_FUTURES", "XSTOCK_SHORT_NOT_ALLOWED", "XSTOCK_LEVERAGE_NOT_ALLOWED",
  ],
  stressModules: [
    "ruin_simulator", "liquidation_heatmap", "funding_shock", "fee_slippage_shock",
    "range_breakout_stress", "rebalance_cost_stress", "execution_shortfall", "concentration_risk", "xstock_constraints",
  ],
};

// ---- xStocks (§10) ----
export const XSTOCKS_REFERENCE = {
  catalog: ["AAPLX", "NVDAX", "TSLAX", "METAX", "AMZNX", "GOOGLX", "HOODX", "CRCLX", "COINX", "MCDX"],
  constraints: "spot-only, long-only, leverage 1, no funding/dividends; 300k USDT/token cap; region-gated (EEA/AU/JP) for live.",
  pricing: "stock_price = token_price / xstockMultiplier (e.g. AAPLX ~1.0027). Live truth via xstocks_instruments.",
  hours: "is_regular_trading_hours uses America/New_York (real DST). Fails loud if tzdata missing. Off-hours widens slippage.",
};

// ---- Run/result tiers ----
export const TIERS = ["LOCAL ONLY", "BACKTEST VERIFIED", "LIVE PAPER VERIFIED"];
