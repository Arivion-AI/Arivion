import { z } from "zod";

// Decimals cross the wire as strings in this stack, but agents often pass numbers.
export const dec = z.union([z.string(), z.number()]);

// A generic escape hatch so an agent can pass any extra/nested fields a proxy
// endpoint accepts without the schema dropping them.
export const extraField = z.record(z.any()).optional().describe("Any additional fields to forward verbatim to the API (see get_param_help).");

export const fullField = z.boolean().optional().describe("Return full arrays instead of truncated previews.");

/** Build a request body from known args (dropping undefined + control keys) merged with `extra`. */
export function buildBody(args: Record<string, unknown>, control: string[] = ["full", "extra"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (control.includes(k) || v === undefined) continue;
    out[k] = v;
  }
  if (args.extra && typeof args.extra === "object") Object.assign(out, args.extra as Record<string, unknown>);
  return out;
}

export const barArray = z
  .array(z.record(z.any()))
  .optional()
  .describe("OHLCV bars: [{ts, open, high, low, close, volume}] (strings for decimals).");

export const fundingArray = z
  .array(z.record(z.any()))
  .optional()
  .describe("Funding rows: [{id, timestamp, funding_rate}].");
