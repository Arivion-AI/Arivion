import { randomUUID } from "node:crypto";
import { config, USD_TO_MICRO } from "../config.js";
import type { AgentPlan, AutonomyLevel, PlanStep } from "../orchestrator/plan.js";

// Read-only "review" plans fired by triggers (Phase 4). They never mutate anything — they surface
// what the agent sees (regime-appropriate bot candidates, coverage, drawdown) so the user can decide.
// All tools used are read-only and in the playbook allowlist (see playbooks/registry.ts).

export interface ReviewInput {
  ownerId: number;
  threadId: string;
  playbook: string; // volatility_spike_review|regime_flip_review|funding_extreme_scan|inspect_drawdown|coverage_repair
  symbol: string;
  category: "spot" | "linear" | "xstock";
  regime?: string;
  interval?: string;
  autonomy?: AutonomyLevel;
}

export function buildReviewPlan(input: ReviewInput): AgentPlan {
  const interval = input.interval ?? "15";
  const autonomy = input.autonomy ?? "L1";
  // Uniform read-only review: confirm data coverage for the symbol. data_coverage is in every trigger
  // playbook's allowlist, takes no prior artifact, and is side-effect free — a safe, always-executable
  // review step that proves the trigger → plan → execute path. (Richer per-trigger analysis is a
  // fast-follow that only widens the allowlist.)
  const steps: PlanStep[] = [
    { step_id: "s1_coverage", tool: "data_coverage", rationale: `Review ${input.playbook}: confirm data coverage for ${input.symbol}.`, params: { symbol: input.symbol, category: input.category, interval }, requires_approval: false, expected_artifact: "none" },
  ];

  return {
    plan_id: `plan_${randomUUID()}`,
    goal_type: "trigger",
    owner_id: input.ownerId,
    thread_id: input.threadId,
    autonomy_level: autonomy,
    playbook_id: input.playbook,
    symbol: input.symbol,
    category: input.category,
    execution_fidelity: "bar_based",
    steps,
    approval_gates: [],
    budgets: {
      max_tokens: config.maxOutputTokensPerStep * 4,
      max_steps: 4,
      max_runs: 0,
      max_sweeps: 0,
      max_live_sessions: 0,
      max_cost_micro_usd: Math.round(config.maxCostPerRunUsd * USD_TO_MICRO),
    },
    stop_conditions: ["budget exhausted"],
    expected_artifacts: [],
    safety_notes: "Read-only trigger review; no mutating tools.",
  };
}
