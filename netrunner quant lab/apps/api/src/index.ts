import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { authMiddleware, issueDevToken, issueOwnerToken, requireOwnerId, verifySiwe, makeSiweNonce, SiweVerificationError } from "./lib/auth.js";
import { bootstrapBackfillWorker, enqueueBackfillJob, enqueueDueSchedules, queueStats, upsertSchedule } from "./lib/backfillQueue.js";
import { db, withTransaction } from "./lib/db.js";
import { redis } from "./lib/redis.js";
import { scanCoverage } from "./lib/gapScanner.js";
import { apiRequestCounter, passportVerificationCounter, registry, runHashMismatchCounter, runTierCounter } from "./lib/metrics.js";
import { normalizeTierLabel, rankScoreForTier, VERIFIED_TIERS } from "./lib/tiering.js";
import { createChainsRouter } from "./routes/chains.js";
import { createDelegationsRouter } from "./routes/delegations.js";
import { createRelayRouter } from "./routes/relay.js";
import { createLpExecRouter } from "./routes/lpExec.js";
import { createExecPlanRouter } from "./routes/execPlan.js";
import { createCrossChainRouter } from "./routes/crosschain.js";
import { createStockOrdersRouter } from "./routes/stockOrders.js";
import { startStockOrderEngine } from "./lib/stockOrderEngine.js";
import { createDexRouter } from "./routes/dex.js";
import { createGmxRouter } from "./routes/gmx.js";
import { createWalletsRouter } from "./routes/wallets.js";
import { createTestnetIntentsRouter } from "./routes/testnetIntents.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS for the local web GUI (browser hits this from a different origin/port).
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
// Safety net: a single rejected DB query must never take down the whole API.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

app.use((req, res, next) => {
  const route = req.path;
  res.on("finish", () => {
    apiRequestCounter.labels(req.method, route, String(res.statusCode)).inc();
  });
  next();
});
app.use(authMiddleware);
app.use(async (req, res, next) => {
  if (!req.auth) {
    next();
    return;
  }
  try {
    const ownerId = req.auth.ownerId;
    // Provisioning is NOT done here. A users row is created exactly once, at the auth edge
    // (POST /auth/session for Privy, GET /auth/dev-token for the dev path) — both keyed on
    // privy_did with BIGSERIAL-assigned ids, so there is one id space and no users_pkey
    // collision. This per-request path is now READ-ONLY: it must never write (no per-request
    // INSERT) and must never resurrect a row that account-erasure deleted. A cheap, PK-indexed
    // SELECT is used (not a Redis status cache) so suspension/erasure take effect immediately,
    // not after a cache TTL.
    const found = await db.query<{ status: string }>(
      `SELECT status FROM users WHERE id = $1`,
      [ownerId]
    );
    if (!found.rowCount) {
      // No row for this owner: an erased or never-provisioned subject. Do not recreate it.
      return res.status(401).json({ error: "UNAUTHORIZED", reason: "USER_NOT_FOUND" });
    }
    // P2 session lifecycle:
    //  (a) suspended accounts are blocked immediately (not at token expiry);
    //  (b) a token whose `ver` is below the owner's current auth:ver:{id} is revoked (logout /
    //      revoke-all bump that key). Redis read is O(1) and on the existing request-path client.
    const status = found.rows[0].status;
    if (status === "suspended") {
      return res.status(403).json({ error: "ACCOUNT_SUSPENDED" });
    }
    const tokenVer = Number(req.auth.claims.ver ?? 0);
    let minVer = 0;
    try {
      minVer = Number(await redis.get(`auth:ver:${ownerId}`)) || 0;
    } catch {
      minVer = 0; // Redis unavailable: fall back to status-only gating (fail-open on revocation).
    }
    if (tokenVer < minVer) {
      return res.status(401).json({ error: "UNAUTHORIZED", reason: "TOKEN_REVOKED" });
    }
    next();
  } catch (error) {
    next(error);
  }
});

const port = Number(process.env.API_PORT ?? 4000);
const workerUrl = process.env.QUANT_WORKER_URL ?? "http://localhost:7000";
const verifierUrl = process.env.DUALITY_VERIFIER_URL ?? "http://verifier:7200";
const dataIngestorUrl = process.env.DATA_INGESTOR_URL ?? "http://data-ingestor:7100";
const workerRequestTimeoutMs = Number(process.env.WORKER_REQUEST_TIMEOUT_MS ?? 25_000);
const workerRetryAttempts = Math.max(1, Number(process.env.WORKER_RETRY_ATTEMPTS ?? 3));
const workerRetryBaseMs = Math.max(0, Number(process.env.WORKER_RETRY_BASE_MS ?? 200));
const apiRoot = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(apiRoot, "../../../packages/ui/templates");
const regimesPath = resolve(apiRoot, "../../../packages/ui/regimes/btc_regimes.json");

type MissingRange = { startMs: number; endMs: number };
type BucketedCoverage = { coverage_pct: number; missing_ranges: MissingRange[]; rows: number };
type CoverageProof = {
  candles: BucketedCoverage;
  l2_snapshots: BucketedCoverage & { depth: number | null };
  trades: BucketedCoverage;
  mark_prices: BucketedCoverage;
  index_prices: BucketedCoverage;
  funding: { coverage_pct: number; rows: number };
  instrument_snapshot: { version: string | null; fetched_at: string | null } | null;
  risk_limit_snapshot: { version: string | null; fetched_at: string | null; tiers: number } | null;
};

type CoverageRequirementMode = "bar_based" | "l2_sweep_only" | "l2_queue_full" | "l2_sweep" | "l2_queue";

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return value == null ? null : String(value);
}

function normalizeCoverageMode(mode: unknown): "bar_based" | "l2_sweep_only" | "l2_queue_full" {
  const m = String(mode ?? "bar_based").toLowerCase();
  if (m === "l2_queue" || m === "l2_queue_full" || m === "queue") return "l2_queue_full";
  if (m === "l2_sweep" || m === "l2_sweep_only" || m === "sweep") return "l2_sweep_only";
  return "bar_based";
}

