import { z } from "zod";
import { Registrar, textResult, summarize, summarizeBacktest } from "./registry.js";
import { buildBody, dec, extraField, fullField, barArray, fundingArray } from "./shared.js";

// Strategy/backtest/bot/portfolio/optimizer/recommender — the "build & run" surface.
export function registerBuildTools(r: Registrar): void {
  const api = () => r.clients.api;
  const ctx = () => r.ctx();

  // ---- Strategies & backtests ----
  r.tool("strategies", "create_strategy", "Create a strategy (owner-scoped).",
    { strategyId: z.string(), name: z.string() },
    async (a) => textResult(await api().post("/api/strategies", buildBody(a), ctx())));

  r.tool("strategies", "create_strategy_version", "Add a DSL version to a strategy.",
    { id: z.string().describe("strategyId"), strategyVersionId: z.string(), dsl: z.any(), hash: z.string().optional(), schemaVersion: z.string().optional(), validationReport: z.any().optional() },
    async (a) => textResult(await api().post(`/api/strategies/${encodeURIComponent(String(a.id))}/versions`, buildBody(a, ["full", "extra", "id"]), ctx())));

  r.tool("strategies", "validate_strategy", "Semantic-validate a strategy version (returns valid/errors/warnings/eligibility_label).",
    { version: z.string().describe("strategyVersionId"), mode: z.string().optional(), strategy: z.any().optional(), coverage: z.record(z.any()).optional() },
    async (a) => textResult(await api().post(`/api/strategies/${encodeURIComponent(String(a.version))}/validate`, buildBody(a, ["full", "extra", "version"]), ctx())));

  r.tool("strategies", "run_backtest",
    "SIMPLE single-signal backtest (one {bar_index: side} -> market fill at next open). Directional check only — NOT the full simulator (use run_bot_backtest / run_paper_runtime for that).",
    { strategyVersionId: z.string().optional(), symbol: z.string(), category: z.string().optional(), interval: z.string(), startTs: z.number().int(), endTs: z.number().int(), bars: barArray, fundingRows: fundingArray, signalBarIndex: z.number().int().optional(), side: z.enum(["long", "short"]).optional(), qty: dec.optional(), slippageBpsOneWay: dec.optional(), canonicalRequired: z.boolean().optional(), extra: extraField },
    async (a) => textResult(await api().post("/api/backtests", buildBody(a), ctx())));

  r.tool("strategies", "get_backtest", "Fetch a backtest run + its events.", { runId: z.string(), full: fullField },
    async (a) => textResult(summarize(await api().get(`/api/backtests/${encodeURIComponent(String(a.runId))}`, undefined, ctx()), Boolean(a.full))));

  r.tool("strategies", "get_replay_timeline", "Step-by-step event timeline for a run.", { runId: z.string(), full: fullField },
    async (a) => textResult(summarize(await api().get(`/api/replay/${encodeURIComponent(String(a.runId))}/timeline`, undefined, ctx()), Boolean(a.full))));

  // ---- Paper runtime (full simulator, one-shot) ----
  r.tool("strategies", "run_paper_runtime",
    "Full PaperRuntime one-shot: run an algo strategy over supplied bars with real fills/fees/slippage/risk. Returns performance + fill_model honesty flags. See get_param_help kind=strategy and kind=run_common.",
    { symbol: z.string(), strategy_id: z.string().describe("one of: pmm|avellaneda_stoikov|funding_fade|trend_ema_cross|grid|twap"), strategy_params: z.record(z.any()).optional(), starting_equity: dec.optional(), fee_bps_taker: dec.optional(), fee_bps_maker: dec.optional(), slippage_bps_one_way: dec.optional(), interval_minutes: z.number().int().optional(), risk: z.record(z.any()).optional(), bars: barArray, funding_rows: fundingArray, execution_fidelity: z.enum(["bar_based", "l2_sweep", "l2_queue", "amm_mid_only", "amm_quote_snapshot", "amm_swap_replay", "testnet_actual"]).optional(), data_source: z.enum(["bybit", "dex", "blended", "testnet"]).optional(), venue: z.string().optional(), chain_id: z.number().int().optional(), pool_id: z.string().optional(), route: z.array(z.record(z.any())).optional(), venue_exact: z.boolean().optional(), vip_tier: z.string().optional(), instrument_filter: z.record(z.any()).optional(), extra: extraField },
    async (a) => textResult(summarizeBacktest(
      await api().post("/api/paper/runtime/run", buildBody(a), ctx()),
      { bars: a.bars, symbol: a.symbol, strategy: a.strategy_id },
    )));

  // ---- Bots ----
  r.tool("bots", "create_bot_spec", "Persist a BotSpec. See get_param_help kind=bot id=<bot_type> for params.",
    { botType: z.string(), name: z.string(), symbols: z.array(z.string()), params: z.record(z.any()).optional(), risk: z.record(z.any()).optional(), accounting: z.record(z.any()).optional(), parentBotSpecId: z.string().optional() },
    async (a) => textResult(await api().post("/api/bots/specs", buildBody(a), ctx())));

  r.tool("bots", "get_bot_spec", "Fetch a stored BotSpec.", { id: z.string() },
    async (a) => textResult(await api().get(`/api/bots/specs/${encodeURIComponent(String(a.id))}`, undefined, ctx())));

  r.tool("bots", "validate_bot_spec", "Validate a stored spec: eligibility_labels, risk_class, spec_hash, data_requirements, errors.",
    { id: z.string(), coverage: z.record(z.any()).optional() },
    async (a) => textResult(await api().post(`/api/bots/specs/${encodeURIComponent(String(a.id))}/validate`, buildBody(a, ["full", "extra", "id"]), ctx())));

  r.tool("bots", "bot_cockpit", "A-priori risk cockpit for a spec: risk_score, risk_class, hard_blocks, stress modules.",
    { spec: z.record(z.any()).describe("{bot_type,name,symbols,params,risk,accounting}"), coverage: z.record(z.any()).optional(), requestedTier: z.string().optional() },
    async (a) => textResult(await api().post("/api/bots/cockpit", buildBody(a), ctx())));

  const botRunShape = {
    botSpecId: z.string(), symbol: z.string().optional(), category: z.string().optional(), starting_equity: dec.optional(), risk: z.record(z.any()).optional(), bars: barArray, funding_rows: fundingArray, side_bars: z.record(z.any()).optional(), interval_minutes: z.number().int().optional(), requested_tier: z.string().optional(), fee_bps_taker: dec.optional(), fee_bps_maker: dec.optional(), slippage_bps_one_way: dec.optional(), execution_fidelity: z.enum(["bar_based", "l2_sweep", "l2_queue"]).optional(), allow_fallback: z.boolean().optional(), venue_exact: z.boolean().optional(), vip_tier: z.string().optional(), coverage: z.record(z.any()).optional(), extra: extraField,
  };
  r.tool("bots", "run_bot_backtest", "Run a stored bot as a backtest (full PaperRuntime). Returns final_equity, fills, performance, fill_model, validation.", botRunShape,
    async (a) => textResult(summarizeBacktest(
      await api().post("/api/bots/runs/backtest", buildBody(a), ctx()),
      { bars: a.bars, symbol: a.symbol, strategy: "bot_backtest" },
    )));
  r.tool("bots", "run_bot_paper", "Run a stored bot in paper mode.", botRunShape,
    async (a) => textResult(summarizeBacktest(
      await api().post("/api/bots/runs/paper", buildBody(a), ctx()),
      { bars: a.bars, symbol: a.symbol, strategy: "bot_paper" },
    )));

  // ---- Recommender ----
  r.tool("bots", "recommend_bots", "Detect regime from bars and return ranked bot candidates with seeded params + reason.",
    { bars: barArray, funding_rate_last: dec.optional(), data_complete: z.boolean().optional(), risk_tolerance: z.enum(["low", "moderate", "high"]).optional(), extra: extraField },
    async (a) => textResult(await api().post("/api/bots/recommendations/scan", buildBody(a), ctx())));
  r.tool("bots", "list_recommendations", "List stored recommendations.", {},
    async () => textResult(await api().get("/api/bots/recommendations", undefined, ctx())));

  // ---- Portfolio ----
  r.tool("portfolio", "validate_portfolio", "Validate multi-asset legs + weighting (venue/calendar rules).",
    { legs: z.array(z.record(z.any())), weighting: z.string().optional(), extra: extraField },
    async (a) => textResult(await api().post("/api/portfolio/validate", buildBody(a), ctx())));
  r.tool("portfolio", "run_portfolio",
    "Run the multi-asset portfolio engine. See get_param_help kind=portfolio_weighting. Returns equity_curve, weights_history, rebalances, metrics, risk_state/notes.",
    { legs: z.array(z.record(z.any())).describe("[{symbol,asset_class,category,target_weight,leverage,bars}]"), weighting: z.string().optional(), total_equity: dec.optional(), rebalance_threshold: dec.optional(), lookback_bars: z.number().int().optional(), top_n: z.number().int().optional(), interval_minutes: z.number().int().optional(), risk: z.record(z.any()).optional(), extra: extraField },
    async (a) => textResult(summarize(await api().post("/api/portfolio/run", buildBody(a), ctx()), false)));

  // ---- Optimizer ----
  r.tool("optimizer", "optimizer_run",
    "Event-rescore + rank candidates. Provide candidates[] OR searchSpace{key:{min,max,step}}. Honest robustness (walk_forward/block_bootstrap=not_computed).",
    { strategyVersionId: z.string(), method: z.string().optional(), topN: z.number().int().optional(), thresholds: z.record(z.any()).optional(), candidates: z.array(z.record(z.any())).optional(), searchSpace: z.record(z.any()).optional(), extra: extraField },
    async (a) => textResult(await api().post("/api/optimizer/runs", buildBody(a), ctx())));
  r.tool("optimizer", "get_optimizer_run", "Fetch optimizer run summary + candidates.", { runId: z.string(), full: fullField },
    async (a) => textResult(summarize(await api().get(`/api/optimizer/runs/${encodeURIComponent(String(a.runId))}`, undefined, ctx()), Boolean(a.full))));
  r.tool("optimizer", "optimizer_sweep",
    "Generate candidates from param_space (NOTE: key is 'param_space', not 'space') + base_params and event-rescore each. method in {grid,random,sobol}.",
    { target: z.string().optional(), target_id: z.string().optional(), symbol: z.string().optional(), param_space: z.record(z.any()), base_params: z.record(z.any()).optional(), method: z.enum(["grid", "random", "sobol"]).optional(), bars: barArray, extra: extraField },
    async (a) => textResult(await api().post("/api/optimizer/sweep", buildBody(a), ctx())));
}
