import { AUTONOMY_RANK, type AgentPlan } from "../orchestrator/plan.js";
import { getPlaybook } from "../playbooks/registry.js";
import {
  isMutating, isLivePaperStart, isPublish, isManagedEntry,
  OPTIMIZER_TOOLS, BACKTEST_TOOLS, DETERMINISM_TOGGLE_PARAMS,
} from "../playbooks/toolClasses.js";
import { validateExitPolicy } from "../positions/exitPolicy.js";

// Guardrails (Phase 4). A plan must pass ALL of these before any step executes. This is where the
// hard safety rules live: allowlist, autonomy floors, budget caps, approval gates, determinism
// protection, and "web can never trade".

export type Decision = "allow" | "needs_approval" | "blocked";

export interface StepDecision {
  step_id: string;
  tool: string;
  decision: Decision;
  reason?: string;
}

export interface Violation {
  code: string;
  message: string;
  step_id?: string;
}

export interface GuardrailResult {
  ok: boolean;
  decisions: StepDecision[];
  violations: Violation[];
}

export interface ValidateOptions {
  // Optional MCP param validation: resolver returns the known input-param keys for a tool (from
  // describe_tool). Unknown params ⇒ rejected. If it returns null, that tool's params aren't checked.
  paramSchemaResolver?: (tool: string) => Promise<string[] | null> | string[] | null;
}