function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function findFirstNumericField(value: unknown, names: Set<string>, depth = 0): number | null {
  if (depth > 5 || value == null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNumericField(item, names, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (names.has(key)) {
      const n = positiveNumber(raw);
      if (n !== null) return n;
    }
  }
  for (const raw of Object.values(value as Record<string, unknown>)) {
    const found = findFirstNumericField(raw, names, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function missingRangesFromBuckets(
  present: Set<number>,
  startMs: number,
  effectiveEndMs: number,
  bucketMs: number,
  total: number
): MissingRange[] {
  const missing: MissingRange[] = [];
  let runStart = -1;
  for (let b = 0; b < total; b += 1) {
    if (!present.has(b)) {
      if (runStart < 0) runStart = b;
    } else if (runStart >= 0) {
      missing.push({ startMs: startMs + runStart * bucketMs, endMs: startMs + b * bucketMs });
      runStart = -1;
    }
  }
  if (runStart >= 0) missing.push({ startMs: startMs + runStart * bucketMs, endMs: effectiveEndMs });
  return missing;
}

async function readWorkerJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { error: "WORKER_INVALID_RESPONSE", raw };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function shouldRetryWorkerStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryBackoffMs(attempt: number): number {
  const exp = Math.max(0, Math.min(6, attempt - 1));
  return workerRetryBaseMs * 2 ** exp;
}

async function fetchWorker(path: string, init: RequestInit = {}, ownerId?: string | number): Promise<Response> {
  const extra: Record<string, string> = {};
  if (ownerId !== undefined) extra["x-owner-id"] = String(ownerId);
  if (process.env.INTERNAL_SECRET) extra["x-internal-secret"] = process.env.INTERNAL_SECRET;
  if (Object.keys(extra).length) {
    init = { ...init, headers: { ...(init.headers as Record<string, string> || {}), ...extra } };
  }
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= workerRetryAttempts; attempt += 1) {
    try {
      const response = await fetch(`${workerUrl}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(workerRequestTimeoutMs),
      });
      if (attempt < workerRetryAttempts && shouldRetryWorkerStatus(response.status)) {
        await sleep(retryBackoffMs(attempt));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error as Error;
      if (attempt < workerRetryAttempts) {
        await sleep(retryBackoffMs(attempt));
        continue;
      }
    }
  }
  throw lastError ?? new Error("Worker request failed");
}

function sha256(input: unknown): string {
  const stable = typeof input === "string" ? input : JSON.stringify(input);
  return createHash("sha256").update(stable).digest("hex");
}

async function bucketedCoverage(
  sourceSql: string,
  params: unknown[],
  startMs: number,
  endMs: number,
  bucketMs: number
): Promise<BucketedCoverage> {
  const safeBucketMs = Math.max(1, Math.floor(bucketMs));
  const total = Math.max(1, Math.min(Math.ceil(Math.max(0, endMs - startMs) / safeBucketMs), 20_000));
  const effectiveEndMs = startMs + total * safeBucketMs;
  const r = await db.query<{ rows: number; buckets: Array<string | number> | null }>(
    `
      SELECT count(*)::int AS rows,
             COALESCE(array_agg(DISTINCT bucket), ARRAY[]::bigint[]) AS buckets
      FROM (${sourceSql}) AS src
      WHERE bucket >= 0 AND bucket < $4
    `,
    [startMs, effectiveEndMs, safeBucketMs, total, ...params]
  );
  const row = r.rows[0] ?? { rows: 0, buckets: [] };
  const present = new Set<number>((row.buckets ?? []).map((x) => Number(x)).filter((x) => Number.isFinite(x)));
  const missing = missingRangesFromBuckets(present, startMs, effectiveEndMs, safeBucketMs, total);
  return {
    coverage_pct: Number((Math.min(present.size, total) / total).toFixed(6)),
    missing_ranges: missing,
    rows: Number(row.rows ?? 0),
  };
}

async function computeCoverageProof(
  symbol: string,
  category: string,
  startMs: number,
  endMs: number,
  intervalMs: number,
  opts: { interval?: string } = {}
): Promise<CoverageProof> {
  const interval = String(opts.interval ?? Math.max(1, Math.round(intervalMs / 60_000)));
  const bucketMs = Math.max(1, Math.floor(intervalMs));
  const sym = symbol.toUpperCase();
  const cat = category || (sym.endsWith("XUSDT") ? "spot" : "linear");

  const [candles, l2Base, l2Depth, trades, markPrices, indexPrices, funding, instrument] = await Promise.all([
    bucketedCoverage(
      `
        SELECT floor((((EXTRACT(EPOCH FROM open_time) * 1000)::bigint - $1) / $3))::bigint AS bucket
        FROM candles
        WHERE symbol = $5 AND category = $6 AND interval = $7
          AND open_time >= to_timestamp($1 / 1000.0)
          AND open_time < to_timestamp($2 / 1000.0)
      `,
      [sym, cat, interval],
      startMs,
      endMs,
      bucketMs
    ),
    bucketedCoverage(
      `
        SELECT floor((((EXTRACT(EPOCH FROM ts) * 1000)::bigint - $1) / $3))::bigint AS bucket
        FROM l2_snapshots
        WHERE symbol = $5 AND category = $6
          AND ts >= to_timestamp($1 / 1000.0)
          AND ts < to_timestamp($2 / 1000.0)
      `,
      [sym, cat],
      startMs,
      endMs,
      bucketMs
    ),
    db.query<{ depth: number | null }>(
      `
        SELECT max(GREATEST(jsonb_array_length(bid_levels_json), jsonb_array_length(ask_levels_json)))::int AS depth
        FROM l2_snapshots
        WHERE symbol = $1 AND category = $2
          AND ts >= to_timestamp($3 / 1000.0)
          AND ts < to_timestamp($4 / 1000.0)
      `,
      [sym, cat, startMs, endMs]
    ),
    bucketedCoverage(
      `
        SELECT floor(((trade_time_ms - $1) / $3))::bigint AS bucket
        FROM trades
        WHERE symbol = $5 AND category = $6
          AND trade_time_ms >= $1
          AND trade_time_ms < $2
      `,
      [sym, cat],
      startMs,
      endMs,
      bucketMs
    ),
    bucketedCoverage(
      `
        SELECT floor((((EXTRACT(EPOCH FROM open_time) * 1000)::bigint - $1) / $3))::bigint AS bucket
        FROM mark_candles
        WHERE symbol = $5 AND interval = $6
          AND open_time >= to_timestamp($1 / 1000.0)
          AND open_time < to_timestamp($2 / 1000.0)
      `,
      [sym, interval],
      startMs,
      endMs,
      bucketMs
    ),
    bucketedCoverage(
      `
        SELECT floor((((EXTRACT(EPOCH FROM open_time) * 1000)::bigint - $1) / $3))::bigint AS bucket
        FROM index_candles
        WHERE symbol = $5 AND interval = $6
          AND open_time >= to_timestamp($1 / 1000.0)
          AND open_time < to_timestamp($2 / 1000.0)
      `,
      [sym, interval],
      startMs,
      endMs,
      bucketMs
    ),
    db.query<{ rows: number }>(
      `
        SELECT count(*)::int AS rows
        FROM funding_rates
        WHERE symbol = $1 AND category = $2
          AND funding_rate_timestamp >= to_timestamp($3 / 1000.0)
          AND funding_rate_timestamp < to_timestamp($4 / 1000.0)
      `,
      [sym, cat, startMs, endMs]
    ),
    db.query<{ data_version: string | null; source_fetched_at: Date | string | null; tiers: number }>(
      `
        SELECT data_version,
               source_fetched_at,
               COALESCE(jsonb_array_length(maintenance_margin_tiers_json), 0)::int AS tiers
        FROM instrument_snapshots
        WHERE symbol = $1
        ORDER BY source_fetched_at DESC NULLS LAST, valid_from DESC NULLS LAST
        LIMIT 1
      `,
      [sym]
    ),
  ]);

  const instrumentRow = instrument.rows[0];
  const fundingRows = Number(funding.rows[0]?.rows ?? 0);
  return {
    candles,
    l2_snapshots: { ...l2Base, depth: l2Depth.rows[0]?.depth ?? null },
    trades,
    mark_prices: markPrices,
    index_prices: indexPrices,
    funding: { coverage_pct: fundingRows > 0 ? 1 : 0, rows: fundingRows },
    instrument_snapshot: instrumentRow
      ? { version: instrumentRow.data_version ?? null, fetched_at: isoOrNull(instrumentRow.source_fetched_at) }
      : null,
    risk_limit_snapshot: instrumentRow && Number(instrumentRow.tiers ?? 0) > 0
      ? {
          version: instrumentRow.data_version ?? null,
          fetched_at: isoOrNull(instrumentRow.source_fetched_at),
          tiers: Number(instrumentRow.tiers ?? 0),
        }
      : null,
  };
}

function coverageRequirementsMet(
  proof: Partial<CoverageProof> | null | undefined,
  mode: CoverageRequirementMode | string,
  opts: { leveraged?: boolean; funding?: boolean; thresholds?: Partial<Record<"candles" | "l2" | "trades" | "mark" | "index", number>> } = {}
): { ok: boolean; missing: string[] } {
  const p = proof ?? {};
  const thresholds = {
    candles: Number(process.env.CANDLE_COVERAGE_THRESHOLD ?? opts.thresholds?.candles ?? 0.98),
    l2: Number(process.env.L2_SNAPSHOT_COVERAGE_THRESHOLD ?? opts.thresholds?.l2 ?? 0.98),
    trades: Number(process.env.TRADE_COVERAGE_THRESHOLD ?? opts.thresholds?.trades ?? 0.98),
    mark: Number(process.env.MARK_PRICE_COVERAGE_THRESHOLD ?? opts.thresholds?.mark ?? 0.98),
    index: Number(process.env.INDEX_PRICE_COVERAGE_THRESHOLD ?? opts.thresholds?.index ?? 0.98),
  };
  const normalized = normalizeCoverageMode(mode);
  const missing: string[] = [];
  const pct = (source: keyof CoverageProof): number => Number((p[source] as { coverage_pct?: unknown } | undefined)?.coverage_pct ?? 0);

  if (pct("candles") < thresholds.candles) missing.push("CANDLE_COVERAGE_BELOW_THRESHOLD");
  if ((normalized === "l2_sweep_only" || normalized === "l2_queue_full") && pct("l2_snapshots") < thresholds.l2) {
    missing.push("L2_SNAPSHOT_COVERAGE_BELOW_THRESHOLD");
  }
  if (normalized === "l2_queue_full" && pct("trades") < thresholds.trades) {
    missing.push("TRADE_COVERAGE_BELOW_THRESHOLD");
  }
  if (opts.leveraged) {
    if (pct("mark_prices") < thresholds.mark) missing.push("MARK_PRICE_COVERAGE_BELOW_THRESHOLD");
    if (pct("index_prices") < thresholds.index) missing.push("INDEX_PRICE_COVERAGE_BELOW_THRESHOLD");
    if (!p.risk_limit_snapshot) missing.push("MISSING_RISK_LIMIT_SNAPSHOT");
  }
  if (opts.funding && Number((p.funding as { rows?: unknown } | undefined)?.rows ?? 0) <= 0) {
    missing.push("MISSING_FUNDING_ROWS");
  }
  return { ok: missing.length === 0, missing };
}

function generateGridCandidates(
  searchSpace: Record<string, { min: number; max: number; step: number }>,
  limit = 500
): Array<{ params: Record<string, number>; vector_metrics: { total_return: number; max_drawdown: number; trade_count: number } }> {
  const keys = Object.keys(searchSpace);
  if (keys.length === 0) return [];
  const values = keys.map((k) => {
    const { min, max, step } = searchSpace[k];
    const arr: number[] = [];
    for (let v = min; v <= max + 1e-12; v += step) {
      arr.push(Number(v.toFixed(10)));
      if (arr.length > 2000) break;
    }
    return arr;
  });
  const out: Array<{ params: Record<string, number>; vector_metrics: { total_return: number; max_drawdown: number; trade_count: number } }> = [];
  const cursor = new Array(keys.length).fill(0);
  while (out.length < limit) {
    const params: Record<string, number> = {};
    for (let i = 0; i < keys.length; i += 1) {
      params[keys[i]] = values[i][cursor[i]];
    }
    // Placeholder vector metric estimate: deterministic monotone score from params hash.
    const hashNum = parseInt(sha256(params).slice(0, 8), 16);
    const u = (hashNum % 10000) / 10000;
    out.push({
      params,
      vector_metrics: {
        total_return: Number((0.05 + u * 0.25).toFixed(6)),
        max_drawdown: Number((0.05 + (1 - u) * 0.25).toFixed(6)),
        trade_count: 10 + (hashNum % 50),
      },
    });

    let idx = keys.length - 1;
    while (idx >= 0) {
      cursor[idx] += 1;
      if (cursor[idx] < values[idx].length) break;
      cursor[idx] = 0;
      idx -= 1;
    }
    if (idx < 0) break;
  }
  return out;
}

async function enrichBotCoverage(
  symbol: string,
  category: string,
  startTs: number,
  endTs: number,
  intervalMs: number,
  requested: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const coverage: Record<string, unknown> = { ...requested };
  if (startTs <= 0 || endTs <= 0) {
    return coverage;
  }
  const sym = symbol.toUpperCase();
  const cat = category || (sym.endsWith("XUSDT") ? "spot" : "linear");
  const interval = String(Math.max(1, Math.round(intervalMs / 60_000)));
  const coverageProof = await computeCoverageProof(sym, cat, startTs, endTs, intervalMs, { interval });
  const [l2, funding, marginTiers] = await Promise.all([
    db.query(
      `
        SELECT 1
        FROM l2_snapshots
        WHERE symbol = $1
          AND category = $2
          AND ts >= to_timestamp($3 / 1000.0)
          AND ts < to_timestamp($4 / 1000.0)
        LIMIT 1
      `,
      [sym, cat, startTs, endTs]
    ),
    db.query(
      `
        SELECT 1
        FROM funding_rates
        WHERE symbol = $1
          AND category = $2
          AND funding_rate_timestamp >= to_timestamp($3 / 1000.0)
          AND funding_rate_timestamp < to_timestamp($4 / 1000.0)
        LIMIT 1
      `,
      [sym, cat, startTs, endTs]
    ),
    db.query(
      `
        SELECT 1
        FROM instrument_snapshots
        WHERE symbol = $1
          AND jsonb_array_length(maintenance_margin_tiers_json) > 0
        LIMIT 1
      `,
      [sym]
    ),
  ]);
  const hasRecordedL2 = Boolean(l2.rowCount);
  coverage.startTs = coverage.startTs ?? startTs;
  coverage.endTs = coverage.endTs ?? endTs;
  coverage.category = coverage.category ?? cat;
  coverage.interval = coverage.interval ?? interval;
  coverage.has_recorded_l2 = hasRecordedL2;
  coverage.has_l2 = hasRecordedL2 || Boolean(coverage.has_l2);
  coverage.has_live_l1 = hasRecordedL2 || Boolean(coverage.has_live_l1);
  coverage.has_funding = Boolean(funding.rowCount) || Boolean(coverage.has_funding);
  coverage.has_margin_tiers = Boolean(marginTiers.rowCount) || Boolean(coverage.has_margin_tiers);
  coverage.has_volume = true;
  coverage.coverage_proof = coverageProof;
  return coverage;
}

async function ensureDefaultBackfillSchedules(): Promise<void> {
  const enabled = String(process.env.BACKFILL_DEFAULT_SCHEDULES_ENABLED ?? "true").toLowerCase() !== "false";
  if (!enabled) return;

  const symbols = Array.from(
    new Set(
      String(process.env.BACKFILL_DEFAULT_SYMBOLS ?? "BTCUSDT,ETHUSDT,SOLUSDT")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  if (symbols.length === 0) return;

  for (const symbol of symbols) {
    await upsertSchedule({
      scheduleId: `default_kline_${symbol}_15`,
      endpoint: "kline",
      symbol,
      category: "linear",
      interval: "15",
      cadenceCron: "*/15 * * * *",
      lookbackMs: 7 * 24 * 60 * 60 * 1000,
      enabled: true,
      dataVersion: "v1",
    });
    await upsertSchedule({
      scheduleId: `default_funding_${symbol}`,
      endpoint: "funding",
      symbol,
      category: "linear",
      interval: "15",
      cadenceCron: "0 */2 * * *",
      lookbackMs: 14 * 24 * 60 * 60 * 1000,
      enabled: true,
      dataVersion: "v1",
    });
    await upsertSchedule({
      scheduleId: `default_oi_${symbol}_15`,
      endpoint: "oi",
      symbol,
      category: "linear",
      interval: "15",
      cadenceCron: "*/15 * * * *",
      lookbackMs: 48 * 60 * 60 * 1000,
      enabled: true,
      dataVersion: "v1",
    });
    await upsertSchedule({
      scheduleId: `default_lsr_${symbol}_15`,
      endpoint: "long-short",
      symbol,
      category: "linear",
      interval: "15",
      cadenceCron: "*/15 * * * *",
      lookbackMs: 48 * 60 * 60 * 1000,
      enabled: true,
      dataVersion: "v1",
    });
  }

  await upsertSchedule({
    scheduleId: "default_instruments_linear",
    endpoint: "instruments",
    symbol: symbols[0],
    category: "linear",
    interval: "15",
    cadenceCron: "0 */6 * * *",
    lookbackMs: 6 * 60 * 60 * 1000,
    enabled: true,
    dataVersion: "v1",
  });
}

app.get("/metrics", async (_req, res) => {
  res.setHeader("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});

app.get("/auth/dev-token", async (req, res) => {
  // SECURITY: this endpoint mints a JWT for ANY ownerId — it is a full auth bypass and
  // MUST be off in production. Disabled unless ALLOW_DEV_TOKEN=true is explicitly set,
  // and refused if the signing secret is unset or still a placeholder.
  if (process.env.ALLOW_DEV_TOKEN !== "true") {
    return res.status(403).json({ error: "DEV_TOKEN_DISABLED",
      reason: "set ALLOW_DEV_TOKEN=true to enable (dev/test only)" });
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change-me") {
    return res.status(403).json({ error: "DEV_TOKEN_DISABLED",
      reason: "refusing to issue with the default/unset JWT_SECRET" });
  }
  const requestedOwnerId = Number(req.query.ownerId ?? 1);
  if (!Number.isInteger(requestedOwnerId) || requestedOwnerId <= 0) {
    return res.status(400).json({ error: "INVALID_OWNER_ID" });
  }
  // Provision the dev user the SAME way Privy does — keyed on a deterministic dev DID, letting
  // BIGSERIAL assign the id (never an explicit id, which could collide with the sequence). The
  // 0011 backfill set privy_did='did:dev:'||id for pre-existing rows, so 'did:dev:1' still maps
  // back to id=1; the returned id is the authoritative ownerId we mint the token for.
  const devDid = `did:dev:${requestedOwnerId}`;
  const upsert = await db.query<{ id: string }>(
    `
      INSERT INTO users (privy_did, last_login_at)
      VALUES ($1, NOW())
      ON CONFLICT (privy_did)
      DO UPDATE SET last_login_at = NOW()
      RETURNING id
    `,
    [devDid]
  );
  const ownerId = Number(upsert.rows[0].id);
  // Mint at the owner's current token version so a freshly-issued dev token is not pre-revoked by
  // a prior /auth/logout (the gate rejects token.ver < auth:ver:{ownerId}).
  let ver = 0;
  try { ver = Number(await redis.get(`auth:ver:${ownerId}`)) || 0; } catch { ver = 0; }
  const token = issueDevToken(ownerId, ver);
  return res.json({ token, ownerId });
});

// SIWE step 1 — issue a single-use nonce. Public route (precedes sign-in). The client embeds this
// nonce in the EIP-4361 message it asks MetaMask to sign; /auth/session consumes it exactly once.
app.get("/auth/nonce", async (_req, res) => {
  const nonce = makeSiweNonce();
  try {
    await redis.set(`auth:siwe:nonce:${nonce}`, "1", "EX", 300); // 5-min TTL
  } catch {
    return res.status(503).json({ error: "NONCE_STORE_UNAVAILABLE" });
  }
  return res.json({ nonce });
});

// SIWE step 2 — MetaMask edge → internal owner JWT (variant A token-exchange). Public route: it
// verifies the EIP-4361 message + personal_sign signature itself; the internal HS256 owner token it
// returns is what every other route (and authMiddleware) consumes — UNCHANGED. The wallet maps to
// the same identity key (`siwe:{address}` in users.privy_did) so the upsert/owner-JWT/revocation
// machinery is reused byte-for-byte.
app.post("/auth/session", async (req, res) => {
  // Lightweight Redis token-bucket rate limit (this does a DB upsert + token mint per call).
  try {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
    const rlKey = `auth:session:rl:${ip}`;
    const n = await redis.incr(rlKey);
    if (n === 1) await redis.expire(rlKey, 60);
    const limit = Number(process.env.AUTH_SESSION_RATE_PER_MIN ?? 30);
    if (n > limit) return res.status(429).json({ error: "RATE_LIMITED" });
  } catch {
    /* Redis down: skip rate-limit rather than block logins. */
  }

  const message = typeof req.body?.message === "string" ? req.body.message : "";
  const signature = typeof req.body?.signature === "string" ? req.body.signature : "";
  if (!message || !signature) return res.status(400).json({ error: "MISSING_SIWE_PAYLOAD" });

  let identity;
  try {
    identity = verifySiwe(message, signature);
  } catch (error) {
    const code = (error as SiweVerificationError).code ?? "SIWE_TOKEN_INVALID";
    return res.status(401).json({ error: code });
  }

  // Consume the nonce exactly once (replay protection). DEL returns 1 only if it existed.
  try {
    const consumed = await redis.del(`auth:siwe:nonce:${identity.nonce}`);
    if (consumed !== 1) return res.status(401).json({ error: "SIWE_NONCE_INVALID" });
  } catch {
    return res.status(503).json({ error: "NONCE_STORE_UNAVAILABLE" });
  }

  // First login auto-provisions; subsequent logins update profile + last_login_at. Identity key is
  // privy_did (now `siwe:{address}`); SIWE logins are wallet-only (no email). tier/status keep
  // their server defaults.
  const upsert = await db.query<{ id: string; tier: string; status: string; email: string | null; display_name: string | null; primary_wallet: string | null }>(
    `
      INSERT INTO users (privy_did, email, primary_wallet, last_login_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (privy_did)
      DO UPDATE SET
        primary_wallet = COALESCE(EXCLUDED.primary_wallet, users.primary_wallet),
        last_login_at = NOW()
      RETURNING id, tier, status, email, display_name, primary_wallet
    `,
    [identity.did, null, identity.wallet]
  );
  const row = upsert.rows[0];
  const ownerId = Number(row.id);
  if (row.status === "suspended") {
    return res.status(403).json({ error: "ACCOUNT_SUSPENDED" });
  }
  let ver = 0;
  try { ver = Number(await redis.get(`auth:ver:${ownerId}`)) || 0; } catch { ver = 0; }
  const ownerToken = issueOwnerToken(ownerId, ver);
  return res.json({
    ownerToken,
    ownerId,
    profile: { tier: row.tier, status: row.status, email: row.email, displayName: row.display_name, primaryWallet: row.primary_wallet },
  });
});

// P1.2 — current owner profile (authenticated).
app.get("/api/me", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const r = await db.query<{ id: string; tier: string; status: string; email: string | null; display_name: string | null; primary_wallet: string | null }>(
    `SELECT id, tier, status, email, display_name, primary_wallet FROM users WHERE id = $1`,
    [ownerId]
  );
  if (!r.rowCount) return res.status(404).json({ error: "USER_NOT_FOUND" });
  const u = r.rows[0];
  return res.json({
    ownerId, tier: u.tier, status: u.status,
    email: u.email ?? undefined, displayName: u.display_name ?? undefined, primaryWallet: u.primary_wallet ?? undefined,
  });
});

// P2 — logout / revoke-all: bump the owner's token version so every outstanding 12h token is
// invalidated on its next request (the gate compares token.ver < auth:ver:{ownerId}).
app.post("/auth/logout", async (req, res) => {
  const ownerId = requireOwnerId(req);
  try {
    await redis.incr(`auth:ver:${ownerId}`);
  } catch {
    return res.status(503).json({ error: "REVOCATION_UNAVAILABLE" });
  }
  return res.json({ ok: true, revoked: true });
});

// P3 — account erasure (DPDP/GDPR). One transaction deletes every owner-scoped row across the
// control-plane + Timescale tables, children before parents, then the user. Owner linkage:
//  - direct owner_id: strategies, strategy_versions, paper_accounts, bot_specs,
//    bot_recommendations, marketplace_cards, live_paper_sessions/checkpoints (TEXT owner_id);
//  - via run_id ∈ owner's backtest_runs: backtest_events, risk_snapshots, leaderboard_passports,
//    bot_cycles, execution_slices, grid_levels, rebalance_events;
//  - via account_id ∈ owner's paper_accounts: paper_sessions → paper_events/fills/positions;
//  - via strategy_version_id: optimization_runs → optimization_candidates.
// Shared canonical market data (candles/trades/l2_snapshots/…) is NOT owner-scoped and untouched.
// FKs have no ON DELETE CASCADE today, so the order is explicit. (S3 cold archive is not wired —
// noted for when it lands: erasure must then also reach it.)
app.delete("/api/me", async (req, res) => {
  const ownerId = requireOwnerId(req);
  // Sub-selects scoping everything to this owner.
  const SVS = `SELECT strategy_version_id FROM strategy_versions WHERE owner_id = $1`;
  const SPECS = `SELECT bot_spec_id FROM bot_specs WHERE owner_id = $1`;
  const RUNS = `SELECT run_id FROM backtest_runs WHERE strategy_version_id IN (${SVS}) OR bot_spec_id IN (${SPECS})`;
  const ACCTS = `SELECT account_id FROM paper_accounts WHERE owner_id = $1`;
  const SESS = `SELECT id FROM paper_sessions WHERE account_id IN (${ACCTS})`;
  const OPTRUNS = `SELECT run_id FROM optimization_runs WHERE strategy_version_id IN (${SVS})`;

  const steps = [
    // run-scoped children
    `DELETE FROM backtest_events     WHERE run_id IN (${RUNS})`,
    `DELETE FROM risk_snapshots      WHERE run_id IN (${RUNS})`,
    `DELETE FROM leaderboard_passports WHERE run_id IN (${RUNS}) OR strategy_version_id IN (${SVS})`,
    `DELETE FROM bot_cycles          WHERE run_id IN (${RUNS})`,
    `DELETE FROM execution_slices    WHERE run_id IN (${RUNS})`,
    `DELETE FROM grid_levels         WHERE run_id IN (${RUNS})`,
    `DELETE FROM rebalance_events    WHERE run_id IN (${RUNS})`,
    // optimization
    `DELETE FROM optimization_candidates WHERE run_id IN (${OPTRUNS})`,
    `DELETE FROM optimization_runs   WHERE strategy_version_id IN (${SVS})`,
    // paper trading
    `DELETE FROM paper_fills         WHERE session_id IN (${SESS})`,
    `DELETE FROM paper_positions     WHERE session_id IN (${SESS})`,
    `DELETE FROM paper_events        WHERE session_id IN (${SESS})`,
    `DELETE FROM paper_sessions      WHERE account_id IN (${ACCTS})`,
    // run + marketplace parents
    `DELETE FROM marketplace_cards   WHERE owner_id = $1 OR bot_spec_id IN (${SPECS})`,
    `DELETE FROM backtest_runs       WHERE strategy_version_id IN (${SVS}) OR bot_spec_id IN (${SPECS})`,
    // live paper (owner_id is BIGINT after migration 0012)
    `DELETE FROM live_paper_checkpoints WHERE owner_id = $1`,
    `DELETE FROM live_paper_sessions    WHERE owner_id = $1`,
    `DELETE FROM testnet_intents        WHERE owner_id = $1`,
    `DELETE FROM wallet_links           WHERE owner_id = $1`,
    // direct owner_id parents
    `DELETE FROM bot_recommendations WHERE owner_id = $1`,
    `DELETE FROM paper_accounts      WHERE owner_id = $1`,
    `DELETE FROM bot_specs           WHERE owner_id = $1`,
    `DELETE FROM strategy_versions   WHERE owner_id = $1`,
    `DELETE FROM strategies          WHERE owner_id = $1`,
    `DELETE FROM users               WHERE id = $1`,
  ];
  // §25 A.2 — quiesce any running live-paper session in the worker FIRST, so erasure doesn't leave
  // an in-memory book ticking after the rows are gone. Best-effort (worker may be down/absent).
  try {
    const sids = await db.query<{ session_id: string }>(
      `SELECT session_id FROM live_paper_sessions WHERE owner_id = $1`, [ownerId]
    ).catch(() => ({ rows: [] as { session_id: string }[] }));
    for (const s of sids.rows) {
      await fetchWorker(`/live-paper/stop/${encodeURIComponent(s.session_id)}`, { method: "POST" }, ownerId).catch(() => undefined);
    }
  } catch { /* non-fatal */ }
  try {
    // Some owner-scoped tables (e.g. live_paper_sessions) are created by the worker, not a
    // migration, so may be absent on a fresh DB. Skip deletes whose target table doesn't exist
    // rather than aborting the whole transaction.
    const present = new Set(
      (await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`
      )).rows.map((r) => r.table_name)
    );
    const targetOf = (sql: string) => (sql.match(/DELETE FROM\s+(\w+)/i)?.[1] ?? "").toLowerCase();
    await withTransaction(async (client) => {
      for (const sql of steps) {
        if (!present.has(targetOf(sql))) continue;
        await client.query(sql, [ownerId]);
      }
    });
  } catch (error) {
    // Log server-side (no PII — a Postgres/error message) so erasure failures are observable.
    console.error(`[erasure] owner=${ownerId} failed: ${(error as Error).message}`);
    return res.status(500).json({ error: "ERASURE_FAILED", message: (error as Error).message });
  }
  // Best-effort purge of out-of-DB owner state.
  try {
    await redis.del(`auth:ver:${ownerId}`);
    const sessKeys = await redis.keys(`rt:session:${ownerId}*`);
    if (sessKeys.length) await redis.del(...sessKeys);
  } catch { /* non-fatal */ }
  return res.json({ ok: true, erased: true, ownerId });
});

app.get("/health", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => undefined);
    }
    await redis.ping();
    res.json({ ok: true, service: "api", db: "up", redis: "up" });
  } catch (error) {
    res.status(503).json({ ok: false, service: "api", error: (error as Error).message });
  }
});

