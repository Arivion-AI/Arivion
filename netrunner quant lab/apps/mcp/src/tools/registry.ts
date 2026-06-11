import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { Clients } from "../http/client.js";
import type { Config } from "../config.js";
import { currentContext } from "../context.js";
import type { AuthProvider, RequestContext } from "../auth/provider.js";

export interface CapabilityEntry {
  name: string;
  domain: string;
  description: string;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [x: string]: unknown;
}

export function textResult(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

export function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const body = (err as { body?: unknown })?.body;
  const payload = body ? `${message}\n\nResponse body:\n${JSON.stringify(body, null, 2)}` : message;
  return { content: [{ type: "text", text: payload }], isError: true };
}

/** Truncate large arrays in a response so an agent isn't flooded; pass full=true to bypass. */
export function summarize(data: unknown, full: boolean, cap = 25): unknown {
  if (full || data == null || typeof data !== "object") return data;
  const clone: Record<string, unknown> = Array.isArray(data) ? ([] as unknown as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > cap) {
      clone[k] = [...v.slice(0, cap), `… (${v.length - cap} more; pass full=true to see all)`];
    } else {
      clone[k] = v;
    }
  }
  return clone;
}

type ChartContext = { bars?: unknown; symbol?: unknown; strategy?: unknown };

function sampleWithIndices<T>(items: T[], max = 240): { values: T[]; indices: number[] } {
  if (items.length <= max) return { values: items, indices: items.map((_, i) => i) };
  const values: T[] = [];
  const indices: number[] = [];
  for (let i = 0; i < max; i += 1) {
    const idx = Math.round((i / (max - 1)) * (items.length - 1));
    values.push(items[idx]);
    indices.push(idx);
  }
  return { values, indices };
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((v) => Number(v)).filter((v) => Number.isFinite(v))
    : [];
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function findEquityNode(value: unknown, depth = 0): Record<string, unknown> | null {
  const rec = asRecord(value);
  if (!rec || depth > 4) return null;
  if (Array.isArray(rec.equity_curve) || Array.isArray(rec.equity)) return rec;
  for (const child of Object.values(rec)) {
    const found = findEquityNode(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeBars(bars: unknown, indices: number[]): Array<{ ts: number }> {
  const arr = Array.isArray(bars) ? bars : [];
  return indices.map((idx) => {
    const row = asRecord(arr[idx]);
    return { ts: firstNumber(row?.ts, row?.time, row?.timestamp, row?.t, idx) ?? idx };
  });
}

function normalizeFills(fills: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(fills)) return [];
  return fills.slice(0, 300).map((fill) => {
    const row = asRecord(fill) ?? {};
    return {
      ts: row.ts ?? row.time ?? row.timestamp,
      side: row.side,
      qty: row.qty ?? row.quantity,
      price: row.price ?? row.fill_price,
      fee: row.fee,
      is_maker: row.is_maker,
    };
  });
}

/** Preserve real backtest visualization data without flooding the agent with full raw arrays. */
export function summarizeBacktest(data: unknown, context: ChartContext = {}, full = false): unknown {
  const base = summarize(data, full, 25);
  if (full || data == null || typeof data !== "object") return base;
  const node = findEquityNode(data);
  const equity = numberArray(node?.equity_curve ?? node?.equity);
  if (!node || equity.length === 0 || base == null || typeof base !== "object") return base;

  const sampled = sampleWithIndices(equity);
  const rec = base as Record<string, unknown>;
  const performance = asRecord(node.performance) ?? asRecord(node.metrics) ?? asRecord((data as Record<string, unknown>).performance) ?? {};
  const fillModel = asRecord(node.fill_model) ?? asRecord((data as Record<string, unknown>).fill_model) ?? {};
  rec.chart_preview = {
    kind: "backtest_equity",
    source: "actual_backtest_result",
    symbol: context.symbol ?? node.symbol,
    strategy: context.strategy ?? node.strategy_id ?? node.bot_type,
    equity_curve: sampled.values,
    sampled_indices: sampled.indices,
    sampled_from: equity.length,
    bars: normalizeBars(context.bars, sampled.indices),
    fills: normalizeFills(node.fills),
    fills_count: Array.isArray(node.fills) ? node.fills.length : firstNumber(node.fills_count),
    starting_equity: firstNumber(node.starting_equity, node.start_equity, equity[0]),
    final_equity: firstNumber(node.final_equity, equity[equity.length - 1]),
    performance,
    fill_model: fillModel,
    result_tier: node.result_tier ?? (data as Record<string, unknown>).result_tier,
  };
  return rec;
}

export function describeShape(shape: ZodRawShape): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, def] of Object.entries(shape)) {
    const z = def as { isOptional?: () => boolean; _def?: { typeName?: string; description?: string } };
    const typeName = z?._def?.typeName?.replace(/^Zod/, "") ?? "unknown";
    const optional = typeof z.isOptional === "function" ? z.isOptional() : false;
    const desc = z?._def?.description ? ` — ${z._def.description}` : "";
    out[key] = `${typeName}${optional ? "?" : ""}${desc}`;
  }
  return out;
}

export class Registrar {
  capabilities: CapabilityEntry[] = [];
  schemas: Record<string, ZodRawShape> = {};
  constructor(
    public server: McpServer,
    public clients: Clients,
    public cfg: Config,
    public auth: AuthProvider
  ) {}

  ctx(): RequestContext {
    return currentContext();
  }

  /** Register a tool and record it in the capability index. */
  tool(
    domain: string,
    name: string,
    description: string,
    inputSchema: ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult
  ): void {
    this.capabilities.push({ name, domain, description });
    this.schemas[name] = inputSchema;
    this.server.registerTool(
      name,
      { description: `[${domain}] ${description}`, inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          return await handler(args ?? {});
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }
}
