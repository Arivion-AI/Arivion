// Dictionary of every machine error / eligibility / hard-block / recovery /
// execution-tier-downgrade code the lab emits, mapped to human guidance.
// Sourced from LAB_REFERENCE.md §6.4, §8.7, §11, §13, §16a.4, §17.

export interface CodeHelp {
  meaning: string;
  fix: string;
  relatedParams?: string[];
}

export const ERROR_CODES: Record<string, CodeHelp> = {
  // ---- Bot spec validation (§8.7) ----
  GRID_RANGE_INVALID: {
    meaning: "Grid lower_price >= upper_price (or non-positive).",
    fix: "Set lower_price strictly below upper_price, both positive.",
    relatedParams: ["lower_price", "upper_price"],
  },
  GRID_COUNT_TOO_LOW: {
    meaning: "grid_count is below the minimum (>=2 levels needed).",
    fix: "Set grid_count >= 2.",
    relatedParams: ["grid_count"],
  },
  GRID_LOWER_GTE_UPPER: {
    meaning: "Grid lower bound is greater than or equal to the upper bound.",
    fix: "lower_price < upper_price.",
    relatedParams: ["lower_price", "upper_price"],
  },
  DIRECTION_INVALID: {
    meaning: "direction is not one of the allowed values.",
    fix: "Use direction in {neutral, long, short} (futures_grid) or {long, short} where applicable.",
    relatedParams: ["direction"],
  },
  FUNDING_COVERAGE_REQUIRED: {
    meaning: "A funding-sensitive run (futures_grid, funding_arbitrage, funding_fade) needs funding rows for a verified tier.",
    fix: "Provide funding_rows for the canonical range, or backfill funding via /collect/funding.",
    relatedParams: ["funding_rows"],
  },
  MARGIN_TIERS_MISSING: {
    meaning: "Leveraged linear run (>1x) needs recorded Bybit risk tiers to be verifiable.",
    fix: "Backfill instruments/risk-limit and pass risk_tiers, or set leverage=1.",
    relatedParams: ["leverage", "risk_tiers"],
  },
  HARD_STOP_REQUIRED: {
    meaning: "futures_martingale requires a positive hard_stop_loss_fraction.",
    fix: "Set hard_stop_loss_fraction > 0.",
    relatedParams: ["hard_stop_loss_fraction"],
  },
  RUIN_MARGIN_EXCEEDS_CAPITAL: {
    meaning: "The ruin simulator found the worst-case margin ladder (base + Σ safety*mult^i + fees + funding shock) exceeds starting capital.",
    fix: "Lower safety_order_multiplier, max_dca_orders, or base/dca margins, or raise starting_equity.",
    relatedParams: ["safety_order_multiplier", "max_dca_orders", "dca_order_margin", "base_order_margin"],
  },
  GROSS_WEIGHT_SUM_INVALID: {
    meaning: "Combo/portfolio gross leg weights do not sum to 1.0.",
    fix: "Make Σ|target_weight_fraction| == 1.0 across legs.",
    relatedParams: ["symbols", "target_weight_fraction"],
  },
  COMBO_GROSS_WEIGHTS_NOT_ONE: {
    meaning: "futures_combo gross weights must sum to exactly 1.0.",
    fix: "Normalize the leg target_weight_fraction values to sum to 1.0.",
    relatedParams: ["symbols", "target_weight_fraction"],
  },
  VP_MISSING_VOLUME: {
    meaning: "vp_pov needs prior-bar volume to size child orders.",
    fix: "Provide bars with volume, or use a different execution bot.",
    relatedParams: ["bars"],
  },
  E0_VERIFIED_EXECUTION_TIER_REQUIRES_L1_L2: {
    meaning: "An execution-family bot (twap/vp_pov/chase_limit/iceberg/scaled_order) cannot earn a verified tier without recorded L1/L2.",
    fix: "Record L2/trades (record_l2/record_trades) and run with execution_fidelity=l2_sweep|l2_queue, or accept LOCAL ONLY.",
    relatedParams: ["execution_fidelity"],
  },
  E0_VERIFIED_EXECUTION_REQUIRES_L1_L2: {
    meaning: "Cockpit hard block: verified execution needs L1/L2 data.",
    fix: "Record/backfill L2 + trades and consume them via l2 fidelity.",
    relatedParams: ["execution_fidelity"],
  },
  XSTOCK_SHORT_NOT_ALLOWED: {
    meaning: "xStocks are long-only; a short leg/side was requested.",
    fix: "Use side=long / allow_short=false for xStock symbols.",
    relatedParams: ["side", "allow_short"],
  },
  XSTOCK_LEVERAGE_NOT_ALLOWED: {
    meaning: "xStocks are leverage-1 only.",
    fix: "Set leverage=1 for xStock legs.",
    relatedParams: ["leverage"],
  },
  XSTOCK_SPOT_ONLY: {
    meaning: "xStocks trade spot only (no perp/futures).",
    fix: "Use category=spot for xStock symbols.",
    relatedParams: ["category"],
  },
  XSTOCK_NO_PERP_OR_FUTURES: {
    meaning: "Cockpit hard block: xStock cannot use perp/futures.",
    fix: "Switch the xStock leg to spot.",
  },
  UNKNOWN_BOT_TYPE: {
    meaning: "bot_type is not one of the 15 registered products.",
    fix: "Use a bot_type from duality://catalog/bots.",
    relatedParams: ["botType"],
  },
  MARTINGALE_WITHOUT_STOP_LOSS: {
    meaning: "Cockpit hard block: martingale without a stop loss.",
    fix: "Add hard_stop_loss_fraction > 0.",
    relatedParams: ["hard_stop_loss_fraction"],
  },
  FUTURES_LEVERAGE_WITHOUT_MARGIN_TIERS: {
    meaning: "Cockpit hard block: leveraged futures without margin tiers.",
    fix: "Supply risk_tiers / backfill risk-limit, or drop leverage to 1.",
    relatedParams: ["leverage", "risk_tiers"],
  },
  "RISK_REJECTION:LIQUIDATION_FLOOR_BREACH": {
    meaning: "position_snowball: a projected add would push liquidation distance below the floor.",
    fix: "Raise liquidation_distance_floor_fraction tolerance, reduce add size, or lower leverage.",
    relatedParams: ["liquidation_distance_floor_fraction", "profit_reinvestment_fraction"],
  },

  // ---- Risk run hard gates (§6.4) ----
  RUIN_ZERO_EQUITY: {
    meaning: "Portfolio/run hit the ruin floor (equity <= 0) and liquidated.",
    fix: "Reduce leverage/exposure; the position was flattened at zero equity.",
  },

  // ---- Execution-tier downgrades (§16a.4) ----
  E0_L2_NOT_CONSUMED_BY_FILL_ENGINE: {
    meaning: "L2 rows exist but the fill engine did not consume them (fill_model.l2_provider_used=false).",
    fix: "Run with execution_fidelity=l2_sweep|l2_queue so the provider is wired.",
    relatedParams: ["execution_fidelity"],
  },
  E0_FILL_MODE_BAR_BASED: {
    meaning: "Run used bar_based fills, which cannot earn an L2-verified tier.",
    fix: "Use an L2 fidelity mode with recorded coverage.",
    relatedParams: ["execution_fidelity"],
  },
  TRADE_COVERAGE_BELOW_THRESHOLD: {
    meaning: "Public-trade coverage is below TRADE_COVERAGE_THRESHOLD for the queue-verified badge.",
    fix: "Record/backfill more trades over the canonical range (default threshold 0.98).",
  },
  L2_COVERAGE_INSUFFICIENT: {
    meaning: "Requested L2 fidelity but l2_snapshots coverage is missing/low.",
    fix: "Record/backfill L2 (record_l2 or /collect/backfill/l2-archive) or allow fallback.",
    relatedParams: ["execution_fidelity", "allow_fallback"],
  },
  TRADE_COVERAGE_INSUFFICIENT: {
    meaning: "l2_queue requested but trades are absent; degrades to sweep or rejects.",
    fix: "Record trades, or accept the sweep degrade with allow_fallback=true.",
    relatedParams: ["execution_fidelity", "allow_fallback"],
  },

  // ---- Optimizer (§13) ----
  PARAM_SPACE_EMPTY: {
    meaning: "Optimizer received an empty param space.",
    fix: "Provide a non-empty param_space (sweep) / searchSpace (runs) / candidates list.",
    relatedParams: ["param_space", "searchSpace", "candidates"],
  },
  NO_CANDIDATES: {
    meaning: "Neither candidates nor a usable searchSpace were provided.",
    fix: "Pass candidates[] or a searchSpace with min/max/step.",
    relatedParams: ["candidates", "searchSpace"],
  },

  // ---- Concurrency / fairness (§17) ----
  OWNER_CONCURRENCY_LIMIT: {
    meaning: "This owner exceeded OWNER_CONCURRENCY (default 3) concurrent heavy jobs.",
    fix: "Wait for an in-flight job to finish, then retry. One owner's flood self-throttles.",
  },
  SERVER_BUSY: {
    meaning: "Global heavy-job cap (HEAVY_CONCURRENCY) saturated; waited > HEAVY_ACQUIRE_TIMEOUT.",
    fix: "Back off and retry shortly; scale workers if persistent.",
  },

  // ---- Recovery (§15/§16a.3) ----
  RECOVERY_BLOCKED: {
    meaning: "A live-paper session could not auto-resume (candle gap or missing L2/trade coverage).",
    fix: "Backfill the gap (/collect/backfill/kline or L2) then flip status to resume.",
  },
  CANDLE_GAP: {
    meaning: "Largest contiguous candle hole exceeded RECOVERY_MAX_GAP_BARS during recovery.",
    fix: "Backfill the missing klines, then resume the session.",
  },

  // ---- Venue / order semantics (§23a WS-A / WS-F) ----
  TICK_VIOLATION: { meaning: "Order price is off the instrument tick grid.", fix: "Round to tick_size (buy down / sell up)." },
  MIN_QTY: { meaning: "Order qty below the instrument minimum.", fix: "Increase qty to >= minOrderQty." },
  MAX_QTY: { meaning: "Order qty above the instrument maximum.", fix: "Reduce qty to <= maxOrderQty." },
  MIN_NOTIONAL: { meaning: "Order notional below the minimum.", fix: "Increase price*qty above minNotional." },
  PRICE_BAND: { meaning: "Order price outside the allowed price band.", fix: "Bring price within priceLimitRatio of mark." },
  POST_ONLY_WOULD_CROSS: { meaning: "A PostOnly order would cross and was rejected.", fix: "Reprice so it rests (don't cross the book)." },
  REDUCE_ONLY_NO_POSITION: { meaning: "reduceOnly order with no position to reduce.", fix: "Only send reduceOnly when a position exists." },
  IOC_REMAINDER: { meaning: "IOC order left an unfilled remainder (cancelled).", fix: "Informational — IOC cancels the unfilled part." },
  IOC_FOK_NO_FILL: { meaning: "IOC/FOK order found no fill.", fix: "Informational — no liquidity at the limit." },
  FOK_UNFILLED: { meaning: "FOK could not fill in full and was cancelled.", fix: "Informational — FOK is all-or-nothing." },
};

export function explainCode(code: string): CodeHelp | undefined {
  if (ERROR_CODES[code]) return ERROR_CODES[code];
  // Codes are often suffixed with detail, e.g. CANDLE_GAP_5_BARS_AT_123.
  for (const key of Object.keys(ERROR_CODES)) {
    if (code.startsWith(key)) return ERROR_CODES[key];
  }
  return undefined;
}
