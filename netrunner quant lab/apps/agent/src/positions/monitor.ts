import { logger } from "../logger.js";
import { config } from "../config.js";
import { connectMcp } from "../mcp/client.js";
import { mintInternalToken } from "../internalToken.js";
import { executePlan } from "../orchestrator/runner.js";
import { createThread } from "../chat/store.js";
import { writeEpisode } from "../memory/store.js";
import { globalKillActive, getOwnerSettings } from "../settings/index.js";
import { refreshRiskState } from "../risk/index.js";
import { evaluateExit, type PositionView } from "./exitPolicy.js";
import { buildClosePositionPlan } from "./plans.js";
import {
  claimForClosing, listOpenIntentsForSweep, markClosed, recordPositionEvent, releaseClaim,
  updateRuntime, type PositionIntent,
} from "./store.js";

// Phase 17 — the position MONITOR: the always-on loop that turns a static strategy-setter into a
// living trader. For every open managed position it re-evaluates the bound exit policy against the
// current mark and, when a stop / trailing-stop / take-profit / time / max-loss condition fires, it
// closes the position autonomously through the typed manage_position playbook. Protective exits are
// pre-authorized (the user approved the policy at entry) and are NEVER blocked by the daily run cap —
// a stop-loss must always be allowed to fire.

export interface TickResult {
  intentId: string;
  action: "hold" | "reduce" | "close";
  reason?: string;
  runId?: string;
  closed?: boolean;
}

// Convert a stored intent into the pure-evaluator's view.
function toView(intent: PositionIntent): PositionView {
  return {
    side: intent.side,
    entry_price: intent.entry_price,
    opened_at_ms: new Date(intent.opened_at).getTime(),
    policy: intent.exit_policy,
    runtime: intent.runtime,
  };
}

// Evaluate ONE open position against a mark and act. Pure decision via evaluateExit; side effects here.
export async function evaluateIntent(intent: PositionIntent, mark: number, nowMs = Date.now()): Promise<TickResult> {
  const decision = evaluateExit(toView(intent), mark, nowMs);

  if (decision.action === "hold") {
    await updateRuntime(intent.id, decision.next_runtime, mark);
    return { intentId: intent.id, action: "hold" };
  }

  if (decision.action === "reduce") {
    // Paper sessions can't be partially reduced (no reduce tool), so a take-profit tier instead
    // RATCHETS the stop (locking in gains) and stays open. Honest about fidelity: the tier is logged
    // as a reduce decision, the tightened stop is persisted, and the position keeps being managed.
    await updateRuntime(intent.id, decision.next_runtime, mark);
    await recordPositionEvent({
      intentId: intent.id, ownerId: intent.owner_id, action: "reduce", reason: decision.reason ?? "take_profit",
      mark, fraction: decision.fraction, unrealized: decision.unrealized,
      detail: { tier_index: decision.tier_index, ratcheted_stop: decision.next_runtime.current_stop_price, note: "paper: stop ratcheted, session stays open" },
    });
    return { intentId: intent.id, action: "reduce", reason: decision.reason };
  }

  // CLOSE — race-safe claim so two concurrent ticks can't both stop the session.
  if (!(await claimForClosing(intent.id))) return { intentId: intent.id, action: "hold" };

  let runId: string | undefined;
  try {
    if (!intent.session_id) {
      // Nothing to stop on the Lab side (position never got a session) — close the intent locally.
      await markClosed(intent.id, { reason: decision.reason ?? "close", mark, realizedReturn: decision.unrealized });
    } else {
      const ownerToken = mintInternalToken(intent.owner_id);
      const mcp = await connectMcp(ownerToken);
      try {
        const threadId = (await createThread(intent.owner_id, `Exit ${intent.symbol}: ${decision.reason}`)).id;
        const plan = buildClosePositionPlan({
          ownerId: intent.owner_id, threadId, sessionId: intent.session_id,
          symbol: intent.symbol, category: intent.category as "spot" | "linear" | "xstock",
          reason: decision.reason ?? "exit",
        });
        const outcome = await executePlan({ plan, mcp, agentAction: `manage_position ${decision.reason}` });
        runId = outcome.runId;
        if (outcome.status === "completed" || outcome.status === "blocked") {
          await markClosed(intent.id, { reason: decision.reason ?? "close", mark, realizedReturn: decision.unrealized, runId });
        } else {
          await releaseClaim(intent.id); // exit failed — let the next tick retry
          return { intentId: intent.id, action: "close", reason: decision.reason, runId, closed: false };
        }
      } finally {
        await mcp.close().catch(() => {});
      }
    }

    await recordPositionEvent({
      intentId: intent.id, ownerId: intent.owner_id, action: "close", reason: decision.reason ?? "close",
      mark, fraction: 1, unrealized: decision.unrealized, runId,
      detail: { entry: intent.entry_price, side: intent.side },
    });
    // Memory: a closed position is an episode (so reflection/recall can learn from realized outcomes).
    await writeEpisode(intent.owner_id, {
      kind: "position", runId: runId ?? null, symbol: intent.symbol, symbolClass: intent.category,
      botOrStrategy: intent.bot_id ?? "managed_position",
      summary: `Closed ${intent.side} ${intent.symbol} via ${decision.reason}: return ${(decision.unrealized * 100).toFixed(2)}% (entry ${intent.entry_price}, exit ${mark}).`,
      source: "live_paper", reward: decision.unrealized,
      evidence: { intent_id: intent.id, reason: decision.reason, entry: intent.entry_price, exit: mark },
    }).catch((e) => logger.warn("position episode write skipped", { message: (e as Error).message }));
    // Recompute circuit breakers from realized outcomes — a streak/drawdown/CVaR breach escalates risk.
    await refreshRiskState(intent.owner_id).catch((e) => logger.warn("risk refresh skipped", { message: (e as Error).message }));

    return { intentId: intent.id, action: "close", reason: decision.reason, runId, closed: true };
  } catch (e) {
    await releaseClaim(intent.id).catch(() => {});
    logger.error("position exit failed", { intentId: intent.id, message: (e as Error).message });
    return { intentId: intent.id, action: "close", reason: decision.reason, closed: false };
  }
}

