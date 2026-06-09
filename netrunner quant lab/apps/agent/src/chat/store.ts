import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import type { ChatMessage } from "../llm-gateway/types.js";

// Persistence for the chat spine. Every query is owner-scoped (cross-tenant isolation — core rule).

export interface Thread {
  id: string;
  owner_id: number;
  title: string | null;
  autonomy_level: string;
  created_at: string;
}

export async function createThread(ownerId: number, title?: string, autonomyLevel = "L1"): Promise<Thread> {
  const id = `thr_${randomUUID()}`;
  const r = await db.query(
    `INSERT INTO agent_threads (id, owner_id, title, autonomy_level) VALUES ($1,$2,$3,$4) RETURNING *`,
    [id, ownerId, title ?? null, autonomyLevel],
  );
  return rowToThread(r.rows[0]);
}

export async function listThreads(ownerId: number, limit = 50): Promise<Thread[]> {
  const r = await db.query(
    `SELECT * FROM agent_threads WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [ownerId, limit],
  );
  return r.rows.map(rowToThread);
}

export async function getThread(ownerId: number, threadId: string): Promise<Thread | null> {
  const r = await db.query(`SELECT * FROM agent_threads WHERE owner_id = $1 AND id = $2`, [ownerId, threadId]);
  return r.rowCount ? rowToThread(r.rows[0]) : null;
}

export async function addMessage(
  ownerId: number,
  threadId: string,
  role: ChatMessage["role"],
  content: string,
  toolCalls?: unknown,
): Promise<number> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO agent_messages (thread_id, owner_id, role, content, tool_calls) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [threadId, ownerId, role, content, toolCalls ?? null],
  );
  return Number(r.rows[0].id);
}

export async function getMessages(ownerId: number, threadId: string): Promise<ChatMessage[]> {
  const r = await db.query(
    `SELECT role, content FROM agent_messages WHERE owner_id = $1 AND thread_id = $2 ORDER BY ts ASC, id ASC`,
    [ownerId, threadId],
  );
  return r.rows.map((row) => ({ role: row.role, content: row.content ?? "" }));
}

export interface Run {
  id: string;
  thread_id: string | null;
  owner_id: number;
  goal: string | null;
  status: string | null;
  playbook_id: string | null;
  cost_micro_usd: number;
  started: string | null;
  ended: string | null;
}

export async function createRun(
  ownerId: number,
  threadId: string,
  goal: string,
  playbookId?: string,
  plan?: unknown,
): Promise<Run> {
  const id = `run_${randomUUID()}`;
  const r = await db.query(
    `INSERT INTO agent_runs (id, thread_id, owner_id, goal, playbook_id, plan, status, started)
     VALUES ($1,$2,$3,$4,$5,$6,'running', now()) RETURNING *`,
    [id, threadId, ownerId, goal, playbookId ?? null, toJson(plan)],
  );
  return rowToRun(r.rows[0]);
}

export async function getRunPlan(ownerId: number, runId: string): Promise<unknown | null> {
  const r = await db.query(`SELECT plan FROM agent_runs WHERE owner_id = $1 AND id = $2`, [ownerId, runId]);
  return r.rowCount ? r.rows[0].plan : null;
}

export async function finishRun(runId: string, status: string, costMicroUsd: number): Promise<void> {
  await db.query(`UPDATE agent_runs SET status = $2, cost_micro_usd = $3, ended = now() WHERE id = $1`, [
    runId,
    status,
    costMicroUsd,
  ]);
}

export async function getRun(ownerId: number, runId: string): Promise<Run | null> {
  const r = await db.query(`SELECT * FROM agent_runs WHERE owner_id = $1 AND id = $2`, [ownerId, runId]);
  return r.rowCount ? rowToRun(r.rows[0]) : null;
}

export async function listRunsForThread(ownerId: number, threadId: string): Promise<Run[]> {
  const r = await db.query(
    `SELECT * FROM agent_runs WHERE owner_id = $1 AND thread_id = $2 ORDER BY started ASC, id ASC`,
    [ownerId, threadId],
  );
  return r.rows.map(rowToRun);
}

export interface StepInput {
  stepId: string;
  state: string;
  tool?: string;
  rationale?: string;
  params?: unknown;
  result?: unknown;
  honesty?: unknown;
  guardrailDecision?: string;
  costMicroUsd?: number;
}

// params/result/honesty are JSONB columns. A tool result can be a bare string (result.text when
// there's no structured payload); binding that directly makes Postgres reject it with "invalid
// input syntax for type json". Explicitly serialize so every JSON column gets valid JSON or NULL.
function toJson(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

export async function addStep(ownerId: number, runId: string, s: StepInput): Promise<number> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO agent_run_steps
       (run_id, owner_id, step_id, state, tool, rationale, params, result, honesty, guardrail_decision, cost_micro_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      runId, ownerId, s.stepId, s.state, s.tool ?? null, s.rationale ?? null,
      toJson(s.params), toJson(s.result), toJson(s.honesty), s.guardrailDecision ?? null, s.costMicroUsd ?? 0,
    ],
  );
  return Number(r.rows[0].id);
}

export async function getSteps(ownerId: number, runId: string): Promise<unknown[]> {
  const r = await db.query(
    `SELECT step_id, state, tool, rationale, params, result, honesty, guardrail_decision, cost_micro_usd, ts
       FROM agent_run_steps WHERE owner_id = $1 AND run_id = $2 ORDER BY ts ASC, id ASC`,
    [ownerId, runId],
  );
  return r.rows;
}

export interface RunEventRow {
  run_id: string;
  seq: number;
  event_type: string;
  payload: unknown;
  emitted_at: string;
}

export async function getRunEvents(ownerId: number, runId: string): Promise<RunEventRow[]> {
  const r = await db.query(
    `SELECT run_id, seq, event_type, payload, emitted_at
       FROM agent_run_events
      WHERE owner_id = $1 AND run_id = $2
      ORDER BY seq ASC`,
    [ownerId, runId],
  );
  return r.rows.map(rowToRunEvent);
}

export async function getThreadEvents(ownerId: number, threadId: string): Promise<RunEventRow[]> {
  const r = await db.query(
    `SELECT run_id, seq, event_type, payload, emitted_at
       FROM agent_run_events
      WHERE owner_id = $1 AND thread_id = $2
      ORDER BY emitted_at ASC, id ASC`,
    [ownerId, threadId],
  );
  return r.rows.map(rowToRunEvent);
}

function rowToThread(r: Record<string, unknown>): Thread {
  return {
    id: String(r.id), owner_id: Number(r.owner_id), title: (r.title as string) ?? null,
    autonomy_level: String(r.autonomy_level),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}
function rowToRun(r: Record<string, unknown>): Run {
  return {
    id: String(r.id), thread_id: (r.thread_id as string) ?? null, owner_id: Number(r.owner_id),
    goal: (r.goal as string) ?? null, status: (r.status as string) ?? null, playbook_id: (r.playbook_id as string) ?? null,
    cost_micro_usd: Number(r.cost_micro_usd ?? 0),
    started: r.started instanceof Date ? r.started.toISOString() : (r.started as string) ?? null,
    ended: r.ended instanceof Date ? r.ended.toISOString() : (r.ended as string) ?? null,
  };
}

function rowToRunEvent(r: Record<string, unknown>): RunEventRow {
  return {
    run_id: String(r.run_id),
    seq: Number(r.seq),
    event_type: String(r.event_type),
    payload: r.payload ?? null,
    emitted_at: r.emitted_at instanceof Date ? r.emitted_at.toISOString() : String(r.emitted_at),
  };
}
