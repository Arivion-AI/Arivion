import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { db } from "../db.js";
import { validatePlan } from "../guardrails/index.js";
import { getPlaybook } from "../playbooks/registry.js";
import { buildTruthCard, type TruthCard } from "./truthCard.js";
import type { AgentPlan } from "./plan.js";
import type { NormalizedToolResult } from "../mcp/normalize.js";
import { publish } from "../chat/bus.js";
import { addMessage, addStep, createRun, finishRun, getSteps } from "../chat/store.js";
import { getRunUsage } from "../llm-gateway/usageRecorder.js";
import { recordOutcome } from "../learning/index.js";

// Minimal interface the runner needs from an MCP client (so tests inject a fake).
export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<NormalizedToolResult>;
}

const COVERAGE_FLOOR = 0.9;

export type RunStatus = "completed" | "blocked" | "awaiting_approval" | "error" | "proposed";

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  truthCard?: TruthCard;
  pendingStepId?: string;
  reason?: string;
  violations?: { code: string; message: string; step_id?: string }[];
}

export interface ExecuteOptions {
  plan: AgentPlan;
  mcp: ToolCaller;
  approvals?: Set<string>;
  runId?: string; // resume an existing run (skips already-completed steps)
  agentAction?: string;
}

// Execute a typed plan step-by-step. Guardrails run first; stop conditions (risk hard block,
// coverage floor, validation failure) halt BEFORE any later mutating step. Resumable: re-invoke with
// the approved step added to `approvals` — already-completed steps are skipped (the Lab calls are not
// idempotent, so we never re-run a completed step).
export async function executePlan(opts: ExecuteOptions): Promise<RunOutcome> {
  const { plan, mcp } = opts;
  const approvals = opts.approvals ?? new Set<string>();
  const ownerId = plan.owner_id;

  const guard = await validatePlan(plan);
  const playbook = getPlaybook(plan.playbook_id);

  // Resolve / create the run row.
  const runId =
    opts.runId ??
    (await createRun(ownerId, plan.thread_id, plan.steps.map((s) => s.tool).join(" → "), plan.playbook_id)).id;
  publish(runId, "run.started", { runId, playbook: plan.playbook_id, autonomy: plan.autonomy_level });

  // L0 = propose only. Surface the plan, run nothing.
  if (plan.autonomy_level === "L0") {
    await finishRun(runId, "proposed", 0);
    publish(runId, "run.done", { status: "proposed", plan });
    return { runId, status: "proposed", violations: guard.violations };
  }

  if (!guard.ok) {
    const blocked = guard.violations[0];
    await addStep(ownerId, runId, { stepId: "guardrail", state: "blocked", guardrailDecision: blocked?.code, result: { violations: guard.violations } });
    await finishRun(runId, "blocked", 0);
    publish(runId, "run.error", { code: "GUARDRAIL_BLOCKED", violations: guard.violations });
    return { runId, status: "blocked", reason: blocked?.code, violations: guard.violations };
  }

  const decisionByStep = new Map(guard.decisions.map((d) => [d.step_id, d]));
  // Only steps that actually COMPLETED are skipped on resume — an awaiting_approval/blocked
  // placeholder row must NOT mark a step as done.
  const priorSteps = await getSteps(ownerId, runId);
  const completed = new Set(
    priorSteps
      .filter((s) => (s as { state: string }).state === "completed")
      .map((s) => (s as { step_id: string }).step_id)
      .filter(Boolean),
  );
  // Outputs of completed steps, so a later step can reference an earlier one via a {$from,path} ref
  // in its params (e.g. the botSpecId from create_bot_spec, the bars from get_candles). Rebuilt from
  // the persisted step results so it survives an approval pause + resume.
  const artifacts: Record<string, unknown> = {};
  for (const s of priorSteps) {
    const row = s as { step_id?: string; state?: string; result?: unknown };
    if (row.state === "completed" && row.step_id) artifacts[row.step_id] = row.result;
  }
  const honesty: Record<string, unknown> = {};

  for (const step of plan.steps) {
    if (completed.has(step.step_id)) continue; // resume: never re-run a completed step
    const decision = decisionByStep.get(step.step_id);

    if (decision?.decision === "needs_approval" && !approvals.has(step.step_id)) {
      await addStep(ownerId, runId, { stepId: step.step_id, state: "awaiting_approval", tool: step.tool, rationale: step.rationale, params: step.params, guardrailDecision: "needs_approval" });
      // Durable approval record (Phase 5) so pending approvals are listable/auditable. Idempotent on
      // (run_id, step_id) so a re-entered run doesn't create duplicates.
      await db.query(
        `INSERT INTO agent_approvals (id, run_id, step_id, owner_id, tool, status)
         SELECT $1,$2,$3,$4,$5,'pending'
         WHERE NOT EXISTS (SELECT 1 FROM agent_approvals WHERE run_id=$2 AND step_id=$3)`,
        [`apr_${randomUUID()}`, runId, step.step_id, ownerId, step.tool],
      ).catch(() => {});
      publish(runId, "approval.required", { step_id: step.step_id, tool: step.tool, rationale: step.rationale });
      // Leave the run open for approval — do not finish it.
      return { runId, status: "awaiting_approval", pendingStepId: step.step_id };
    }

    // Resolve any {$from,path} references against earlier steps' outputs just before the call.
    // The unresolved params are what we persist (compact, shows the plan's intent); the resolved
    // params — which may include a large bars array — go only to the tool.
    const resolvedParams = resolveRefs(step.params, artifacts) as Record<string, unknown>;
    publish(runId, "run.step", { step_id: step.step_id, tool: step.tool, state: "running", rationale: step.rationale });
    let result: NormalizedToolResult;
    try {
      result = await mcp.callTool(step.tool, resolvedParams);
    } catch (e) {
      await addStep(ownerId, runId, { stepId: step.step_id, state: "error", tool: step.tool, rationale: step.rationale, params: step.params, guardrailDecision: "allow", result: { error: (e as Error).message } });
      await finishRun(runId, "error", 0);
      publish(runId, "run.error", { code: "TOOL_ERROR", step_id: step.step_id, message: (e as Error).message });
      return { runId, status: "error", reason: "TOOL_ERROR" };
    }

    mergeHonesty(honesty, result.honesty);
    artifacts[step.step_id] = result.raw ?? result.text;
    await addStep(ownerId, runId, {
      stepId: step.step_id, state: result.isError ? "error" : "completed", tool: step.tool,
      rationale: step.rationale, params: step.params, result: result.raw ?? result.text,
      honesty: Object.keys(result.honesty).length ? result.honesty : null, guardrailDecision: "allow",
    });
    publish(runId, "run.step", {
      step_id: step.step_id,
      tool: step.tool,
      state: result.isError ? "error" : "completed",
      honesty: result.honesty,
      result: streamableResult(step.tool, result.raw ?? result.text),
    });

    // --- Stop conditions, evaluated BEFORE the next (possibly mutating) step ---
    if (result.isError) {
      await finishRun(runId, "error", 0);
      publish(runId, "run.error", { code: "TOOL_RESULT_ERROR", step_id: step.step_id, text: result.text });
      return { runId, status: "error", reason: "TOOL_RESULT_ERROR" };
    }
    const blocks = result.honesty.hard_blocks;
    if (Array.isArray(blocks) && blocks.length > 0) {
      return finishBlocked(ownerId, runId, "RISK_HARD_BLOCK", honesty, opts.agentAction, { hard_blocks: blocks });
    }
    if (step.tool === "data_coverage") {
      const cov = coverageValue(result.honesty);
      if (cov !== null && cov < COVERAGE_FLOOR) {
        return finishBlocked(ownerId, runId, "COVERAGE_BELOW_FLOOR", honesty, opts.agentAction, {
          coverage: cov, floor: COVERAGE_FLOOR, suggestion: "run coverage_repair playbook first",
        });
      }
    }
  }

  // All steps done → Truth Card.
  const usage = await getRunUsage(ownerId, runId);
  const card = buildTruthCard({ honesty, agentAction: opts.agentAction ?? `Ran ${playbook?.id ?? plan.playbook_id}`, llmCostMicroUsd: usage.total_credit_debit_micro_usd });
  await addMessage(ownerId, plan.thread_id, "assistant", card.text);
  await finishRun(runId, "completed", usage.total_credit_debit_micro_usd);

  // Phase 3/6 — record the outcome as an episode and update the learned policy. The reward is
  // computed only from the Lab's honesty-gated metrics (never from narration). Guarded so a memory
  // failure never fails a completed run.
  await recordOutcome({ ownerId, runId, plan, honesty, agentAction: opts.agentAction }).catch((e) =>
    logger.warn("outcome recording skipped", { runId, message: (e as Error).message }),
  );

  publish(runId, "truth_card", card);
  publish(runId, "message", { role: "assistant", content: card.text });
  publish(runId, "run.done", { status: "completed", costMicroUsd: usage.total_credit_debit_micro_usd });
  logger.info("playbook completed", { runId, playbook: plan.playbook_id });
  return { runId, status: "completed", truthCard: card };
}

