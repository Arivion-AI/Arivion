import { randomUUID } from "node:crypto";
import { config, USD_TO_MICRO } from "../config.js";
import type { AgentPlan, AutonomyLevel } from "../orchestrator/plan.js";
import type { ExitPolicy } from "./exitPolicy.js";

// Phase 17 — typed plans for the position lifecycle. Both go through the same guardrails + Truth Card
// as everything else; no free-form tool chains.

export interface OpenPositionInput {
  ownerId: number;
  threadId: string;
  botId: string;
  symbol: string;
  category: "spot" | "linear" | "xstock";
  exitPolicy: ExitPolicy;
  autonomy?: AutonomyLevel; // L2 auto-runs; L1 asks approval before start_live_paper
  maxRuntimeSeconds?: number;
  investmentQuote?: number;
}

// open_managed_position: read the spec, then open a capped live-paper session. The exit_policy rides
// on the plan so the NO-NAKED-ENTRY guardrail can enforce that consequences are bound at entry.
export function buildOpenPositionPlan(input: OpenPositionInput): AgentPlan {
  const autonomy = input.autonomy ?? "L2";
  const needApproval = autonomy === "L1" || autonomy === "L1_5_shadow";
  return {
    plan_id: `plan_${randomUUID()}`,
    goal_type: "user_request",
    owner_id: input.ownerId,
    thread_id: input.threadId,
    autonomy_level: autonomy,
    playbook_id: "open_managed_position",
    symbol: input.symbol,
    category: input.category,
    execution_fidelity: "bar_based",
    steps: [
      { step_id: "s1_spec", tool: "get_bot_spec", rationale: "Load the bot spec before opening a live-paper position.", params: { bot_id: input.botId }, requires_approval: false, expected_artifact: "none" },
      { step_id: "s2_open", tool: "start_live_paper", rationale: "Open the capped live-paper position.", params: { bot_id: input.botId, max_runtime_seconds: input.maxRuntimeSeconds ?? 86400, investment_quote: input.investmentQuote ?? 1000 }, requires_approval: needApproval, expected_artifact: "session" },
    ],
    approval_gates: needApproval ? ["s2_open"] : [],
    budgets: {
      max_tokens: config.maxOutputTokensPerStep * 4,
      max_steps: 4,
      max_runs: 0,
      max_sweeps: 0,
      max_live_sessions: 1,
      max_cost_micro_usd: Math.round(config.maxCostPerRunUsd * USD_TO_MICRO),
    },
    stop_conditions: ["no exit policy", "risk halted", "budget exhausted"],
    expected_artifacts: ["session"],
    safety_notes: "Managed entry: exit consequences are bound at entry and enforced by the monitor.",
    exit_policy: input.exitPolicy,
  };
}

// manage_position: close the live-paper session. Pre-authorized (no approval) — the user signed off
// on the exit policy at entry, and a protective exit must never wait on a human.
export function buildClosePositionPlan(input: {
  ownerId: number;
  threadId: string;
  sessionId: string;
  symbol?: string;
  category?: "spot" | "linear" | "xstock";
  reason: string;
}): AgentPlan {
  return {
    plan_id: `plan_${randomUUID()}`,
    goal_type: "scheduled",
    owner_id: input.ownerId,
    thread_id: input.threadId,
    autonomy_level: "L2",
    playbook_id: "manage_position",
    symbol: input.symbol,
    category: input.category,
    execution_fidelity: "bar_based",
    steps: [
      { step_id: "s1_stop", tool: "stop_live_paper", rationale: `Autonomous exit: ${input.reason}.`, params: { session_id: input.sessionId }, requires_approval: false, expected_artifact: "session" },
    ],
    approval_gates: [],
    budgets: {
      max_tokens: config.maxOutputTokensPerStep * 2,
      max_steps: 2,
      max_runs: 0,
      max_sweeps: 0,
      max_live_sessions: 0,
      max_cost_micro_usd: Math.round(config.maxCostPerRunUsd * USD_TO_MICRO),
    },
    stop_conditions: ["position closed"],
    expected_artifacts: ["session"],
    safety_notes: "Autonomous protective exit, pre-authorized by the entry exit_policy.",
  };
}