app.use(createChainsRouter());
app.use(createDelegationsRouter());
app.use(createRelayRouter());
app.use(createLpExecRouter());
app.use(createExecPlanRouter());
app.use(createCrossChainRouter());
app.use(createStockOrdersRouter());
app.use(createGmxRouter());
app.use(createWalletsRouter(redis));
app.use(createTestnetIntentsRouter());

app.get("/api/data/coverage", async (req, res) => {
  const querySchema = z.object({
    symbol: z.string(),
    interval: z.string(),
    category: z.string().default("linear")
  });

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const coverage = await db.query(
    `
      SELECT symbol, category, interval, range_start, range_end, expected_bars,
             actual_bars, missing_bars, duplicate_bars, data_version,
             subject_to_retention, updated_at
      FROM data_coverage
      WHERE symbol = $1 AND category = $2 AND interval = $3
      ORDER BY updated_at DESC
      LIMIT 50
    `,
    [parsed.data.symbol, parsed.data.category, parsed.data.interval]
  );

  // Phase 7 audit layer: when an explicit [startTs,endTs] window is supplied, also return
  // the structured coverage proof (per-source coverage_pct + missing_ranges). The legacy
  // `rows` view (data_coverage table) is preserved for back-compat.
  const startMs = Number(req.query.startTs ?? req.query.startMs ?? NaN);
  const endMs = Number(req.query.endTs ?? req.query.endMs ?? NaN);
  let coverage_proof: CoverageProof | null = null;
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
    const intervalMs = Math.max(1, Number(parsed.data.interval) || 1) * 60_000;
    coverage_proof = await computeCoverageProof(
      parsed.data.symbol, parsed.data.category, startMs, endMs, intervalMs,
      { interval: parsed.data.interval });
  }

  return res.json({ rows: coverage.rows, coverage_proof });
});

app.get("/api/data/health", async (_req, res) => {
  const staleThresholdMs = 30_000;
  const symbolKeys = await redis.keys("latest:*:ts");
  const now = Date.now();

  const rows: Array<{ symbol: string; ageMs: number; status: "fresh" | "stale" }> = [];
  for (const key of symbolKeys) {
    const raw = await redis.get(key);
    if (!raw) {
      continue;
    }
    const ts = Number(raw);
    const ageMs = now - ts;
    const symbol = key.split(":")[1] ?? "unknown";
    rows.push({ symbol, ageMs, status: ageMs > staleThresholdMs ? "stale" : "fresh" });
  }
  res.json({ generatedAt: now, rows, staleThresholdMs });
});

app.get("/api/templates", async (_req, res) => {
  const files = (await readdir(templatesDir)).filter((name) => name.endsWith(".json")).sort();
  const templates = await Promise.all(
    files.map(async (file) => {
      const raw = await readFile(resolve(templatesDir, file), "utf8");
      return JSON.parse(raw);
    })
  );
  res.json({ templates });
});

app.get("/api/data/regimes", async (_req, res) => {
  const raw = await readFile(regimesPath, "utf8");
  const regimes = JSON.parse(raw);
  res.json({ regimes });
});

// §25 A.1 — guard against cross-tenant takeover via client-supplied ids. Many handlers upsert on a
// client id (strategy_id, account_id, …) with `ON CONFLICT … DO UPDATE SET owner_id=EXCLUDED`,
// which let owner B seize owner A's row by resending A's id. This refuses any upsert that would
// touch a row already owned by someone else. (table/idCol are server-controlled literals — no
// injection surface.)
async function isForeignOwned(table: string, idCol: string, idVal: string, ownerId: number): Promise<boolean> {
  const r = await db.query<{ owner_id: string | number | null }>(
    `SELECT owner_id FROM ${table} WHERE ${idCol} = $1 LIMIT 1`,
    [idVal]
  );
  if (!r.rowCount) return false;
  const existing = r.rows[0].owner_id;
  return existing != null && Number(existing) !== ownerId;
}

app.post("/api/strategies", async (req, res) => {
  const payloadSchema = z.object({
    strategyId: z.string(),
    name: z.string().min(1)
  });
  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const ownerId = requireOwnerId(req);
  if (await isForeignOwned("strategies", "strategy_id", parsed.data.strategyId, ownerId)) {
    return res.status(403).json({ error: "FORBIDDEN_RESOURCE_OWNER", resource: "strategy" });
  }

  await db.query(
    `
      INSERT INTO strategies (strategy_id, owner_id, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (strategy_id)
      DO UPDATE SET owner_id = EXCLUDED.owner_id, name = EXCLUDED.name, updated_at = NOW()
    `,
    [parsed.data.strategyId, ownerId, parsed.data.name]
  );
  return res.status(201).json({ strategyId: parsed.data.strategyId });
});

app.post("/api/strategies/:id/versions", async (req, res) => {
  const payloadSchema = z.object({
    strategyVersionId: z.string(),
    dsl: z.unknown(),
    hash: z.string().optional(),
    schemaVersion: z.string().optional(),
    validationReport: z.unknown().optional(),
  });
  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const ownerId = requireOwnerId(req);
  // Must own the parent strategy AND not be clobbering someone else's version id.
  if (await isForeignOwned("strategies", "strategy_id", req.params.id, ownerId)
      || await isForeignOwned("strategy_versions", "strategy_version_id", parsed.data.strategyVersionId, ownerId)) {
    return res.status(403).json({ error: "FORBIDDEN_RESOURCE_OWNER", resource: "strategy_version" });
  }

  await db.query(
    `
      INSERT INTO strategy_versions (
        strategy_version_id, strategy_id, dsl_json, validation_report_json, hash, schema_version, owner_id
      ) VALUES (
        $1, $2, $3::jsonb, $4::jsonb, $5, $6, $7
      )
      ON CONFLICT (strategy_version_id)
      DO UPDATE SET
        dsl_json = EXCLUDED.dsl_json,
        validation_report_json = EXCLUDED.validation_report_json,
        hash = EXCLUDED.hash,
        schema_version = EXCLUDED.schema_version,
        owner_id = COALESCE(EXCLUDED.owner_id, strategy_versions.owner_id),
        updated_at = NOW()
    `,
    [
      parsed.data.strategyVersionId,
      req.params.id,
      JSON.stringify(parsed.data.dsl),
      JSON.stringify(parsed.data.validationReport ?? null),
      parsed.data.hash ?? null,
      parsed.data.schemaVersion ?? null,
      ownerId
    ]
  );

  await db.query(
    `
      UPDATE strategies
      SET current_version_id = $2, updated_at = NOW()
      WHERE strategy_id = $1
    `,
    [req.params.id, parsed.data.strategyVersionId]
  );

  return res.status(201).json({ strategyVersionId: parsed.data.strategyVersionId });
});

app.post("/api/data/gaps", async (req, res) => {
  const payloadSchema = z.object({
    symbol: z.string(),
    category: z.string().default("linear"),
    interval: z.string(),
    startTs: z.number().int(),
    endTs: z.number().int()
  });

  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const result = await scanCoverage(parsed.data);
  return res.json(result);
});

app.post("/api/backfill/jobs", async (req, res) => {
  const payloadSchema = z.object({
    endpoint: z.enum(["kline", "funding", "oi", "long-short", "instruments"]),
    category: z.string().default("linear"),
    symbol: z.string().optional(),
    interval: z.string().optional(),
    startMs: z.number().int().optional(),
    endMs: z.number().int().optional(),
    dataVersion: z.string().default("v1"),
  });
  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const jobId = await enqueueBackfillJob({
    endpoint: parsed.data.endpoint,
    category: parsed.data.category,
    symbol: parsed.data.symbol,
    interval: parsed.data.interval,
    start_ms: parsed.data.startMs,
    end_ms: parsed.data.endMs,
    data_version: parsed.data.dataVersion,
  });
  return res.status(202).json({ queued: true, jobId });
});

app.get("/api/backfill/queue", async (_req, res) => {
  const stats = await queueStats();
  const recent = await db.query(
    `
      SELECT job_key, queue_name, endpoint, status, attempt_count, checkpoint_json, last_error, updated_at
      FROM backfill_queue_state
      ORDER BY updated_at DESC
      LIMIT 100
    `
  );
  return res.json({ stats, jobs: recent.rows });
});

app.post("/api/backfill/schedules", async (req, res) => {
  const payloadSchema = z.object({
    scheduleId: z.string().optional(),
    endpoint: z.enum(["kline", "funding", "oi", "long-short", "instruments"]),
    symbol: z.string(),
    category: z.string().default("linear"),
    interval: z.string().default("15"),
    cadenceCron: z.string().default("*/30 * * * *"),
    lookbackMs: z.number().int().positive(),
    enabled: z.boolean().default(true),
    dataVersion: z.string().default("v1"),
  });
  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const scheduleId = await upsertSchedule({
    scheduleId: parsed.data.scheduleId,
    endpoint: parsed.data.endpoint,
    symbol: parsed.data.symbol,
    category: parsed.data.category,
    interval: parsed.data.interval,
    cadenceCron: parsed.data.cadenceCron,
    lookbackMs: parsed.data.lookbackMs,
    enabled: parsed.data.enabled,
    dataVersion: parsed.data.dataVersion,
  });
  return res.status(201).json({ scheduleId });
});

app.get("/api/backfill/schedules", async (_req, res) => {
  const rows = await db.query(
    `
      SELECT schedule_id, queue_name, endpoint, symbol, category, interval, cadence_cron, lookback_ms, enabled, updated_at
      FROM backfill_schedules
      ORDER BY updated_at DESC
      LIMIT 500
    `
  );
  return res.json({ rows: rows.rows });
});

app.post("/api/backfill/schedules/run-due", async (_req, res) => {
  const enqueued = await enqueueDueSchedules(Date.now());
  return res.json({ enqueued });
});

app.post("/api/backtests", async (req, res) => {
  const payloadSchema = z.object({
    strategyVersionId: z.string().default("phase3-local"),
    symbol: z.string(),
    category: z.string().default("linear"),
    interval: z.string(),
    startTs: z.number().int(),
    endTs: z.number().int(),
    intervalMinutes: z.number().int().positive().default(15),
    dataVersion: z.string().default("v1"),
    engineVersion: z.string().default("quant-core-phase3-v1"),
    seed: z.number().int().default(42),
    bars: z
      .array(
        z.object({
          ts: z.number().int(),
          open: z.string(),
          high: z.string(),
          low: z.string(),
          close: z.string()
        })
      )
      .default([]),
    fundingRows: z
      .array(
        z.object({
          id: z.string(),
          timestamp: z.number().int(),
          funding_rate: z.string()
        })
      )
      .default([]),
    signalBarIndex: z.number().int().default(0),
    side: z.enum(["long", "short"]).default("long"),
    qty: z.string().default("1"),
    slippageBpsOneWay: z.string().default("0"),
    canonicalRequired: z.boolean().default(false),
  });

  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const hasProvidedBars = parsed.data.bars.length > 0;
  const gap = hasProvidedBars
    ? {
        expectedBars: parsed.data.bars.length,
        actualBars: parsed.data.bars.length,
        duplicateBars: 0,
        missingBars: 0,
        missingRanges: [],
      }
    : await scanCoverage(parsed.data);
  const coverageBlocked = gap.missingBars > 0 || gap.duplicateBars > 0;
  if (coverageBlocked && (parsed.data.canonicalRequired || !hasProvidedBars)) {
    return res.status(409).json({
      blocked: true,
      reason: "DATA_COVERAGE_INCOMPLETE",
      gap
    });
  }

  try {
    const response = await fetchWorker("/backtests/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-owner-id": String(requireOwnerId(req)) },
      body: JSON.stringify({
        strategyVersionId: parsed.data.strategyVersionId,
        symbol: parsed.data.symbol,
        category: parsed.data.category,
        intervalMinutes: parsed.data.intervalMinutes,
        dataVersion: parsed.data.dataVersion,
        engineVersion: parsed.data.engineVersion,
        seed: parsed.data.seed,
        bars: parsed.data.bars,
        fundingRows: parsed.data.fundingRows,
        signalBarIndex: parsed.data.signalBarIndex,
        side: parsed.data.side,
        qty: parsed.data.qty,
        slippageBpsOneWay: parsed.data.slippageBpsOneWay,
        coverageProof: {
          symbol: parsed.data.symbol,
          category: parsed.data.category,
          interval: parsed.data.interval,
          startTs: parsed.data.startTs,
          endTs: parsed.data.endTs,
          expectedBars: gap.expectedBars,
          actualBars: gap.actualBars,
          missingBars: gap.missingBars,
          duplicateBars: gap.duplicateBars,
          canonical_required: parsed.data.canonicalRequired,
          canonical_complete: !coverageBlocked,
          source: hasProvidedBars ? "adhoc_user_bars" : "canonical_candles_db",
        }
      })
    });

    const body = await response.json();
    if (response.ok) {
      runTierCounter.labels("historical_backtest", String(body?.resultTier ?? "LOCAL ONLY")).inc();
    }
    return res.status(response.status).json(body);
  } catch (error) {
    return res.status(502).json({ error: "BACKTEST_WORKER_UNAVAILABLE", message: (error as Error).message });
  }
});

