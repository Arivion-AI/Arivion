import { logger } from "../logger.js";
import { connectMcp } from "../mcp/client.js";
import { mintInternalToken } from "../internalToken.js";
import { executePlan } from "../orchestrator/runner.js";
import { createRun, getSteps } from "../chat/store.js";
import { recordBudgetEvent } from "../budget/index.js";
import { getRiskState } from "../risk/index.js";
import { validateExitPolicy, type ExitPolicy } from "./exitPolicy.js";
import { buildOpenPositionPlan } from "./plans.js";
import { openIntent, type PositionIntent } from "./store.js";

// Phase 17 — open a managed position. This is the ONLY entry path that the "living trader" uses: it
// (1) refuses if the risk state blocks new entries, (2) refuses a naked entry (no/invalid exit_policy),
// (3) runs the typed open_managed_position plan (guardrails + approval), then (4) binds the position
// intent so the monitor owns its lifecycle. Entry consequences are inseparable from entry itself.

export interface OpenManagedInput {
  ownerId: number;
  threadId: string;
  botId: string;
  symbol: string;
  category: "spot" | "linear" | "xstock";
  side?: "long" | "short";
  entryPrice: number;
  exitPolicy: ExitPolicy;
  atr?: number;
  autonomy?: "L1" | "L2";
  maxRuntimeSeconds?: number;
  investmentQuote?: number;
  ownerToken?: string;
}

export interface OpenManagedResult {
  status: "opened" | "awaiting_approval" | "blocked";
  runId: string;
  intent?: PositionIntent;
  reason?: string;
}

// Pull a session id out of the start_live_paper step result (shape varies across Lab versions).
function extractSessionId(result: unknown): string | null {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    for (const k of ["session_id", "sessionId", "id", "live_paper_session_id"]) {
      if (typeof r[k] === "string") return r[k] as string;
    }
    if (r.session && typeof (r.session as Record<string, unknown>).id === "string") {
      return (r.session as Record<string, unknown>).id as string;
    }
  }
  return null;
}

export async function openManagedPosition(input: OpenManagedInput): Promise<OpenManagedResult> {
  // Gate 0 — autonomy. Opening a live-paper position is a live-paper start, which the guardrails
  // hard-require at L2+. Surface that as a clear, actionable message instead of a raw guardrail code.
  if ((input.autonomy ?? "L2") !== "L2") {
    const run = await createRun(input.ownerId, input.threadId, "open_managed_position (blocked: autonomy)", "open_managed_position");
    return { status: "blocked", runId: run.id, reason: "managed positions require autonomy L2+ (set it in kill-switch settings); the agent will then open and manage exits autonomously" };
  }

  // Gate 1 — risk state. risk_averse / halted both block NEW entries (exits are always allowed).
  const risk = await getRiskState(input.ownerId);
  if (risk.state !== "normal") {
    const run = await createRun(input.ownerId, input.threadId, "open_managed_position (blocked: risk)", "open_managed_position");
    return { status: "blocked", runId: run.id, reason: `risk_state=${risk.state}: ${risk.reason ?? "new entries paused"}` };
  }

  // Gate 2 — no naked entry (also enforced by the guardrail; checked here for a clean early error).
  const policyCheck = validateExitPolicy(input.exitPolicy);
  if (!policyCheck.ok) {
    const run = await createRun(input.ownerId, input.threadId, "open_managed_position (blocked: policy)", "open_managed_position");
    return { status: "blocked", runId: run.id, reason: policyCheck.reason };
  }

  const plan = buildOpenPositionPlan({
    ownerId: input.ownerId, threadId: input.threadId, botId: input.botId, symbol: input.symbol,
    category: input.category, exitPolicy: input.exitPolicy, autonomy: input.autonomy ?? "L2",
    maxRuntimeSeconds: input.maxRuntimeSeconds, investmentQuote: input.investmentQuote,
  });
  const run = await createRun(input.ownerId, input.threadId, "open_managed_position", plan.playbook_id, plan);

  const ownerToken = input.ownerToken ?? mintInternalToken(input.ownerId);
  const mcp = await connectMcp(ownerToken);
  try {
    const outcome = await executePlan({ plan, mcp, runId: run.id, agentAction: `open_managed_position ${input.symbol}` });
    if (outcome.status === "awaiting_approval") {
      return { status: "awaiting_approval", runId: run.id, reason: outcome.pendingStepId };
    }
    if (outcome.status !== "completed") {
      return { status: "blocked", runId: run.id, reason: outcome.reason };
    }

    // Bind the position intent now that the session exists.
    const steps = await getSteps(input.ownerId, run.id);
    const openStep = steps.find((s) => (s as { step_id?: string }).step_id === "s2_open") as { result?: unknown } | undefined;
    const sessionId = extractSessionId(openStep?.result);
    const intent = await openIntent({
      ownerId: input.ownerId, runId: run.id, sessionId: sessionId ?? undefined, botId: input.botId,
      symbol: input.symbol, category: input.category, side: input.side ?? "long",
      entryPrice: input.entryPrice, policy: input.exitPolicy, atr: input.atr,
    });
    await recordBudgetEvent(input.ownerId, "live_session", run.id, `open_managed_position ${input.symbol}`).catch(() => {});
    logger.info("managed position opened", { ownerId: input.ownerId, intentId: intent.id, sessionId, symbol: input.symbol });
    return { status: "opened", runId: run.id, intent };
  } finally {
    await mcp.close().catch(() => {});
  }
}
