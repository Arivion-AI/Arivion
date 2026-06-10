/**
 * LLM Gateway + managed-credit ledger integration tests (Phase 1 acceptance).
 *
 * Runs against a real Postgres with migration 0014 applied. GATED on RUN_DB_TESTS=1 so plain
 * `npm test` (no DB) stays green; under the harness, run with:
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter agent test
 * Uses the deterministic `mock` provider — no API keys, no network.
 *
 * Covers: welcome grant (once), reserve→debit, unused-reservation refund, insufficient-credit block
 * BEFORE provider call, concurrency (no overspend), idempotency (no double-debit), provider-timeout
 * estimated metering, kill-switch/Lab-429 refund (release), unknown managed model blocked, BYOK off,
 * cross-tenant ledger isolation.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/db.js";
import { llmGateway } from "../src/llm-gateway/index.js";
import { ensureAccount, getAccount, listLedger } from "../src/llm-gateway/creditLedger.js";
import { reserve, release } from "../src/llm-gateway/reservation.js";
import type { CompleteRequest } from "../src/llm-gateway/types.js";

const ENABLED = process.env.RUN_DB_TESTS === "1";
const d = ENABLED ? describe : describe.skip;

// A priced mock model so costs are non-zero and deterministic. Fixed effective_from in the past.
const PRICED_MODEL = "mock-priced";
const INPUT_RATE = 1_000_000; // $1.00 / Mtoken
const OUTPUT_RATE = 2_000_000; // $2.00 / Mtoken

async function makeOwner(): Promise<number> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (privy_did) VALUES ($1) RETURNING id`,
    [`did:test:${randomUUID()}`],
  );
  return Number(r.rows[0].id);
}

async function balance(ownerId: number): Promise<number> {
  const r = await db.query<{ b: string }>(
    `SELECT managed_balance_micro_usd AS b FROM agent_credit_accounts WHERE owner_id = $1`,
    [ownerId],
  );
  return r.rowCount ? Number(r.rows[0].b) : 0;
}

async function setBalance(ownerId: number, micro: number): Promise<void> {
  await db.query(`UPDATE agent_credit_accounts SET managed_balance_micro_usd = $2 WHERE owner_id = $1`, [ownerId, micro]);
}

function baseReq(ownerId: number, over: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    ownerId,
    purpose: "test",
    providerMode: "managed",
    provider: "mock",
    model: PRICED_MODEL,
    messages: [{ role: "user", content: "hello world this is a fixed prompt" }],
    maxTokens: 100,
    idempotencyKey: `idem_${randomUUID()}`,
    metadata: { mock: { outputTokens: 100 } }, // output == maxTokens ⇒ reserve == actual (deterministic)
    ...over,
  };
}

beforeAll(async () => {
  if (!ENABLED) return;
  await db.query(
    `INSERT INTO agent_model_price_book
       (provider, model, input_micro_usd_per_mtoken, output_micro_usd_per_mtoken, source, effective_from)
     VALUES ('mock', $1, $2, $3, 'TEST', now() - interval '1 day')
     ON CONFLICT (provider, model, effective_from) DO NOTHING`,
    [PRICED_MODEL, INPUT_RATE, OUTPUT_RATE],
  );
});

afterAll(async () => {
  if (ENABLED) await db.end();
});

d("welcome grant", () => {
  test("new owner gets exactly one $2 grant; ensureAccount is idempotent", async () => {
    const owner = await makeOwner();
    const a1 = await ensureAccount(owner);
    expect(a1.managed_balance_micro_usd).toBe(2_000_000);
    expect(a1.lifetime_grants_micro_usd).toBe(2_000_000);
    const a2 = await ensureAccount(owner); // second activation must not re-grant
    expect(a2.managed_balance_micro_usd).toBe(2_000_000);
    const grants = (await listLedger(owner, 50)).filter((e) => e.event_type === "grant");
    expect(grants).toHaveLength(1);
  });
});

d("reserve → debit → refund", () => {
  test("managed call debits exactly the actual cost", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    const before = await balance(owner);
    const res = await llmGateway.complete(baseReq(owner));
    expect(res.status).toBe("ok");
    expect(res.content).toContain("echo:");
    expect(res.meteringQuality).toBe("actual");
    const cost = res.cost.total_micro_usd;
    expect(cost).toBeGreaterThan(0);
    expect(await balance(owner)).toBe(before - cost);
    // usage event written
    const u = await db.query(`SELECT count(*)::int AS n FROM agent_llm_usage_events WHERE owner_id=$1 AND status='ok'`, [owner]);
    expect(u.rows[0].n).toBe(1);
  });

  test("unused reserved amount is refunded (debit == actual, not worst-case)", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    const before = await balance(owner);
    // maxTokens 4000 ⇒ big worst-case reserve, but mock emits only 10 output tokens ⇒ small actual.
    const res = await llmGateway.complete(baseReq(owner, { maxTokens: 4000, metadata: { mock: { outputTokens: 10 } } }));
    const cost = res.cost.total_micro_usd;
    const worst = res.estimatedCostMicroUsd;
    expect(worst).toBeGreaterThan(cost); // we reserved more than we spent
    expect(await balance(owner)).toBe(before - cost); // only actual was debited
    // ledger shows a reserve, a reserve_release, and a debit for this reservation
    const types = (await listLedger(owner, 50)).map((e) => e.event_type);
    expect(types).toContain("reserve");
    expect(types).toContain("reserve_release");
    expect(types).toContain("debit");
  });
});

d("insufficient credit", () => {
  test("blocks BEFORE the provider call and leaves balance untouched", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    await setBalance(owner, 50); // 50 micro-USD — below the worst-case hold for maxTokens 100
    await expect(llmGateway.complete(baseReq(owner))).rejects.toMatchObject({ code: "INSUFFICIENT_CREDIT" });
    expect(await balance(owner)).toBe(50); // unchanged
    const ok = await db.query(`SELECT count(*)::int AS n FROM agent_llm_usage_events WHERE owner_id=$1 AND status='ok'`, [owner]);
    expect(ok.rows[0].n).toBe(0); // provider never billed
  });

  test("reserve() rejects a hold larger than balance", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    await expect(
      reserve({ ownerId: owner, idempotencyKey: randomUUID(), provider: "mock", model: PRICED_MODEL, providerMode: "managed", reservedMicroUsd: 3_000_000 }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDIT" });
  });
});

d("concurrency", () => {
  test("concurrent calls cannot overspend the balance", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    // Probe one call's cost, then budget for exactly 3 calls.
    const probe = await llmGateway.complete(baseReq(owner));
    const cost = probe.cost.total_micro_usd;
    expect(cost).toBeGreaterThan(0);
    await setBalance(owner, cost * 3);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => llmGateway.complete(baseReq(owner))),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(ok).toBe(3); // exactly the budget, no more
    expect(rejected).toBe(7);
    const bal = await balance(owner);
    expect(bal).toBe(0); // spent exactly the budget
    expect(bal).toBeGreaterThanOrEqual(0); // never negative
  });
});

d("idempotency", () => {
  test("same idempotencyKey debits at most once", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    const req = baseReq(owner);
    const before = await balance(owner);
    const r1 = await llmGateway.complete(req);
    const afterFirst = await balance(owner);
    expect(afterFirst).toBe(before - r1.cost.total_micro_usd);
    const r2 = await llmGateway.complete(req); // replay
    expect(await balance(owner)).toBe(afterFirst); // no second debit
    expect(r2.status).toBe("ok");
    expect(r2.content).toBe(""); // replay does not re-execute the provider
    const debits = (await listLedger(owner, 50)).filter((e) => e.event_type === "debit");
    expect(debits).toHaveLength(1); // exactly one actual-spend debit
    const okEvents = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_llm_usage_events WHERE owner_id=$1`, [owner]);
    expect(okEvents.rows[0].n).toBe(1); // idempotent: one usage event, not two
  });
});

d("provider timeout", () => {
  test("unknown usage ⇒ estimated metering, still debits", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    const before = await balance(owner);
    const res = await llmGateway.complete(baseReq(owner, { metadata: { mock: { timeout: true } } }));
    expect(res.status).toBe("error");
    expect(res.errorCode).toBe("PROVIDER_TIMEOUT");
    expect(res.meteringQuality).toBe("estimated");
    expect(res.cost.total_micro_usd).toBeGreaterThan(0);
    expect(await balance(owner)).toBe(before - res.cost.total_micro_usd);
    const ev = await db.query(`SELECT metering_quality FROM agent_llm_usage_events WHERE owner_id=$1 ORDER BY id DESC LIMIT 1`, [owner]);
    expect(ev.rows[0].metering_quality).toBe("estimated");
  });
});

d("kill switch / Lab 429 refund", () => {
  test("release() refunds the whole reservation", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    const before = await balance(owner);
    const r = await reserve({ ownerId: owner, idempotencyKey: randomUUID(), provider: "mock", model: PRICED_MODEL, providerMode: "managed", reservedMicroUsd: 500_000 });
    expect(await balance(owner)).toBe(before - 500_000);
    await release(r.id, "KILL_SWITCH");
    expect(await balance(owner)).toBe(before); // fully restored
    const refunds = (await listLedger(owner, 50)).filter((e) => e.event_type === "refund");
    expect(refunds.length).toBeGreaterThanOrEqual(1);
  });
});

d("price governance + BYOK gate", () => {
  test("unknown managed model with no active price row is blocked", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    const before = await balance(owner);
    await expect(llmGateway.complete(baseReq(owner, { model: "no-such-model" }))).rejects.toMatchObject({ code: "NO_ACTIVE_PRICE" });
    expect(await balance(owner)).toBe(before);
  });

  test("BYOK is disabled in v1", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    await expect(llmGateway.complete(baseReq(owner, { providerMode: "byok" }))).rejects.toMatchObject({ code: "BYOK_DISABLED" });
  });

  test("non-allowlisted provider is rejected", async () => {
    const owner = await makeOwner();
    await expect(llmGateway.complete(baseReq(owner, { provider: "evilcorp" }))).rejects.toMatchObject({ code: "PROVIDER_NOT_ALLOWLISTED" });
  });
});

d("cross-tenant isolation", () => {
  test("owner A's ledger never contains owner B's entries", async () => {
    const a = await makeOwner();
    const b = await makeOwner();
    await ensureAccount(a);
    await ensureAccount(b);
    await llmGateway.complete(baseReq(a));
    const bLedger = await listLedger(b, 50);
    expect(bLedger.every((e) => e.event_type === "grant")).toBe(true); // only B's own welcome grant
    const aAcct = await getAccount(a);
    const bAcct = await getAccount(b);
    expect(bAcct.managed_balance_micro_usd).toBe(2_000_000); // untouched by A's spend
    expect(aAcct.managed_balance_micro_usd).toBeLessThan(2_000_000);
  });
});
