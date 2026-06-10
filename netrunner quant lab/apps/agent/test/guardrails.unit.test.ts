import { describe, expect, test } from "vitest";
import { parsePlan, AgentPlanSchema, type AgentPlan } from "../src/orchestrator/plan.js";
import { validatePlan } from "../src/guardrails/index.js";

// Build a baseline VALID build_and_backtest_bot plan (L1), then mutate per test.
function basePlan(over: Partial<AgentPlan> = {}): AgentPlan {
  const plan: AgentPlan = {
    plan_id: "plan_1",
    goal_type: "user_request",
    owner_id: 1,
    thread_id: "thr_1",
    autonomy_level: "L1",
    playbook_id: "build_and_backtest_bot",
    symbol: "BTCUSDT",
    category: "linear",
    execution_fidelity: "bar_based",
    steps: [
      { step_id: "s1", tool: "data_coverage", rationale: "check coverage", params: { symbol: "BTCUSDT" }, requires_approval: false, expected_artifact: "none" },
      { step_id: "s2", tool: "create_bot_spec", rationale: "build spec", params: { symbol: "BTCUSDT" }, requires_approval: true, expected_artifact: "bot_spec" },
      { step_id: "s3", tool: "bot_cockpit", rationale: "risk", params: {}, requires_approval: false, expected_artifact: "none" },
      { step_id: "s4", tool: "run_bot_backtest", rationale: "backtest", params: {}, requires_approval: true, expected_artifact: "backtest_run" },
    ],
    approval_gates: ["s2", "s4"],
    budgets: { max_tokens: 100000, max_steps: 10, max_runs: 2, max_sweeps: 0, max_live_sessions: 0, max_cost_micro_usd: 1000000 },
    stop_conditions: ["risk hard block"],
    expected_artifacts: ["bot_spec", "backtest_run"],
    safety_notes: "",
    trigger_ref: undefined,
    ...over,
  };
  return plan;
}

describe("plan schema", () => {
  test("a well-formed plan parses", () => {
    expect(() => parsePlan(basePlan())).not.toThrow();
  });
  test("a malformed plan is rejected (missing required field)", () => {
    const bad = { ...basePlan(), autonomy_level: "L9" };
    expect(AgentPlanSchema.safeParse(bad).success).toBe(false);
  });
  test("a plan with zero steps is rejected", () => {
    expect(AgentPlanSchema.safeParse({ ...basePlan(), steps: [] }).success).toBe(false);
  });
});

describe("guardrails", () => {
  test("valid plan passes with approval gates flagged", async () => {
    const r = await validatePlan(basePlan());
    expect(r.ok).toBe(true);
    const s2 = r.decisions.find((d) => d.step_id === "s2")!;
    expect(s2.decision).toBe("needs_approval");
    const s1 = r.decisions.find((d) => d.step_id === "s1")!;
    expect(s1.decision).toBe("allow");
  });

  test("L2 can run create/backtest within caps without per-step approval", async () => {
    const plan = basePlan({ autonomy_level: "L2" });
    for (const s of plan.steps) s.requires_approval = false;
    plan.approval_gates = [];
    const r = await validatePlan(plan);
    expect(r.ok).toBe(true);
    expect(r.decisions.every((d) => d.decision === "allow")).toBe(true);
  });

  test("out-of-allowlist tool is blocked", async () => {
    const plan = basePlan();
    plan.steps[0].tool = "optimizer_sweep"; // not in build_and_backtest_bot allowlist
    const r = await validatePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "TOOL_NOT_IN_ALLOWLIST")).toBe(true);
  });

  test("over-budget plan is blocked", async () => {
    const plan = basePlan({ budgets: { max_tokens: 1, max_steps: 2, max_runs: 0, max_sweeps: 0, max_live_sessions: 0, max_cost_micro_usd: 0 } });
    const r = await validatePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "OVER_BUDGET")).toBe(true);
  });

  test("mutating tool at L0 is blocked", async () => {
    const plan = basePlan({ autonomy_level: "L0" });
    const r = await validatePlan(plan);
    expect(r.ok).toBe(false);
    // create_bot_spec + run_bot_backtest are mutating; also below min autonomy.
    expect(r.violations.some((v) => v.code === "MUTATION_IN_L0")).toBe(true);
  });

  test("live-paper start below L2 is blocked", async () => {
    const plan = basePlan({
      playbook_id: "start_live_paper_session",
      autonomy_level: "L1",
      steps: [{ step_id: "s1", tool: "start_live_paper", rationale: "go", params: { bot_id: "b1" }, requires_approval: true, expected_artifact: "session" }],
      approval_gates: ["s1"],
    });
    const r = await validatePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "LIVE_PAPER_REQUIRES_L2" || v.code === "BELOW_MIN_AUTONOMY")).toBe(true);
  });

  test("publish without an approval gate is blocked", async () => {
    const plan = basePlan({
      playbook_id: "publish_verified_result",
      autonomy_level: "L2",
      steps: [{ step_id: "s1", tool: "publish_passport", rationale: "publish", params: { passport_id: "p1" }, requires_approval: false, expected_artifact: "passport" }],
      approval_gates: [],
    });
    const r = await validatePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "PUBLISH_REQUIRES_APPROVAL")).toBe(true);
  });

  test("publish WITH an approval gate resolves to needs_approval", async () => {
    const plan = basePlan({
      playbook_id: "publish_verified_result",
      autonomy_level: "L2",
      steps: [{ step_id: "s1", tool: "publish_passport", rationale: "publish", params: { passport_id: "p1" }, requires_approval: true, expected_artifact: "passport" }],
      approval_gates: ["s1"],
    });
    const r = await validatePlan(plan);
    expect(r.ok).toBe(true);
    expect(r.decisions[0].decision).toBe("needs_approval");
  });

  test("determinism toggle without safety_notes is blocked", async () => {
    const plan = basePlan();
    plan.steps[1].params = { symbol: "BTCUSDT", fill_model: "optimistic_maker" };
    const r = await validatePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "DETERMINISM_TOGGLE_NEEDS_NOTES")).toBe(true);
  });

  test("determinism toggle WITH safety_notes is allowed", async () => {
    const plan = basePlan({ safety_notes: "Switching to optimistic maker fills for sensitivity analysis only." });
    plan.steps[1].params = { symbol: "BTCUSDT", fill_model: "optimistic_maker" };
    const r = await validatePlan(plan);
    expect(r.violations.some((v) => v.code === "DETERMINISM_TOGGLE_NEEDS_NOTES")).toBe(false);
  });

  test("web-triggered plan cannot run a mutating tool", async () => {
    const plan = basePlan({ goal_type: "trigger", trigger_ref: "web:some-article" });
    const r = await validatePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "WEB_TRIGGER_NO_TRADE")).toBe(true);
  });

  test("MCP param validation rejects unknown params", async () => {
    const plan = basePlan();
    plan.steps[0].params = { symbol: "BTCUSDT", bogus_param: 1 };
    const resolver = (tool: string) => (tool === "data_coverage" ? ["symbol", "category", "interval"] : null);
    const r = await validatePlan(plan, { paramSchemaResolver: resolver });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "INVALID_TOOL_PARAMS")).toBe(true);
  });
});

