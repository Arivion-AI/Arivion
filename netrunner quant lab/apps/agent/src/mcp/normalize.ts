// Result normalizer for MCP tool calls. The Lab encodes structured results as a JSON string inside
// content[0].text. We parse it and surface a `honesty` summary WITHOUT ever stripping or rewriting
// the raw payload — the determinism/honesty guarantees require fill_model, coverage_proof,
// result_tier, hard blocks and validation labels to pass through untouched (core rule).

export interface McpToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

// Honesty / determinism fields we always want to find and display if present. This list only drives
// the *surfaced summary*; the raw payload is returned in full regardless.
export const HONESTY_KEYS = [
  "fill_model",
  "fill_model_mode",
  "maker_fills_optimistic",
  "liquidity_free_upper_bound",
  "coverage_proof",
  "coverage",
  "result_tier",
  "execution_fidelity",
  "verified",
  "risk_class",
  "risk_score",
  "hard_blocks",
  "validation",
  "recovery_blocked",
] as const;

export interface NormalizedToolResult {
  isError: boolean;
  text: string; // the original text payload, verbatim
  raw: unknown; // parsed JSON if parseable, else undefined — NEVER mutated
  honesty: Record<string, unknown>; // surfaced honesty fields (a view, not a replacement)
}

function collectHonesty(node: unknown, out: Record<string, unknown>, depth = 0): void {
  if (node === null || typeof node !== "object" || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collectHonesty(item, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if ((HONESTY_KEYS as readonly string[]).includes(k) && !(k in out)) {
      out[k] = v;
    }
    collectHonesty(v, out, depth + 1);
  }
}

export function normalizeToolResult(result: McpToolResultLike): NormalizedToolResult {
  const text = (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : undefined;
  } catch {
    raw = undefined; // non-JSON text result — keep `text`, no structured honesty extraction
  }
  const honesty: Record<string, unknown> = {};
  if (raw !== undefined) collectHonesty(raw, honesty);
  return { isError: Boolean(result.isError), text, raw, honesty };
}

// Detect a Lab rate-limit (429) / kill-switch signal in a tool result or error, for backoff/refund.
export function isRateLimited(resultOrError: unknown): boolean {
  const s = typeof resultOrError === "string" ? resultOrError : JSON.stringify(resultOrError ?? "");
  return /\b429\b|RATE_LIMIT|TOO_MANY_REQUESTS|rate.?limit/i.test(s);
}
