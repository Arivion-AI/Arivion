import { randomUUID } from "node:crypto";
import { config, USD_TO_MICRO } from "../config.js";
import { logger } from "../logger.js";
import {
  GatewayError,
  type CompleteRequest,
  type CompleteResult,
  type CostBreakdown,
  type NormalizedUsage,
} from "./types.js";
import { getActivePrice } from "./priceBook.js";
import { costForUsage, estimateWorstCaseCost } from "./creditMeter.js";
import { ensureAccount, lockAccount } from "./creditLedger.js";
import { reserve, finalize, release } from "./reservation.js";
import { recordUsage, getUsageByIdempotency } from "./usageRecorder.js";
import { assertAllowlistedProvider, assertByokEnabled } from "./keyVault.js";
import { execute, embed, ProviderTimeoutError } from "./providerRouter.js";
import { db } from "../db.js";

// =================================================================================================
// THE LLM GATEWAY. Every model call in Duality Copilot goes through complete(). It is the ONLY
// place that (a) calls a provider and (b) moves managed credit. The flow is: estimate → reserve →
// execute → meter → finalize, with refund-on-failure. Concurrency-safe (FOR UPDATE account lock)
// and idempotent (idempotencyKey) end to end (corrections #1, #3, #4, #7).
// =================================================================================================

const ZERO_COST: CostBreakdown = {
  input_micro_usd: 0,
  cached_input_micro_usd: 0,
  output_micro_usd: 0,
  reasoning_micro_usd: 0,
  total_micro_usd: 0,
};

async function currentBalance(ownerId: number): Promise<number> {
  const r = await db.query<{ managed_balance_micro_usd: string }>(
    `SELECT managed_balance_micro_usd FROM agent_credit_accounts WHERE owner_id = $1`,
    [ownerId],
  );
  return r.rowCount ? Number(r.rows[0].managed_balance_micro_usd) : 0;
}

export interface Quote {
  provider: string;
  model: string;
  estimatedCostMicroUsd: number;
  maxOutputTokens: number;
  priced: boolean;
  withinStepCap: boolean;
}

// Estimate-only (no reserve, no provider call). Backs POST /api/copilot/llm/quote.
export async function quote(
  req: Pick<CompleteRequest, "provider" | "model" | "messages" | "maxTokens" | "maxCostUsd">,
): Promise<Quote> {
  assertAllowlistedProvider(req.provider);
  const price = await getActivePrice(req.provider, req.model);
  const maxOutputTokens = Math.min(req.maxTokens ?? config.maxOutputTokensPerStep, config.maxOutputTokensPerStep);
  if (!price) {
    return { provider: req.provider, model: req.model, estimatedCostMicroUsd: 0, maxOutputTokens, priced: false, withinStepCap: true };
  }
  const est = estimateWorstCaseCost(req.messages, maxOutputTokens, price);
  const stepCap = stepCapMicro(req.maxCostUsd);
  return {
    provider: req.provider,
    model: req.model,
    estimatedCostMicroUsd: est.total_micro_usd,
    maxOutputTokens,
    priced: true,
    withinStepCap: est.total_micro_usd <= stepCap,
  };
}

function stepCapMicro(maxCostUsd?: number): number {
  const configCap = Math.round(config.maxCostPerStepUsd * USD_TO_MICRO);
  if (maxCostUsd === undefined) return configCap;
  return Math.min(configCap, Math.round(maxCostUsd * USD_TO_MICRO));
}

