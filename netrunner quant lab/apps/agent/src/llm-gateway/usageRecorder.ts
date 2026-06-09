import { db } from "../db.js";
import type { CostBreakdown, MeteringQuality, NormalizedUsage, ProviderMode } from "./types.js";

// Every gateway call writes exactly one usage event (correction #1: usage event for every call).
// Idempotent on (owner_id, idempotency_key) so retries/replays don't duplicate.

export interface RecordUsageArgs {
  ownerId: number;
  threadId?: string;
  runId?: string;
  stepId?: string;
  playbookId?: string;
  purpose: string;
  providerMode: ProviderMode;
  provider: string;
  model: string;
  requestId: string;
  providerRequestId?: string;
  reservationId?: string;
  idempotencyKey: string;
  usage: NormalizedUsage;
  cost: CostBreakdown;
  creditDebitMicroUsd: number;
  meteringQuality: MeteringQuality;
  latencyMs?: number;
  status: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

export interface UsageEventRow {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  tool_call_count: number;
  provider_cost_micro_usd: number;
  duality_credit_debit_micro_usd: number;
  metering_quality: MeteringQuality;
  status: string;
  provider: string;
  model: string;
  provider_mode: ProviderMode;
  latency_ms: number | null;
}

export async function recordUsage(args: RecordUsageArgs): Promise<void> {
  await db.query(
    `INSERT INTO agent_llm_usage_events
       (owner_id, thread_id, run_id, step_id, playbook_id, purpose, provider_mode, provider, model,
        request_id, provider_request_id, reservation_id, idempotency_key,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, tool_call_count,
        provider_cost_micro_usd, duality_credit_debit_micro_usd, metering_quality, latency_ms,
        status, error_code, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [
      args.ownerId, args.threadId ?? null, args.runId ?? null, args.stepId ?? null, args.playbookId ?? null,
      args.purpose, args.providerMode, args.provider, args.model,
      args.requestId, args.providerRequestId ?? null, args.reservationId ?? null, args.idempotencyKey,
      args.usage.input_tokens, args.usage.cached_input_tokens, args.usage.output_tokens,
      args.usage.reasoning_tokens, args.usage.tool_call_count,
      args.cost.total_micro_usd, args.creditDebitMicroUsd, args.meteringQuality, args.latencyMs ?? null,
      args.status, args.errorCode ?? null, args.metadata ?? null,
    ],
  );
}

export async function getUsageByIdempotency(
  ownerId: number,
  idempotencyKey: string,
): Promise<UsageEventRow | null> {
  const res = await db.query(
    `SELECT input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, tool_call_count,
            provider_cost_micro_usd, duality_credit_debit_micro_usd, metering_quality, status,
            provider, model, provider_mode, latency_ms
       FROM agent_llm_usage_events
      WHERE owner_id = $1 AND idempotency_key = $2
      LIMIT 1`,
    [ownerId, idempotencyKey],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0];
  return {
    input_tokens: Number(r.input_tokens),
    cached_input_tokens: Number(r.cached_input_tokens),
    output_tokens: Number(r.output_tokens),
    reasoning_tokens: Number(r.reasoning_tokens),
    tool_call_count: Number(r.tool_call_count),
    provider_cost_micro_usd: Number(r.provider_cost_micro_usd),
    duality_credit_debit_micro_usd: Number(r.duality_credit_debit_micro_usd),
    metering_quality: r.metering_quality,
    status: r.status,
    provider: r.provider,
    model: r.model,
    provider_mode: r.provider_mode,
    latency_ms: r.latency_ms === null ? null : Number(r.latency_ms),
  };
}

// Usage rollup for a single run (Cost Card / run summary).
export async function getRunUsage(ownerId: number, runId: string): Promise<{
  events: number;
  total_credit_debit_micro_usd: number;
  total_provider_cost_micro_usd: number;
}> {
  const res = await db.query(
    `SELECT COUNT(*)::bigint AS events,
            COALESCE(SUM(duality_credit_debit_micro_usd),0)::bigint AS debit,
            COALESCE(SUM(provider_cost_micro_usd),0)::bigint AS provider_cost
       FROM agent_llm_usage_events
      WHERE owner_id = $1 AND run_id = $2`,
    [ownerId, runId],
  );
  const r = res.rows[0];
  return {
    events: Number(r.events),
    total_credit_debit_micro_usd: Number(r.debit),
    total_provider_cost_micro_usd: Number(r.provider_cost),
  };
}
