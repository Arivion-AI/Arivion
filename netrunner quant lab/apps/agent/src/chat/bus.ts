import { EventEmitter } from "node:events";
import { db } from "../db.js";

// In-process pub/sub for streaming a run's trace to SSE subscribers, with a short replay buffer so a
// subscriber that connects slightly after the run starts still sees earlier events (no race).
//
// MVP scope: single agent process. COPILOT_IMPLEMENTATION_NOTES.md flags Redis pub/sub
// (rt:* channels) as the production multi-instance upgrade (Phase 9).

export interface RunEvent {
  type:
    | "run.started"
    | "run.step"
    | "message"
    | "cost"
    | "approval.required"
    | "truth_card"
    | "widget"      // a board node for the Nexa UI flowchart (structured agent activity)
    | "question"    // an option prompt the UI renders as selectable chips
    | "run.done"
    | "run.error";
  runId: string;
  seq: number;
  data: unknown;
  ts: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const buffers = new Map<string, RunEvent[]>();
const seqs = new Map<string, number>();
const BUFFER_TTL_MS = 5 * 60_000;

export function publish(runId: string, type: RunEvent["type"], data: unknown): RunEvent {
  const seq = (seqs.get(runId) ?? 0) + 1;
  seqs.set(runId, seq);
  const ev: RunEvent = { type, runId, seq, data, ts: new Date().toISOString() };
  const buf = buffers.get(runId) ?? [];
  buf.push(ev);
  buffers.set(runId, buf);
  emitter.emit(runId, ev);
  void persistEvent(ev);
  if (type === "run.done" || type === "run.error") {
    setTimeout(() => {
      buffers.delete(runId);
      seqs.delete(runId);
    }, BUFFER_TTL_MS).unref?.();
  }
  return ev;
}

async function persistEvent(ev: RunEvent): Promise<void> {
  try {
    await db.query(
      `INSERT INTO agent_run_events (run_id, thread_id, owner_id, seq, event_type, payload, emitted_at)
       SELECT id, thread_id, owner_id, $2, $3, $4::jsonb, $5
       FROM agent_runs
       WHERE id = $1
       ON CONFLICT (run_id, seq) DO NOTHING`,
      [ev.runId, ev.seq, ev.type, JSON.stringify(ev.data ?? null), ev.ts],
    );
  } catch {
    // Streaming should not fail because replay persistence is unavailable.
  }
}

export function replay(runId: string): RunEvent[] {
  return buffers.get(runId) ?? [];
}

// Subscribe to a run's events. Returns an unsubscribe fn. Immediately replays buffered events.
export function subscribe(runId: string, onEvent: (ev: RunEvent) => void): () => void {
  for (const ev of replay(runId)) onEvent(ev);
  const handler = (ev: RunEvent) => onEvent(ev);
  emitter.on(runId, handler);
  return () => emitter.off(runId, handler);
}

export function isTerminal(ev: RunEvent): boolean {
  return ev.type === "run.done" || ev.type === "run.error";
}