export async function complete(req: CompleteRequest): Promise<CompleteResult> {
  if (!req.idempotencyKey) throw new GatewayError("MISSING_IDEMPOTENCY_KEY", "idempotencyKey is required", 400);
  assertAllowlistedProvider(req.provider);

  const requestId = `req_${randomUUID()}`;
  const managed = req.providerMode === "managed";
  if (!managed) assertByokEnabled(); // BYOK disabled in v1 → throws BYOK_DISABLED

  // Replay guard (correction #4): if this idempotencyKey already produced a usage event, the call
  // was already billed — do not call the provider or debit again.
  const prior = await getUsageByIdempotency(req.ownerId, req.idempotencyKey);
  if (prior) {
    logger.info("gateway replay short-circuit", { ownerId: req.ownerId, requestId, idempotencyKey: req.idempotencyKey });
    return {
      content: "",
      usage: priorToUsage(prior),
      cost: { ...ZERO_COST, total_micro_usd: prior.provider_cost_micro_usd },
      meteringQuality: prior.metering_quality,
      providerMode: prior.provider_mode,
      provider: prior.provider,
      model: prior.model,
      requestId,
      managedBalanceMicroUsd: managed ? await currentBalance(req.ownerId) : undefined,
      estimatedCostMicroUsd: prior.provider_cost_micro_usd,
      status: prior.status === "ok" ? "ok" : "error",
      errorCode: prior.status === "ok" ? undefined : "REPLAYED",
    };
  }

  // 0. Ensure account + welcome grant (idempotent).
  if (managed) await ensureAccount(req.ownerId);

  // 1. Price (correction #7: managed with no active price row is BLOCKED before anything else).
  const price = await getActivePrice(req.provider, req.model);
  if (managed && !price) {
    throw new GatewayError("NO_ACTIVE_PRICE", `no active price row for managed model ${req.provider}/${req.model}`, 422);
  }

  const maxOutputTokens = Math.min(req.maxTokens ?? config.maxOutputTokensPerStep, config.maxOutputTokensPerStep);

  // 1b. Estimate worst-case cost and enforce the per-step cost cap before reserving.
  const worst = price ? estimateWorstCaseCost(req.messages, maxOutputTokens, price) : ZERO_COST;
  const estimatedCostMicroUsd = worst.total_micro_usd;
  const cap = stepCapMicro(req.maxCostUsd);
  if (managed && estimatedCostMicroUsd > cap) {
    throw new GatewayError(
      "COST_CAP_EXCEEDED",
      `estimated ${estimatedCostMicroUsd} micro-USD exceeds per-step cap ${cap}`,
      402,
    );
  }

  // 2. Reserve (managed). Throws INSUFFICIENT_CREDIT *before* the provider call.
  let reservationId: string | undefined;
  if (managed) {
    const reservation = await reserve({
      ownerId: req.ownerId,
      runId: req.runId,
      stepId: req.stepId,
      idempotencyKey: req.idempotencyKey,
      provider: req.provider,
      model: req.model,
      providerMode: req.providerMode,
      reservedMicroUsd: estimatedCostMicroUsd,
    });
    reservationId = reservation.id;
  }

  // 3. Execute provider (the ONLY provider call site).
  let usage: NormalizedUsage;
  try {
    const resp = await execute({
      provider: req.provider,
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      maxTokens: maxOutputTokens,
      metadata: req.metadata,
    });
    usage = resp.usage;

    // 4 + 5. Meter actual usage, finalize (debit actual + refund remainder).
    const cost = price ? costForUsage(usage, price) : ZERO_COST;
    if (managed && reservationId) await finalize(reservationId, cost.total_micro_usd);

    await recordUsage({
      ownerId: req.ownerId, threadId: req.threadId, runId: req.runId, stepId: req.stepId,
      playbookId: req.playbookId, purpose: req.purpose, providerMode: req.providerMode,
      provider: req.provider, model: req.model, requestId,
      providerRequestId: usage.provider_request_id, reservationId, idempotencyKey: req.idempotencyKey,
      usage, cost, creditDebitMicroUsd: managed ? cost.total_micro_usd : 0,
      meteringQuality: "actual", latencyMs: usage.latency_ms, status: "ok",
    });

    return {
      content: resp.content, toolCalls: resp.toolCalls, usage, cost, meteringQuality: "actual",
      providerMode: req.providerMode, provider: req.provider, model: req.model, requestId, reservationId,
      managedBalanceMicroUsd: managed ? await currentBalance(req.ownerId) : undefined,
      estimatedCostMicroUsd, status: "ok",
    };
  } catch (err) {
    return handleExecuteFailure(req, requestId, reservationId, price, maxOutputTokens, estimatedCostMicroUsd, managed, err);
  }
}

// Failure handling (step 6). Timeout with unknown usage ⇒ bill ESTIMATED. Any other pre-token
// provider error ⇒ refund the whole reservation.
async function handleExecuteFailure(
  req: CompleteRequest,
  requestId: string,
  reservationId: string | undefined,
  price: Awaited<ReturnType<typeof getActivePrice>>,
  maxOutputTokens: number,
  estimatedCostMicroUsd: number,
  managed: boolean,
  err: unknown,
): Promise<CompleteResult> {
  if (err instanceof ProviderTimeoutError) {
    // Unknown usage — charge the pre-call estimate (expected, not worst case) and mark estimated.
    const expectedOutput = Math.ceil(maxOutputTokens / 2);
    const expectedUsage: NormalizedUsage = {
      input_tokens: estimateInput(req),
      cached_input_tokens: 0,
      output_tokens: expectedOutput,
      reasoning_tokens: 0,
      tool_call_count: 0,
    };
    const cost = price ? costForUsage(expectedUsage, price) : ZERO_COST;
    if (managed && reservationId) await finalize(reservationId, cost.total_micro_usd);
    await recordUsage({
      ownerId: req.ownerId, threadId: req.threadId, runId: req.runId, stepId: req.stepId,
      playbookId: req.playbookId, purpose: req.purpose, providerMode: req.providerMode,
      provider: req.provider, model: req.model, requestId, reservationId, idempotencyKey: req.idempotencyKey,
      usage: expectedUsage, cost, creditDebitMicroUsd: managed ? cost.total_micro_usd : 0,
      meteringQuality: "estimated", status: "timeout", errorCode: "PROVIDER_TIMEOUT",
    });
    logger.warn("gateway provider timeout — billed estimated", { ownerId: req.ownerId, requestId });
    return {
      content: "", usage: expectedUsage, cost, meteringQuality: "estimated",
      providerMode: req.providerMode, provider: req.provider, model: req.model, requestId, reservationId,
      managedBalanceMicroUsd: managed ? await currentBalance(req.ownerId) : undefined,
      estimatedCostMicroUsd, status: "error", errorCode: "PROVIDER_TIMEOUT",
    };
  }

  // Pre-token error: refund the whole reservation, record a zero-cost error usage event, rethrow.
  if (managed && reservationId) await release(reservationId, "PROVIDER_ERROR");
  await recordUsage({
    ownerId: req.ownerId, threadId: req.threadId, runId: req.runId, stepId: req.stepId,
    playbookId: req.playbookId, purpose: req.purpose, providerMode: req.providerMode,
    provider: req.provider, model: req.model, requestId, reservationId, idempotencyKey: req.idempotencyKey,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, tool_call_count: 0 },
    cost: ZERO_COST, creditDebitMicroUsd: 0, meteringQuality: "unknown", status: "error",
    errorCode: err instanceof GatewayError ? err.code : "PROVIDER_ERROR",
  });
  logger.error("gateway provider error — reservation refunded", {
    ownerId: req.ownerId, requestId, code: err instanceof GatewayError ? err.code : "PROVIDER_ERROR",
  });
  throw err instanceof GatewayError ? err : new GatewayError("PROVIDER_ERROR", (err as Error).message, 502);
}

