import type { AutonomyLevel } from "../orchestrator/plan.js";

// Typed playbook registry (Phase 4). A playbook is the ONLY way an autonomous tool chain may run:
// it declares exactly which tools are allowed, the minimum autonomy, what needs approval, the stop
// conditions, and which honesty fields the result MUST surface. The guardrails enforce all of this.

export interface Playbook {
  id: string;
  goal: string;
  allowedTools: string[];
  requiredInputs: string[];
  minAutonomy: AutonomyLevel;
  // Tools within this playbook that always require explicit user approval before executing.
  approvalRequiredTools: string[];
  stopConditions: string[];
  requiredHonestyFields: string[];
  failureModes: string[];
}

// Discovery tools every playbook may always call (read-only, no side effects).
const DISCOVERY = ["list_capabilities", "describe_tool", "get_param_help", "explain_error"];

export const PLAYBOOKS: Record<string, Playbook> = {
  build_and_backtest_bot: {
    id: "build_and_backtest_bot",
    goal: "Build a bot spec from a user goal and run an honest backtest, surfacing full fidelity.",
    allowedTools: [
      ...DISCOVERY,
      "data_coverage", "find_data_gaps", "ensure_candles", "get_candles",
      "list_symbols", "list_bot_templates",
      "create_bot_spec", "get_bot_spec", "validate_bot_spec",
      "bot_cockpit", "run_bot_backtest",
    ],
    requiredInputs: ["symbol", "category"],
    minAutonomy: "L1",
    approvalRequiredTools: ["create_bot_spec", "run_bot_backtest"],
    stopConditions: [
      "risk hard block present", "coverage below floor", "budget exhausted", "validation failed",
    ],
    requiredHonestyFields: ["fill_model", "coverage_proof", "result_tier", "risk_class", "hard_blocks"],
    failureModes: ["MISSING_COVERAGE", "RISK_HARD_BLOCK", "VALIDATION_FAILED", "OVER_BUDGET"],
  },

  optimize_existing_bot: {
    id: "optimize_existing_bot",
    goal: "Optimize an existing bot's parameters within capped sweeps.",
    allowedTools: [...DISCOVERY, "get_bot_spec", "bot_cockpit", "optimizer_run", "optimizer_sweep", "get_optimizer_run", "run_bot_backtest"],
    requiredInputs: ["bot_id"],
    minAutonomy: "L2",
    approvalRequiredTools: ["optimizer_sweep"],
    stopConditions: ["max_sweeps reached", "budget exhausted", "no improvement"],
    requiredHonestyFields: ["fill_model", "coverage_proof", "result_tier"],
    failureModes: ["OVER_BUDGET", "OPTIMIZER_DISABLED", "NO_IMPROVEMENT"],
  },

  start_live_paper_session: {
    id: "start_live_paper_session",
    goal: "Start a capped live-paper session for an approved bot (L2+).",
    allowedTools: [...DISCOVERY, "get_bot_spec", "bot_cockpit", "start_live_paper", "list_live_paper_sessions", "stop_live_paper"],
    requiredInputs: ["bot_id"],
    minAutonomy: "L2",
    approvalRequiredTools: ["start_live_paper"],
    stopConditions: ["max runtime", "auto-stop condition", "budget exhausted", "recovery_blocked"],
    requiredHonestyFields: ["execution_fidelity", "result_tier"],
    failureModes: ["SESSION_CAP", "RECOVERY_BLOCKED", "BELOW_L2"],
  },

  // Phase 17 — the "living trader" entry path. Opens a capped live-paper position AND binds its exit
  // consequences (the guardrail forbids this playbook from running without a valid exit_policy).
  // Human-in-the-loop at ENTRY (start_live_paper needs approval at L1; auto at L2 within caps), then
  // the monitor manages the exit autonomously per the policy the user signed off on.
  open_managed_position: {
    id: "open_managed_position",
    goal: "Open a capped live-paper position with its stop-loss / take-profit / trailing / time exit bound at entry.",
    allowedTools: [...DISCOVERY, "get_bot_spec", "bot_cockpit", "data_coverage", "get_candles", "start_live_paper", "list_live_paper_sessions"],
    requiredInputs: ["bot_id"],
    minAutonomy: "L2",
    approvalRequiredTools: ["start_live_paper"],
    stopConditions: ["no exit policy", "risk halted", "budget exhausted", "recovery_blocked"],
    requiredHonestyFields: ["execution_fidelity", "result_tier"],
    failureModes: ["NAKED_ENTRY_FORBIDDEN", "RISK_HALTED", "SESSION_CAP", "BELOW_L2"],
  },

  // Phase 17 — autonomous exit. Fired by the position monitor when an open position hits its bound
  // stop/TP/trailing/time/max-loss condition. Pre-authorized: the user approved the exit policy at
  // entry, so closing for safety needs no fresh approval (and is never blocked by the daily run cap).
  manage_position: {
    id: "manage_position",
    goal: "Close or reduce an open managed position when its bound exit condition is hit.",
    allowedTools: [...DISCOVERY, "get_bot_spec", "bot_cockpit", "list_live_paper_sessions", "stop_live_paper"],
    requiredInputs: ["session_id"],
    minAutonomy: "L2",
    approvalRequiredTools: [],
    stopConditions: ["position closed", "session not found"],
    requiredHonestyFields: ["execution_fidelity"],
    failureModes: ["SESSION_NOT_FOUND", "STOP_FAILED"],
  },

  inspect_drawdown: {
    id: "inspect_drawdown",
    goal: "Read-only investigation of a bot/session drawdown.",
    allowedTools: [...DISCOVERY, "get_bot_spec", "get_backtest", "list_trades", "get_replay_timeline", "bot_cockpit", "data_coverage"],
    requiredInputs: [],
    minAutonomy: "L0",
    approvalRequiredTools: [],
    stopConditions: ["analysis complete"],
    requiredHonestyFields: ["result_tier"],
    failureModes: ["NOT_FOUND"],
  },

  regime_flip_review: {
    id: "regime_flip_review",
    goal: "Read-only review of a regime flip and its effect on strategies.",
    allowedTools: [...DISCOVERY, "list_regimes", "load_regime", "get_regime_bars", "data_coverage"],
    requiredInputs: [],
    minAutonomy: "L0",
    approvalRequiredTools: [],
    stopConditions: ["analysis complete"],
    requiredHonestyFields: [],
    failureModes: ["NOT_FOUND"],
  },

  funding_extreme_scan: {
    id: "funding_extreme_scan",
    goal: "Read-only scan for funding-rate extremes.",
    allowedTools: [...DISCOVERY, "list_symbols", "data_coverage", "get_regime_bars"],
    requiredInputs: [],
    minAutonomy: "L0",
    approvalRequiredTools: [],
    stopConditions: ["scan complete"],
    requiredHonestyFields: [],
    failureModes: ["NO_DATA"],
  },

  volatility_spike_review: {
    id: "volatility_spike_review",
    goal: "Read-only review of a volatility spike.",
    allowedTools: [...DISCOVERY, "data_coverage", "get_regime_bars", "get_candles"],
    requiredInputs: [],
    minAutonomy: "L0",
    approvalRequiredTools: [],
    stopConditions: ["review complete"],
    requiredHonestyFields: [],
    failureModes: ["NO_DATA"],
  },

  coverage_repair: {
    id: "coverage_repair",
    goal: "Repair data coverage gaps before a backtest (capped backfill).",
    allowedTools: [...DISCOVERY, "data_coverage", "find_data_gaps", "ensure_candles", "backfill_job", "backfill_queue"],
    requiredInputs: ["symbol"],
    minAutonomy: "L1",
    approvalRequiredTools: ["ensure_candles", "backfill_job"],
    stopConditions: ["coverage restored", "budget exhausted"],
    requiredHonestyFields: ["coverage_proof"],
    failureModes: ["BACKFILL_FAILED", "OVER_BUDGET"],
  },

  publish_verified_result: {
    id: "publish_verified_result",
    goal: "Publish a verified result/passport — always requires explicit approval.",
    allowedTools: [...DISCOVERY, "get_backtest", "verify_passport_direct", "publish_passport", "marketplace_publish"],
    requiredInputs: ["passport_id"],
    minAutonomy: "L2",
    approvalRequiredTools: ["publish_passport", "marketplace_publish"],
    stopConditions: ["not verified", "approval denied"],
    requiredHonestyFields: ["result_tier", "fill_model"],
    failureModes: ["NOT_VERIFIED", "APPROVAL_DENIED"],
  },

  // Phase 18 — multi-asset basket. Backtest + cross-validate a basket across scenarios.
  build_and_backtest_multiasset: {
    id: "build_and_backtest_multiasset",
    goal: "Validate + backtest a multi-asset basket (and cross-validate across bull/bear regimes).",
    allowedTools: [...DISCOVERY, "data_coverage", "list_symbols", "get_candles", "list_regimes", "get_regime_bars", "validate_portfolio", "run_portfolio", "optimizer_sweep"],
    requiredInputs: [],
    minAutonomy: "L1",
    approvalRequiredTools: ["run_portfolio", "optimizer_sweep"],
    stopConditions: ["validation failed", "budget exhausted"],
    requiredHonestyFields: ["result_tier"],
    failureModes: ["PORTFOLIO_VALIDATION_FAILED", "INSUFFICIENT_BARS", "OVER_BUDGET"],
  },

  // Phase 18 — go-live: open a forward multi-asset paper session (the basket's own risk gates apply).
  setup_multiasset_paper: {
    id: "setup_multiasset_paper",
    goal: "Start a forward multi-asset (portfolio) paper session for a confirmed, backtested basket.",
    allowedTools: [...DISCOVERY, "validate_portfolio", "list_live_paper_sessions", "start_multiasset_paper", "stop_multiasset_paper", "list_multiasset_paper_sessions"],
    requiredInputs: ["legs"],
    minAutonomy: "L2",
    approvalRequiredTools: ["start_multiasset_paper"],
    stopConditions: ["session started", "validation failed", "budget exhausted"],
    requiredHonestyFields: ["execution_fidelity"],
    failureModes: ["PORTFOLIO_VALIDATION_FAILED", "BELOW_L2", "SESSION_CAP"],
  },

  web_research_note: {
    id: "web_research_note",
    goal: "Produce a structured, quarantined research note from web sources (no trading actions).",
    allowedTools: [...DISCOVERY], // web tools are agent-native, added in Phase 13; never trading tools
    requiredInputs: ["query"],
    minAutonomy: "L1",
    approvalRequiredTools: [],
    stopConditions: ["note produced"],
    requiredHonestyFields: [],
    failureModes: ["NO_SOURCES"],
  },

  memory_reflection: {
    id: "memory_reflection",
    goal: "Reflect over prior episodes to produce semantic insights (read-only over memory).",
    allowedTools: [...DISCOVERY],
    requiredInputs: [],
    minAutonomy: "L1",
    approvalRequiredTools: [],
    stopConditions: ["reflection complete"],
    requiredHonestyFields: [],
    failureModes: ["NO_EPISODES"],
  },
};

export function getPlaybook(id: string): Playbook | undefined {
  return PLAYBOOKS[id];
}
