import { z } from "zod";
import { Registrar, textResult, summarize } from "./registry.js";
import { buildBody, fullField } from "./shared.js";

// Data, catalogs, regimes, backfill, xStocks.
export function registerDataTools(r: Registrar): void {
  const api = () => r.clients.api;
  const ctx = () => r.ctx();

  // ---- Coverage / health ----
  r.tool("data", "data_coverage",
    "Structured per-source coverage proof (candles/L2/trades/mark/index/funding/instrument/risk-limit) for a window.",
    { symbol: z.string(), category: z.string().optional(), interval: z.string().optional(), startTs: z.number().int().optional(), endTs: z.number().int().optional(), full: fullField },
    async (a) => textResult(summarize(await api().get("/api/data/coverage", buildBody(a, ["full"]), ctx()), Boolean(a.full))));

  r.tool("data", "data_health", "Per-symbol freshness/staleness status.", {},
    async () => textResult(await api().get("/api/data/health", undefined, ctx())));

  r.tool("data", "list_symbols", "Symbols known to the lab.", {},
    async () => textResult(await api().get("/api/symbols", undefined, ctx())));

  r.tool("data", "get_candles", "Recent OHLCV candles.",
    { symbol: z.string(), category: z.string().optional(), interval: z.string().optional(), limit: z.number().int().optional(), full: fullField },
    async (a) => textResult(summarize(await api().get("/api/candles", buildBody(a, ["full"]), ctx()), Boolean(a.full))));

  r.tool("data", "ensure_candles", "Ensure at least minBars candles exist for a symbol (triggers backfill if needed).",
    { symbol: z.string(), category: z.string().optional(), interval: z.string().optional(), minBars: z.number().int().optional() },
    async (a) => textResult(await api().post("/api/candles/ensure", buildBody(a), ctx())));

  r.tool("data", "find_data_gaps", "Report missing candle ranges for a symbol/interval window.",
    { symbol: z.string(), category: z.string().optional(), interval: z.string(), startTs: z.number().int(), endTs: z.number().int() },
    async (a) => textResult(await api().post("/api/data/gaps", buildBody(a), ctx())));

  // ---- Trades ----
  r.tool("data", "list_trades", "Recorded public trades for a symbol window.",
    { symbol: z.string(), category: z.string().optional(), startTs: z.number().int().optional(), endTs: z.number().int().optional(), full: fullField },
    async (a) => textResult(summarize(await api().get("/api/trades", buildBody(a, ["full"]), ctx()), Boolean(a.full))));

  r.tool("data", "trades_coverage", "Bucketed trade coverage_pct + missing ranges.",
    { symbol: z.string(), category: z.string().optional(), startTs: z.number().int().optional(), endTs: z.number().int().optional(), bucketMs: z.number().int().optional() },
    async (a) => textResult(await api().get("/api/trades/coverage", buildBody(a), ctx())));

  // ---- Regimes ----
  r.tool("data", "list_regimes", "Available market regimes (test scenarios).", {},
    async () => textResult(await api().get("/api/regimes", undefined, ctx())));

  r.tool("data", "get_regime_bars", "Bars for a regime.", { regimeId: z.string(), full: fullField },
    async (a) => textResult(summarize(await api().get(`/api/regimes/${encodeURIComponent(String(a.regimeId))}/bars`, undefined, ctx()), Boolean(a.full))));

  r.tool("data", "load_regime", "Trigger ingestor backfill to load a regime's data.", { regimeId: z.string() },
    async (a) => textResult(await api().post(`/api/regimes/${encodeURIComponent(String(a.regimeId))}/load`, {}, ctx())));

  // ---- Catalogs / registries (the discovery surface) ----
  r.tool("data", "list_templates", "Strategy templates (seed defaults).", {},
    async () => textResult(await api().get("/api/templates", undefined, ctx())));
  r.tool("data", "list_bot_templates", "Bot templates (seed defaults; params are fully custom).", {},
    async () => textResult(await api().get("/api/bots/templates", undefined, ctx())));
  r.tool("data", "get_strategy_registry", "The live strategy registry (the 6 algo strategies).", {},
    async () => textResult(await api().get("/api/strategies/registry", undefined, ctx())));
  r.tool("data", "list_portfolio_schemes", "Available portfolio weighting schemes.", {},
    async () => textResult(await api().get("/api/portfolio/schemes", undefined, ctx())));

  // ---- xStocks ----
  r.tool("data", "xstocks_catalog", "Tokenized-stock catalog (10 symbols).", {},
    async () => textResult(await api().get("/api/xstocks/catalog", undefined, ctx())));
  r.tool("data", "xstocks_session", "Current xStock market-session state.", { symbol: z.string().optional() },
    async (a) => textResult(await api().get("/api/xstocks/session", buildBody(a), ctx())));
  r.tool("data", "xstocks_instruments", "Live xStock instruments incl. real xstockMultiplier.", {},
    async () => textResult(await api().get("/api/xstocks/instruments", undefined, ctx())));

  // ---- Backfill (public API) ----
  r.tool("data", "backfill_job", "Enqueue a durable backfill job.",
    { endpoint: z.enum(["kline", "funding", "oi", "long-short", "instruments"]), category: z.string().optional(), symbol: z.string().optional(), interval: z.string().optional(), startMs: z.number().int().optional(), endMs: z.number().int().optional(), dataVersion: z.string().optional() },
    async (a) => textResult(await api().post("/api/backfill/jobs", buildBody(a), ctx())));
  r.tool("data", "backfill_queue", "Backfill queue stats + recent jobs.", {},
    async () => textResult(await api().get("/api/backfill/queue", undefined, ctx())));
  r.tool("data", "backfill_schedule_create", "Create/update a recurring backfill schedule.",
    { scheduleId: z.string().optional(), endpoint: z.enum(["kline", "funding", "oi", "long-short", "instruments"]), symbol: z.string(), category: z.string().optional(), interval: z.string().optional(), cadenceCron: z.string().optional(), lookbackMs: z.number().int().positive(), enabled: z.boolean().optional(), dataVersion: z.string().optional() },
    async (a) => textResult(await api().post("/api/backfill/schedules", buildBody(a), ctx())));
  r.tool("data", "backfill_schedules_list", "List backfill schedules.", {},
    async () => textResult(await api().get("/api/backfill/schedules", undefined, ctx())));
  r.tool("data", "backfill_schedules_run_due", "Enqueue all due schedules now.", {},
    async () => textResult(await api().post("/api/backfill/schedules/run-due", {}, ctx())));

  // ---- Concurrency ----
  r.tool("data", "concurrency_stats", "Worker concurrency/fairness guard stats.", {},
    async () => textResult(await api().get("/api/concurrency/stats", undefined, ctx())));
}
