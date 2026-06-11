import { z } from "zod";
import { Registrar, textResult, summarize } from "./registry.js";
import { buildBody, extraField, fullField } from "./shared.js";

// Internal-service tools (verifier replay, ingestor /collect/*, sandbox execute).
// Only registered when DUALITY_ENABLE_INTERNAL=true. These are the endpoints the
// API normally calls service-to-service.
export function registerInternalTools(r: Registrar): void {
  const ver = () => r.clients.verifier;
  const ing = () => r.clients.ingestor;
  const sb = () => r.clients.sandbox;

  // ---- Verifier (trust boundary) ----
  r.tool("verifier", "verify_passport_direct",
    "Direct verifier call: canonical replay + signed result. The API uses this behind publish_passport.",
    { runId: z.string().optional(), spec: z.record(z.any()).optional(), extra: extraField },
    async (a) => textResult(await ver().post("/verify/passport", buildBody(a))));

  // ---- Ingestor /collect/* (market-data foundation) ----
  r.tool("ingestor", "collect_backfill_kline", "Backfill paginated klines into the candles hypertable.",
    { category: z.string(), symbol: z.string(), interval: z.string(), start_ms: z.number().int(), end_ms: z.number().int(), data_version: z.string().optional(), extra: extraField },
    async (a) => textResult(await ing().post("/collect/backfill/kline", buildBody(a))));
  r.tool("ingestor", "collect_backfill_mark_kline", "Backfill mark-price candles (mark_candles).",
    { category: z.string(), symbol: z.string(), interval: z.string(), start_ms: z.number().int(), end_ms: z.number().int(), extra: extraField },
    async (a) => textResult(await ing().post("/collect/backfill/mark-kline", buildBody(a))));
  r.tool("ingestor", "collect_backfill_index_kline", "Backfill index-price candles (index_candles).",
    { category: z.string(), symbol: z.string(), interval: z.string(), start_ms: z.number().int(), end_ms: z.number().int(), extra: extraField },
    async (a) => textResult(await ing().post("/collect/backfill/index-kline", buildBody(a))));
  r.tool("ingestor", "collect_backfill_l2_archive",
    "Normalize Bybit-archive depth-500 snapshots + trades (and optional Tardis L2) into l2_snapshots/trades with a historical data_version. Enables historical L2/queue replay.",
    { category: z.string(), symbol: z.string(), start_ms: z.number().int(), end_ms: z.number().int(), source: z.string().optional(), extra: extraField },
    async (a) => textResult(await ing().post("/collect/backfill/l2-archive", buildBody(a))));
  r.tool("ingestor", "collect_funding", "Backfill funding-rate rows.",
    { category: z.string(), symbol: z.string(), start_ms: z.number().int().optional(), end_ms: z.number().int().optional(), extra: extraField },
    async (a) => textResult(await ing().post("/collect/funding", buildBody(a))));
  r.tool("ingestor", "collect_oi", "Backfill open-interest series.",
    { category: z.string(), symbol: z.string(), extra: extraField },
    async (a) => textResult(await ing().post("/collect/oi", buildBody(a))));
  r.tool("ingestor", "collect_long_short", "Backfill long/short ratio series.",
    { category: z.string(), symbol: z.string(), extra: extraField },
    async (a) => textResult(await ing().post("/collect/long-short", buildBody(a))));
  r.tool("ingestor", "collect_instruments", "Fetch instrument snapshots (filters, settleCoin, risk-limit tiers) for a category.",
    { category: z.string().describe("linear | spot"), extra: extraField },
    async (a) => textResult(await ing().post(`/collect/instruments/${encodeURIComponent(String(a.category))}`, buildBody(a, ["full", "extra", "category"]))));
  r.tool("ingestor", "collect_live_subscribe", "Subscribe symbols to the ingestor live poller.",
    { items: z.array(z.record(z.any())), extra: extraField },
    async (a) => textResult(await ing().post("/collect/live/subscribe", buildBody(a))));
  r.tool("ingestor", "collect_live_unsubscribe", "Unsubscribe symbols from the live poller.",
    { items: z.array(z.record(z.any())), extra: extraField },
    async (a) => textResult(await ing().post("/collect/live/unsubscribe", buildBody(a))));
  r.tool("ingestor", "collect_live_poll", "Force a live-poll refresh in the ingestor.", {},
    async () => textResult(await ing().post("/collect/live/poll", {})));
  r.tool("ingestor", "collect_record_l2", "Toggle realtime L2 recording at the ingestor.",
    { items: z.array(z.record(z.any())), enable: z.boolean(), manual: z.boolean().optional() },
    async (a) => textResult(await ing().post("/collect/realtime/record-l2", buildBody(a))));
  r.tool("ingestor", "collect_record_trades", "Toggle realtime trade recording (seeds recent REST trades).",
    { items: z.array(z.record(z.any())), enable: z.boolean(), manual: z.boolean().optional() },
    async (a) => textResult(await ing().post("/collect/realtime/record-trades", buildBody(a))));
  r.tool("ingestor", "collect_ws_subscribe", "Subscribe the raw WS collector to symbols.",
    { items: z.array(z.record(z.any())).optional(), symbols: z.array(z.string()).optional(), extra: extraField },
    async (a) => textResult(await ing().post("/collect/ws/subscribe", buildBody(a))));
  r.tool("ingestor", "collect_live_prices", "Ingestor view of live prices.", {},
    async () => textResult(await ing().get("/collect/live/prices")));
  r.tool("ingestor", "collect_realtime_status", "Ingestor realtime collector status.", {},
    async () => textResult(await ing().get("/collect/realtime/status")));
  r.tool("ingestor", "collect_ws_symbols", "Symbols the WS collector is subscribed to.", {},
    async () => textResult(await ing().get("/collect/ws/symbols")));
  r.tool("ingestor", "collect_xstocks_instruments", "Ingestor live xStock instruments.", { full: fullField },
    async (a) => textResult(summarize(await ing().get("/collect/xstocks/instruments"), Boolean(a.full))));

  // ---- Sandbox (deny-model untrusted Python) ----
  r.tool("sandbox", "sandbox_execute",
    "Execute untrusted Python in the deny-model sandbox (AST-scanned, no network/file/env, BLAS pinned, resource-limited).",
    { code: z.string(), input: z.record(z.any()).optional(), timeout_s: z.number().optional(), extra: extraField },
    async (a) => textResult(await sb().post("/sandbox/execute", buildBody(a))));
}