app.get("/api/backtests/:runId", async (req, res) => {
  try {
    const ownerId = requireOwnerId(req);
    const run = await db.query(
      `
        SELECT br.run_id, br.strategy_version_id, br.data_version, br.engine_version, br.seed,
               br.status, br.result_tier, br.config_json, br.metrics_json, br.coverage_proof_json,
               br.created_at, br.updated_at
        FROM backtest_runs br
        JOIN strategy_versions sv ON sv.strategy_version_id = br.strategy_version_id
        WHERE br.run_id = $1
          AND (sv.owner_id IS NULL OR sv.owner_id = $2)
        LIMIT 1
      `,
      [req.params.runId, ownerId]
    );

    if (!run.rowCount) {
      return res.status(404).json({ error: "RUN_NOT_FOUND" });
    }

    const events = await db.query(
      `
        SELECT event_ts, event_type, payload_json
        FROM backtest_events
        WHERE run_id = $1
        ORDER BY event_ts ASC, id ASC
        LIMIT 2000
      `,
      [req.params.runId]
    );

    return res.json({ run: run.rows[0], events: events.rows });
  } catch (error) {
    return res.status(500).json({ error: "RUN_FETCH_FAILED", message: (error as Error).message });
  }
});

app.get("/api/replay/:runId/timeline", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const run = await db.query(
    `
      SELECT br.run_id
      FROM backtest_runs br
      JOIN strategy_versions sv ON sv.strategy_version_id = br.strategy_version_id
      WHERE br.run_id = $1
        AND (sv.owner_id IS NULL OR sv.owner_id = $2)
      LIMIT 1
    `,
    [req.params.runId, ownerId]
  );
  if (!run.rowCount) {
    return res.status(404).json({ error: "RUN_NOT_FOUND" });
  }
  const events = await db.query(
    `
      SELECT id, event_ts, event_type, payload_json
      FROM backtest_events
      WHERE run_id = $1
      ORDER BY event_ts ASC, id ASC
      LIMIT 10000
    `,
    [req.params.runId]
  );
  return res.json({
    runId: req.params.runId,
    totalSteps: events.rowCount ?? 0,
    steps: events.rows.map((row, index) => ({
      step: index + 1,
      eventId: row.id,
      ts: row.event_ts,
      type: row.event_type,
      payload: row.payload_json,
    })),
  });
});

app.post("/api/paper/accounts", async (req, res) => {
  const payloadSchema = z.object({
    accountId: z.string(),
    startingBalance: z.string().default("10000"),
    quoteCurrency: z.string().default("USDT")
  });
  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const ownerId = requireOwnerId(req);
    if (await isForeignOwned("paper_accounts", "account_id", parsed.data.accountId, ownerId)) {
      return res.status(403).json({ error: "FORBIDDEN_RESOURCE_OWNER", resource: "paper_account" });
    }
    // The users row is guaranteed to exist here: the auth middleware does a read-only existence
    // check and 401s (USER_NOT_FOUND) before any handler runs. No defensive upsert needed.

    await db.query(
      `
        INSERT INTO paper_accounts (account_id, owner_id, starting_balance, quote_currency, mode)
        VALUES ($1, $2, $3, $4, 'paper')
        ON CONFLICT (account_id)
        DO UPDATE SET owner_id = EXCLUDED.owner_id, starting_balance = EXCLUDED.starting_balance, quote_currency = EXCLUDED.quote_currency
      `,
      [parsed.data.accountId, ownerId, parsed.data.startingBalance, parsed.data.quoteCurrency]
    );
    return res.status(201).json({ accountId: parsed.data.accountId });
  } catch (error) {
    return res.status(500).json({ error: "PAPER_ACCOUNT_CREATE_FAILED", message: (error as Error).message });
  }
});

app.post("/api/paper/sessions", async (req, res) => {
  const payloadSchema = z.object({
    sessionId: z.string(),
    accountId: z.string(),
    strategyVersionId: z.string(),
    symbol: z.string().default("BTCUSDT"),
    maxDataAgeMs: z.number().int().positive().default(30000),
    requiredFreshTicks: z.number().int().positive().default(3)
  });
  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const ownerId = requireOwnerId(req);

  try {
    const ownedAccount = await db.query(
      `SELECT account_id FROM paper_accounts WHERE account_id = $1 AND owner_id = $2 LIMIT 1`,
      [parsed.data.accountId, ownerId]
    );
    if (!ownedAccount.rowCount) {
      return res.status(403).json({ error: "FORBIDDEN_ACCOUNT_OWNER" });
    }
    await db.query(
      `
        INSERT INTO strategies (strategy_id, owner_id, name)
        VALUES ($1, 1, $1)
        ON CONFLICT (strategy_id) DO NOTHING
      `,
      [parsed.data.strategyVersionId]
    );
    await db.query(
      `
        INSERT INTO strategy_versions (strategy_version_id, strategy_id, dsl_json)
        VALUES ($1, $2, '{}'::jsonb)
        ON CONFLICT (strategy_version_id) DO NOTHING
      `,
      [parsed.data.strategyVersionId, parsed.data.strategyVersionId]
    );

    await db.query(
      `
        INSERT INTO paper_sessions (
          id, account_id, strategy_version_id, symbol, status,
          max_data_age_ms, required_fresh_ticks, reconnecting
        ) VALUES ($1, $2, $3, $4, 'active', $5, $6, false)
        ON CONFLICT (id)
        DO UPDATE SET
          account_id = EXCLUDED.account_id,
          strategy_version_id = EXCLUDED.strategy_version_id,
          symbol = EXCLUDED.symbol,
          status = 'active',
          max_data_age_ms = EXCLUDED.max_data_age_ms,
          required_fresh_ticks = EXCLUDED.required_fresh_ticks,
          reconnecting = false
      `,
      [
        parsed.data.sessionId,
        parsed.data.accountId,
        parsed.data.strategyVersionId,
        parsed.data.symbol,
        parsed.data.maxDataAgeMs,
        parsed.data.requiredFreshTicks
      ]
    );
    return res.status(201).json({ sessionId: parsed.data.sessionId });
  } catch (error) {
    return res.status(500).json({ error: "PAPER_SESSION_CREATE_FAILED", message: (error as Error).message });
  }
});

app.post("/api/paper/sessions/:id/tick", async (req, res) => {
  const payloadSchema = z.object({
    symbol: z.string(),
    price: z.string(),
    tsMs: z.number().int(),
    nowMs: z.number().int().optional()
  });
  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const ownerId = requireOwnerId(req);
  const sessionOwnership = await db.query(
    `
      SELECT ps.id
      FROM paper_sessions ps
      JOIN paper_accounts pa ON pa.account_id = ps.account_id
      WHERE ps.id = $1 AND pa.owner_id = $2
      LIMIT 1
    `,
    [req.params.id, ownerId]
  );
  if (!sessionOwnership.rowCount) {
    return res.status(403).json({ error: "FORBIDDEN_SESSION_OWNER" });
  }

  try {
    const response = await fetchWorker("/paper/process-tick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: req.params.id, ...parsed.data })
    });
    const body = await readWorkerJson(response);
    return res.status(response.status).json(body);
  } catch (error) {
    return res.status(502).json({ error: "PAPER_WORKER_UNAVAILABLE", message: (error as Error).message });
  }
});

app.post("/api/paper/sessions/:id/rebuild", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const sessionOwnership = await db.query(
    `
      SELECT ps.id
      FROM paper_sessions ps
      JOIN paper_accounts pa ON pa.account_id = ps.account_id
      WHERE ps.id = $1 AND pa.owner_id = $2
      LIMIT 1
    `,
    [req.params.id, ownerId]
  );
  if (!sessionOwnership.rowCount) {
    return res.status(403).json({ error: "FORBIDDEN_SESSION_OWNER" });
  }
  try {
    const response = await fetchWorker("/paper/rebuild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: req.params.id })
    });
    const body = await readWorkerJson(response);
    return res.status(response.status).json(body);
  } catch (error) {
    return res.status(502).json({ error: "PAPER_REBUILD_UNAVAILABLE", message: (error as Error).message });
  }
});

app.post("/api/paper/sessions/:id/stop", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const sessionOwnership = await db.query(
    `
      SELECT ps.id
      FROM paper_sessions ps
      JOIN paper_accounts pa ON pa.account_id = ps.account_id
      WHERE ps.id = $1 AND pa.owner_id = $2
      LIMIT 1
    `,
    [req.params.id, ownerId]
  );
  if (!sessionOwnership.rowCount) {
    return res.status(403).json({ error: "FORBIDDEN_SESSION_OWNER" });
  }
  await db.query(
    `
      UPDATE paper_sessions
      SET status = 'stopped', stopped_at = NOW()
      WHERE id = $1
    `,
    [req.params.id]
  );
  return res.json({ sessionId: req.params.id, status: "stopped" });
});

app.get("/api/paper/sessions/:id", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const session = await db.query(
    `
      SELECT ps.id, ps.account_id, ps.strategy_version_id, ps.symbol, ps.status,
             ps.started_at, ps.stopped_at, ps.last_seen_ts, ps.reconnecting
      FROM paper_sessions ps
      JOIN paper_accounts pa ON pa.account_id = ps.account_id
      WHERE ps.id = $1 AND pa.owner_id = $2
    `,
    [req.params.id, ownerId]
  );
  if (!session.rowCount) {
    return res.status(404).json({ error: "SESSION_NOT_FOUND" });
  }
  const positions = await db.query(
    `
      SELECT symbol, qty, avg_entry, realized_pnl, unrealized_pnl, funding_pnl, updated_at
      FROM paper_positions
      WHERE session_id = $1
    `,
    [req.params.id]
  );
  const events = await db.query(
    `
      SELECT event_type, payload_json, created_at
      FROM paper_events
      WHERE session_id = $1
      ORDER BY event_id DESC
      LIMIT 200
    `,
    [req.params.id]
  );
  return res.json({ session: session.rows[0], positions: positions.rows, events: events.rows });
});

// ---------- v4.1 Bot OS proxies + persistence ----------

