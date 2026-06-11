import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Guided workflows packaging the lab's end-to-end flows (§20). Each prompt
// returns a message the agent can follow, with the right tool order + caveats.
export function registerPrompts(server: McpServer): void {
  const p = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

  server.registerPrompt(
    "build_and_backtest_strategy",
    {
      title: "Build & backtest an algo strategy",
      description: "Create -> version -> validate -> run on the full PaperRuntime, then read the honesty flags.",
      argsSchema: { strategy_id: z.string().optional(), symbol: z.string().optional() },
    },
    (args) =>
      p(
        `Goal: build and backtest the '${args.strategy_id ?? "<pick one>"}' strategy on ${args.symbol ?? "<symbol>"}.\n` +
          `Steps:\n` +
          `1. get_param_help kind=strategy id=${args.strategy_id ?? "<id>"} to learn the params (defaults/ranges).\n` +
          `2. (optional) create_strategy + create_strategy_version + validate_strategy if you need a stored DSL version.\n` +
          `3. run_paper_runtime {symbol, strategy_id, strategy_params, bars, interval_minutes} — this is the FULL simulator.\n` +
          `4. Read result.fill_model: if maker_fills_optimistic/liquidity_free_upper_bound are true, treat returns as an upper bound; consider l2 fidelity.\n` +
          `Note: run_backtest is only a directional single-signal check, not the simulator.`
      )
  );

  server.registerPrompt(
    "compose_and_run_bot",
    {
      title: "Compose, validate & run a bot",
      description: "Recommend -> create spec -> cockpit -> validate -> backtest -> publish.",
      argsSchema: { bot_type: z.string().optional(), symbol: z.string().optional() },
    },
    (args) =>
      p(
        `Goal: stand up the '${args.bot_type ?? "<bot_type>"}' bot on ${args.symbol ?? "<symbol>"}.\n` +
          `1. (optional) recommend_bots {bars, risk_tolerance} to pick a bot for the current regime.\n` +
          `2. get_param_help kind=bot id=${args.bot_type ?? "<bot_type>"} for the param spec + required fields.\n` +
          `3. create_bot_spec {botType, name, symbols, params}.\n` +
          `4. bot_cockpit {spec} for a-priori risk + hard_blocks; resolve any blocks (explain_error on each code).\n` +
          `5. validate_bot_spec {id} — check eligibility_labels + data_requirements.\n` +
          `6. run_bot_backtest {botSpecId, bars, ...}; inspect performance + fill_model + validation.\n` +
          `7. publish_passport to attempt a verified tier (only passes hard gates + canonical replay).`
      )
  );

  server.registerPrompt(
    "go_live_paper",
    {
      title: "Run a forward live-paper session",
      description: "Start a persistent session, watch it, and handle recovery caveats.",
      argsSchema: { strategy_id: z.string().optional(), symbol: z.string().optional() },
    },
    (args) =>
      p(
        `Goal: forward-paper '${args.strategy_id ?? "<id>"}' on ${args.symbol ?? "<symbol>"}.\n` +
          `1. start_live_paper {strategyId, symbol, params}. It backfills ~3h warmup + subscribes the feed; live_return starts at 0%.\n` +
          `2. stream_snapshot topics=sessions,prices symbols=${args.symbol ?? "<symbol>"} to watch updates (or read duality://live/sessions).\n` +
          `3. list_live_paper_sessions to poll status. If status=recovery_blocked, explain_error RECOVERY_BLOCKED and backfill the candle gap, then resume.\n` +
          `4. stop_live_paper {id} when done.`
      )
  );

  server.registerPrompt(
    "enable_execution_fidelity",
    {
      title: "Upgrade to L2/queue execution fidelity",
      description: "Record L2/trades, re-run with l2_queue, and check the verified-execution gate.",
      argsSchema: { symbol: z.string().optional() },
    },
    (args) =>
      p(
        `Goal: get realistic (non-optimistic) maker fills for ${args.symbol ?? "<symbol>"}.\n` +
          `1. record_l2 {items:[{symbol,category}], enable:true} and record_trades {..., enable:true} (or backfill historical via collect_backfill_l2_archive if internal tools enabled).\n` +
          `2. execution_coverage to confirm execution_fidelity_available.\n` +
          `3. Re-run with execution_fidelity=l2_queue (run_bot_backtest / run_paper_runtime).\n` +
          `4. Read fill_model: l2_provider_used + trade_prints_used + coverage_pct must clear thresholds, else explain_error the downgrade code (e.g. E0_FILL_MODE_BAR_BASED, TRADE_COVERAGE_BELOW_THRESHOLD).`
      )
  );

  server.registerPrompt(
    "multi_asset_portfolio",
    {
      title: "Run a multi-asset portfolio",
      description: "Validate legs + weighting, then run with calendar/RTH rules.",
      argsSchema: {},
    },
    () =>
      p(
        `Goal: run a crypto + xStock portfolio.\n` +
          `1. get_param_help kind=portfolio_weighting for schemes + leg shape + constraints (equity = spot/long/lev-1).\n` +
          `2. validate_portfolio {legs, weighting} — fix any XSTOCK_* codes (explain_error).\n` +
          `3. run_portfolio {legs, weighting, total_equity, rebalance_threshold}. Crypto trades 24/7; equity legs trade RTH-only.\n` +
          `4. Inspect metrics, rebalances, risk_state/risk_notes (ruin floor at zero equity).`
      )
  );
}
