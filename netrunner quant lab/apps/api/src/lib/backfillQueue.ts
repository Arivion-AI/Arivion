import { Queue, QueueEvents, Worker, type JobsOptions } from "bullmq";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { backfillDurationMs, backfillFailuresCounter, queueDepthGauge } from "./metrics.js";

const dataIngestorUrl = process.env.DATA_INGESTOR_URL ?? "http://data-ingestor:7100";
const queueName = process.env.BACKFILL_QUEUE_NAME ?? "backfill";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const queueConnection = { url: redisUrl, maxRetriesPerRequest: null as null };

export type BackfillJobPayload = {
  endpoint: "kline" | "funding" | "oi" | "long-short" | "instruments";
  category?: string;
  symbol?: string;
  interval?: string;
  start_ms?: number;
  end_ms?: number;
  data_version?: string;
  schedule_id?: string;
};

const queue = new Queue<BackfillJobPayload, unknown, BackfillJobPayload["endpoint"]>(queueName, { connection: queueConnection });
const queueEvents = new QueueEvents(queueName, { connection: queueConnection });

let workerBootstrapped = false;

function endpointPath(endpoint: BackfillJobPayload["endpoint"], category?: string): string {
  switch (endpoint) {
    case "kline":
      return "/collect/backfill/kline";
    case "funding":
      return "/collect/funding";
    case "oi":
      return "/collect/oi";
    case "long-short":
      return "/collect/long-short";
    case "instruments":
      return `/collect/instruments/${category ?? "linear"}`;
    default:
      return "/collect/backfill/kline";
  }
}

function normalizeIntervalForEndpoint(endpoint: BackfillJobPayload["endpoint"], interval?: string): string | undefined {
  if (!interval) return interval;
  const raw = String(interval).trim();
  if (endpoint === "kline") {
    const map: Record<string, string> = {
      "1m": "1",
      "3m": "3",
      "5m": "5",
      "15m": "15",
      "30m": "30",
      "1h": "60",
      "2h": "120",
      "4h": "240",
      "6h": "360",
      "12h": "720",
      "1d": "D",
      "1w": "W",
      "1M": "M",
    };
    return map[raw] ?? raw;
  }
  if (endpoint === "oi" || endpoint === "long-short") {
    const map: Record<string, string> = {
      "5": "5min",
      "15": "15min",
      "30": "30min",
      "60": "1h",
      "240": "4h",
      "D": "1d",
      "1m": "5min",
      "3m": "5min",
      "5m": "5min",
      "15m": "15min",
      "30m": "30min",
      "1h": "1h",
      "4h": "4h",
      "1d": "1d",
    };
    return map[raw] ?? raw;
  }
  return raw;
}

async function persistQueueState(jobKey: string, payload: BackfillJobPayload, status: string, patch?: Record<string, unknown>) {
  const attemptCount = Number(patch?.attempt_count ?? 0);
  const checkpoint = JSON.stringify((patch?.checkpoint_json as Record<string, unknown>) ?? {});
  const lastError = (patch?.last_error as string | null) ?? null;
  const nextRunAt = (patch?.next_run_at as string | null) ?? null;
  await db.query(
    `
      INSERT INTO backfill_queue_state (job_key, queue_name, endpoint, payload_json, status, checkpoint_json, attempt_count, next_run_at, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, '{}'::jsonb, 0, NULL, NOW())
      ON CONFLICT (job_key)
      DO UPDATE SET
        endpoint = EXCLUDED.endpoint,
        payload_json = EXCLUDED.payload_json,
        status = $5,
        attempt_count = CASE WHEN $6 > 0 THEN $6 ELSE backfill_queue_state.attempt_count END,
        checkpoint_json = COALESCE($7::jsonb, backfill_queue_state.checkpoint_json),
        last_error = $8,
        next_run_at = $9::timestamptz,
        updated_at = NOW()
    `,
    [
      jobKey,
      queueName,
      payload.endpoint,
      JSON.stringify(payload),
      status,
      attemptCount,
      checkpoint,
      lastError,
      nextRunAt,
    ],
  );
}

