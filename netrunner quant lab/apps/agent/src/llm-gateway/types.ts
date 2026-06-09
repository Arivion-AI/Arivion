// Shared types for the LLM Gateway. Every model call in the system flows through these.

export type ProviderMode = "managed" | "byok";
export type MeteringQuality = "actual" | "estimated" | "unknown";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  // On an assistant turn that requested tools, carry them back so the provider sees a valid
  // tool-calling transcript on the next round.
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface ToolSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

// Normalized usage parsed out of any provider response.
export interface NormalizedUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  tool_call_count: number;
  provider_request_id?: string;
  latency_ms?: number;
}

export interface PriceRow {
  provider: string;
  model: string;
  input_micro_usd_per_mtoken: number;
  cached_input_micro_usd_per_mtoken: number | null;
  output_micro_usd_per_mtoken: number;
  reasoning_micro_usd_per_mtoken: number | null;
  source: string;
  source_url: string | null;
  fetched_at: string | null;
  effective_from: string;
  effective_to: string | null;
}

export interface CompleteRequest {
  ownerId: number;
  threadId?: string;
  runId?: string;
  stepId?: string;
  purpose: string; // e.g. 'chat', 'planner', 'actor', 'triage'
  providerMode: ProviderMode;
  provider: string; // allowlisted provider id
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  maxCostUsd?: number;
  metadata?: Record<string, unknown>;
  // REQUIRED for safe retries (correction #4). Same key ⇒ at most one debit ever.
  idempotencyKey: string;
  playbookId?: string;
}

export interface CostBreakdown {
  input_micro_usd: number;
  cached_input_micro_usd: number;
  output_micro_usd: number;
  reasoning_micro_usd: number;
  total_micro_usd: number;
}

export interface CompleteResult {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage: NormalizedUsage;
  cost: CostBreakdown;
  meteringQuality: MeteringQuality;
  providerMode: ProviderMode;
  provider: string;
  model: string;
  requestId: string;
  reservationId?: string;
  // Credit snapshot after this call (managed mode). Undefined for BYOK.
  managedBalanceMicroUsd?: number;
  estimatedCostMicroUsd: number;
  status: "ok" | "error";
  errorCode?: string;
}

// A provider adapter only knows how to call a model and normalize its usage. It NEVER touches
// credits — that is the gateway's job (correction #1).
export interface ProviderResponse {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage: NormalizedUsage;
}

export class GatewayError extends Error {
  constructor(
    public code: string,
    message?: string,
    public httpStatus = 400,
  ) {
    super(message ?? code);
    this.name = "GatewayError";
  }
}
