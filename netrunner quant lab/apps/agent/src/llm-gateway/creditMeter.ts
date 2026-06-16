import type { ChatMessage, CostBreakdown, NormalizedUsage, PriceRow } from "./types.js";

// Pure cost math — no DB, no side effects. Unit-tested without a database.

// Rough token estimate (~4 chars/token). Deliberately conservative: estimates only drive the
// worst-case *reservation*, never the final debit (which uses actual provider usage).
export function estimateTokensFromMessages(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length + (m.role?.length ?? 0) + 4;
  }
  return Math.ceil(chars / 4);
}

// micro-USD for a token count at a per-MTOKEN micro-USD price, rounded up (never under-bill).
function lineCost(tokens: number, microPerMToken: number): number {
  if (tokens <= 0 || microPerMToken <= 0) return 0;
  return Math.ceil((tokens * microPerMToken) / 1_000_000);
}

// Cost of a *known* usage against a price row. Assumes input_tokens INCLUDES cached tokens: cached
// are billed at the cheaper cached rate, the remainder at full input rate.
export function costForUsage(usage: NormalizedUsage, price: PriceRow): CostBreakdown {
  const cached = Math.max(0, usage.cached_input_tokens);
  const uncachedInput = Math.max(0, usage.input_tokens - cached);
  const cachedRate = price.cached_input_micro_usd_per_mtoken ?? price.input_micro_usd_per_mtoken;
  const reasoningRate = price.reasoning_micro_usd_per_mtoken ?? price.output_micro_usd_per_mtoken;

  const input_micro_usd = lineCost(uncachedInput, price.input_micro_usd_per_mtoken);
  const cached_input_micro_usd = lineCost(cached, cachedRate);
  const output_micro_usd = lineCost(usage.output_tokens, price.output_micro_usd_per_mtoken);
  const reasoning_micro_usd = lineCost(usage.reasoning_tokens, reasoningRate);

  return {
    input_micro_usd,
    cached_input_micro_usd,
    output_micro_usd,
    reasoning_micro_usd,
    total_micro_usd: input_micro_usd + cached_input_micro_usd + output_micro_usd + reasoning_micro_usd,
  };
}

// Worst-case cost used to size a reservation BEFORE the provider call: assume no cache hits and the
// full output-token budget is produced.
export function estimateWorstCaseCost(
  messages: ChatMessage[],
  maxOutputTokens: number,
  price: PriceRow,
): CostBreakdown {
  const inputTokens = estimateTokensFromMessages(messages);
  return costForUsage(
    {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      output_tokens: maxOutputTokens,
      reasoning_tokens: 0,
      tool_call_count: 0,
    },
    price,
  );
}
