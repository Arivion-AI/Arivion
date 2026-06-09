import { z } from "zod";
import { ExitPolicySchema } from "../positions/exitPolicy.js";

// Typed plan schema (Phase 4). Every autonomous action executes through a typed AgentPlan — there
// are NO free-form autonomous tool chains (core rule). Plans are validated against this schema and
// then against the guardrails before any step runs.

export const AUTONOMY_LEVELS = ["L0", "L1", "L1_5_shadow", "L2", "L3"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

// Monotonic rank for comparisons (L0 lowest).
export const AUTONOMY_RANK: Record<AutonomyLevel, number> = {
  L0: 0,
  L1: 1,
  L1_5_shadow: 2,
  L2: 3,
  L3: 4,
};

export const ExpectedArtifact = z.enum([
  "bot_spec",
  "backtest_run",
  "optimizer_run",
  "passport",
  "session",
  "note",
  "none",
]);

export const PlanStepSchema = z.object({
  step_id: z.string().min(1),
  tool: z.string().min(1),
  rationale: z.string(),
  params: z.record(z.unknown()),
  requires_approval: z.boolean(),
  expected_artifact: ExpectedArtifact,
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const BudgetsSchema = z.object({
  max_tokens: z.number().int().nonnegative(),
  max_steps: z.number().int().positive(),
  max_runs: z.number().int().nonnegative(),
  max_sweeps: z.number().int().nonnegative(),
  max_live_sessions: z.number().int().nonnegative(),
  max_cost_micro_usd: z.number().int().nonnegative(),
});
export type Budgets = z.infer<typeof BudgetsSchema>;

export const AgentPlanSchema = z.object({
  plan_id: z.string().min(1),
  goal_type: z.enum(["user_request", "trigger", "scheduled"]),
  owner_id: z.number().int().positive(),
  thread_id: z.string().min(1),
  autonomy_level: z.enum(AUTONOMY_LEVELS),
  playbook_id: z.string().min(1),
  symbol: z.string().optional(),
  category: z.enum(["spot", "linear", "xstock"]).optional(),
  execution_fidelity: z.enum(["bar_based", "l2_sweep", "l2_queue"]),
  steps: z.array(PlanStepSchema).min(1),
  approval_gates: z.array(z.string()),
  budgets: BudgetsSchema,
  stop_conditions: z.array(z.string()),
  expected_artifacts: z.array(z.string()),
  safety_notes: z.string(),
  trigger_ref: z.string().optional(),
  // Phase 17 — the consequences bound at entry. REQUIRED by the guardrails whenever a step opens a
  // live-paper position (start_live_paper): a managed position can never be opened naked.
  exit_policy: ExitPolicySchema.optional(),
});
export type AgentPlan = z.infer<typeof AgentPlanSchema>;

export function parsePlan(input: unknown): AgentPlan {
  return AgentPlanSchema.parse(input);
}
