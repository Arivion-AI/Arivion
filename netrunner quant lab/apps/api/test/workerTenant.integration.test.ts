/**
 * §25 Phase 1 — worker-in-the-loop tests (closes NOT-verified #2 erasure-quiesce + #3
 * worker-compute isolation). Runs only when the ephemeral stack includes the worker
 * (ITEST_WORKER=1, set by scripts/run_auth_itest.sh). Skips otherwise.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pg from "pg";
import IORedisPkg from "ioredis";
import jwt from "jsonwebtoken";

const API_BASE = process.env.API_BASE ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const REDIS_URL = process.env.REDIS_URL ?? "";
const PRIV = (process.env.ITEST_PRIVY_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
const APP_ID = process.env.PRIVY_APP_ID ?? "test-privy-app";
const ENABLED = Boolean(process.env.ITEST_WORKER && API_BASE && DATABASE_URL && REDIS_URL && PRIV);

const IORedis = (IORedisPkg as unknown as { Redis: new (u: string, o?: object) => any }).Redis
  ?? (IORedisPkg as unknown as new (u: string, o?: object) => any);

let pool: pg.Pool;
let redis: any;

function privyToken(did: string): string {
  return jwt.sign({ sub: did }, PRIV, { algorithm: "ES256", issuer: "privy.io", audience: APP_ID, expiresIn: "10m" });
}
async function f(path: string, init: RequestInit = {}): Promise<Response> { return fetch(`${API_BASE}${path}`, init); }
function authed(t: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}`, ...(init.headers || {}) } };
}
async function login(did: string): Promise<{ ownerToken: string; ownerId: number }> {
  const r = await f("/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ privyToken: privyToken(did) }) });
  expect(r.status, `login ${did}`).toBe(200);
  const b = await r.json();
  return { ownerToken: b.ownerToken, ownerId: b.ownerId };
}
async function clearRl() { const ks = await redis.keys("auth:session:rl:*"); if (ks.length) await redis.del(...ks); }

async function seedCandles(symbol: string, n = 12): Promise<void> {
  const base = Date.now() - n * 60_000;
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(base + i * 60_000).toISOString();
    const px = 100 + i;
    rows.push(`('${symbol}','linear','1','${ts}',${px},${px + 1},${px - 1},${px + 0.5},10,1000,'lp-itest','c${i}')`);
  }
  await pool.query(
    `INSERT INTO candles (symbol,category,interval,open_time,open,high,low,close,volume,turnover,data_version,checksum)
     VALUES ${rows.join(",")} ON CONFLICT (symbol,category,interval,open_time) DO NOTHING`
  );
}

/** Count rt:session:{ownerId} messages over `ms`. */
async function countTicks(ownerId: number, ms: number): Promise<number> {
  const sub = redis.duplicate();
  let n = 0;
  await sub.subscribe(`rt:session:${ownerId}`);
  sub.on("message", () => { n += 1; });
  await new Promise((r) => setTimeout(r, ms));
  await sub.unsubscribe();
  await sub.quit();
  return n;
}

beforeAll(async () => {
  if (!ENABLED) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 2 });
});
afterAll(async () => { if (!ENABLED) return; await pool.end(); await redis.quit(); });

const itIf = (name: string, fn: () => Promise<void>) =>
  test(name, { timeout: 60_000 }, async () => {
    if (!ENABLED) { console.warn(`SKIP (no worker in stack): ${name}`); return; }
    await clearRl();
    await fn();
  });

describe("§25 Phase 1 — worker-in-the-loop", () => {
  itIf("1.1 cross-tenant: B cannot read A's worker-created bot spec, nor stop A's live session", async () => {
    const A = await login("did:privy:wA");
    const B = await login("did:privy:wB");
    const sym = `WK${A.ownerId}USDT`;
    await seedCandles(sym);

    // A creates a bot spec through the REAL worker validate path.
    const create = await f("/api/bots/specs", authed(A.ownerToken, {
      method: "POST",
      body: JSON.stringify({ botType: "twap", name: "wkA", symbols: [sym], params: { symbol: sym, side: "buy", total_qty: "1.0", slice_count: 5, order_style: "market" } }),
    }));
    expect([200, 201], await create.clone().text()).toContain(create.status);
    const specId = (await create.json()).botSpecId as string;
    expect((await f(`/api/bots/specs/${specId}`, authed(A.ownerToken))).status).toBe(200);
    expect([403, 404]).toContain((await f(`/api/bots/specs/${specId}`, authed(B.ownerToken))).status);

    // A starts a live-paper session (worker-tracked, owned by A).
    const sid = `lp_wk_${A.ownerId}`;
    const start = await f("/api/live-paper/start", authed(A.ownerToken, {
      method: "POST",
      body: JSON.stringify({ sessionId: sid, strategyId: "trend_ema_cross", symbol: sym, startingEquity: "10000" }),
    }));
    expect(start.status, await start.clone().text()).toBe(200);

    // B cannot stop A's session, and cannot see it.
    const bStop = await f(`/api/live-paper/stop/${sid}`, authed(B.ownerToken, { method: "POST" }));
    expect(bStop.status).toBe(404);
    const bList = await (await f("/api/live-paper/sessions", authed(B.ownerToken))).json();
    const bSessions = (bList.sessions ?? []) as Array<{ session_id: string }>;
    expect(bSessions.find((s) => s.session_id === sid)).toBeUndefined();

    // A can stop their own session.
    expect((await f(`/api/live-paper/stop/${sid}`, authed(A.ownerToken, { method: "POST" }))).status).toBe(200);
  });

  itIf("1.2 erasure quiesces the running worker session (no ticks after) + zero residue", async () => {
    const E = await login("did:privy:wErase");
    const sym = `WKE${E.ownerId}USDT`;
    await seedCandles(sym);
    const sid = `lp_wke_${E.ownerId}`;
    const start = await f("/api/live-paper/start", authed(E.ownerToken, {
      method: "POST",
      body: JSON.stringify({ sessionId: sid, strategyId: "trend_ema_cross", symbol: sym, startingEquity: "10000" }),
    }));
    expect(start.status, await start.clone().text()).toBe(200);

    // It's live: the worker ticks (tick=1s) and publishes rt:session:{E}.
    const before = await countTicks(E.ownerId, 3000);
    expect(before, "session should be publishing ticks before erasure").toBeGreaterThan(0);

    // Erase.
    const del = await f("/api/me", authed(E.ownerToken, { method: "DELETE" }));
    expect(del.status, await del.clone().text()).toBe(200);

    // Quiesced: no further ticks after erasure (worker stop fired + row gone -> loop publishes nothing).
    const after = await countTicks(E.ownerId, 4000);
    expect(after, "no rt:session ticks after erasure").toBe(0);

    // And zero residue.
    const lpRows = Number((await pool.query(`SELECT count(*) c FROM live_paper_sessions WHERE owner_id=$1`, [E.ownerId])).rows[0].c);
    expect(lpRows).toBe(0);
    const usr = Number((await pool.query(`SELECT count(*) c FROM users WHERE id=$1`, [E.ownerId])).rows[0].c);
    expect(usr).toBe(0);
  });
});
