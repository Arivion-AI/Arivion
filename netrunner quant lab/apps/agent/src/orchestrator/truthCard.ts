// Result Truth Card (Phase 5). Built ONLY from honesty fields the Lab actually returned — we never
// fabricate or soften them. Missing fields render as "unknown" rather than an optimistic default.

export interface TruthCardInput {
  honesty: Record<string, unknown>; // accumulated across steps (from the normalizer)
  agentAction: string;
  llmCostMicroUsd: number;
}

export interface TruthCard {
  result_tier: string;
  fill_model_mode: string;
  maker_fills_optimistic: string;
  liquidity_free_upper_bound: string;
  coverage: string;
  execution_fidelity: string;
  verified: string;
  risk_class: string;
  hard_blocks: string;
  agent_action: string;
  llm_cost_usd: string;
  text: string; // pre-rendered card for the chat/console
}

function show(v: unknown): string {
  if (v === undefined || v === null) return "unknown";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function fillMode(honesty: Record<string, unknown>): string {
  const fm = honesty.fill_model as Record<string, unknown> | undefined;
  return show(honesty.fill_model_mode ?? fm?.fill_model_mode ?? fm?.mode ?? fm);
}

function makerOptimistic(honesty: Record<string, unknown>): string {
  const fm = honesty.fill_model as Record<string, unknown> | undefined;
  return show(honesty.maker_fills_optimistic ?? fm?.maker_fills_optimistic);
}

function liqFree(honesty: Record<string, unknown>): string {
  const fm = honesty.fill_model as Record<string, unknown> | undefined;
  return show(honesty.liquidity_free_upper_bound ?? fm?.liquidity_free_upper_bound);
}

function coverage(honesty: Record<string, unknown>): string {
  const cp = honesty.coverage_proof as Record<string, unknown> | undefined;
  return show(honesty.coverage ?? cp?.coverage ?? cp);
}

function hardBlocks(honesty: Record<string, unknown>): string {
  const hb = honesty.hard_blocks;
  if (Array.isArray(hb)) return hb.length ? hb.join(", ") : "none";
  return show(hb);
}

export function buildTruthCard(input: TruthCardInput): TruthCard {
  const h = input.honesty;
  const card: Omit<TruthCard, "text"> = {
    result_tier: show(h.result_tier),
    fill_model_mode: fillMode(h),
    maker_fills_optimistic: makerOptimistic(h),
    liquidity_free_upper_bound: liqFree(h),
    coverage: coverage(h),
    execution_fidelity: show(h.execution_fidelity),
    verified: show(h.verified ?? (typeof h.result_tier === "string" ? /verified/i.test(h.result_tier) : undefined)),
    risk_class: show(h.risk_class),
    hard_blocks: hardBlocks(h),
    agent_action: input.agentAction,
    llm_cost_usd: `$${(input.llmCostMicroUsd / 1_000_000).toFixed(6)}`,
  };
  const text = [
    "Result Truth Card:",
    `- Result tier: ${card.result_tier}`,
    `- Fill model mode: ${card.fill_model_mode}`,
    `- Maker fills optimistic: ${card.maker_fills_optimistic}`,
    `- Liquidity-free upper bound: ${card.liquidity_free_upper_bound}`,
    `- Coverage: ${card.coverage}`,
    `- Execution fidelity: ${card.execution_fidelity}`,
    `- Verified: ${card.verified}`,
    `- Risk class: ${card.risk_class}`,
    `- Hard blocks: ${card.hard_blocks}`,
    `- Agent action: ${card.agent_action}`,
    `- LLM cost: ${card.llm_cost_usd}`,
  ].join("\n");
  return { ...card, text };
}
