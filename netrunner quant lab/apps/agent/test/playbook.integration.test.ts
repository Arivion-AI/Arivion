/**
 * build_and_backtest_bot end-to-end (Phase 5/6 acceptance). GATED on RUN_DB_TESTS=1.
 * Uses a FAKE MCP client returning Lab-shaped results (honesty fields included) so the full
 * orchestration — guardrails, stop conditions, Truth Card, approval gating — is exercised without
 * the live Lab stack.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/db.js";
import { createThread, getSteps, getRun, createRun } from "../src/chat/store.js";
import { executePlan, type ToolCaller } from "../src/orchestrator/runner.js";
import { buildAndBacktestPlan } from "../src/playbooks/buildAndBacktest.js";
import { normalizeToolResult, type NormalizedToolResult } from "../src/mcp/normalize.js";

const ENABLED = process.env.RUN_DB_TESTS === "1";
const d = ENABLED ? describe : describe.skip;

async function makeOwner(): Promise<number> {
  const r = await db.query<{ id: string }>(`INSERT INTO users (privy_did) VALUES ($1) RETURNING id`, [`did:test:${randomUUID()}`]);
  return Number(r.rows[0].id);
}

// Build a fake MCP whose per-tool responses are configurable; records every call.
function fakeMcp(responses: Record<string, unknown>): ToolCaller & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async callTool(name: string): Promise<NormalizedToolResult> {
      calls.push(name);
      const payload = responses[name] ?? { ok: true };
      return normalizeToolResult({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    },
  };
}

const HEALTHY = {
  data_coverage: { coverage: 0.97, bars: 5000 },
  create_bot_spec: { bot_id: "bot_1", spec: { symbol: "BTCUSDT" } },
  validate_bot_spec: { valid: true, validation: { labels: ["OK"] } },
  bot_cockpit: { risk_class: "moderate", risk_score: 0.4, hard_blocks: [] },
  run_bot_backtest: {
    final_equity: 11000,
    result_tier: "unverified",
    execution_fidelity: "bar_based",
    fill_model: { fill_model_mode: "optimistic_maker", maker_fills_optimistic: true, liquidity_free_upper_bound: true },
    coverage_proof: { coverage: 0.97 },
    validation: { labels: ["LOOKAHEAD_SAFE"] },
  },
};

afterAll(async () => {
  if (ENABLED) await db.end();
});

d("build_and_backtest_bot", () => {
  test("L2 happy path: runs all steps and produces a complete Truth Card", async () => {
    const owner = await makeOwner();
    const thread = await createThread(owner);
    const plan = buildAndBacktestPlan({ ownerId: owner, threadId: thread.id, symbol: "BTCUSDT", category: "linear", autonomy: "L2" });
    const run = await createRun(owner, thread.id, "bt", plan.playbook_id, plan);
    const mcp = fakeMcp(HEALTHY);
    const outcome = await executePlan({ plan, mcp, runId: run.id, agentAction: "build BTC grid bot" });

    expect(outcome.status).toBe("completed");
    expect(mcp.calls).toEqual(["data_coverage", "create_bot_spec", "validate_bot_spec", "bot_cockpit", "get_candles", "run_bot_backtest"]);
    const card = outcome.truthCard!;
    expect(card.result_tier).toBe("unverified");
    expect(card.fill_model_mode).toContain("optimistic_maker");
    expect(card.maker_fills_optimistic).toBe("yes");
    expect(card.liquidity_free_upper_bound).toBe("yes");
    expect(card.execution_fidelity).toBe("bar_based");
    expect(card.risk_class).toBe("moderate");
    expect(card.hard_blocks).toBe("none");
    // every required field is present in the rendered card
    for (const label of ["Result tier", "Fill model mode", "Coverage", "Execution fidelity", "Risk class", "Hard blocks", "LLM cost"]) {
      expect(card.text).toContain(label);
    }
    const status = (await getRun(owner, run.id))!.status;
    expect(status).toBe("completed");
  });

  test("missing coverage stops BEFORE the backtest (routes to repair/block)", async () => {
    const owner = await makeOwner();
    const thread = await createThread(owner);
    const plan = buildAndBacktestPlan({ ownerId: owner, threadId: thread.id, symbol: "BTCUSDT", category: "linear", autonomy: "L2" });
    const run = await createRun(owner, thread.id, "bt", plan.playbook_id, plan);
    const mcp = fakeMcp({ ...HEALTHY, data_coverage: { coverage: 0.4 } });
    const outcome = await executePlan({ plan, mcp, runId: run.id });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toBe("COVERAGE_BELOW_FLOOR");
    expect(mcp.calls).toEqual(["data_coverage"]); // never reached create_bot_spec / backtest
  });

  test("risk hard block prevents the backtest", async () => {
    const owner = await makeOwner();
    const thread = await createThread(owner);
    const plan = buildAndBacktestPlan({ ownerId: owner, threadId: thread.id, symbol: "BTCUSDT", category: "linear", autonomy: "L2" });
    const run = await createRun(owner, thread.id, "bt", plan.playbook_id, plan);
    const mcp = fakeMcp({ ...HEALTHY, bot_cockpit: { risk_class: "ruinous", hard_blocks: ["RUIN_MARGIN_EXCEEDS_CAPITAL"] } });
    const outcome = await executePlan({ plan, mcp, runId: run.id });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toBe("RISK_HARD_BLOCK");
    expect(mcp.calls).not.toContain("run_bot_backtest");
    expect(outcome.truthCard!.hard_blocks).toContain("RUIN_MARGIN_EXCEEDS_CAPITAL");
  });

  test("L1 pauses for approval before create_bot_spec; no Lab call until approved", async () => {
    const owner = await makeOwner();
    const thread = await createThread(owner);
    const plan = buildAndBacktestPlan({ ownerId: owner, threadId: thread.id, symbol: "BTCUSDT", category: "linear", autonomy: "L1" });
    const run = await createRun(owner, thread.id, "bt", plan.playbook_id, plan);
    const mcp = fakeMcp(HEALTHY);
    const first = await executePlan({ plan, mcp, runId: run.id });
    expect(first.status).toBe("awaiting_approval");
    expect(first.pendingStepId).toBe("s2_spec");
    expect(mcp.calls).toEqual(["data_coverage"]); // coverage ran; spec did NOT

    // Approve s2 → runs spec/validate/risk/bars, then pauses again at s6 (backtest).
    const second = await executePlan({ plan, mcp, runId: run.id, approvals: new Set(["s2_spec"]) });
    expect(second.status).toBe("awaiting_approval");
    expect(second.pendingStepId).toBe("s6_backtest");
    expect(mcp.calls).toContain("create_bot_spec");
    expect(mcp.calls).not.toContain("run_bot_backtest");

    // Approve s6 → completes. (Coverage/spec NOT re-run — completed steps are skipped.)
    const third = await executePlan({ plan, mcp, runId: run.id, approvals: new Set(["s6_backtest"]) });
    expect(third.status).toBe("completed");
    expect(mcp.calls.filter((c) => c === "create_bot_spec")).toHaveLength(1); // not re-run on resume
    expect(mcp.calls).toContain("run_bot_backtest");
  });

  test("agent cannot call a tool outside the playbook allowlist", async () => {
    const owner = await makeOwner();
    const thread = await createThread(owner);
    const plan = buildAndBacktestPlan({ ownerId: owner, threadId: thread.id, symbol: "BTCUSDT", category: "linear", autonomy: "L2" });
    plan.steps[0].tool = "optimizer_sweep"; // tamper: not allowlisted here
    const run = await createRun(owner, thread.id, "bt", plan.playbook_id, plan);
    const mcp = fakeMcp(HEALTHY);
    const outcome = await executePlan({ plan, mcp, runId: run.id });
    expect(outcome.status).toBe("blocked");
    expect(outcome.violations!.some((v) => v.code === "TOOL_NOT_IN_ALLOWLIST")).toBe(true);
    expect(mcp.calls).toHaveLength(0); // nothing executed
  });
});
