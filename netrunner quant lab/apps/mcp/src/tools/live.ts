import { z } from "zod";
import { Registrar, textResult, summarize } from "./registry.js";
import { buildBody, dec, extraField, fullField } from "./shared.js";
import { collectStream } from "../util/sse.js";

// Paper (legacy), live-paper sessions, realtime, streaming, verify, leaderboard, marketplace.
export function registerLiveTools(r: Registrar): void {
  const api = () => r.clients.api;
  const ctx = () => r.ctx();

  // ---- Legacy tick sessions (§15A) ----
  r.tool("paper", "create_paper_account", "Create a legacy paper account.",
    { accountId: z.string(), startingBalance: dec.optional(), quoteCurrency: z.string().optional() },
    async (a) => textResult(await api().post("/api/paper/accounts", buildBody(a), ctx())));
  r.tool("paper", "create_paper_session", "Create a legacy paper session (staleness-gated tick loop).",
    { sessionId: z.string(), accountId: z.string(), strategyVersionId: z.string(), symbol: z.string().optional(), maxDataAgeMs: z.number().int().optional(), requiredFreshTicks: z.number().int().optional() },
    async (a) => textResult(await api().post("/api/paper/sessions", buildBody(a), ctx())));
  r.tool("paper", "paper_tick", "Advance a legacy paper session one tick.", { id: z.string() },
    async (a) => textResult(await api().post(`/api/paper/sessions/${encodeURIComponent(String(a.id))}/tick`, {}, ctx())));
  r.tool("paper", "paper_rebuild", "Rebuild a legacy session's hot state from its event log.", { id: z.string() },
    async (a) => textResult(await api().post(`/api/paper/sessions/${encodeURIComponent(String(a.id))}/rebuild`, {}, ctx())));
  r.tool("paper", "paper_stop", "Stop a legacy paper session.", { id: z.string() },
    async (a) => textResult(await api().post(`/api/paper/sessions/${encodeURIComponent(String(a.id))}/stop`, {}, ctx())));
  r.tool("paper", "get_paper_session", "Fetch a legacy paper session.", { id: z.string() },
    async (a) => textResult(await api().get(`/api/paper/sessions/${encodeURIComponent(String(a.id))}`, undefined, ctx())));

  // ---- Persistent live-paper (§15C) ----
  r.tool("livepaper", "start_live_paper",
    "Start a persistent forward live-paper session (auto-backfills ~3h warmup + subscribes the realtime feed). live_return starts at 0% and grows from real forward bars.",
    { strategyId: z.string(), symbol: z.string(), category: z.string().optional(), params: z.record(z.any()).optional(), startingEquity: dec.optional(), risk: z.record(z.any()).optional(), executionFidelity: z.enum(["bar_based", "l2_sweep", "l2_queue"]).optional(), sessionId: z.string().optional(), extra: extraField },
    async (a) => textResult(await api().post("/api/live-paper/start", buildBody(a), ctx())));
  r.tool("livepaper", "list_live_paper_sessions", "List this owner's live-paper sessions + status.", {},
    async () => textResult(await api().get("/api/live-paper/sessions", undefined, ctx())));
  r.tool("livepaper", "stop_live_paper", "Stop a live-paper session.", { id: z.string() },
    async (a) => textResult(await api().post(`/api/live-paper/stop/${encodeURIComponent(String(a.id))}`, {}, ctx())));

  // ---- Persistent MULTI-ASSET (portfolio) paper sessions ----
  r.tool("multiasset", "start_multiasset_paper",
    "Start a persistent forward MULTI-ASSET (portfolio) paper session. Runs a basket of legs as one book with weighting + rebalancing; backfills warmup + subscribes each leg's feed. legs=[{symbol,asset_class,category,target_weight,leverage,allow_short}].",
    { legs: z.array(z.record(z.any())).describe("[{symbol,asset_class,category,target_weight,leverage,allow_short}]"), weighting: z.enum(["fixed", "equal", "inverse_vol", "risk_parity", "momentum"]).optional(), totalEquity: dec.optional(), intervalMinutes: z.number().int().optional(), risk: z.record(z.any()).optional(), rebalanceThreshold: dec.optional(), lookbackBars: z.number().int().optional(), topN: z.number().int().optional(), sessionId: z.string().optional(), extra: extraField },
    async (a) => textResult(await api().post("/api/live-portfolio/start", buildBody(a), ctx())));
  r.tool("multiasset", "list_multiasset_paper_sessions", "List this owner's multi-asset paper sessions + status.", {},
    async () => textResult(await api().get("/api/live-portfolio/sessions", undefined, ctx())));
  r.tool("multiasset", "stop_multiasset_paper", "Stop a multi-asset paper session.", { id: z.string() },
    async (a) => textResult(await api().post(`/api/live-portfolio/stop/${encodeURIComponent(String(a.id))}`, {}, ctx())));

  // ---- Realtime / live data ----
  r.tool("realtime", "live_subscribe", "Subscribe symbols to the realtime feed.",
    { items: z.array(z.record(z.any())).describe("[{symbol,category,interval}]") },
    async (a) => textResult(await api().post("/api/live/subscribe", buildBody(a), ctx())));
  r.tool("realtime", "live_prices", "Current live prices + freshness (auto-polls if stale).", {},
    async () => textResult(await api().get("/api/live/prices", undefined, ctx())));
  r.tool("realtime", "live_poll", "Force a REST live-poll refresh.", {},
    async () => textResult(await api().post("/api/live/poll", {}, ctx())));
  r.tool("realtime", "record_l2", "Enable/disable demand-driven L2 snapshot recording (needed for l2_sweep/l2_queue).",
    { items: z.array(z.record(z.any())).describe("[{symbol,category}]"), enable: z.boolean() },
    async (a) => textResult(await api().post("/api/live/record-l2", buildBody(a), ctx())));
  r.tool("realtime", "record_trades", "Enable/disable demand-driven public-trade recording (needed for l2_queue through-volume).",
    { items: z.array(z.record(z.any())), enable: z.boolean() },
    async (a) => textResult(await api().post("/api/live/record-trades", buildBody(a), ctx())));
  r.tool("realtime", "execution_coverage", "Per-symbol recording + execution_fidelity_available.", {},
    async () => textResult(await api().get("/api/execution/coverage", undefined, ctx())));
  r.tool("realtime", "realtime_status", "Raw WS collector stats + per-symbol recording state.", {},
    async () => textResult(await api().get("/api/realtime/status", undefined, ctx())));

  r.tool("realtime", "stream_snapshot",
    "Open the SSE stream briefly and collect a batch of live events (prices/barclose/session). For continuous push, subscribe the duality://live/* resources.",
    { topics: z.string().optional().describe("comma list: prices,bars,sessions"), symbols: z.string().optional().describe("comma list, e.g. BTCUSDT,AAPLXUSDT"), maxEvents: z.number().int().optional(), timeoutMs: z.number().int().optional() },
    async (a) => {
      const token = await r.auth.getToken(ctx());
      const events = await collectStream({
        baseUrl: r.cfg.apiUrl,
        token,
        topics: a.topics as string | undefined,
        symbols: a.symbols as string | undefined,
        maxEvents: (a.maxEvents as number | undefined) ?? 10,
        timeoutMs: (a.timeoutMs as number | undefined) ?? 8000,
      });
      return textResult({ count: events.length, events });
    });

  // ---- Verify / leaderboard / marketplace ----
  r.tool("market", "publish_passport",
    "Publish a run for verification -> signed tier + official score. Verifier re-runs canonical replay (client PnL ignored).",
    { runId: z.string(), localRunSummary: z.record(z.any()).optional(), cohort: z.array(z.record(z.any())).optional(), requestVerification: z.boolean().optional(), requestedTier: z.enum(["BACKTEST_VERIFIED", "LIVE_PAPER_VERIFIED"]).optional(), strategyHash: z.string().optional(), dataSnapshotId: z.string().optional(), extra: extraField },
    async (a) => textResult(await api().post("/api/passports/publish", buildBody(a), ctx())));
  r.tool("market", "get_leaderboard", "Verified-tier leaderboard.", { tier: z.string().optional() },
    async (a) => textResult(await api().get("/api/leaderboard", buildBody(a), ctx())));
  r.tool("market", "marketplace_publish", "Publish a bot card to the marketplace.",
    { botSpecId: z.string(), title: z.string().optional(), resultTier: z.string().optional(), extra: extraField },
    async (a) => textResult(await api().post("/api/bots/marketplace/publish", buildBody(a), ctx())));
  r.tool("market", "list_marketplace", "Browse marketplace cards.", { tier: z.string().optional(), full: fullField },
    async (a) => textResult(summarize(await api().get("/api/bots/marketplace", buildBody(a, ["full"]), ctx()), Boolean(a.full))));
  r.tool("market", "marketplace_fork", "Fork a marketplace card into your own spec.", { cardId: z.string() },
    async (a) => textResult(await api().post(`/api/bots/marketplace/${encodeURIComponent(String(a.cardId))}/fork`, {}, ctx())));
}
