import { randomUUID } from "node:crypto";
import { config, USD_TO_MICRO } from "../config.js";
import type { AgentPlan, AutonomyLevel, PlanStep } from "../orchestrator/plan.js";

// Deterministic plan builder for build_and_backtest_bot (Phase 5). The MVP builds this plan
// deterministically (not via free-form LLM tool-calling) so the agent NEVER emits an ad-hoc tool
// chain — every step is typed and guardrail-checked before execution (core rule).

export interface BuildAndBacktestInput {
  ownerId: number;
  threadId: string;
  symbol: string;
  category: "spot" | "linear" | "xstock";
  autonomy?: AutonomyLevel;
  template?: string;
  // Candle interval in minutes as a string (e.g. "15", "60"). The data_coverage API requires it,
  // and the backtest runs on this timeframe. Defaults to "15".
  interval?: string;
  botParams?: Record<string, unknown>;
}

// Sensible default bot for each category so the playbook is runnable without an explicit botType.
// Params come from the Bot OS templates (packages/quant-core/.../bot_os/templates.py).
const DEFAULTS: Record<string, { botType: string; params: Record<string, unknown> }> = {
  linear: {
    botType: "futures_grid",
    params: { symbol: "BTCUSDT", lower_price: "60000", upper_price: "70000", grid_count: 10, direction: "neutral", leverage: 1, investment_quote: "1000" },
  },
  spot: {
    botType: "spot_grid",
    params: { symbol: "BTCUSDT", lower_price: "60000", upper_price: "70000", grid_count: 10, grid_spacing: "arithmetic", investment_quote: "1000" },
  },
  xstock: {
    botType: "spot_grid",
    params: { symbol: "BTCUSDT", lower_price: "60000", upper_price: "70000", grid_count: 10, grid_spacing: "arithmetic", investment_quote: "1000" },
  },
};

// Resolve the bot type + seed params for a category (used for bandit selection before planning).
export function defaultBotFor(category: string, template?: string, botParams?: Record<string, unknown>): { botType: string; params: Record<string, unknown> } {
  const def = DEFAULTS[category] ?? DEFAULTS.linear;
  const botType = (botParams?.botType as string) ?? template ?? def.botType;
  const params = { ...def.params, ...((botParams?.params as Record<string, unknown>) ?? {}) };
  return { botType, params };
}

export function buildAndBacktestPlan(input: BuildAndBacktestInput): AgentPlan {
  const autonomy = input.autonomy ?? "L1";
  const interval = input.interval ?? "15";
  // L1 asks approval before create_bot_spec + run_bot_backtest; L2+ runs within caps.
  const needApproval = autonomy === "L1" || autonomy === "L1_5_shadow";

  const def = DEFAULTS[input.category] ?? DEFAULTS.linear;
  const botType = (input.botParams?.botType as string) ?? input.template ?? def.botType;
  const name = (input.botParams?.name as string) ?? `${botType} ${input.symbol}`;
  // Point the bot's own symbol param at the requested symbol; allow caller params to override.
  const params = { ...def.params, symbol: input.symbol, ...((input.botParams?.params as Record<string, unknown>) ?? {}) };
  // bot_cockpit takes the full spec object (it has no stored id yet); build it deterministically.
  const specObject = { bot_type: botType, name, symbols: [input.symbol], params, risk: {}, accounting: {} };

  const steps: PlanStep[] = [
    // Self-provision: backfill the bot's interval from Bybit so new/thin tokens have bars to test on.
    { step_id: "s0_ensure", tool: "ensure_candles", rationale: "Ensure candle coverage exists for this symbol+interval (backfills if needed).", params: { symbol: input.symbol, category: input.category, interval, minBars: 400 }, requires_approval: false, expected_artifact: "none" },
    { step_id: "s1_coverage", tool: "data_coverage", rationale: "Confirm we have enough candle coverage before backtesting.", params: { symbol: input.symbol, category: input.category, interval }, requires_approval: false, expected_artifact: "none" },
    { step_id: "s2_spec", tool: "create_bot_spec", rationale: "Create the bot spec from the user's goal.", params: { botType, name, symbols: [input.symbol], params }, requires_approval: needApproval, expected_artifact: "bot_spec" },
    // Thread the persisted spec id (create_bot_spec returns { botSpecId }) into validate + backtest.
    { step_id: "s3_validate", tool: "validate_bot_spec", rationale: "Validate the stored spec before running.", params: { id: { $from: "s2_spec", path: "botSpecId" } }, requires_approval: false, expected_artifact: "none" },
    { step_id: "s4_risk", tool: "bot_cockpit", rationale: "A-priori risk cockpit: surface risk_class and any hard_blocks.", params: { spec: specObject }, requires_approval: false, expected_artifact: "none" },
    // Fetch the actual candles (full=true so the bars array isn't summarized) to feed the backtest.
    { step_id: "s5_bars", tool: "get_candles", rationale: "Fetch OHLCV bars for the backtest window.", params: { symbol: input.symbol, category: input.category, interval, limit: 1000, full: true }, requires_approval: false, expected_artifact: "none" },
    { step_id: "s6_backtest", tool: "run_bot_backtest", rationale: "Run the backtest with full fill-model honesty.", params: { botSpecId: { $from: "s2_spec", path: "botSpecId" }, symbol: input.symbol, category: input.category, interval_minutes: Number(interval), bars: { $from: "s5_bars", path: "bars" } }, requires_approval: needApproval, expected_artifact: "backtest_run" },
  ];

  const approvalGates = needApproval ? ["s2_spec", "s6_backtest"] : [];

  return {
    plan_id: `plan_${randomUUID()}`,
    goal_type: "user_request",
    owner_id: input.ownerId,
    thread_id: input.threadId,
    autonomy_level: autonomy,
    playbook_id: "build_and_backtest_bot",
    symbol: input.symbol,
    category: input.category,
    execution_fidelity: "bar_based",
    steps,
    approval_gates: approvalGates,
    budgets: {
      max_tokens: config.maxOutputTokensPerStep * 8,
      max_steps: 8,
      max_runs: 1,
      max_sweeps: 0,
      max_live_sessions: 0,
      max_cost_micro_usd: Math.round(config.maxCostPerRunUsd * USD_TO_MICRO),
    },
    stop_conditions: ["risk hard block present", "coverage below floor", "validation failed", "budget exhausted"],
    expected_artifacts: ["bot_spec", "backtest_run"],
    safety_notes: "", // determinism defaults are NOT changed by this plan, so no notes are required.
  };
}