// Phase 17 — NO NAKED ENTRY. A plan that opens a managed position must carry a valid exit_policy.
function openPositionPlan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    plan_id: "plan_pos",
    goal_type: "user_request",
    owner_id: 1,
    thread_id: "thr_1",
    autonomy_level: "L2",
    playbook_id: "open_managed_position",
    symbol: "BTCUSDT",
    category: "linear",
    execution_fidelity: "bar_based",
    steps: [
      { step_id: "s1_spec", tool: "get_bot_spec", rationale: "load", params: { bot_id: "b1" }, requires_approval: false, expected_artifact: "none" },
      { step_id: "s2_open", tool: "start_live_paper", rationale: "open", params: { bot_id: "b1" }, requires_approval: false, expected_artifact: "session" },
    ],
    approval_gates: [],
    budgets: { max_tokens: 100000, max_steps: 4, max_runs: 0, max_sweeps: 0, max_live_sessions: 1, max_cost_micro_usd: 1000000 },
    stop_conditions: ["no exit policy"],
    expected_artifacts: ["session"],
    safety_notes: "managed entry",
    ...over,
  };
}

describe("no naked entry (Phase 17)", () => {
  test("opening a position without an exit_policy is blocked", async () => {
    const r = await validatePlan(openPositionPlan());
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "NAKED_ENTRY_FORBIDDEN")).toBe(true);
  });

  test("opening WITH a valid exit_policy passes", async () => {
    const r = await validatePlan(openPositionPlan({
      exit_policy: {
        stop_loss: { type: "fixed_pct", value: 0.05 },
        take_profit: { ladder: [{ target_pct: 0.04, reduce_fraction: 0.5 }, { target_pct: 0.08, reduce_fraction: 0.5 }] },
        trailing: { activate_at_pct: 0.04, trail_pct: 0.02, ratchet: true },
      },
    }));
    expect(r.ok).toBe(true);
  });

  test("an invalid exit_policy (descending ladder) is blocked", async () => {
    const r = await validatePlan(openPositionPlan({
      exit_policy: {
        stop_loss: { type: "fixed_pct", value: 0.05 },
        take_profit: { ladder: [{ target_pct: 0.08, reduce_fraction: 0.5 }, { target_pct: 0.04, reduce_fraction: 0.5 }] },
      },
    }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "INVALID_EXIT_POLICY")).toBe(true);
  });

  test("closing a position (manage_position) needs NO exit_policy and no approval", async () => {
    const r = await validatePlan({
      plan_id: "plan_close",
      goal_type: "scheduled",
      owner_id: 1,
      thread_id: "thr_1",
      autonomy_level: "L2",
      playbook_id: "manage_position",
      execution_fidelity: "bar_based",
      steps: [{ step_id: "s1_stop", tool: "stop_live_paper", rationale: "exit", params: { session_id: "sess_1" }, requires_approval: false, expected_artifact: "session" }],
      approval_gates: [],
      budgets: { max_tokens: 1000, max_steps: 2, max_runs: 0, max_sweeps: 0, max_live_sessions: 0, max_cost_micro_usd: 100000 },
      stop_conditions: ["position closed"],
      expected_artifacts: ["session"],
      safety_notes: "autonomous exit",
    });
    expect(r.ok).toBe(true);
    expect(r.decisions[0].decision).toBe("allow");
  });
});
