import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "duality_api_" });

export const apiRequestCounter = new Counter({
  name: "duality_api_requests_total",
  help: "API requests by method, route and status",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const passportVerificationCounter = new Counter({
  name: "duality_passport_verification_total",
  help: "Passport verification outcomes",
  labelNames: ["status", "tier"] as const,
  registers: [registry],
});

export const runTierCounter = new Counter({
  name: "duality_runs_by_tier_total",
  help: "Run outcomes grouped by tier and kind",
  labelNames: ["kind", "tier"] as const,
  registers: [registry],
});

export const runHashMismatchCounter = new Counter({
  name: "duality_run_hash_mismatch_total",
  help: "Run hash mismatches returned by verifier flow",
  registers: [registry],
});

export const queueDepthGauge = new Gauge({
  name: "duality_backfill_queue_depth",
  help: "Current backfill queue depth by queue and state",
  labelNames: ["queue", "state"] as const,
  registers: [registry],
});

export const backfillFailuresCounter = new Counter({
  name: "duality_backfill_failures_total",
  help: "Backfill failures by endpoint",
  labelNames: ["endpoint"] as const,
  registers: [registry],
});

export const backfillDurationMs = new Histogram({
  name: "duality_backfill_duration_ms",
  help: "Backfill duration in ms by endpoint",
  labelNames: ["endpoint"] as const,
  buckets: [100, 500, 1000, 5000, 15000, 30000, 60000, 120000],
  registers: [registry],
});

