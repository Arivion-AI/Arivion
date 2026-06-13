/* auto-generated from strategy.schema.json; schema_sha256=346ef87abaa0d0fb */
export type RequirementValue = "REQUIRED" | "REQUIRED_NATIVE_CADENCE" | "OPTIONAL_SUBJECT_TO_RETENTION" | "NOT_USED";

export type StrategySpec = {
  strategy: {
    name: string;
    universe: {
      category: string;
      symbols: string[];
      timeframe: string;
      timezone: string;
    };
    data_requirements: Record<string, RequirementValue> & {
      candles: RequirementValue;
      mark_price: RequirementValue;
      funding_rates: RequirementValue;
      open_interest: RequirementValue;
      orderbook_depth: RequirementValue;
    };
    features: Record<string, unknown>;
    entry: Record<string, unknown>;
    exit: Record<string, unknown>;
    sizing: {
      type: string;
      max_position_fraction: number;
      [key: string]: unknown;
    };
    risk: {
      max_leverage: number;
      max_daily_loss_fraction: number;
      max_drawdown_kill_fraction: number;
      [key: string]: unknown;
    };
    accounting: {
      perp_funding: "funding_history_timestamp_driven";
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};