async function finishBlocked(
  ownerId: number, runId: string, code: string, honesty: Record<string, unknown>, agentAction: string | undefined, detail: unknown,
): Promise<RunOutcome> {
  const card = buildTruthCard({ honesty, agentAction: agentAction ?? `Stopped: ${code}`, llmCostMicroUsd: (await getRunUsage(ownerId, runId)).total_credit_debit_micro_usd });
  await addStep(ownerId, runId, { stepId: "stop", state: "blocked", guardrailDecision: code, result: detail });
  await finishRun(runId, "blocked", 0);
  publish(runId, "truth_card", card);
  publish(runId, "run.error", { code, detail });
  return { runId, status: "blocked", reason: code, truthCard: card };
}

// Deep-resolve {$from: "<stepId>", path: "<dot.path>"} references against earlier steps' outputs.
// A bare {$from} (no path) yields the whole artifact. Anything else is returned structurally
// unchanged (arrays/objects walked recursively), so static params pass through untouched.
function resolveRefs(value: unknown, artifacts: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, artifacts));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$from === "string") {
      const src = artifacts[obj.$from];
      return typeof obj.path === "string" ? getPath(src, obj.path) : src;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveRefs(v, artifacts);
    return out;
  }
  return value;
}

function getPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => (acc == null ? undefined : (acc as Record<string, unknown>)[key]), obj);
}

function mergeHonesty(acc: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(next)) {
    if (v !== undefined && v !== null) acc[k] = v;
  }
}

function coverageValue(honesty: Record<string, unknown>): number | null {
  if (typeof honesty.coverage === "number") return honesty.coverage;
  const cp = honesty.coverage_proof as Record<string, unknown> | undefined;
  if (cp && typeof cp.coverage === "number") return cp.coverage;
  return null;
}

function streamableResult(tool: string, result: unknown): unknown {
  if (!["run_bot_backtest", "run_bot_paper", "run_paper_runtime", "run_portfolio"].includes(tool)) return undefined;
  if (typeof result === "string") return result.slice(0, 8000);
  return result;
}