function estimateInput(req: CompleteRequest): number {
  let chars = 0;
  for (const m of req.messages) chars += (m.content ?? "").length;
  return Math.ceil(chars / 4);
}

function priorToUsage(p: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_tokens: number; tool_call_count: number }): NormalizedUsage {
  return {
    input_tokens: p.input_tokens,
    cached_input_tokens: p.cached_input_tokens,
    output_tokens: p.output_tokens,
    reasoning_tokens: p.reasoning_tokens,
    tool_call_count: p.tool_call_count,
  };
}

// On Lab 429 / kill switch / plan-blocked AFTER a reservation but BEFORE/with no provider call, the
// caller releases the hold via this (full refund). Exposed so the orchestrator/guardrails can undo.
export async function refundReservation(reservationId: string, reason: string): Promise<void> {
  await release(reservationId, reason);
}

// Embed text → vector, metered through the same managed-credit path (reserve → execute → finalize).
// Embeddings only consume input tokens. Returns the vector plus the actual cost.
export async function embedText(req: {
  ownerId: number;
  text: string;
  provider?: string;
  model?: string;
  runId?: string;
  purpose?: string;
}): Promise<{ vector: number[]; model: string; costMicroUsd: number; inputTokens: number }> {
  const provider = req.provider ?? config.embeddingProvider;
  const model = req.model ?? config.embeddingModel;
  assertAllowlistedProvider(provider);
  await ensureAccount(req.ownerId);
  const price = await getActivePrice(provider, model);
  if (!price) throw new GatewayError("NO_ACTIVE_PRICE", `no active price row for embedding model ${provider}/${model}`, 422);

  const idempotencyKey = `emb_${randomUUID()}`;
  // Estimate ~4 chars/token for the reservation hold.
  const estTokens = Math.max(1, Math.ceil(req.text.length / 4));
  const estCost = costForUsage(
    { input_tokens: estTokens, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, tool_call_count: 0 },
    price,
  );
  const reservation = await reserve({
    ownerId: req.ownerId, runId: req.runId, idempotencyKey,
    provider, model, providerMode: "managed", reservedMicroUsd: Math.max(1, estCost.total_micro_usd),
  });

  try {
    const res = await embed(provider, model, req.text);
    const usage: NormalizedUsage = {
      input_tokens: res.inputTokens || estTokens, cached_input_tokens: 0,
      output_tokens: 0, reasoning_tokens: 0, tool_call_count: 0,
    };
    const cost = costForUsage(usage, price);
    await finalize(reservation.id, cost.total_micro_usd);
    await recordUsage({
      ownerId: req.ownerId, runId: req.runId, purpose: req.purpose ?? "embedding",
      providerMode: "managed", provider, model, requestId: `req_${randomUUID()}`,
      providerRequestId: res.provider_request_id, reservationId: reservation.id, idempotencyKey,
      usage, cost, creditDebitMicroUsd: cost.total_micro_usd, meteringQuality: "actual",
      latencyMs: res.latency_ms, status: "ok",
    });
    return { vector: res.vector, model, costMicroUsd: cost.total_micro_usd, inputTokens: usage.input_tokens };
  } catch (err) {
    await release(reservation.id, "EMBED_ERROR");
    throw err instanceof GatewayError ? err : new GatewayError("PROVIDER_ERROR", (err as Error).message, 502);
  }
}

export const llmGateway = { complete, quote, refundReservation, embedText };

// Re-exports so callers import from one place.
export { ensureAccount, getAccount, listLedger, recordGrant, lockAccount } from "./creditLedger.js";
export { getManagedCatalog, getPreferences, updatePreferences, resolveModels } from "./modelCatalog.js";
export { getUsageByIdempotency, getRunUsage } from "./usageRecorder.js";
export { providerHealth } from "./providerHealth.js";
export * from "./types.js";
