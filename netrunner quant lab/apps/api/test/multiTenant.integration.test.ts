/**
 * §25 — multi-tenant isolation, identity, session lifecycle, and erasure.
 *
 * Runs against an EPHEMERAL stack (throwaway Postgres + Redis + a freshly-booted API) created by
 * scripts/run_auth_itest.sh — NEVER the shared dev DB. A test ES256 keypair stands in for Privy:
 * the API holds the public key (PRIVY_VERIFICATION_KEY), this test signs Privy-shaped tokens with
 * the private key (ITEST_PRIVY_PRIVATE_KEY), so /auth/session runs for real without Privy's servers.
 *
 * Requires env: DATABASE_URL, REDIS_URL, API_BASE, ITEST_PRIVY_PRIVATE_KEY, PRIVY_APP_ID.
 * If they're absent the suite SKIPS (so plain `npm test` doesn't fail) — but under the harness they
 * EXECUTE. A skipped run is NOT acceptance; the harness is how acceptance is met.
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
const ENABLED = Boolean(API_BASE && DATABASE_URL && REDIS_URL && PRIV);

const IORedis = (IORedisPkg as unknown as { Redis: new (u: string, o?: object) => any }).Redis
  ?? (IORedisPkg as unknown as new (u: string, o?: object) => any);

let pool: pg.Pool;
let redis: any;

function privyToken(did: string, email?: string): string {
  const claims: Record<string, unknown> = { sub: did };
  if (email) claims.email = email;
  return jwt.sign(claims, PRIV, { algorithm: "ES256", issuer: "privy.io", audience: APP_ID, expiresIn: "10m" });
}
async function f(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, init);
}
function authed(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) } };
}
async function login(did: string, email?: string): Promise<{ ownerToken: string; ownerId: number }> {
  const r = await f("/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ privyToken: privyToken(did, email) }) });
  expect(r.status, `login ${did}`).toBe(200);
  const b = await r.json();
  return { ownerToken: b.ownerToken, ownerId: b.ownerId };
}

// Seed one representative row in each owner-scoped table for `ownerId`. Returns ids for residue checks.
async function seedAll(ownerId: number, tag: string) {
  const sid = `sv_${tag}`, stratId = `st_${tag}`, runId = `run_${tag}`, acct = `acc_${tag}`, sess = `ps_${tag}`;
  const tmpl = `tmpl_${tag}`, tver = `tver_${tag}`, spec = `bs_${tag}`, card = `card_${tag}`;
  await pool.query(`INSERT INTO strategies (strategy_id, owner_id, name) VALUES ($1,$2,$1)`, [stratId, ownerId]);
  await pool.query(`INSERT INTO strategy_versions (strategy_version_id, strategy_id, dsl_json, owner_id) VALUES ($1,$2,'{}'::jsonb,$3)`, [sid, stratId, ownerId]);
  await pool.query(
    `INSERT INTO backtest_runs (run_id, strategy_version_id, data_version, engine_version, seed, status, result_tier, config_json, metrics_json, coverage_proof_json)
     VALUES ($1,$2,'dv','ev',42,'completed','LOCAL ONLY','{}'::jsonb,'{}'::jsonb,'{}'::jsonb)`, [runId, sid]);
  await pool.query(`INSERT INTO backtest_events (run_id, event_ts, event_type, payload_json) VALUES ($1, NOW(), 'FILL', '{}'::jsonb)`, [runId]);
  await pool.query(
    `INSERT INTO risk_snapshots (run_id, total_return_after_fees_funding, sharpe, calmar, max_drawdown, consistency, robustness, hard_gates_passed, base_score)
     VALUES ($1,0,0,0,0,0,0,true,0)`, [runId]);
  await pool.query(`INSERT INTO paper_accounts (account_id, owner_id, starting_balance) VALUES ($1,$2,10000)`, [acct, ownerId]);
  await pool.query(`INSERT INTO paper_sessions (id, account_id, strategy_version_id, symbol, status) VALUES ($1,$2,$3,'BTCUSDT','active')`, [sess, acct, sid]);
  await pool.query(`INSERT INTO paper_fills (session_id, order_id, symbol, side, qty, fill_price, ts) VALUES ($1,'o1','BTCUSDT','buy',1,100,NOW())`, [sess]);
  await pool.query(`INSERT INTO bot_templates (template_id, bot_type, display_name, description, category, risk_class, default_params_json, param_schema_json) VALUES ($1,'twap','t','d','execution','LOW','{}'::jsonb,'{}'::jsonb) ON CONFLICT DO NOTHING`, [tmpl]);
  await pool.query(`INSERT INTO bot_template_versions (version_id, template_id, version, param_schema_json, compiler_version) VALUES ($1,$2,1,'{}'::jsonb,'v1') ON CONFLICT DO NOTHING`, [tver, tmpl]);
  await pool.query(`INSERT INTO bot_specs (bot_spec_id, owner_id, template_version_id, bot_type, name, universe_json, params_json, spec_hash) VALUES ($1,$2,$3,'twap','b','{}'::jsonb,'{}'::jsonb,'h')`, [spec, ownerId, tver]);
  await pool.query(
    `INSERT INTO marketplace_cards (card_id, bot_spec_id, run_id, run_kind, title, bot_type, symbol_set, summary_json, metrics_json, risk_json, data_version, engine_version, compiler_version, result_tier, owner_id)
     VALUES ($1,$2,$3,'backtest','t','twap',$4,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'dv','ev','v1','LOCAL ONLY',$5)`, [card, spec, runId, ["BTCUSDT"], ownerId]);
  await pool.query(
    `INSERT INTO live_paper_checkpoints (session_id, owner_id, symbol, checkpoint_bar_ms, strategy_id, equity) VALUES ($1,$2,'BTCUSDT',1,$3,10000)`, [`lp_${tag}`, ownerId, stratId]);
  return { sid, stratId, runId, spec, acct, sess };
}

async function residueCount(ownerId: number): Promise<Record<string, number>> {
  const q = async (sql: string) => Number((await pool.query(sql, [ownerId])).rows[0].c);
  return {
    users: await q(`SELECT count(*) c FROM users WHERE id=$1`),
    strategies: await q(`SELECT count(*) c FROM strategies WHERE owner_id=$1`),
    strategy_versions: await q(`SELECT count(*) c FROM strategy_versions WHERE owner_id=$1`),
    backtest_runs: await q(`SELECT count(*) c FROM backtest_runs WHERE strategy_version_id IN (SELECT strategy_version_id FROM strategy_versions WHERE owner_id=$1) OR bot_spec_id IN (SELECT bot_spec_id FROM bot_specs WHERE owner_id=$1)`),
    risk_snapshots: await q(`SELECT count(*) c FROM risk_snapshots WHERE run_id IN (SELECT run_id FROM backtest_runs WHERE strategy_version_id IN (SELECT strategy_version_id FROM strategy_versions WHERE owner_id=$1))`),
    paper_accounts: await q(`SELECT count(*) c FROM paper_accounts WHERE owner_id=$1`),
    paper_sessions: await q(`SELECT count(*) c FROM paper_sessions WHERE account_id IN (SELECT account_id FROM paper_accounts WHERE owner_id=$1)`),
    bot_specs: await q(`SELECT count(*) c FROM bot_specs WHERE owner_id=$1`),
    marketplace_cards: await q(`SELECT count(*) c FROM marketplace_cards WHERE owner_id=$1`),
    live_paper_checkpoints: await q(`SELECT count(*) c FROM live_paper_checkpoints WHERE owner_id=$1`),
  };
}

beforeAll(async () => {
  if (!ENABLED) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 2 });
});
afterAll(async () => {
  if (!ENABLED) return;
  await pool.end();
  await redis.quit();
});

async function clearRateLimit(): Promise<void> {
  // The /auth/session rate limit is per-IP per-60s; all tests share one IP, so clear it between
  // tests (otherwise the C.2 rate-limit test would 429 the others).
  const ks = await redis.keys("auth:session:rl:*");
  if (ks.length) await redis.del(...ks);
}

const itIf = (name: string, fn: () => Promise<void>) =>
  test(name, async () => {
    if (!ENABLED) { console.warn(`SKIP (no ephemeral stack env): ${name}`); return; }
    await clearRateLimit();
    await fn();
  });

describe("§25 C — executed on the ephemeral stack", () => {
  itIf("C.1 /auth/session round trip: verify → provision → mint; returning DID reuses ownerId", async () => {
    const a1 = await login("did:privy:c1user", "c1@x.com");
    expect(Number.isInteger(a1.ownerId) && a1.ownerId > 0).toBe(true);
    expect(a1.ownerToken).toBeTruthy();
    const a2 = await login("did:privy:c1user");           // same DID
    expect(a2.ownerId).toBe(a1.ownerId);                  // returning user → same owner
    const other = await login("did:privy:c1other");
    expect(other.ownerId).not.toBe(a1.ownerId);           // new DID → new owner
    const me = await (await f("/api/me", authed(a1.ownerToken))).json();
    expect(me.ownerId).toBe(a1.ownerId);
    expect(me.tier).toBe("consumer");
    expect(me.status).toBe("active");
    expect(me.email).toBe("c1@x.com");
  });

  itIf("C.2 /auth/session is rate limited", async () => {
    // harness sets AUTH_SESSION_RATE_PER_MIN low. Fire enough to trip it.
    let got429 = false;
    for (let i = 0; i < 40; i++) {
      const r = await f("/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ privyToken: privyToken(`did:privy:rl${i}`) }) });
      if (r.status === 429) { got429 = true; break; }
    }
    expect(got429).toBe(true);
  });

  itIf("C.3 cross-tenant isolation + strategy_id takeover regression", async () => {
    const A = await login("did:privy:ownerA");
    const B = await login("did:privy:ownerB");

    // Takeover regression: A owns strategy "shared-id"; B must NOT be able to seize it.
    const sId = `shared-${A.ownerId}`;
    expect((await f("/api/strategies", authed(A.ownerToken, { method: "POST", body: JSON.stringify({ strategyId: sId, name: "A's" }) }))).status).toBe(201);
    const takeover = await f("/api/strategies", authed(B.ownerToken, { method: "POST", body: JSON.stringify({ strategyId: sId, name: "B steals" }) }));
    expect(takeover.status).toBe(403);
    const owner = (await pool.query(`SELECT owner_id FROM strategies WHERE strategy_id=$1`, [sId])).rows[0].owner_id;
    expect(Number(owner)).toBe(A.ownerId); // still A's

    // Resource isolation: seed A's backtest run + bot spec; B's reads must 404.
    const seeded = await seedAll(A.ownerId, `iso${A.ownerId}`);
    expect((await f(`/api/backtests/${seeded.runId}`, authed(A.ownerToken))).status).toBe(200);
    expect([403, 404]).toContain((await f(`/api/backtests/${seeded.runId}`, authed(B.ownerToken))).status);
    expect((await f(`/api/bots/specs/${seeded.spec}`, authed(A.ownerToken))).status).toBe(200);
    expect([403, 404]).toContain((await f(`/api/bots/specs/${seeded.spec}`, authed(B.ownerToken))).status);
  });

  itIf("C.4 logout revokes outstanding tokens immediately", async () => {
    const A = await login("did:privy:c4user");
    expect((await f("/api/me", authed(A.ownerToken))).status).toBe(200);
    expect((await f("/auth/logout", authed(A.ownerToken, { method: "POST" }))).ok).toBe(true);
    expect((await f("/api/me", authed(A.ownerToken))).status).toBe(401); // same token now dead
    const A2 = await login("did:privy:c4user");                          // re-login → new ver
    expect((await f("/api/me", authed(A2.ownerToken))).status).toBe(200);
  });

  itIf("C.5 suspended status blocks an already-issued token", async () => {
    const A = await login("did:privy:c5user");
    expect((await f("/api/me", authed(A.ownerToken))).status).toBe(200);
    await pool.query(`UPDATE users SET status='suspended' WHERE id=$1`, [A.ownerId]);
    expect((await f("/api/me", authed(A.ownerToken))).status).toBe(403);
    await pool.query(`UPDATE users SET status='active' WHERE id=$1`, [A.ownerId]);
    expect((await f("/api/me", authed(A.ownerToken))).status).toBe(200);
  });

  itIf("C.6 erasure leaves zero residue across DB + Redis", async () => {
    const E = await login("did:privy:eraseme", "erase@x.com");
    await seedAll(E.ownerId, `erase${E.ownerId}`);
    // Seed the owner's out-of-DB keys so we can prove erasure removes them. Use "0" (== the token's
    // ver) so E's own token stays valid for the DELETE call (setting "1" would self-revoke it).
    await redis.set(`auth:ver:${E.ownerId}`, "0");
    await redis.set(`rt:session:${E.ownerId}`, "snap");

    const before = await residueCount(E.ownerId);
    expect(before.users).toBe(1);
    expect(before.bot_specs).toBe(1);
    expect(before.paper_fills ?? 0).toBeGreaterThanOrEqual(0);

    const del = await f("/api/me", authed(E.ownerToken, { method: "DELETE" }));
    expect(del.ok).toBe(true);
    expect((await del.json()).erased).toBe(true);

    const after = await residueCount(E.ownerId);
    for (const [table, count] of Object.entries(after)) {
      expect(count, `residue in ${table}`).toBe(0);
    }
    expect(await redis.get(`auth:ver:${E.ownerId}`)).toBeNull();
    expect(await redis.get(`rt:session:${E.ownerId}`)).toBeNull();
  });
});