async function proxyToWorker(path: string, body: unknown, res: express.Response) {
  try {
    const r = await fetchWorker(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await readWorkerJson(r);
    res.status(r.status).json(out);
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
}

// ---------- Multi-regime historical library (Tier 4 #14) ----------
const REGIME_CATALOG = [
  { regime_id: "btc_2021_bull", label: "BTC 2021 — Full-year bull cycle", symbol: "BTCUSDT", category: "linear", interval: "D", start_ms: 1609459200000, end_ms: 1640995200000, expected_regime: "bull" },
  { regime_id: "btc_2022_bear", label: "BTC 2022 — Crypto winter (LUNA + FTX)", symbol: "BTCUSDT", category: "linear", interval: "D", start_ms: 1640995200000, end_ms: 1672531200000, expected_regime: "bear" },
  { regime_id: "btc_2023_recovery", label: "BTC 2023 — Sideways recovery", symbol: "BTCUSDT", category: "linear", interval: "D", start_ms: 1672531200000, end_ms: 1704067200000, expected_regime: "mixed" },
  { regime_id: "btc_2024_halving", label: "BTC 2024 — Halving + ETF era", symbol: "BTCUSDT", category: "linear", interval: "D", start_ms: 1704067200000, end_ms: 1735689600000, expected_regime: "bull" },
  { regime_id: "btc_2025_recent", label: "BTC 2025 YTD — Mixed", symbol: "BTCUSDT", category: "linear", interval: "D", start_ms: 1735689600000, end_ms: 1767225600000, expected_regime: "mixed" },
  { regime_id: "eth_2021_bull", label: "ETH 2021 — DeFi/NFT bull", symbol: "ETHUSDT", category: "linear", interval: "D", start_ms: 1609459200000, end_ms: 1640995200000, expected_regime: "bull" },
  { regime_id: "eth_2022_bear", label: "ETH 2022 — Bear + Merge", symbol: "ETHUSDT", category: "linear", interval: "D", start_ms: 1640995200000, end_ms: 1672531200000, expected_regime: "bear" },
  { regime_id: "btc_2024_oct_chop_1h", label: "BTC Oct 2024 — One-month chop (1h)", symbol: "BTCUSDT", category: "linear", interval: "60", start_ms: 1727740800000, end_ms: 1730419200000, expected_regime: "chop" },
  { regime_id: "btc_2022_may_luna_crash_1h", label: "BTC May 2022 — LUNA crash (1h)", symbol: "BTCUSDT", category: "linear", interval: "60", start_ms: 1651363200000, end_ms: 1654041600000, expected_regime: "crash" },
  // xStocks (tokenized US equities on Bybit Spot). History begins mid-2025.
  { regime_id: "nvdax_2025_recent", label: "NVDAx 2025+ — Tokenized NVIDIA (spot)", symbol: "NVDAXUSDT", category: "spot", interval: "D", start_ms: 1751328000000, end_ms: 1769904000000, expected_regime: "mixed", asset_class: "equity" },
  { regime_id: "aaplx_2025_recent", label: "AAPLx 2025+ — Tokenized Apple (spot)", symbol: "AAPLXUSDT", category: "spot", interval: "D", start_ms: 1751328000000, end_ms: 1769904000000, expected_regime: "mixed", asset_class: "equity" },
  { regime_id: "tslax_2025_recent", label: "TSLAx 2025+ — Tokenized Tesla (spot)", symbol: "TSLAXUSDT", category: "spot", interval: "D", start_ms: 1751328000000, end_ms: 1769904000000, expected_regime: "mixed", asset_class: "equity" },
  { regime_id: "googlx_2025_recent", label: "GOOGLx 2025+ — Tokenized Alphabet (spot)", symbol: "GOOGLXUSDT", category: "spot", interval: "D", start_ms: 1751328000000, end_ms: 1769904000000, expected_regime: "mixed", asset_class: "equity" },
];

app.get("/api/regimes", (_req, res) => {
  res.json({ regimes: REGIME_CATALOG });
});

// ---- Realtime live feed (demand-driven 1-min REST poller in the data-ingestor) ----
const INGESTOR_URL = process.env.INGESTOR_URL ?? "http://data-ingestor:7100";
async function ingestor(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${INGESTOR_URL}${path}`, init);
}
app.use(createDexRouter(ingestor, (path, init) => fetchWorker(path, init ?? {})));
app.post("/api/live/subscribe", async (req, res) => {
  try {
    const r = await ingestor("/collect/live/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "INGESTOR_UNREACHABLE", detail: (err as Error).message });
  }
});
app.get("/api/live/prices", async (_req, res) => {
  try {
    const r = await ingestor("/collect/live/prices");
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "INGESTOR_UNREACHABLE", detail: (err as Error).message });
  }
});
app.post("/api/live/poll", async (_req, res) => {
  try {
    const r = await ingestor("/collect/live/poll", { method: "POST" });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "INGESTOR_UNREACHABLE", detail: (err as Error).message });
  }
});
// ---- Persistent server-side live paper sessions ----
app.post("/api/live-paper/start", async (req, res) => {
  try {
    const ownerId = requireOwnerId(req);
    const b = req.body || {};
    const symbol = String(b.symbol || "BTCUSDT").toUpperCase();
    const category = String(b.category || (symbol.endsWith("XUSDT") ? "spot" : "linear"));
    const sessionId = String(b.sessionId || `lp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`);
    // 1) warmup backfill (last ~3h of 1m) so the strategy has context
    const now = Date.now();
    try {
      await ingestor("/collect/backfill/kline", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, symbol, interval: "1", start_ms: now - 3 * 3600 * 1000, end_ms: now, data_version: "live-paper-warmup" }),
      });
    } catch { /* non-fatal */ }
    // 2) subscribe to the live poller so 1m bars stay fresh
    try {
      await ingestor("/collect/live/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ symbol, category, interval: "1" }] }),
      });
    } catch { /* non-fatal */ }
    // 2b) Phase 2/9: for L2 fidelities, auto-enable demand-driven recording for this symbol
    // (forward-only). l2_queue additionally records public trades (Phase 3).
    const executionFidelity = String(b.executionFidelity || b.execution_fidelity || "bar_based");
    if (executionFidelity === "l2_sweep" || executionFidelity === "l2_queue") {
      try {
        await ingestor("/collect/realtime/record-l2", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: [{ symbol, category }], enable: true, manual: false }),
        });
      } catch { /* non-fatal */ }
    }
    if (executionFidelity === "l2_queue") {
      try {
        await ingestor("/collect/realtime/record-trades", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: [{ symbol, category }], enable: true, manual: false }),
        });
      } catch { /* non-fatal */ }
    }
    // 3) start the persistent worker session
    const r = await fetchWorker("/live-paper/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId, owner_id: String(ownerId), strategy_id: b.strategyId || b.strategy_id,
        symbol, category, params: b.params || {}, starting_equity: String(b.startingEquity || b.starting_equity || "10000"),
        interval_minutes: 1, risk: b.risk || { max_position_fraction: "1.0", max_daily_loss_fraction: "0.9", max_drawdown_kill_fraction: "0.9" },
        execution_fidelity: executionFidelity,
        allow_fallback: b.allowFallback ?? b.allow_fallback ?? true,
      }),
    }, ownerId);
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "LIVE_PAPER_START_FAILED", detail: (err as Error).message });
  }
});

app.post("/api/live-paper/stop/:id", async (req, res) => {
  try {
    const ownerId = requireOwnerId(req);
    // §25 cross-tenant guard: only the owner may stop their session. Without this, owner B could
    // stop owner A's running session (the worker's stop_session does not check ownership). 404 (not
    // 403) so a non-owner can't probe session existence.
    const own = await db.query<{ owner_id: string | number | null }>(
      `SELECT owner_id FROM live_paper_sessions WHERE session_id = $1`,
      [req.params.id]
    );
    if (!own.rowCount || Number(own.rows[0].owner_id) !== ownerId) {
      return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    }
    const r = await fetchWorker(`/live-paper/stop/${encodeURIComponent(req.params.id)}`, { method: "POST" }, ownerId);
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

app.get("/api/live-paper/sessions", async (req, res) => {
  try {
    const ownerId = requireOwnerId(req);
    const r = await fetchWorker(`/live-paper/sessions?owner_id=${encodeURIComponent(String(ownerId))}`);
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

// ---- Multi-asset (portfolio) paper sessions ----
app.post("/api/live-portfolio/start", async (req, res) => {
  try {
    const ownerId = requireOwnerId(req);
    const b = req.body || {};
    const legs: Array<Record<string, any>> = Array.isArray(b.legs) ? b.legs : [];
    if (!legs.length) return res.status(400).json({ error: "LEGS_REQUIRED" });
    const intervalMinutes = Number(b.intervalMinutes ?? b.interval_minutes ?? 60);
    const interval = intervalMinutes === 1 ? "1" : intervalMinutes === 1440 ? "D" : String(intervalMinutes);
    const sessionId = String(b.sessionId || `mp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`);
    const now = Date.now();
    // Warm up + keep fresh each leg (best-effort): backfill a generous window + subscribe the poller.
    for (const leg of legs) {
      const symbol = String(leg.symbol || "").toUpperCase();
      const category = String(leg.category || "linear");
      if (!symbol) continue;
      try {
        await ingestor("/collect/backfill/kline", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category, symbol, interval, start_ms: now - 120 * 24 * 3600 * 1000, end_ms: now, data_version: "multiasset-warmup" }),
        });
      } catch { /* non-fatal */ }
      try {
        await ingestor("/collect/live/subscribe", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: [{ symbol, category, interval }] }),
        });
      } catch { /* non-fatal */ }
    }
    const r = await fetchWorker("/live-portfolio/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId, owner_id: String(ownerId), legs,
        weighting: b.weighting || "fixed", total_equity: String(b.totalEquity || b.total_equity || "10000"),
        interval_minutes: intervalMinutes, risk: b.risk || {},
        rebalance_threshold: String(b.rebalanceThreshold || b.rebalance_threshold || "0.05"),
        lookback_bars: Number(b.lookbackBars ?? b.lookback_bars ?? 20), top_n: Number(b.topN ?? b.top_n ?? 3),
      }),
    }, ownerId);
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "LIVE_PORTFOLIO_START_FAILED", detail: (err as Error).message });
  }
});

app.post("/api/live-portfolio/stop/:id", async (req, res) => {
  try {
    const ownerId = requireOwnerId(req);
    const own = await db.query<{ owner_id: string | number | null }>(
      `SELECT owner_id FROM live_portfolio_sessions WHERE session_id = $1`, [req.params.id]);
    if (!own.rowCount || Number(own.rows[0].owner_id) !== ownerId) {
      return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    }
    const r = await fetchWorker(`/live-portfolio/stop/${encodeURIComponent(req.params.id)}`, { method: "POST" }, ownerId);
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

app.get("/api/live-portfolio/sessions", async (req, res) => {
  try {
    const ownerId = requireOwnerId(req);
    const r = await fetchWorker(`/live-portfolio/sessions?owner_id=${encodeURIComponent(String(ownerId))}`);
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

function realtimePerSymbol(status: Record<string, any>): Array<{ symbol: string; category: string; recording: { ticker: boolean; kline: boolean; l2: boolean; trades: boolean } }> {
  const out: Array<{ symbol: string; category: string; recording: { ticker: boolean; kline: boolean; l2: boolean; trades: boolean } }> = [];
  const categories = new Set<string>([
    ...Object.keys(status?.desired ?? {}),
    ...Object.keys(status?.l2_desired ?? {}),
    ...Object.keys(status?.trade_desired ?? {}),
  ]);
  for (const category of categories) {
    const desired = new Set<string>((status?.desired?.[category] ?? []).map((s: unknown) => String(s).toUpperCase()));
    const l2 = new Set<string>((status?.l2_desired?.[category] ?? []).map((s: unknown) => String(s).toUpperCase()));
    const trades = new Set<string>((status?.trade_desired?.[category] ?? []).map((s: unknown) => String(s).toUpperCase()));
    const symbols = new Set<string>([...desired, ...l2, ...trades]);
    for (const symbol of [...symbols].sort()) {
      out.push({
        symbol,
        category,
        recording: {
          ticker: desired.has(symbol),
          kline: desired.has(symbol),
          l2: l2.has(symbol),
          trades: trades.has(symbol),
        },
      });
    }
  }
  return out;
}

app.get("/api/realtime/status", async (_req, res) => {
  try {
    const r = await ingestor("/collect/realtime/status");
    const body = await r.json() as Record<string, any>;
    res.status(r.status).json({ ...body, per_symbol: realtimePerSymbol(body) });
  } catch (err) {
    res.status(502).json({ error: "INGESTOR_UNREACHABLE", detail: (err as Error).message });
  }
});

// Opt-in, demand-driven L2 (orderbook) recording for verified-execution-tier bots.
app.post("/api/live/record-l2", async (req, res) => {
  try {
    const r = await ingestor("/collect/realtime/record-l2", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "INGESTOR_UNREACHABLE", detail: (err as Error).message });
  }
});

// Opt-in, demand-driven Bybit publicTrade recording for full queue-aware replay.
app.post("/api/live/record-trades", async (req, res) => {
  try {
    const r = await ingestor("/collect/realtime/record-trades", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "INGESTOR_UNREACHABLE", detail: (err as Error).message });
  }
});

async function executionCoverageHandler(req: express.Request, res: express.Response) {
  try {
    const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();
    const category = String(req.query.category || (symbol.endsWith("XUSDT") ? "spot" : "linear"));
    const startMs = Number(req.query.startMs || Date.now() - 60 * 60 * 1000);
    const endMs = Number(req.query.endMs || Date.now());
    const [l2, trades, candles, status] = await Promise.all([
      db.query(
        `SELECT count(*)::int AS n FROM l2_snapshots
         WHERE symbol=$1 AND category=$2 AND ts BETWEEN to_timestamp($3/1000.0) AND to_timestamp($4/1000.0)`,
        [symbol, category, startMs, endMs]
      ),
      db.query(
        `SELECT count(*)::int AS n FROM trades
         WHERE symbol=$1 AND category=$2 AND trade_time_ms >= $3 AND trade_time_ms < $4`,
        [symbol, category, startMs, endMs]
      ).catch(() => ({ rows: [{ n: 0 }] })),
      db.query(
        `SELECT count(*)::int AS n FROM candles
         WHERE symbol=$1 AND category=$2 AND interval='1'
           AND open_time BETWEEN to_timestamp($3/1000.0) AND to_timestamp($4/1000.0)`,
        [symbol, category, startMs, endMs]
      ),
      ingestor("/collect/realtime/status").then((r) => r.json()).catch(() => ({})),
    ]);
    const st = status as Record<string, any>;
    const l2Desired = Boolean(st?.l2_desired?.[category]?.includes(symbol));
    const tradeDesired = Boolean(st?.trade_desired?.[category]?.includes(symbol));
    const l2Rows = Number(l2.rows[0]?.n || 0);
    const tradeRows = Number(trades.rows[0]?.n || 0);
    const candleRows = Number(candles.rows[0]?.n || 0);
    const available = ["bar_based"];
    if (l2Rows > 0) available.push("l2_sweep_only");
    if (l2Rows > 0 && tradeRows > 0) available.push("l2_queue_full");
    const warnings: string[] = [];
    if (l2Desired && l2Rows === 0) warnings.push("L2_RECORDING_ENABLED_BUT_NO_ROWS_YET");
    if (tradeDesired && tradeRows === 0) warnings.push("TRADE_RECORDING_ENABLED_BUT_NO_ROWS_YET");
    return res.json({
      symbol,
      category,
      range: { startMs, endMs },
      recording: {
        ticker: Boolean(st?.desired?.[category]?.includes(symbol)),
        kline: Boolean(st?.desired?.[category]?.includes(symbol)),
        l2: l2Desired,
        trades: tradeDesired,
      },
      rows: { candles: candleRows, l2_snapshots: l2Rows, trades: tradeRows },
      execution_fidelity_available: available,
      warnings,
    });
  } catch (err) {
    res.status(500).json({ error: "EXECUTION_COVERAGE_FAILED", detail: (err as Error).message });
  }
}

app.get("/api/live/execution-coverage", executionCoverageHandler);
app.get("/api/execution/coverage", executionCoverageHandler);

// NOTE: /api/data/coverage is defined ONCE, above (the legacy data_coverage view augmented
// with the Phase-7 coverage_proof). A second registration here previously shadowed nothing
// because Express serves the first match — it was dead code and has been removed.

// Phase 3: recorded public-trade reads.
app.get("/api/trades", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();
    const category = String(req.query.category || (symbol.endsWith("XUSDT") ? "spot" : "linear"));
    const startMs = Number(req.query.startTs ?? req.query.startMs ?? Date.now() - 60 * 60 * 1000);
    const endMs = Number(req.query.endTs ?? req.query.endMs ?? Date.now());
    const limit = Math.min(Number(req.query.limit ?? 1000), 10000);
    const r = await db.query(
      `SELECT trade_time_ms, symbol, category, trade_id, side, price::text AS price, qty::text AS qty, data_version
         FROM trades
        WHERE symbol=$1 AND category=$2 AND trade_time_ms >= $3 AND trade_time_ms < $4
        ORDER BY trade_time_ms ASC LIMIT $5`,
      [symbol, category, startMs, endMs, limit]
    );
    res.json({ symbol, category, count: r.rowCount, trades: r.rows });
  } catch (err) {
    res.status(500).json({ error: "TRADES_QUERY_FAILED", detail: (err as Error).message });
  }
});

app.get("/api/trades/coverage", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();
    const category = String(req.query.category || (symbol.endsWith("XUSDT") ? "spot" : "linear"));
    const startMs = Number(req.query.startTs ?? req.query.startMs ?? Date.now() - 60 * 60 * 1000);
    const endMs = Number(req.query.endTs ?? req.query.endMs ?? Date.now());
    const bucketMs = Math.max(60_000, Number(req.query.bucketMs ?? 60_000));
    // Bucket the window; a bucket is "covered" if it holds >=1 trade. Report gaps as
    // merged [start,end) ranges of empty buckets.
    const r = await db.query(
      `SELECT DISTINCT floor((trade_time_ms - $3) / $5)::bigint AS bucket
         FROM trades
        WHERE symbol=$1 AND category=$2 AND trade_time_ms >= $3 AND trade_time_ms < $4`,
      [symbol, category, startMs, endMs, bucketMs]
    );
    const total = Math.max(1, Math.ceil((endMs - startMs) / bucketMs));
    const present = new Set<number>(r.rows.map((x: { bucket: string }) => Number(x.bucket)));
    const missing: Array<{ startMs: number; endMs: number }> = [];
    let runStart = -1;
    for (let b = 0; b < total; b += 1) {
      if (!present.has(b)) {
        if (runStart < 0) runStart = b;
      } else if (runStart >= 0) {
        missing.push({ startMs: startMs + runStart * bucketMs, endMs: startMs + b * bucketMs });
        runStart = -1;
      }
    }
    if (runStart >= 0) missing.push({ startMs: startMs + runStart * bucketMs, endMs });
    res.json({
      symbol, category, range: { startMs, endMs }, bucketMs,
      total_buckets: total, covered_buckets: present.size,
      coverage_pct: Number((present.size / total).toFixed(6)),
      missing_ranges: missing,
    });
  } catch (err) {
    res.status(500).json({ error: "TRADES_COVERAGE_FAILED", detail: (err as Error).message });
  }
});

// ---- Server-Sent Events: realtime prices, bar closes, and live-paper session updates ----
app.get("/api/stream", async (req, res) => {
  const ownerId = requireOwnerId(req);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, ownerId, ts: Date.now() })}\n\n`);

  const topics = String(req.query.topics ?? "prices,bars,sessions").split(",").map((s) => s.trim());
  const symbolFilter = req.query.symbols ? new Set(String(req.query.symbols).toUpperCase().split(",")) : null;
  const patterns: string[] = [];
  if (topics.includes("prices")) patterns.push("rt:price:*");
  if (topics.includes("bars")) patterns.push("rt:barclose:*");
  if (topics.includes("sessions")) patterns.push(`rt:session:${ownerId}`);
  if (topics.includes("dex_prices")) patterns.push("rt:dex:price:*");
  if (topics.includes("dex_bars")) patterns.push("rt:dex:candle:*");
  if (topics.includes("dex_swaps")) patterns.push("rt:dex:swap:*");
  if (topics.includes("dex_pools")) patterns.push("rt:dex:pool:*");
  if (topics.includes("testnet_intents")) patterns.push(`rt:testnet:intent:${ownerId}:*`);

  const sub = redis.duplicate();
  let alive = true;
  const onMsg = (_pattern: string, channel: string, message: string) => {
    if (!alive) return;
    let ev = "message";
    if (channel.startsWith("rt:price:")) ev = "price";
    else if (channel.startsWith("rt:barclose:")) ev = "barclose";
    else if (channel.startsWith("rt:session:")) ev = "session";
    else if (channel.startsWith("rt:dex:price:")) ev = "dex_price";
    else if (channel.startsWith("rt:dex:candle:")) ev = "dex_bar";
    else if (channel.startsWith("rt:dex:swap:")) ev = "dex_swap";
    else if (channel.startsWith("rt:dex:pool:")) ev = "dex_pool";
    else if (channel.startsWith("rt:testnet:intent:")) ev = "testnet_intent";
    if (symbolFilter && (ev === "price" || ev === "barclose")) {
      const sym = channel.split(":").pop() ?? "";
      if (!symbolFilter.has(sym.toUpperCase())) return;
    }
    res.write(`event: ${ev}\ndata: ${message}\n\n`);
  };
  sub.on("pmessage", onMsg);
  try {
    if (patterns.length) await sub.psubscribe(...patterns);
  } catch { /* ignore */ }

  const hb = setInterval(() => { if (alive) res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`); }, 15000);
  const cleanup = () => {
    if (!alive) return;
    alive = false;
    clearInterval(hb);
    sub.removeListener("pmessage", onMsg);
    sub.disconnect();
    try { res.end(); } catch { /* ignore */ }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
});

app.get("/api/xstocks/instruments", async (_req, res) => {
  try {
    const r = await ingestor("/collect/xstocks/instruments");
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "INGESTOR_UNREACHABLE", detail: (err as Error).message });
  }
});

// Generic real-candle fetch from the DB for any ingested symbol (used by the
// Multi-Asset Portfolio screen to run on real Bybit data).
app.get("/api/candles", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    const category = String(req.query.category || "linear");
    const interval = String(req.query.interval || "D");
    const limit = Math.min(Number(req.query.limit || 400), 2000);
    if (!symbol) return res.status(400).json({ error: "SYMBOL_REQUIRED" });
    const r = await db.query(
      `SELECT EXTRACT(EPOCH FROM open_time)*1000 AS ts, open, high, low, close, volume
       FROM candles WHERE symbol=$1 AND category=$2 AND interval=$3
       ORDER BY open_time DESC LIMIT $4`,
      [symbol, category, interval, limit]
    );
    const bars = r.rows.map((row) => ({
      ts: Number(row.ts), open: String(row.open), high: String(row.high),
      low: String(row.low), close: String(row.close), volume: String(row.volume ?? "0"),
    })).reverse();
    res.json({ symbol, category, interval, count: bars.length, bars });
  } catch (error) {
    res.status(500).json({ error: "CANDLES_FETCH_FAILED", message: (error as Error).message });
  }
});

app.get("/api/regimes/:regimeId/bars", async (req, res) => {
  const regime = REGIME_CATALOG.find((r) => r.regime_id === req.params.regimeId);
  if (!regime) return res.status(404).json({ error: "REGIME_NOT_FOUND" });
  const startTs = new Date(regime.start_ms).toISOString();
  const endTs = new Date(regime.end_ms).toISOString();
  const intervalMin = regime.interval === "D" ? 1440 : Number(regime.interval);
  const r = await db.query(
    `SELECT EXTRACT(EPOCH FROM open_time)*1000 AS ts, open, high, low, close, volume
     FROM candles
     WHERE symbol=$1 AND category=$2 AND interval=$3 AND open_time >= $4 AND open_time < $5
     ORDER BY open_time`,
    [regime.symbol, regime.category, regime.interval, startTs, endTs]
  );
  const bars = r.rows.map((row) => ({
    ts: Number(row.ts), open: String(row.open), high: String(row.high),
    low: String(row.low), close: String(row.close), volume: String(row.volume ?? "0"),
  }));
  res.json({ regime, intervalMinutes: intervalMin, bars, count: bars.length });
});

app.post("/api/regimes/:regimeId/load", async (req, res) => {
  // Trigger the data-ingestor to backfill this regime's slice.
  const regime = REGIME_CATALOG.find((r) => r.regime_id === req.params.regimeId);
  if (!regime) return res.status(404).json({ error: "REGIME_NOT_FOUND" });
  try {
    const ingestor = process.env.INGESTOR_URL ?? "http://data-ingestor:7100";
    const r = await fetch(`${ingestor}/collect/backfill/kline`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: regime.category, symbol: regime.symbol, interval: regime.interval,
        start_ms: regime.start_ms, end_ms: regime.end_ms, data_version: "regime-library-v1",
      }),
    });
    const body = await readWorkerJson(r);
    res.status(r.status).json(body);
  } catch (err) {
    res.status(502).json({ error: "INGESTOR_UNREACHABLE", detail: (err as Error).message });
  }
});

app.get("/api/concurrency/stats", async (_req, res) => {
  try {
    const r = await fetchWorker("/concurrency/stats");
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

app.get("/api/bots/templates", async (_req, res) => {
  try {
    const r = await fetchWorker("/bots/templates");
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

// xStocks (tokenized equities) catalog + live US-equity session phase.
app.get("/api/xstocks/catalog", async (_req, res) => {
  try {
    const r = await fetchWorker("/xstocks/catalog");
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

app.get("/api/xstocks/session", async (req, res) => {
  try {
    const qs = req.query.ts_ms ? `?ts_ms=${encodeURIComponent(String(req.query.ts_ms))}` : "";
    const r = await fetchWorker(`/xstocks/session${qs}`);
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

// On-demand synchronous backfill: if we don't hold enough candles for a symbol/interval,
// pull them from Bybit (public kline) right now, then report how many we have. Lets the UI
// pick ANY Bybit symbol and auto-fetch data instead of erroring with "backfill first".
app.post("/api/candles/ensure", async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || "").toUpperCase();
    const category = String(req.body?.category || (symbol.endsWith("XUSDT") ? "spot" : "linear"));
    const interval = String(req.body?.interval || "60");
    const minBars = Math.max(1, Number(req.body?.minBars || 200));
    if (!symbol) return res.status(400).json({ error: "SYMBOL_REQUIRED" });

    const have = await db.query(
      `SELECT COUNT(*)::int AS n FROM candles WHERE symbol=$1 AND category=$2 AND interval=$3`,
      [symbol, category, interval]
    );
    let count = have.rows[0]?.n ?? 0;
    let backfilled = 0;
    if (count < minBars) {
      // window sized to comfortably exceed minBars for this interval
      const stepMs = interval === "D" ? 86_400_000 : interval === "W" ? 604_800_000
        : (Number(interval) || 60) * 60_000;
      const now = Date.now();
      const startMs = now - stepMs * Math.max(minBars + 50, 500);
      const r = await ingestor("/collect/backfill/kline", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, symbol, interval, start_ms: startMs, end_ms: now, data_version: "on-demand-v1" }),
      });
      const body = await r.json().catch(() => ({})) as { rows_inserted?: number };
      backfilled = Number(body?.rows_inserted ?? 0);
      const after = await db.query(
        `SELECT COUNT(*)::int AS n FROM candles WHERE symbol=$1 AND category=$2 AND interval=$3`,
        [symbol, category, interval]
      );
      count = after.rows[0]?.n ?? count;
    }
    return res.json({ ok: true, symbol, category, interval, count, backfilled, sufficient: count >= minBars });
  } catch (err) {
    return res.status(502).json({ error: "ENSURE_FAILED", message: (err as Error).message });
  }
});

// Full selectable symbol universe (linear perps from instrument snapshots + xStocks),
// each tagged with base/quote/kind/category and whether we hold candle data for it.
app.get("/api/symbols", async (_req, res) => {
  try {
    const QUOTES = ["USDT", "USDC", "USD", "DAI", "EUR"];
    const splitQuote = (sym: string): { base: string; quote: string } => {
      for (const q of QUOTES) if (sym.endsWith(q) && sym.length > q.length) return { base: sym.slice(0, -q.length), quote: q };
      return { base: sym, quote: "" };
    };
    const [instr, withData, xstocksRes] = await Promise.all([
      db.query(`SELECT DISTINCT symbol FROM instrument_snapshots ORDER BY symbol`),
      db.query(`SELECT DISTINCT symbol FROM candles`),
      fetchWorker("/xstocks/catalog").then((r) => readWorkerJson(r)).catch(() => ({ xstocks: [] })),
    ]);
    const dataSet = new Set<string>(withData.rows.map((r: { symbol: string }) => r.symbol));
    const xstocks = ((xstocksRes as { xstocks?: Array<Record<string, unknown>> })?.xstocks ?? []);
    const xstockSymbols = new Set(xstocks.map((x) => String(x.symbol)));

    const symbols: Array<Record<string, unknown>> = [];
    // xStocks first (spot equity)
    for (const x of xstocks) {
      const symbol = String(x.symbol);
      symbols.push({
        symbol, category: "spot", kind: "equity",
        base: String(x.base_coin ?? ""), quote: String(x.quote ?? "USDT"),
        underlying: String(x.underlying ?? ""), name: String(x.name ?? ""),
        has_data: dataSet.has(symbol), bot_enabled: Boolean(x.bot_enabled),
      });
    }
    // linear perps (skip any that are xStock symbols to avoid dupes)
    for (const row of instr.rows as Array<{ symbol: string }>) {
      if (xstockSymbols.has(row.symbol)) continue;
      const { base, quote } = splitQuote(row.symbol);
      symbols.push({ symbol: row.symbol, category: "linear", kind: "crypto", base, quote, has_data: dataSet.has(row.symbol) });
    }
    res.json({ count: symbols.length, with_data: dataSet.size, symbols });
  } catch (err) {
    res.status(500).json({ error: "SYMBOLS_FETCH_FAILED", message: (err as Error).message });
  }
});

// Multi-asset / multi-token portfolio engine (combined crypto + xStocks book).
app.get("/api/portfolio/schemes", async (_req, res) => {
  try {
    const r = await fetchWorker("/portfolio/schemes");
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

app.post("/api/portfolio/validate", async (req, res) => {
  try {
    const r = await fetchWorker("/portfolio/validate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

app.post("/api/portfolio/run", async (req, res) => {
  try {
    const r = await fetchWorker("/portfolio/run", {
      method: "POST", headers: { "Content-Type": "application/json", "x-owner-id": String(requireOwnerId(req)) }, body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await readWorkerJson(r));
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

app.post("/api/bots/specs", async (req, res) => {
  const schema = z.object({
    botType: z.string(),
    name: z.string(),
    symbols: z.array(z.string()).default([]),
    params: z.record(z.unknown()).default({}),
    risk: z.record(z.unknown()).default({}),
    accounting: z.record(z.unknown()).default({}),
    parentBotSpecId: z.string().optional(),
  });
  const p = schema.parse(req.body);
  const ownerId = requireOwnerId(req);
  const derivedSymbols = new Set<string>(p.symbols.map((s) => s.toUpperCase()));
  const paramsObj = p.params as Record<string, unknown>;
  const oneSymbolKeys = ["symbol", "perp_symbol", "spot_symbol"];
  for (const key of oneSymbolKeys) {
    const val = paramsObj[key];
    if (typeof val === "string" && val.trim()) {
      derivedSymbols.add(val.trim().toUpperCase());
    }
  }
  if (Array.isArray(paramsObj.symbols)) {
    for (const entry of paramsObj.symbols as Array<Record<string, unknown>>) {
      const symbol = entry?.symbol;
      if (typeof symbol === "string" && symbol.trim()) {
        derivedSymbols.add(symbol.trim().toUpperCase());
      }
    }
  }
  const validate = await fetchWorker("/bots/validate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec: { bot_type: p.botType, name: p.name, symbols: p.symbols, params: p.params, risk: p.risk, accounting: p.accounting } }),
  });
  const validation = await readWorkerJson(validate) as any;
  const id = `bs_${randomUUID()}`;
  // Ensure a default template_version row exists per bot_type (lazy seed).
  await db.query(
    `INSERT INTO bot_templates (template_id, bot_type, display_name, description, category, risk_class, default_params_json, param_schema_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)
     ON CONFLICT DO NOTHING`,
    [`tpl_${p.botType}_default`, p.botType, p.botType, p.botType, "auto", validation?.risk_class ?? "MODERATE", JSON.stringify(p.params)]
  );
  await db.query(
    `INSERT INTO bot_template_versions (version_id, template_id, version, param_schema_json, compiler_version)
     VALUES ($1, $2, 1, '{}'::jsonb, $3)
     ON CONFLICT DO NOTHING`,
    [`tpv_${p.botType}_v1`, `tpl_${p.botType}_default`, validation?.compiler_version ?? "unknown"]
  );
  await db.query(
    `INSERT INTO bot_specs (bot_spec_id, owner_id, template_version_id, bot_type, name, universe_json, params_json, risk_json, accounting_json, validation_report_json, spec_hash, parent_bot_spec_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, ownerId, `tpv_${p.botType}_v1`, p.botType, p.name, JSON.stringify({ symbols: p.symbols }), JSON.stringify(p.params), JSON.stringify(p.risk), JSON.stringify(p.accounting), JSON.stringify(validation), validation?.spec_hash ?? "", p.parentBotSpecId ?? null]
  );
  if (derivedSymbols.size > 0) {
    await fetch(`${dataIngestorUrl}/collect/ws/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: [...derivedSymbols] }),
    }).catch(() => undefined);
  }
  res.json({ botSpecId: id, validation });
});

app.get("/api/bots/specs/:id", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const r = await db.query(`SELECT * FROM bot_specs WHERE bot_spec_id = $1 AND owner_id = $2`, [req.params.id, ownerId]);
  if (!r.rowCount) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(r.rows[0]);
});

app.post("/api/bots/specs/:id/validate", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const r = await db.query(`SELECT * FROM bot_specs WHERE bot_spec_id = $1 AND owner_id = $2`, [req.params.id, ownerId]);
  if (!r.rowCount) return res.status(404).json({ error: "NOT_FOUND" });
  const row = r.rows[0];
  const symbols = (row.universe_json as { symbols?: string[] }).symbols ?? [];
  return proxyToWorker("/bots/validate", {
    spec: { bot_type: row.bot_type, name: row.name, symbols, params: row.params_json, risk: row.risk_json, accounting: row.accounting_json },
    coverage: (req.body && req.body.coverage) || {},
    requested_tier: (req.body && req.body.requestedTier) || "LOCAL ONLY",
  }, res);
});

app.post("/api/bots/cockpit", async (req, res) => {
  return proxyToWorker("/bots/cockpit", req.body, res);
});

app.post("/api/bots/runs/backtest", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const specId = String(req.body?.botSpecId ?? "");
  if (!specId) {
    return res.status(400).json({ error: "MISSING_BOT_SPEC_ID" });
  }
  const specRow = await db.query(
    `SELECT bot_spec_id, bot_type, name, params_json, risk_json, accounting_json, universe_json, spec_hash FROM bot_specs WHERE bot_spec_id = $1 AND owner_id = $2 LIMIT 1`,
    [specId, ownerId]
  );
  if (!specRow.rowCount) {
    return res.status(404).json({ error: "BOT_SPEC_NOT_FOUND" });
  }
  const spec = specRow.rows[0];
  const bars = Array.isArray(req.body?.bars) ? req.body.bars : [];
  const intervalMinutes = Number(req.body?.interval_minutes ?? 15);
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const startTs = bars.length > 0 ? Number(bars[0]?.ts ?? 0) : 0;
  const endTs = bars.length > 0 ? Number(bars[bars.length - 1]?.ts ?? 0) + intervalMs : 0;
  const symbolForL2 = String(req.body?.symbol ?? (spec.universe_json as { symbols?: string[] })?.symbols?.[0] ?? "BTCUSDT");
  const category = String(req.body?.category ?? "linear");
  const coverage = await enrichBotCoverage(
    symbolForL2,
    category,
    startTs,
    endTs,
    intervalMs,
    (req.body?.coverage ?? {}) as Record<string, unknown>
  );

  const body = {
    spec: {
      bot_type: spec.bot_type,
      name: spec.name,
      symbols: (spec.universe_json as { symbols?: string[] })?.symbols ?? [],
      params: spec.params_json,
      risk: spec.risk_json,
      accounting: spec.accounting_json,
    },
    symbol: req.body?.symbol ?? "BTCUSDT",
    bars: req.body?.bars ?? [],
    funding_rows: req.body?.funding_rows ?? [],
    side_bars: req.body?.side_bars ?? {},
    starting_equity: req.body?.starting_equity ?? "10000",
    risk: req.body?.risk ?? {},
    coverage,
    requested_tier: req.body?.requested_tier ?? "LOCAL ONLY",
    fee_bps_taker: req.body?.fee_bps_taker ?? "5.5",
    fee_bps_maker: req.body?.fee_bps_maker ?? "1.0",
    slippage_bps_one_way: req.body?.slippage_bps_one_way ?? "2.0",
    interval_minutes: intervalMinutes,
    bot_spec_id: specId,
    strategy_version_id: `bot_${specId}`,
    persist_run: true,
    run_mode: "backtest",
    execution_fidelity: req.body?.execution_fidelity ?? req.body?.executionFidelity ?? "bar_based",
    allow_fallback: req.body?.allow_fallback ?? true,
    category,
    venue_exact: Boolean(req.body?.venue_exact ?? req.body?.venueExact ?? false),
    vip_tier: req.body?.vip_tier ?? req.body?.vipTier ?? null,
  };
  try {
    const r = await fetchWorker("/bots/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-owner-id": String(requireOwnerId(req)) },
      body: JSON.stringify(body),
    });
    const out = await readWorkerJson(r);
    return res.status(r.status).json(out);
  } catch (err) {
    return res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

app.post("/api/bots/runs/paper", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const specId = String(req.body?.botSpecId ?? "");
  if (!specId) {
    return res.status(400).json({ error: "MISSING_BOT_SPEC_ID" });
  }
  const specRow = await db.query(
    `SELECT bot_spec_id, bot_type, name, params_json, risk_json, accounting_json, universe_json FROM bot_specs WHERE bot_spec_id = $1 AND owner_id = $2 LIMIT 1`,
    [specId, ownerId]
  );
  if (!specRow.rowCount) {
    return res.status(404).json({ error: "BOT_SPEC_NOT_FOUND" });
  }
  const spec = specRow.rows[0];
  const bars = Array.isArray(req.body?.bars) ? req.body.bars : [];
  const intervalMinutes = Number(req.body?.interval_minutes ?? 15);
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const startTs = bars.length > 0 ? Number(bars[0]?.ts ?? 0) : 0;
  const endTs = bars.length > 0 ? Number(bars[bars.length - 1]?.ts ?? 0) + intervalMs : 0;
  const symbol = String(req.body?.symbol ?? (spec.universe_json as { symbols?: string[] })?.symbols?.[0] ?? "BTCUSDT");
  const category = String(req.body?.category ?? "linear");
  const coverage = await enrichBotCoverage(symbol, category, startTs, endTs, intervalMs, (req.body?.coverage ?? {}) as Record<string, unknown>);
  try {
    const r = await fetchWorker("/bots/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-owner-id": String(requireOwnerId(req)) },
      body: JSON.stringify({
        spec: {
          bot_type: spec.bot_type,
          name: spec.name,
          symbols: (spec.universe_json as { symbols?: string[] })?.symbols ?? [],
          params: spec.params_json,
          risk: spec.risk_json,
          accounting: spec.accounting_json,
        },
        symbol,
        bars: req.body?.bars ?? [],
        funding_rows: req.body?.funding_rows ?? [],
        side_bars: req.body?.side_bars ?? {},
        starting_equity: req.body?.starting_equity ?? "10000",
        risk: req.body?.risk ?? {},
        coverage,
        requested_tier: req.body?.requested_tier ?? "LOCAL ONLY",
        fee_bps_taker: req.body?.fee_bps_taker ?? "5.5",
        fee_bps_maker: req.body?.fee_bps_maker ?? "1.0",
        slippage_bps_one_way: req.body?.slippage_bps_one_way ?? "2.0",
        interval_minutes: intervalMinutes,
        bot_spec_id: specId,
        strategy_version_id: `bot_paper_${specId}`,
        persist_run: true,
        run_mode: "paper",
        execution_fidelity: req.body?.execution_fidelity ?? req.body?.executionFidelity ?? "bar_based",
        allow_fallback: req.body?.allow_fallback ?? true,
        category,
        venue_exact: Boolean(req.body?.venue_exact ?? req.body?.venueExact ?? false),
        vip_tier: req.body?.vip_tier ?? req.body?.vipTier ?? null,
      }),
    });
    const out = await readWorkerJson(r);
    return res.status(r.status).json(out);
  } catch (error) {
    return res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (error as Error).message });
  }
});

app.post("/api/bots/recommendations/scan", async (req, res) => {
  try {
    const ownerId = requireOwnerId(req);
    const r = await fetchWorker("/bots/recommend", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const out = await readWorkerJson(r) as any;
    // Persist
    const recs = (out.recommendations as any[]) || [];
    const ids: string[] = [];
    for (const rec of recs) {
      const id = `rec_${randomUUID()}`;
      ids.push(id);
      await db.query(
        `INSERT INTO bot_recommendations (recommendation_id, owner_id, symbol, bot_type, regime_label, params_json, expected_risk_json, reason_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ownerId, rec.params?.symbol ?? rec.params?.perp_symbol ?? "BTCUSDT", rec.bot_type, rec.regime_label, JSON.stringify(rec.params), JSON.stringify(rec.expected_risk), JSON.stringify(rec.reason)]
      );
    }
    res.json({ ...out, recommendation_ids: ids });
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

app.get("/api/bots/recommendations", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const r = await db.query(`SELECT * FROM bot_recommendations WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2`, [ownerId, limit]);
  res.json({ rows: r.rows });
});

app.post("/api/bots/marketplace/publish", async (req, res) => {
  try {
    const ownerId = requireOwnerId(req);
    const schema = z.object({
      botSpecId: z.string(),
      runId: z.string(),
      runKind: z.enum(["backtest", "paper"]).default("backtest"),
      title: z.string(),
      botType: z.string(),
      symbolSet: z.array(z.string()).default([]),
      summary: z.record(z.unknown()).default({}),
      metrics: z.record(z.unknown()).default({}),
      risk: z.record(z.unknown()).default({}),
      dataVersion: z.string(),
      engineVersion: z.string(),
      compilerVersion: z.string(),
      verificationHash: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const p = parsed.data;
    const run = await db.query(
      `
        SELECT run_id, bot_spec_id, result_tier, metrics_json, coverage_proof_json, fill_model_json,
               config_json, compiler_version, engine_version, data_version, approximate_fills,
               canonical_range_start, canonical_range_end
        FROM backtest_runs
        WHERE run_id = $1 AND bot_spec_id = $2
        LIMIT 1
      `,
      [p.runId, p.botSpecId]
    );
    if (!run.rowCount) {
      return res.status(404).json({ error: "RUN_NOT_FOUND_FOR_SPEC" });
    }
    const spec = await db.query(`SELECT bot_spec_id, owner_id FROM bot_specs WHERE bot_spec_id = $1 LIMIT 1`, [p.botSpecId]);
    if (!spec.rowCount || Number(spec.rows[0].owner_id) !== ownerId) {
      return res.status(403).json({ error: "FORBIDDEN_SPEC_OWNER" });
    }
    const runRow = run.rows[0] as {
      result_tier: string;
      metrics_json: Record<string, unknown>;
      coverage_proof_json: Record<string, unknown>;
      fill_model_json: Record<string, unknown> | null;
      config_json: Record<string, unknown>;
      approximate_fills: boolean;
      compiler_version: string | null;
      engine_version: string | null;
      data_version: string | null;
      canonical_range_start: Date | string | null;
      canonical_range_end: Date | string | null;
    };
    const requestedTier = normalizeTierLabel(String(req.body?.resultTier ?? runRow.result_tier ?? "LOCAL ONLY"));
    const approximateFills = Boolean(runRow.approximate_fills);
    let resultTier = requestedTier;
    const eligibilityLabels: string[] = [];
    if (approximateFills && VERIFIED_TIERS.has(resultTier)) {
      resultTier = "LOCAL ONLY";
      eligibilityLabels.push("E0_VERIFIED_EXECUTION_TIER_REQUIRES_L1_L2");
    }
    // Verified ⇔ the fill engine consumed the data (fill_model) AND the data coverage
    // proves it was present (coverage_proof). Recorded L2 rows alone are not sufficient.
    const coverage = (runRow.coverage_proof_json ?? {}) as Record<string, unknown>;
    const fmSource = runRow.fill_model_json && Object.keys(runRow.fill_model_json).length > 0
      ? runRow.fill_model_json
      : coverage.fill_model;
    const fm = (fmSource ?? {}) as Record<string, unknown>;
    const snapThreshold = Number(process.env.L2_SNAPSHOT_COVERAGE_THRESHOLD ?? "0.98");
    const l2Consumed =
      fm.l2_provider_used === true &&
      (fm.mode === "l2_sweep_only" || fm.mode === "l2_queue_full") &&
      Number(fm.snapshot_coverage_pct ?? 0) >= snapThreshold;
    if (!l2Consumed && VERIFIED_TIERS.has(resultTier)) {
      resultTier = "LOCAL ONLY";
      if (fm.l2_provider_used !== true) {
        // covers the "recorded-L2-but-not-consumed" and "no-L2-at-all" cases identically.
        eligibilityLabels.push("E0_L2_NOT_CONSUMED_BY_FILL_ENGINE");
      } else if (fm.mode === "bar_based") {
        eligibilityLabels.push("E0_FILL_MODE_BAR_BASED");
      } else {
        eligibilityLabels.push("E0_L2_SNAPSHOT_COVERAGE_BELOW_THRESHOLD");
      }
    }
    let proof = (coverage.coverage_proof ?? null) as Partial<CoverageProof> | null;
    if (!proof && runRow.canonical_range_start && runRow.canonical_range_end) {
      const cfg = (runRow.config_json ?? {}) as Record<string, unknown>;
      const specCfg = (cfg.spec ?? {}) as Record<string, unknown>;
      const universe = (specCfg.universe_json ?? {}) as Record<string, unknown>;
      const symbolSet = Array.isArray(p.symbolSet) && p.symbolSet.length > 0 ? p.symbolSet : [];
      const specSymbols = Array.isArray(specCfg.symbols) ? specCfg.symbols : [];
      const universeSymbols = Array.isArray(universe.symbols) ? universe.symbols : [];
      const symbol = String(cfg.symbol ?? symbolSet[0] ?? specSymbols[0] ?? universeSymbols[0] ?? "BTCUSDT").toUpperCase();
      const category = String(cfg.category ?? (symbol.endsWith("XUSDT") ? "spot" : "linear"));
      const intervalMinutes = Number(cfg.interval_minutes ?? cfg.intervalMinutes ?? 15);
      const startMs = new Date(runRow.canonical_range_start).getTime();
      const endMs = new Date(runRow.canonical_range_end).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        proof = await computeCoverageProof(symbol, category, startMs, endMs, Math.max(1, intervalMinutes) * 60_000, {
          interval: String(Math.max(1, intervalMinutes)),
        });
      }
    }
    const cfg = (runRow.config_json ?? {}) as Record<string, unknown>;
    const leverage = findFirstNumericField(cfg, new Set(["leverage"]));
    const category = String(cfg.category ?? "").toLowerCase();
    const fundingRows = cfg.funding_rows ?? cfg.fundingRows;
    const fundingRequired = (Array.isArray(fundingRows) && fundingRows.length > 0)
      || String((cfg.spec as Record<string, unknown> | undefined)?.bot_type ?? "").includes("funding");
    const coverageGate = coverageRequirementsMet(proof, String(fm.mode ?? "bar_based"), {
      leveraged: category === "linear" && (leverage ?? 1) > 1,
      funding: fundingRequired,
    });
    if (!coverageGate.ok && VERIFIED_TIERS.has(resultTier)) {
      resultTier = "LOCAL ONLY";
      eligibilityLabels.push(...coverageGate.missing);
    }
    const qualityScore = Number(runRow.metrics_json?.total_return_after_fees_funding ?? 0);
    const score = rankScoreForTier(resultTier, qualityScore);
    const published = VERIFIED_TIERS.has(resultTier);
    const id = `card_${randomUUID()}`;
    await db.query(
      `INSERT INTO marketplace_cards (card_id, bot_spec_id, run_id, run_kind, title, bot_type, symbol_set, summary_json, metrics_json, risk_json, data_version, engine_version, compiler_version, verification_hash, result_tier, published, owner_id, rank_score, eligibility_labels_json, published_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20)`,
      [
        id,
        p.botSpecId,
        p.runId,
        p.runKind,
        p.title,
        p.botType,
        p.symbolSet,
        JSON.stringify(p.summary),
        JSON.stringify(runRow.metrics_json ?? p.metrics),
        JSON.stringify(p.risk),
        runRow.data_version ?? p.dataVersion,
        runRow.engine_version ?? p.engineVersion,
        runRow.compiler_version ?? p.compilerVersion,
        p.verificationHash ?? null,
        resultTier,
        published,
        ownerId,
        score,
        JSON.stringify(eligibilityLabels),
        published ? "VERIFIED_ELIGIBLE" : "LOCAL_ONLY_DEMOTED",
      ]
    );
    return res.json({ cardId: id, published, resultTier, rankScore: score, eligibilityLabels });
  } catch (error) {
    return res.status(500).json({ error: "MARKETPLACE_PUBLISH_FAILED", message: (error as Error).message });
  }
});

app.get("/api/bots/marketplace", async (req, res) => {
  const tier = (req.query.tier as string) || undefined;
  const rows = tier
    ? await db.query(`SELECT * FROM marketplace_cards WHERE published = true AND result_tier = $1 ORDER BY rank_score DESC, created_at DESC LIMIT 100`, [normalizeTierLabel(tier)])
    : await db.query(`SELECT * FROM marketplace_cards WHERE published = true ORDER BY rank_score DESC, created_at DESC LIMIT 100`);
  res.json({ cards: rows.rows });
});

app.post("/api/bots/marketplace/:cardId/fork", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const c = await db.query(`SELECT bot_spec_id, published, result_tier FROM marketplace_cards WHERE card_id = $1`, [req.params.cardId]);
  if (!c.rowCount) return res.status(404).json({ error: "CARD_NOT_FOUND" });
  if (!Boolean(c.rows[0].published) || !VERIFIED_TIERS.has(String(c.rows[0].result_tier))) {
    return res.status(403).json({ error: "FORK_REQUIRES_VERIFIED_PUBLISHED_CARD" });
  }
  const orig = await db.query(`SELECT * FROM bot_specs WHERE bot_spec_id = $1`, [c.rows[0].bot_spec_id]);
  if (!orig.rowCount) return res.status(404).json({ error: "SPEC_NOT_FOUND" });
  const o = orig.rows[0];
  const id = `bs_${randomUUID()}`;
  await db.query(
    `INSERT INTO bot_specs (bot_spec_id, owner_id, template_version_id, bot_type, name, universe_json, params_json, risk_json, accounting_json, spec_hash, parent_bot_spec_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, ownerId, o.template_version_id, o.bot_type, `Fork of ${o.name}`, JSON.stringify(o.universe_json), JSON.stringify(o.params_json), JSON.stringify(o.risk_json), JSON.stringify(o.accounting_json), o.spec_hash, o.bot_spec_id]
  );
  res.json({ botSpecId: id, parentBotSpecId: o.bot_spec_id });
});

app.post("/api/optimizer/sweep", async (req, res) => {
  return proxyToWorker("/optimizer/sweep", req.body, res);
});

app.post("/api/paper/runtime/run", async (req, res) => {
  // Stateless: forward to worker, which runs PaperRuntime with the requested strategy.
  try {
    const r = await fetchWorker("/paper/runtime/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-owner-id": String(requireOwnerId(req)) },
      body: JSON.stringify(req.body),
    });
    const body = await readWorkerJson(r);
    res.status(r.status).json(body);
  } catch (err) {
    res.status(502).json({ error: "WORKER_UNREACHABLE", detail: (err as Error).message });
  }
});

app.get("/api/strategies/registry", (_req, res) => {
  res.json({
    strategies: [
      { id: "pmm", name: "Pure Market Maker", description: "Bid/ask quotes with inventory skew (Hummingbot PMM).", params: { bid_spread_bps: 5, ask_spread_bps: 5, order_qty: "0.01", inventory_skew_bps_per_unit: 50, max_inventory_qty: "1.0", refresh_each_bar: true } },
      { id: "avellaneda_stoikov", name: "Avellaneda-Stoikov MM", description: "Optimal MM with reservation price + spread from inventory risk.", params: { gamma_mode: "auto_calibrated", target_spread_bps: 10, gamma: 0.1, k: 1.5, sigma_lookback: 50, horizon_bars: 100, order_qty: "0.01" } },
      { id: "funding_fade", name: "Funding Mean Reversion", description: "Fades crowded funding gated by slow-trend filter (spec §6.1).", params: { funding_z_threshold: "1.75", ema_slow_len: 80, atr_len: 14, stop_atr_mult: "1.8", tp_atr_mult: "2.4", order_qty: "0.1", max_holding_bars: 96 } },
      { id: "trend_ema_cross", name: "Trend EMA Cross", description: "Fast/slow EMA cross with ATR trailing stop.", params: { ema_fast: 20, ema_slow: 50, atr_len: 14, order_qty: "0.1", trail_atr_mult: "3.0" } },
      { id: "grid", name: "Static Grid Trader", description: "Bid/ask grid around an anchor price (APPROXIMATE_FILLS).", params: { spacing_bps: 30, num_levels: 5, qty_per_level: "0.01", refresh_each_bar: false } },
      { id: "twap", name: "TWAP Executor", description: "Equal-slice time-weighted execution.", params: { total_qty: "1.0", side: "buy", n_slices: 10 } },
    ],
  });
});

app.post("/api/optimizer/runs", async (req, res) => {
  const payloadSchema = z.object({
    strategyVersionId: z.string(),
    method: z.string().default("grid"),
    topN: z.number().int().positive().default(3),
    eventOnlyTemplate: z.boolean().default(false),
    thresholds: z
      .object({
        allowed_return_drift: z.number().default(0.005),
        allowed_drawdown_drift: z.number().default(0.01),
        allowed_trade_count_drift: z.number().int().default(2)
      })
      .default({
        allowed_return_drift: 0.005,
        allowed_drawdown_drift: 0.01,
        allowed_trade_count_drift: 2
      }),
    candidates: z.array(
      z.object({
        params: z.record(z.any()),
        vector_metrics: z.object({
          total_return: z.number(),
          max_drawdown: z.number(),
          trade_count: z.number().int()
        })
      })
    ).default([]),
    searchSpace: z.record(z.object({
      min: z.number(),
      max: z.number(),
      step: z.number().positive()
    })).default({})
  });

  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const ownerId = requireOwnerId(req);
  const generatedCandidates =
    parsed.data.candidates.length > 0
      ? parsed.data.candidates
      : generateGridCandidates(parsed.data.searchSpace, 2000);
  if (generatedCandidates.length === 0) {
    return res.status(400).json({ error: "NO_CANDIDATES", reason: "Provide candidates or searchSpace." });
  }

  if (await isForeignOwned("strategies", "strategy_id", parsed.data.strategyVersionId, ownerId)
      || await isForeignOwned("strategy_versions", "strategy_version_id", parsed.data.strategyVersionId, ownerId)) {
    return res.status(403).json({ error: "FORBIDDEN_RESOURCE_OWNER", resource: "optimization_strategy" });
  }
  try {
    await db.query(
      `
        INSERT INTO strategies (strategy_id, owner_id, name)
        VALUES ($1, $2, $1)
        ON CONFLICT (strategy_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, updated_at = NOW()
      `,
      [parsed.data.strategyVersionId, ownerId]
    );
    await db.query(
      `
        INSERT INTO strategy_versions (strategy_version_id, strategy_id, dsl_json, owner_id)
        VALUES ($1, $2, '{}'::jsonb, $3)
        ON CONFLICT (strategy_version_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, updated_at = NOW()
      `,
      [parsed.data.strategyVersionId, parsed.data.strategyVersionId, ownerId]
    );

    const response = await fetchWorker("/optimizer/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-owner-id": String(requireOwnerId(req)) },
      body: JSON.stringify({
        strategyVersionId: parsed.data.strategyVersionId,
        method: parsed.data.method,
        topN: parsed.data.topN,
        event_only_template: parsed.data.eventOnlyTemplate,
        thresholds: parsed.data.thresholds,
        candidates: generatedCandidates
      })
    });
    const body = await readWorkerJson(response);
    return res.status(response.status).json(body);
  } catch (error) {
    return res.status(502).json({ error: "OPTIMIZER_WORKER_UNAVAILABLE", message: (error as Error).message });
  }
});

app.get("/api/optimizer/runs/:runId", async (req, res) => {
  try {
    const ownerId = requireOwnerId(req);
    const run = await db.query(
      `
        SELECT o.run_id, o.strategy_version_id, o.status, o.method, o.config_json,
               o.parity_threshold_json, o.summary_json, o.created_at
        FROM optimization_runs o
        JOIN strategy_versions sv ON sv.strategy_version_id = o.strategy_version_id
        WHERE o.run_id = $1
          AND (sv.owner_id IS NULL OR sv.owner_id = $2)
        LIMIT 1
      `,
      [req.params.runId, ownerId]
    );
    if (!run.rowCount) {
      return res.status(404).json({ error: "OPTIMIZATION_RUN_NOT_FOUND" });
    }
    const candidates = await db.query(
      `
        SELECT candidate_rank, params_json, vector_metrics_json, event_metrics_json, parity_json, event_rescored, promoteable, badge
        FROM optimization_candidates
        WHERE run_id = $1
        ORDER BY candidate_rank ASC
      `,
      [req.params.runId]
    );
    return res.json({ run: run.rows[0], candidates: candidates.rows });
  } catch (error) {
    return res.status(500).json({ error: "OPTIMIZATION_RUN_FETCH_FAILED", message: (error as Error).message });
  }
});

app.post("/api/passports/publish", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const metricSchema = z.object({
    total_return_after_fees_funding: z.number(),
    sharpe: z.number(),
    calmar: z.number(),
    max_drawdown: z.number(),
    consistency: z.number(),
    robustness: z.number(),
    live_paper_score: z.number().default(0),
    liquidation_events: z.number().int().default(0),
    data_coverage_complete: z.boolean().default(true),
    overfit_penalty: z.number().default(0),
    approximate_fills: z.boolean().default(false)
  });
  const payloadSchema = z.object({
    runId: z.string(),
    localRunSummary: metricSchema,
    cohort: z.array(metricSchema).default([]),
    requestVerification: z.boolean().default(true),
    requestedTier: z.enum(["BACKTEST_VERIFIED", "LIVE_PAPER_VERIFIED"]).default("BACKTEST_VERIFIED"),
    strategyHash: z.string().optional(),
    dataSnapshotId: z.string().default("canonical-v1")
  });
  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const run = await db.query(
    `
      SELECT
        br.run_id, br.strategy_version_id, br.metrics_json, br.run_hash, br.strategy_hash_at_run, br.data_snapshot_id, br.engine_version, br.data_version, br.compiler_version, br.approximate_fills, br.liquidation_events,
        sv.hash AS strategy_hash_current, sv.dsl_json
      FROM backtest_runs br
      JOIN strategy_versions sv ON sv.strategy_version_id = br.strategy_version_id
      WHERE br.run_id = $1
        AND (sv.owner_id IS NULL OR sv.owner_id = $2)
      LIMIT 1
    `,
    [parsed.data.runId, ownerId]
  );
  if (!run.rowCount) {
    return res.status(404).json({ error: "RUN_NOT_FOUND" });
  }

  const runRow = run.rows[0] as {
    run_id: string;
    strategy_version_id: string;
    metrics_json: Record<string, unknown> | null;
    run_hash: string | null;
    strategy_hash_at_run: string | null;
    data_snapshot_id: string;
    engine_version: string | null;
    data_version: string | null;
    compiler_version: string | null;
    approximate_fills: boolean;
    liquidation_events: number;
    strategy_hash_current: string | null;
    dsl_json: unknown;
  };
  const normalizedLocalSummary = {
    ...parsed.data.localRunSummary,
    approximate_fills: Boolean(runRow.approximate_fills),
    liquidation_events: Number(runRow.liquidation_events ?? parsed.data.localRunSummary.liquidation_events ?? 0),
  };

  const riskResponse = await fetchWorker("/risk/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: normalizedLocalSummary,
      cohort: parsed.data.cohort
    })
  });
  const riskBody = (await readWorkerJson(riskResponse)) as {
    baseScore?: number;
    hardGatesPassed?: boolean;
    gateFailures?: string[];
  };
  if (!riskResponse.ok) {
    return res.status(502).json({ error: "RISK_EVALUATION_FAILED", details: riskBody });
  }

  const baseScore = Number(riskBody.baseScore ?? 0);
  const hardGatesPassed = Boolean(riskBody.hardGatesPassed);
  const gateFailures = riskBody.gateFailures ?? [];

  await db.query(
    `
      INSERT INTO risk_snapshots (
        run_id, total_return_after_fees_funding, sharpe, calmar, max_drawdown, consistency, robustness,
        live_paper_score, liquidation_events, data_coverage_complete, overfit_penalty, approximate_fills,
        hard_gates_passed, gate_failures_json, base_score
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14::jsonb, $15
      )
      ON CONFLICT (run_id)
      DO UPDATE SET
        total_return_after_fees_funding = EXCLUDED.total_return_after_fees_funding,
        sharpe = EXCLUDED.sharpe,
        calmar = EXCLUDED.calmar,
        max_drawdown = EXCLUDED.max_drawdown,
        consistency = EXCLUDED.consistency,
        robustness = EXCLUDED.robustness,
        live_paper_score = EXCLUDED.live_paper_score,
        liquidation_events = EXCLUDED.liquidation_events,
        data_coverage_complete = EXCLUDED.data_coverage_complete,
        overfit_penalty = EXCLUDED.overfit_penalty,
        approximate_fills = EXCLUDED.approximate_fills,
        hard_gates_passed = EXCLUDED.hard_gates_passed,
        gate_failures_json = EXCLUDED.gate_failures_json,
        base_score = EXCLUDED.base_score
    `,
    [
      parsed.data.runId,
      normalizedLocalSummary.total_return_after_fees_funding,
      normalizedLocalSummary.sharpe,
      normalizedLocalSummary.calmar,
      normalizedLocalSummary.max_drawdown,
      normalizedLocalSummary.consistency,
      normalizedLocalSummary.robustness,
      normalizedLocalSummary.live_paper_score,
      normalizedLocalSummary.liquidation_events,
      normalizedLocalSummary.data_coverage_complete,
      normalizedLocalSummary.overfit_penalty,
      normalizedLocalSummary.approximate_fills,
      hardGatesPassed,
      JSON.stringify(gateFailures),
      baseScore
    ]
  );

  const runHash =
    runRow.run_hash ??
    sha256({
      run_id: runRow.run_id,
      strategy_version_id: runRow.strategy_version_id,
      metrics_json: runRow.metrics_json
    });
  const strategyHash =
    parsed.data.strategyHash ??
    runRow.strategy_hash_at_run ??
    runRow.strategy_hash_current ??
    sha256(runRow.dsl_json ?? {});
  const passportId = randomUUID();

  let tier = "UNVERIFIED PAPER";
  let status = "UNVERIFIED";
  let ranked = false;
  let officialScore: number | null = null;
  let officialSummary: Record<string, unknown> = {};
  let verificationHash: string | null = null;
  const localScore = hardGatesPassed ? baseScore : null;
  let finalScore = localScore;

  if (parsed.data.requestVerification) {
    try {
      const verifierResponse = await fetch(`${verifierUrl}/verify/passport`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: parsed.data.runId,
          strategyVersionId: runRow.strategy_version_id,
          submittedRunHash: runHash,
          submittedStrategyHash: strategyHash,
          requestedTier: parsed.data.requestedTier,
          dataSnapshotId: parsed.data.dataSnapshotId,
          localRunSummary: normalizedLocalSummary,
          submittedEngineVersion: runRow.engine_version,
          submittedDataVersion: runRow.data_version,
          submittedCompilerVersion: runRow.compiler_version,
        })
      });
      const verifierBody = (await readWorkerJson(verifierResponse)) as Record<string, unknown>;
      if (verifierResponse.ok && verifierBody.status === "verified") {
        tier = String(verifierBody.tier ?? "BACKTEST VERIFIED");
        status = "VERIFIED";
        ranked = tier === "BACKTEST VERIFIED" || tier === "LIVE PAPER VERIFIED";
        officialScore = Number(verifierBody.officialScore ?? 0);
        officialSummary = (verifierBody.officialSummary as Record<string, unknown>) ?? {};
        verificationHash = String(verifierBody.verificationHash ?? "");
        finalScore = officialScore;
        passportVerificationCounter.labels("verified", tier).inc();
      } else {
        status = "REJECTED";
        tier = "UNVERIFIED PAPER";
        ranked = false;
        officialSummary = verifierBody;
        passportVerificationCounter.labels("rejected", tier).inc();
        if (String(verifierBody.reason ?? "") === "RUN_HASH_MISMATCH") {
          runHashMismatchCounter.inc();
        }
      }
    } catch (error) {
      status = "UNVERIFIED";
      tier = "UNVERIFIED PAPER";
      ranked = false;
      officialSummary = { warning: "VERIFIER_UNAVAILABLE", message: (error as Error).message };
      passportVerificationCounter.labels("unverified", tier).inc();
    }
  }
  const rankScore = hardGatesPassed && finalScore != null ? rankScoreForTier(tier, Number(finalScore)) : null;

  await db.query(
    `
      INSERT INTO leaderboard_passports (
        passport_id, run_id, strategy_version_id, tier, status, ranked, local_score, official_score, final_score,
        local_summary_json, official_summary_json, verification_hash, run_hash, signed_at, rank_score
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10::jsonb, $11::jsonb, $12, $13, $14::timestamptz, $15
      )
    `,
    [
      passportId,
      parsed.data.runId,
      runRow.strategy_version_id,
      tier,
      status,
      ranked && hardGatesPassed,
      localScore,
      officialScore,
      hardGatesPassed ? finalScore : null,
      JSON.stringify(normalizedLocalSummary),
      JSON.stringify(officialSummary),
      verificationHash,
      runHash,
      verificationHash ? new Date().toISOString() : null,
      rankScore
    ]
  );

  return res.status(201).json({
    passportId,
    runId: parsed.data.runId,
    tier,
    status,
    ranked: ranked && hardGatesPassed,
    hardGatesPassed,
    gateFailures,
    localScore,
    officialScore,
    finalScore: hardGatesPassed ? finalScore : null,
    rankScore,
    verificationHash,
    visibility: ranked && hardGatesPassed ? "OFFICIAL_ELIGIBLE" : "LOCAL_UNVERIFIED_ONLY"
  });
});

app.get("/api/leaderboard", async (req, res) => {
  const querySchema = z.object({
    ranked: z
      .union([z.literal("true"), z.literal("false")])
      .optional()
      .transform((v) => v === "true"),
    tier: z.string().optional()
  });
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const ranked = parsed.data.ranked ?? false;
  const tier = parsed.data.tier ?? "UNVERIFIED PAPER";
  const rows = await db.query(
    `
      SELECT passport_id, run_id, strategy_version_id, tier, status, ranked, final_score, rank_score, created_at
      FROM leaderboard_passports
      WHERE ranked = $1 AND tier = $2
      ORDER BY rank_score DESC NULLS LAST, final_score DESC NULLS LAST, created_at DESC
      LIMIT 100
    `,
    [ranked, normalizeTierLabel(tier)]
  );

  return res.json({
    label: ranked ? "OFFICIAL_RANKED" : "UNVERIFIED_LOCAL_ONLY",
    tier,
    rows: rows.rows
  });
});

app.post("/api/strategies/:version/validate", async (req, res) => {
  const ownerId = requireOwnerId(req);
  const ownership = await db.query(
    `SELECT strategy_version_id FROM strategy_versions WHERE strategy_version_id = $1 AND (owner_id IS NULL OR owner_id = $2) LIMIT 1`,
    [req.params.version, ownerId]
  );
  if (!ownership.rowCount) {
    return res.status(403).json({ error: "FORBIDDEN_STRATEGY_VERSION" });
  }
  try {
    const response = await fetchWorker("/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyVersionId: req.params.version, ...req.body })
    });

    const body = await response.json();
    return res.status(response.status).json(body);
  } catch (error) {
    return res.status(502).json({
      error: "VALIDATOR_UNAVAILABLE",
      message: (error as Error).message
    });
  }
});

async function bootstrap(): Promise<void> {
  await bootstrapBackfillWorker();
  await ensureDefaultBackfillSchedules();
  await enqueueDueSchedules(Date.now());
  const schedulerEveryMs = Number(process.env.BACKFILL_SCHEDULER_INTERVAL_MS ?? 300_000);
  setInterval(() => {
    enqueueDueSchedules(Date.now()).catch((error) => {
      // eslint-disable-next-line no-console
      console.error("backfill scheduler error", error);
    });
  }, schedulerEveryMs);

  startStockOrderEngine();

  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`api listening on :${port}`);
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("api bootstrap failed", error);
  process.exit(1);
});