export async function enqueueBackfillJob(payload: BackfillJobPayload, options?: JobsOptions): Promise<string> {
  const jobId = `bf_${randomUUID()}`;
  const resolvedJobId = String(options?.jobId ?? jobId);
  try {
    await queue.add(payload.endpoint, payload, {
      jobId,
      removeOnComplete: 1000,
      removeOnFail: 2000,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
      ...options,
    });
  } catch (error) {
    const message = (error as Error).message ?? "";
    if (!message.toLowerCase().includes("already exists")) {
      throw error;
    }
  }
  await persistQueueState(resolvedJobId, payload, "queued");
  return resolvedJobId;
}

export async function bootstrapBackfillWorker(): Promise<void> {
  if (workerBootstrapped) return;
  workerBootstrapped = true;

  // eslint-disable-next-line no-new
  new Worker<BackfillJobPayload, unknown, BackfillJobPayload["endpoint"]>(
    queueName,
    async (job) => {
      const started = Date.now();
      const payload = job.data;
      await persistQueueState(job.id ?? job.name, payload, "running", {
        attempt_count: job.attemptsMade + 1,
      });
      try {
        const path = endpointPath(payload.endpoint, payload.category);
        const requestBody =
          payload.endpoint === "instruments"
            ? {}
            : {
                category: payload.category ?? "linear",
                symbol: payload.symbol,
                interval: normalizeIntervalForEndpoint(payload.endpoint, payload.interval),
                start_ms: payload.start_ms,
                end_ms: payload.end_ms,
                data_version: payload.data_version ?? "v1",
              };
        const response = await fetch(`${dataIngestorUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(180_000),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(`ingestor_error:${response.status}:${JSON.stringify(body)}`);
        }
        const durationMs = Date.now() - started;
        backfillDurationMs.labels(payload.endpoint).observe(durationMs);
        await persistQueueState(job.id ?? job.name, payload, "completed", {
          checkpoint_json: body?.checkpoint ?? {},
          next_run_at: null,
          last_error: null,
        });
        return body;
      } catch (error) {
        backfillFailuresCounter.labels(payload.endpoint).inc();
        await persistQueueState(job.id ?? job.name, payload, "failed", {
          last_error: (error as Error).message,
          attempt_count: job.attemptsMade + 1,
        });
        throw error;
      }
    },
    { connection: queueConnection, concurrency: 2 },
  );

  queueEvents.on("waiting", async () => {
    const waiting = await queue.getWaitingCount();
    queueDepthGauge.labels(queueName, "waiting").set(waiting);
  });
  queueEvents.on("active", async () => {
    const active = await queue.getActiveCount();
    queueDepthGauge.labels(queueName, "active").set(active);
  });
  queueEvents.on("completed", async () => {
    const completed = await queue.getCompletedCount();
    queueDepthGauge.labels(queueName, "completed").set(completed);
  });
  queueEvents.on("failed", async () => {
    const failed = await queue.getFailedCount();
    queueDepthGauge.labels(queueName, "failed").set(failed);
  });
}

export async function upsertSchedule(input: {
  scheduleId?: string;
  endpoint: BackfillJobPayload["endpoint"];
  symbol: string;
  category: string;
  interval: string;
  cadenceCron: string;
  lookbackMs: number;
  enabled?: boolean;
  dataVersion?: string;
}): Promise<string> {
  const scheduleId = input.scheduleId ?? `sched_${randomUUID()}`;
  const payloadTemplate = {
    endpoint: input.endpoint,
    symbol: input.symbol,
    category: input.category,
    interval: input.interval,
    data_version: input.dataVersion ?? "v1",
  };
  await db.query(
    `
      INSERT INTO backfill_schedules (schedule_id, queue_name, endpoint, symbol, category, interval, cadence_cron, lookback_ms, payload_template_json, enabled, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,NOW())
      ON CONFLICT (schedule_id)
      DO UPDATE SET
        endpoint = EXCLUDED.endpoint,
        symbol = EXCLUDED.symbol,
        category = EXCLUDED.category,
        interval = EXCLUDED.interval,
        cadence_cron = EXCLUDED.cadence_cron,
        lookback_ms = EXCLUDED.lookback_ms,
        payload_template_json = EXCLUDED.payload_template_json,
        enabled = EXCLUDED.enabled,
        updated_at = NOW()
    `,
    [scheduleId, queueName, input.endpoint, input.symbol, input.category, input.interval, input.cadenceCron, input.lookbackMs, JSON.stringify(payloadTemplate), input.enabled ?? true],
  );
  return scheduleId;
}

export async function enqueueDueSchedules(nowMs = Date.now()): Promise<number> {
  const rows = await db.query<{
    schedule_id: string;
    endpoint: BackfillJobPayload["endpoint"];
    symbol: string;
    category: string;
    interval: string;
    cadence_cron: string;
    lookback_ms: string;
    payload_template_json: Record<string, unknown>;
    enabled: boolean;
    last_enqueued_at: Date | null;
  }>(
    `
      SELECT
        bs.schedule_id,
        bs.endpoint,
        bs.symbol,
        bs.category,
        bs.interval,
        bs.cadence_cron,
        bs.lookback_ms,
        bs.payload_template_json,
        bs.enabled,
        st.updated_at AS last_enqueued_at
      FROM backfill_schedules bs
      LEFT JOIN backfill_queue_state st
        ON st.job_key = ('sched_' || bs.schedule_id)
      WHERE enabled = true
    `,
  );

  const cadenceMsFromCron = (cron: string): number => {
    const raw = cron.trim();
    const everyMinute = raw.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (everyMinute) {
      const minutes = Number(everyMinute[1]);
      return Math.max(1, minutes) * 60_000;
    }
    const everyHour = raw.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
    if (everyHour) {
      const hours = Number(everyHour[1]);
      return Math.max(1, hours) * 3_600_000;
    }
    const daily = raw.match(/^0\s+0\s+\*\s+\*\s+\*$/);
    if (daily) {
      return 86_400_000;
    }
    return 30 * 60_000;
  };

  let count = 0;
  for (const row of rows.rows) {
    const cadenceMs = cadenceMsFromCron(row.cadence_cron);
    const lastEnqueuedMs = row.last_enqueued_at ? row.last_enqueued_at.getTime() : 0;
    if (lastEnqueuedMs > 0 && nowMs - lastEnqueuedMs < cadenceMs) {
      continue;
    }
    const lookbackMs = Number(row.lookback_ms);
    const endMs = nowMs;
    const startMs = Math.max(0, endMs - lookbackMs);
    const cadenceBucket = Math.floor(nowMs / cadenceMs);
    const scheduledJobId = `bf_sched_${row.schedule_id}_${cadenceBucket}`;
    const payload = {
      endpoint: row.endpoint,
      symbol: row.symbol,
      category: row.category,
      interval: row.interval,
      start_ms: startMs,
      end_ms: endMs,
      data_version: String((row.payload_template_json?.data_version as string) ?? "v1"),
      schedule_id: row.schedule_id,
    } satisfies BackfillJobPayload;
    await enqueueBackfillJob({
      ...payload,
    }, { jobId: scheduledJobId });
    await persistQueueState(`sched_${row.schedule_id}`, payload, "queued", {
      next_run_at: new Date(nowMs + cadenceMs).toISOString(),
      checkpoint_json: { cadence_bucket: cadenceBucket },
      last_error: null,
    });
    count += 1;
  }
  return count;
}

export async function queueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed, queueName };
}
