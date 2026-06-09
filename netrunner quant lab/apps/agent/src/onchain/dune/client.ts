import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { resolveQuery, availableQueries, allQueryNames } from "./queries.js";

// Dune Analytics adapter — the agent's on-chain "data brain". Read-only. It executes ONLY the curated,
// allowlisted query pack (queries.ts) by id; arbitrary SQL is intentionally not reachable from here.
//
// Cost discipline (Dune execution is credit-metered):
//   • cache-first  — a recent cached result (in-process TTL) is reused before spending a credit;
//   • execute path — POST /execute → poll /status → GET /results, bounded by a wall-clock timeout;
//   • honest-by-construction — every result carries source/as_of/query_id so the UI + reasoning can
//     cite exactly what produced it, and an unconfigured key/query returns a clear "unavailable"
//     result instead of throwing or fabricating numbers.
//
// Auth header is `X-Dune-API-Key` (Dune's documented scheme). No SDK dependency — native fetch.

const API_BASE = "https://api.dune.com/api/v1";

export interface DuneColumn { name: string }
export interface DunePanel {
  query: string;                 // the allowlisted name the agent asked for
  query_id: number | null;       // concrete Dune query id (null ⇒ unavailable)
  status: "ok" | "unavailable" | "error";
  reason?: string;               // why, when status !== ok (never a fake number)
  columns: string[];
  rows: Array<Record<string, unknown>>;
  row_count: number;
  source: "dune" | "gmx_api_fallback";
  as_of: string;                 // ISO timestamp of the result (cache or fresh)
  cached: boolean;
  execution_id?: string;
  params?: Record<string, string | number>;
}

interface CacheEntry { at: number; panel: DunePanel }
const cache = new Map<string, CacheEntry>();

function cacheKey(queryId: number, params: Record<string, string | number>): string {
  return `${queryId}:${JSON.stringify(params, Object.keys(params).sort())}`;
}

function unavailable(query: string, reason: string, queryId: number | null = null): DunePanel {
  return { query, query_id: queryId, status: "unavailable", reason, columns: [], rows: [], row_count: 0, source: "dune", as_of: new Date().toISOString(), cached: false };
}

async function duneFetch(path: string, init: RequestInit, apiKey: string): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "X-Dune-API-Key": apiKey, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

// Run one allowlisted query. Honors the cache; falls back to the cached "latest results" endpoint
// (free-ish, no execution) when allowed, else triggers a fresh execution.
export async function runDuneQuery(
  name: string,
  params: Record<string, string | number> = {},
  opts: { maxAgeSeconds?: number; preferCached?: boolean } = {},
): Promise<DunePanel> {
  const apiKey = config.duneApiKey;
  // Dune-only by design: panels are populated from real Dune executions or honestly marked
  // "unavailable" — there is NO GMX (or other) data fallback, so a number on a Dune panel always
  // came from Dune.
  if (!apiKey) return unavailable(name, "Dune is not configured (set DUNE_API_KEY).");

  const resolved = resolveQuery(name);
  if (!resolved) return unavailable(name, `'${name}' is not an allowlisted Dune query. Available: ${allQueryNames().join(", ")}.`);
  if (resolved.queryId <= 0) {
    return unavailable(name, `'${name}' has no Dune query id configured (set DUNE_QUERY_${name.toUpperCase()}). Configured: ${availableQueries().map((q) => q.name).join(", ") || "none"}.`, null);
  }

  // Only pass through params the query actually declares (avoids Dune 400s on unknown params).
  const cleanParams: Record<string, string | number> = {};
  for (const p of resolved.params) if (params[p] !== undefined) cleanParams[p] = params[p];

  const maxAge = opts.maxAgeSeconds ?? config.duneCacheTtlSeconds;
  const key = cacheKey(resolved.queryId, cleanParams);
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.at) / 1000 < maxAge) {
    return { ...hit.panel, cached: true };
  }

  try {
    // Cache-first: try Dune's "latest results" (cheaper) before paying for an execution. This endpoint
    // is param-blind (it returns the query's last run regardless of parameters), so it's only safe for
    // queries with NO parameters — a parameterized query (e.g. per-market gmx_market_stats) must execute
    // with its own params to avoid serving another symbol's rows.
    if (opts.preferCached !== false && Object.keys(cleanParams).length === 0) {
      const cachedPanel = await fetchLatestResults(name, resolved.queryId, cleanParams, apiKey).catch(() => null);
      if (cachedPanel && cachedPanel.status === "ok") {
        cache.set(key, { at: Date.now(), panel: cachedPanel });
        return cachedPanel;
      }
    }
    const fresh = await executeAndPoll(name, resolved.queryId, cleanParams, apiKey);
    if (fresh.status === "ok") cache.set(key, { at: Date.now(), panel: fresh });
    return fresh;
  } catch (e) {
    logger.warn("dune query failed", { name, queryId: resolved.queryId, message: (e as Error).message });
    return { ...unavailable(name, (e as Error).message, resolved.queryId), status: "error" };
  }
}