export async function validatePlan(plan: AgentPlan, opts: ValidateOptions = {}): Promise<GuardrailResult> {
  const violations: Violation[] = [];
  const decisions: StepDecision[] = [];
  const add = (code: string, message: string, step_id?: string) => violations.push({ code, message, step_id });

  const playbook = getPlaybook(plan.playbook_id);
  if (!playbook) {
    return { ok: false, decisions: [], violations: [{ code: "UNKNOWN_PLAYBOOK", message: `no playbook '${plan.playbook_id}'` }] };
  }

  // Plan-level: autonomy floor.
  if (AUTONOMY_RANK[plan.autonomy_level] < AUTONOMY_RANK[playbook.minAutonomy]) {
    add("BELOW_MIN_AUTONOMY", `playbook requires ≥ ${playbook.minAutonomy}, plan is ${plan.autonomy_level}`);
  }

  // Plan-level: required inputs (present on the plan or in some step's params).
  for (const input of playbook.requiredInputs) {
    const onPlan = (plan as Record<string, unknown>)[input] != null;
    const inStep = plan.steps.some((s) => s.params[input] != null);
    if (!onPlan && !inStep) add("MISSING_REQUIRED_INPUT", `required input '${input}' missing`);
  }

  // Plan-level: budget caps.
  if (plan.steps.length > plan.budgets.max_steps) {
    add("OVER_BUDGET", `steps ${plan.steps.length} > max_steps ${plan.budgets.max_steps}`);
  }
  const runs = plan.steps.filter((s) => BACKTEST_TOOLS.has(s.tool)).length;
  if (runs > plan.budgets.max_runs) add("OVER_BUDGET", `runs ${runs} > max_runs ${plan.budgets.max_runs}`);
  const sweeps = plan.steps.filter((s) => OPTIMIZER_TOOLS.has(s.tool)).length;
  if (sweeps > plan.budgets.max_sweeps) add("OVER_BUDGET", `sweeps ${sweeps} > max_sweeps ${plan.budgets.max_sweeps}`);
  const lives = plan.steps.filter((s) => isLivePaperStart(s.tool)).length;
  if (lives > plan.budgets.max_live_sessions) add("OVER_BUDGET", `live sessions ${lives} > max_live_sessions ${plan.budgets.max_live_sessions}`);

  const webTrigger = plan.goal_type === "trigger" && (plan.trigger_ref ?? "").startsWith("web:");
  const noSafetyNotes = plan.safety_notes.trim() === "";

  // Phase 17 — NO NAKED ENTRY. Any plan that opens a managed position (start_live_paper) MUST carry a
  // valid exit_policy: a stop-loss plus a well-formed take-profit/trailing/time config. A position can
  // never exist without its consequences. This is the structural form of "trades with consequences".
  const opensPosition = plan.steps.some((s) => isManagedEntry(s.tool));
  if (opensPosition) {
    if (plan.exit_policy == null) {
      add("NAKED_ENTRY_FORBIDDEN", "a plan that opens a position must declare an exit_policy (stop-loss + exits)");
    } else {
      const v = validateExitPolicy(plan.exit_policy);
      if (!v.ok) add("INVALID_EXIT_POLICY", v.reason ?? "invalid exit_policy");
    }
  }

  for (const step of plan.steps) {
    let decision: Decision = "allow";
    let reason: string | undefined;
    let blocked = false;
    const block = (code: string, message: string) => {
      decision = "blocked";
      blocked = true;
      reason = code;
      add(code, message, step.step_id);
    };

    // 1. Allowlist.
    if (!playbook.allowedTools.includes(step.tool)) {
      block("TOOL_NOT_IN_ALLOWLIST", `tool '${step.tool}' not allowed in playbook ${playbook.id}`);
    }
    // 2. L0 may not mutate.
    else if (plan.autonomy_level === "L0" && isMutating(step.tool)) {
      block("MUTATION_IN_L0", `mutating tool '${step.tool}' not allowed at L0`);
    }
    // 3. Live-paper start requires ≥ L2.
    else if (isLivePaperStart(step.tool) && AUTONOMY_RANK[plan.autonomy_level] < AUTONOMY_RANK["L2"]) {
      block("LIVE_PAPER_REQUIRES_L2", `live-paper start needs ≥ L2, plan is ${plan.autonomy_level}`);
    }
    // 4. Publish always requires explicit approval (declared gate + requires_approval).
    else if (isPublish(step.tool) && !(step.requires_approval && plan.approval_gates.includes(step.step_id))) {
      block("PUBLISH_REQUIRES_APPROVAL", `publish tool '${step.tool}' requires an explicit approval gate`);
    }
    // 5. Web-triggered plans may never run trading/mutating actions.
    else if (webTrigger && isMutating(step.tool)) {
      block("WEB_TRIGGER_NO_TRADE", `web-triggered plan cannot run mutating tool '${step.tool}'`);
    } else {
      // Approval logic (publish already handled above as an always-approval hard rule).
      const inApprovalSet = step.requires_approval && plan.approval_gates.includes(step.step_id);
      const playbookWantsApproval = playbook.approvalRequiredTools.includes(step.tool);
      const atCapsAutonomy = AUTONOMY_RANK[plan.autonomy_level] >= AUTONOMY_RANK["L2"];

      if (playbookWantsApproval) {
        // L1 must approve these tools; L2+ may auto-run within caps (brief: "L2 can run within caps").
        if (!atCapsAutonomy && !inApprovalSet) {
          block("APPROVAL_REQUIRED", `tool '${step.tool}' requires approval at ${plan.autonomy_level}`);
        } else if (inApprovalSet) {
          decision = "needs_approval";
          reason = "APPROVAL_REQUIRED";
        }
      } else if (step.requires_approval) {
        if (!plan.approval_gates.includes(step.step_id)) {
          block("APPROVAL_GATE_NOT_DECLARED", `step '${step.step_id}' is requires_approval but not in approval_gates`);
        } else {
          decision = "needs_approval";
          reason = "APPROVAL_REQUIRED";
        }
      }
    }

    // 6. Determinism / fidelity toggle requires safety_notes (any decision).
    const togglesDeterminism = Object.keys(step.params).some((k) => DETERMINISM_TOGGLE_PARAMS.has(k));
    if (togglesDeterminism && noSafetyNotes) {
      add("DETERMINISM_TOGGLE_NEEDS_NOTES", `step '${step.step_id}' toggles determinism/fidelity without safety_notes`, step.step_id);
      if (!blocked) {
        decision = "blocked";
        blocked = true;
        reason = "DETERMINISM_TOGGLE_NEEDS_NOTES";
      }
    }

    // 7. MCP param validation (optional).
    if (!blocked && opts.paramSchemaResolver) {
      const known = await opts.paramSchemaResolver(step.tool);
      if (known) {
        const unknown = Object.keys(step.params).filter((k) => !known.includes(k));
        if (unknown.length) {
          block("INVALID_TOOL_PARAMS", `unknown params for '${step.tool}': ${unknown.join(", ")}`);
        }
      }
    }

    decisions.push({ step_id: step.step_id, tool: step.tool, decision, reason });
  }

  return { ok: violations.length === 0, decisions, violations };
}