// Process a market mark for a symbol: evaluate every open position on that symbol. Driven by the
// rt:session:* / rt:barclose:* subscriber and the deterministic test endpoint.
export async function onMark(symbol: string, mark: number, nowMs = Date.now()): Promise<TickResult[]> {
  if (globalKillActive()) return [];
  if (!Number.isFinite(mark) || mark <= 0) return [];
  const intents = await listOpenIntentsForSweep(symbol);
  const out: TickResult[] = [];
  for (const intent of intents) {
    const settings = await getOwnerSettings(intent.owner_id).catch(() => null);
    if (settings && !settings.agent_enabled) continue; // a killed agent still shouldn't act
    out.push(await evaluateIntent(intent, mark, nowMs).catch((e) => {
      logger.warn("evaluateIntent error", { intentId: intent.id, message: (e as Error).message });
      return { intentId: intent.id, action: "hold" as const };
    }));
  }
  return out;
}

// Periodic safety sweep: catches TIME exits (and any position a mark feed missed) using the last
// known mark. Time-based exits need no fresh price, so this guarantees positions can't outlive their
// max_hold even with no tick.
export async function sweepOpenPositions(nowMs = Date.now()): Promise<TickResult[]> {
  if (globalKillActive()) return [];
  const intents = await listOpenIntentsForSweep();
  const out: TickResult[] = [];
  for (const intent of intents) {
    const mark = intent.last_mark ?? intent.entry_price;
    out.push(await evaluateIntent(intent, mark, nowMs).catch((e) => {
      logger.warn("sweep evaluateIntent error", { intentId: intent.id, message: (e as Error).message });
      return { intentId: intent.id, action: "hold" as const };
    }));
  }
  return out;
}

let sweepTimer: NodeJS.Timeout | null = null;

// Start the periodic safety sweep (best-effort; the per-tick path does the real-time work).
export function startPositionMonitor(): void {
  if (sweepTimer || config.positionSweepIntervalMs <= 0) return;
  sweepTimer = setInterval(() => {
    sweepOpenPositions().catch((e) => logger.warn("position sweep error", { message: (e as Error).message }));
  }, config.positionSweepIntervalMs);
  sweepTimer.unref?.();
  logger.info("position monitor started", { intervalMs: config.positionSweepIntervalMs });
}

export function stopPositionMonitor(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
