// Classification of real Lab MCP tools by side-effect/risk, used by the guardrails. Names verified
// against apps/mcp/src/tools/*.ts. Read-only discovery/data tools are not listed as mutating.

// Tools that mutate Lab state or consume real compute (anything that creates specs/strategies,
// runs backtests/optimizers, writes data, starts sessions, or publishes).
export const MUTATING_TOOLS = new Set<string>([
  // bots
  "create_bot_spec", "run_bot_backtest", "run_bot_paper",
  // strategies
  "create_strategy", "create_strategy_version", "run_backtest", "run_paper_runtime",
  // portfolio
  "run_portfolio",
  // optimizer
  "optimizer_run", "optimizer_sweep",
  // live paper / paper sessions
  "start_live_paper", "stop_live_paper", "create_paper_account", "create_paper_session",
  "paper_rebuild", "paper_stop", "paper_tick",
  // multi-asset (portfolio) paper (run_portfolio already listed above; validate_portfolio is a read)
  "start_multiasset_paper", "stop_multiasset_paper",
  // data writes / ingestion
  "ensure_candles", "backfill_job", "backfill_schedule_create", "backfill_schedules_run_due",
  "collect_backfill_kline", "collect_backfill_index_kline", "collect_backfill_mark_kline",
  "collect_backfill_l2_archive", "collect_funding", "collect_instruments", "collect_oi",
  "collect_long_short", "collect_record_l2", "collect_record_trades", "record_l2", "record_trades",
  "live_subscribe", "collect_live_subscribe", "collect_ws_subscribe", "collect_live_unsubscribe",
  // marketplace / publish
  "marketplace_publish", "marketplace_fork", "publish_passport",
  // sandbox
  "sandbox_execute",
  // testnet execution / intent writes (real on-chain testnet txs or DB writes)
  "prepare_testnet_intent", "execute_stock_buy", "execute_lp", "execute_swap", "execute_bridge",
  "launch_plan", "record_testnet_intent_submission",
]);

// Starting a live-paper session (requires ≥ L2).
export const LIVE_PAPER_START_TOOLS = new Set<string>([
  "start_live_paper", "run_bot_paper", "create_paper_session", "run_paper_runtime",
  "start_multiasset_paper",
]);

// Publishing a result (always requires explicit approval, at every autonomy level).
export const PUBLISH_TOOLS = new Set<string>(["marketplace_publish", "publish_passport"]);

// Optimizer sweeps (gated by budget + permission).
export const OPTIMIZER_TOOLS = new Set<string>(["optimizer_run", "optimizer_sweep"]);

// A "run" for budget accounting (backtests).
export const BACKTEST_TOOLS = new Set<string>([
  "run_bot_backtest", "run_backtest", "run_paper_runtime", "run_portfolio",
]);

// Param keys that change determinism / execution fidelity. Toggling any of these requires the plan
// to carry safety_notes (so a venue/fill-fidelity change is never silent — core rule).
export const DETERMINISM_TOGGLE_PARAMS = new Set<string>([
  "fill_model", "fill_model_mode", "maker_fills_optimistic", "execution_fidelity",
  "seed", "rng_seed", "venue", "slippage_model", "liquidity_model", "queue_model",
]);

// Opening a managed position (a capped live-paper session) — the guardrails require a valid
// exit_policy on any plan that calls this, so a position can never be opened without its consequences.
export const MANAGED_ENTRY_TOOLS = new Set<string>(["start_live_paper"]);

export function isMutating(tool: string): boolean {
  return MUTATING_TOOLS.has(tool);
}
export function isManagedEntry(tool: string): boolean {
  return MANAGED_ENTRY_TOOLS.has(tool);
}
export function isLivePaperStart(tool: string): boolean {
  return LIVE_PAPER_START_TOOLS.has(tool);
}
export function isPublish(tool: string): boolean {
  return PUBLISH_TOOLS.has(tool);
}
