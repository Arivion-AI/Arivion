/**
 * Chat spine integration tests (Phase 3 acceptance). GATED on RUN_DB_TESTS=1.
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter agent test
 * Spins up the real agent express app on an ephemeral port and drives it over HTTP, including SSE.
 * Uses the deterministic mock provider (priced) so a chat turn debits credit without API keys.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { createApp } from "../src/server.js";
import { db } from "../src/db.js";
import { ensureAccount } from "../src/llm-gateway/creditLedger.js";
import { updatePreferences } from "../src/llm-gateway/modelCatalog.js";

const ENABLED = process.env.RUN_DB_TESTS === "1";
const d = ENABLED ? describe : describe.skip;
const SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString("hex");
process.env.JWT_SECRET = SECRET;

let server: http.Server;
let base = "";

function tokenFor(ownerId: number): string {
  return jwt.sign({ sub: String(ownerId) }, SECRET, { algorithm: "HS256", expiresIn: "1h" });
}
async function api(path: string, ownerId: number, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(ownerId)}`, ...(init.headers || {}) },
  });
}
async function makeOwner(): Promise<number> {
  const r = await db.query<{ id: string }>(`INSERT INTO users (privy_did) VALUES ($1) RETURNING id`, [`did:test:${randomUUID()}`]);
  return Number(r.rows[0].id);
}
async function balance(ownerId: number): Promise<number> {
  const r = await db.query<{ b: string }>(`SELECT managed_balance_micro_usd AS b FROM agent_credit_accounts WHERE owner_id=$1`, [ownerId]);
  return r.rowCount ? Number(r.rows[0].b) : 0;
}
async function waitForRun(ownerId: number, runId: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`/api/copilot/runs/${runId}`, ownerId);
    if (r.ok) {
      const run = await r.json();
      if (run.status && run.status !== "running") return run.status;
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("run did not finish in time");
}

beforeAll(async () => {
  if (!ENABLED) return;
  await db.query(
    `INSERT INTO agent_model_price_book (provider, model, input_micro_usd_per_mtoken, output_micro_usd_per_mtoken, source, effective_from)
     VALUES ('mock','mock-priced',1000000,2000000,'TEST', now() - interval '1 day') ON CONFLICT (provider, model, effective_from) DO NOTHING`,
  );
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});
afterAll(async () => {
  if (!ENABLED) return;
  await new Promise<void>((r) => server.close(() => r()));
  await db.end();
});

d("chat spine", () => {
  test("missing token is rejected", async () => {
    const r = await fetch(`${base}/api/copilot/credits`);
    expect(r.status).toBe(401);
  });

  test("a chat turn replies and debits managed credit", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    await updatePreferences(owner, { default_provider: "mock", default_model: "mock-priced" });
    const before = await balance(owner);

    const t = await (await api("/api/copilot/threads", owner, { method: "POST", body: JSON.stringify({ title: "t" }) })).json();
    const m = await (await api(`/api/copilot/threads/${t.id}/message`, owner, { method: "POST", body: JSON.stringify({ content: "hello copilot" }) })).json();
    expect(m.runId).toBeTruthy();

    const status = await waitForRun(owner, m.runId);
    expect(status).toBe("completed");

    // assistant message persisted
    const msgs = await (await api(`/api/copilot/threads/${t.id}/messages`, owner)).json();
    const assistant = msgs.messages.find((x: { role: string }) => x.role === "assistant");
    expect(assistant.content).toContain("echo:");
    // credit debited
    expect(await balance(owner)).toBeLessThan(before);
    // step recorded with cost
    const steps = await (await api(`/api/copilot/runs/${m.runId}/steps`, owner)).json();
    expect(steps.steps.length).toBeGreaterThanOrEqual(1);
    expect(Number(steps.steps.at(-1).cost_micro_usd)).toBeGreaterThan(0);
  });

  test("zero credit blocks the turn with a clear message (run errors, no provider spend)", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    await updatePreferences(owner, { default_provider: "mock", default_model: "mock-priced" });
    await db.query(`UPDATE agent_credit_accounts SET managed_balance_micro_usd = 0 WHERE owner_id = $1`, [owner]);

    const t = await (await api("/api/copilot/threads", owner, { method: "POST", body: JSON.stringify({}) })).json();
    const m = await (await api(`/api/copilot/threads/${t.id}/message`, owner, { method: "POST", body: JSON.stringify({ content: "hi" }) })).json();
    const status = await waitForRun(owner, m.runId);
    expect(status).toBe("error");
    const steps = await (await api(`/api/copilot/runs/${m.runId}/steps`, owner)).json();
    const last = steps.steps.at(-1);
    expect(last.guardrail_decision).toBe("blocked");
    expect(JSON.stringify(last.result)).toContain("credits");
    expect(await balance(owner)).toBe(0);
  });

  test("SSE stream delivers the run trace and terminates", async () => {
    const owner = await makeOwner();
    await ensureAccount(owner);
    await updatePreferences(owner, { default_provider: "mock", default_model: "mock-priced" });
    const t = await (await api("/api/copilot/threads", owner, { method: "POST", body: JSON.stringify({}) })).json();
    const m = await (await api(`/api/copilot/threads/${t.id}/message`, owner, { method: "POST", body: JSON.stringify({ content: "stream please" }) })).json();

    // EventSource can't set headers — token via query, like the real proxy.
    const resp = await fetch(`${base}/api/copilot/stream?runId=${m.runId}&token=${tokenFor(owner)}`);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    const text = await readStreamToEnd(resp);
    expect(text).toContain("event: run.started");
    expect(text).toContain("event: message");
    expect(text).toContain("event: cost");
    expect(text).toContain("event: run.done");
  });

  test("cross-tenant: owner B cannot read owner A's run", async () => {
    const a = await makeOwner();
    const b = await makeOwner();
    await ensureAccount(a);
    await updatePreferences(a, { default_provider: "mock", default_model: "mock-priced" });
    const t = await (await api("/api/copilot/threads", a, { method: "POST", body: JSON.stringify({}) })).json();
    const m = await (await api(`/api/copilot/threads/${t.id}/message`, a, { method: "POST", body: JSON.stringify({ content: "private" }) })).json();
    await waitForRun(a, m.runId);
    const r = await api(`/api/copilot/runs/${m.runId}`, b);
    expect(r.status).toBe(404);
  });
});

async function readStreamToEnd(resp: Response, timeoutMs = 5000): Promise<string> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.includes("event: run.done") || out.includes("event: run.error")) break;
  }
  await reader.cancel().catch(() => {});
  return out;
}
