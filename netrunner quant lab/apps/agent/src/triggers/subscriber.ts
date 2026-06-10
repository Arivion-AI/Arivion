import { Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import { evaluateEvent, type MarketEvent } from "./evaluator.js";
import { onMark } from "../positions/monitor.js";

// Phase 4/17 — production trigger + position-monitor wiring. Subscribe once per agent node to the
// Lab's canonical bar-close channel (rt:barclose:*) and the session channel (rt:session:*). Each bar
// close (a) evaluates armed owners' market-structure triggers and (b) feeds the close as a MARK to the
// position monitor so open positions are checked against their exit policy in (near) real time.
// Best-effort and fully defensive: a malformed event or a Redis hiccup must never crash the agent (the
// deterministic paths used by tests are POST /api/copilot/triggers/evaluate and /positions/tick).

let client: Redis | null = null;

export function startTriggerSubscriber(): void {
  if (config.globalKillSwitch) {
    logger.info("trigger subscriber not started (global kill switch on)");
    return;
  }
  try {
    client = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    client.on("error", (e: Error) => logger.warn("trigger subscriber redis error", { message: e.message }));
    client.connect().then(() => {
      client!.psubscribe("rt:barclose:*", "rt:session:*", (err?: Error | null) => {
        if (err) logger.warn("psubscribe failed", { message: err.message });
        else logger.info("trigger subscriber listening", { channels: ["rt:barclose:*", "rt:session:*"] });
      });
      client!.on("pmessage", (pattern: string, channel: string, message: string) => {
        if (pattern === "rt:session:*") {
          void onSession(channel, message).catch((e) => logger.warn("session handler error", { message: (e as Error).message }));
        } else {
          void onBarClose(channel, message).catch((e) => logger.warn("barclose handler error", { message: (e as Error).message }));
        }
      });
    }).catch((e: Error) => logger.warn("trigger subscriber connect failed (non-fatal)", { message: e.message }));
  } catch (e) {
    logger.warn("trigger subscriber init failed (non-fatal)", { message: (e as Error).message });
  }
}

async function onBarClose(channel: string, message: string): Promise<void> {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(message); } catch { return; }
  const symbol = String(payload.symbol ?? channel.split(":").pop() ?? "");
  if (!symbol) return;
  const ev: MarketEvent = {
    symbol,
    category: (payload.category as MarketEvent["category"]) ?? "linear",
    close: payload.close != null ? Number(payload.close) : undefined,
    volume: payload.volume != null ? Number(payload.volume) : undefined,
    regime: payload.regime as string | undefined,
    prev_regime: payload.prev_regime as string | undefined,
    funding_rate: payload.funding_rate != null ? Number(payload.funding_rate) : undefined,
    vol_pct: payload.vol_pct != null ? Number(payload.vol_pct) : undefined,
    median_vol_pct: payload.median_vol_pct != null ? Number(payload.median_vol_pct) : undefined,
    bar_ts: payload.ts != null ? Number(payload.ts) : undefined,
  };
  // Fan out to every owner with at least one armed trigger.
  const owners = (await db.query(`SELECT DISTINCT owner_id FROM agent_trigger_config WHERE armed=true`)).rows as Array<{ owner_id: string }>;
  for (const o of owners) {
    await evaluateEvent(Number(o.owner_id), ev).catch((e) => logger.warn("evaluateEvent error", { ownerId: o.owner_id, message: (e as Error).message }));
  }
  // Feed the bar close as a MARK to the position monitor (cross-owner: it sweeps open positions on
  // this symbol). This is the always-on lifecycle loop that reacts to PnL in (near) real time.
  if (ev.close != null && Number.isFinite(ev.close)) {
    await onMark(symbol, Number(ev.close), ev.bar_ts ?? Date.now()).catch((e) => logger.warn("onMark error", { symbol, message: (e as Error).message }));
  }
}

// A session update (rt:session:*) carries a per-session mark/PnL. Use its mark to drive the monitor.
async function onSession(channel: string, message: string): Promise<void> {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(message); } catch { return; }
  const symbol = String(payload.symbol ?? channel.split(":").pop() ?? "");
  const mark = payload.mark != null ? Number(payload.mark) : payload.price != null ? Number(payload.price) : payload.close != null ? Number(payload.close) : NaN;
  if (!symbol || !Number.isFinite(mark)) return;
  await onMark(symbol, mark).catch((e) => logger.warn("session onMark error", { symbol, message: (e as Error).message }));
}

export async function stopTriggerSubscriber(): Promise<void> {
  if (client) { await client.quit().catch(() => {}); client = null; }
}