async function fetchLatestResults(name: string, queryId: number, params: Record<string, string | number>, apiKey: string): Promise<DunePanel> {
  const qs = new URLSearchParams({ limit: String(config.duneMaxRows) });
  const res = await duneFetch(`/query/${queryId}/results?${qs}`, { method: "GET" }, apiKey);
  if (!res.ok) throw new Error(`latest-results HTTP ${res.status}`);
  return normalizeResult(name, queryId, params, await res.json());
}

async function executeAndPoll(name: string, queryId: number, params: Record<string, string | number>, apiKey: string): Promise<DunePanel> {
  const exec = await duneFetch(`/query/${queryId}/execute`, {
    method: "POST",
    body: JSON.stringify(Object.keys(params).length ? { query_parameters: params } : {}),
  }, apiKey);
  if (!exec.ok) throw new Error(`execute HTTP ${exec.status}`);
  const execJson = (await exec.json()) as { execution_id?: string };
  const executionId = execJson.execution_id;
  if (!executionId) throw new Error("no execution_id returned");

  const deadline = Date.now() + config.duneExecTimeoutSeconds * 1000;
  // Poll status until the execution leaves the running/pending states.
  while (Date.now() < deadline) {
    await sleep(config.dunePollIntervalMs);
    const st = await duneFetch(`/execution/${executionId}/status`, { method: "GET" }, apiKey);
    if (!st.ok) throw new Error(`status HTTP ${st.status}`);
    const stJson = (await st.json()) as { state?: string };
    const state = stJson.state ?? "";
    if (state === "QUERY_STATE_COMPLETED") break;
    if (state === "QUERY_STATE_FAILED" || state === "QUERY_STATE_CANCELLED" || state === "QUERY_STATE_EXPIRED") {
      throw new Error(`execution ${state}`);
    }
  }
  const qs = new URLSearchParams({ limit: String(config.duneMaxRows) });
  const res = await duneFetch(`/execution/${executionId}/results?${qs}`, { method: "GET" }, apiKey);
  if (!res.ok) throw new Error(`results HTTP ${res.status}`);
  const panel = normalizeResult(name, queryId, params, await res.json());
  panel.execution_id = executionId;
  return panel;
}

// Normalize Dune's result envelope into a compact, UI-ready panel. Caps rows defensively.
function normalizeResult(name: string, queryId: number, params: Record<string, string | number>, json: unknown): DunePanel {
  const j = (json ?? {}) as Record<string, unknown>;
  const result = (j.result ?? {}) as Record<string, unknown>;
  const rowsRaw = Array.isArray(result.rows) ? (result.rows as Array<Record<string, unknown>>) : [];
  const meta = (result.metadata ?? {}) as Record<string, unknown>;
  const columns = Array.isArray(meta.column_names)
    ? (meta.column_names as unknown[]).map(String)
    : rowsRaw.length ? Object.keys(rowsRaw[0]) : [];
  const rows = rowsRaw.slice(0, config.duneMaxRows);
  const asOf = typeof j.execution_ended_at === "string" ? (j.execution_ended_at as string)
    : typeof j.submitted_at === "string" ? (j.submitted_at as string) : new Date().toISOString();
  return {
    query: name, query_id: queryId, status: "ok", columns, rows, row_count: rows.length,
    source: "dune", as_of: asOf, cached: false, params: Object.keys(params).length ? params : undefined,
  };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

export { availableQueries, allQueryNames };
