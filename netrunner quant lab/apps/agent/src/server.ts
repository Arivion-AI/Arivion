import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { config, assertStartupSafety, USD_TO_MICRO } from "./config.js";
import { logger } from "./logger.js";
import { authMiddleware, requireOwnerId } from "./auth.js";
import {
  llmGateway, ensureAccount, getAccount, listLedger, recordGrant,
  getManagedCatalog, getPreferences, updatePreferences, getRunUsage, providerHealth,
  GatewayError,
} from "./llm-gateway/index.js";
import { db } from "./db.js";
import { createThread, listThreads, getThread, getMessages, getRun, getSteps, getRunEvents, getThreadEvents, listRunsForThread, createRun, getRunPlan, finishRun } from "./chat/store.js";
import { startChatTurn } from "./chat/engine.js";
import { publish } from "./chat/bus.js";
import { subscribe, replay, isTerminal } from "./chat/bus.js";
import { buildAndBacktestPlan, defaultBotFor } from "./playbooks/buildAndBacktest.js";
import { selectParamBucket } from "./learning/index.js";
import { runReflection, learnedReport } from "./learning/reflect.js";
import { executePlan } from "./orchestrator/runner.js";
import { parsePlan } from "./orchestrator/plan.js";
import { connectMcp } from "./mcp/client.js";
import { logger as log } from "./logger.js";
import { listMemory, getMemory, forgetMemory, patchMemory } from "./memory/store.js";
import { evaluateEvent, executeTriggerPlan, type MarketEvent } from "./triggers/evaluator.js";
import { getOwnerSettings, updateOwnerSettings, killSwitchState } from "./settings/index.js";
import { startTriggerSubscriber } from "./triggers/subscriber.js";
import { budgetState } from "./budget/index.js";
import { researchNote } from "./web/index.js";
import { promoteToGlobal, listGlobal, adminBudget, isAdmin } from "./global/index.js";
import { runScheduledReflection } from "./learning/reflect.js";
import { openManagedPosition } from "./positions/open.js";
import { listIntents, getIntent, listPositionEvents } from "./positions/store.js";
import { onMark, sweepOpenPositions, evaluateIntent, startPositionMonitor } from "./positions/monitor.js";
import { ExitPolicySchema } from "./positions/exitPolicy.js";
import { buildClosePositionPlan } from "./positions/plans.js";
import { runTradingDecision } from "./reasoning/pipeline.js";
import { getRiskState, setRiskState } from "./risk/index.js";
import { runMultiassetProposal, startMultiassetPaper, composeLegs, type MultiassetParams, type RiskAppetite, type AssetClass } from "./multiasset/setup.js";
import { scanMarket, marketOverview, type ScanSort } from "./market/scanner.js";
import { fetchTokenNews } from "./news/feeds.js";
import { screenTokens } from "./analysis/engine.js";

assertStartupSafety();

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/health", (_req, res) =>
    res.json({ ok: true, service: "duality-agent", byokEnabled: config.byokEnabled, providers: providerHealth() }),
  );

  app.use(authMiddleware);

  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) =>
    fn(req, res).catch((e) => {
      // If the handler already started the response (e.g. an SSE stream wrote headers, or a
      // handler partially responded), we cannot send a fresh status/body — doing so throws
      // ERR_HTTP_HEADERS_SENT, which previously escaped as an unhandled rejection and crashed the
      // whole agent for every owner. Log it and just close the socket instead.
      if (res.headersSent) {
        logger.error("route error after response started", { path: req.path, message: (e as Error).message });
        if (!res.writableEnded) res.end();
        return;
      }
      if (e instanceof GatewayError) {
        res.status(e.httpStatus).json({ error: e.code, message: e.message });
      } else if (e instanceof z.ZodError) {
        res.status(400).json({ error: "INVALID_REQUEST", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      } else {
        logger.error("route error", { path: req.path, message: (e as Error).message });
        res.status(500).json({ error: "INTERNAL", message: (e as Error).message });
      }
    });

  // --- Credits ------------------------------------------------------------------------------
  app.get("/api/copilot/credits", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const acct = await ensureAccount(ownerId);
    res.json({
      ownerId,
      currency: acct.currency,
      managedBalanceMicroUsd: acct.managed_balance_micro_usd,
      managedBalanceUsd: acct.managed_balance_micro_usd / USD_TO_MICRO,
      lifetimeGrantsMicroUsd: acct.lifetime_grants_micro_usd,
      lifetimeSpendMicroUsd: acct.lifetime_spend_micro_usd,
      status: acct.status,
    });
  }));

  app.get("/api/copilot/credits/ledger", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const limit = Number(req.query.limit ?? 50);
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    res.json({ entries: await listLedger(ownerId, limit, before) });
  }));

  // Admin-only grant. Admins are listed in COPILOT_ADMIN_OWNER_IDS.
  const grantSchema = z.object({
    targetOwnerId: z.number().int().positive(),
    amountUsd: z.number().positive(),
    reason: z.string().min(1),
    idempotencyKey: z.string().min(1),
  });
  app.post("/api/copilot/credits/grant", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    if (!config.adminOwnerIds.includes(ownerId)) {
      res.status(403).json({ error: "FORBIDDEN", message: "admin only" });
      return;
    }
    const body = grantSchema.parse(req.body);
    const acct = await recordGrant(
      body.targetOwnerId,
      Math.round(body.amountUsd * USD_TO_MICRO),
      body.reason,
      body.idempotencyKey,
    );
    res.json({ ok: true, targetOwnerId: body.targetOwnerId, managedBalanceMicroUsd: acct.managed_balance_micro_usd });
  }));

  // --- Model catalog / preferences ----------------------------------------------------------
  app.get("/api/copilot/model-catalog", wrap(async (_req, res) => {
    res.json({ models: await getManagedCatalog(), providers: providerHealth() });
  }));

  app.get("/api/copilot/model-preferences", wrap(async (req, res) => {
    res.json(await getPreferences(requireOwnerId(req)));
  }));

  const prefsSchema = z.object({
    default_provider_mode: z.enum(["managed", "byok"]).optional(),
    default_provider: z.string().optional(),
    default_model: z.string().optional(),
    planner_model: z.string().nullable().optional(),
    actor_model: z.string().nullable().optional(),
    triage_model: z.string().nullable().optional(),
    embedding_model: z.string().nullable().optional(),
    fallback_policy: z.enum(["ask", "managed_fallback", "fail"]).optional(),
  });
  app.put("/api/copilot/model-preferences", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const patch = prefsSchema.parse(req.body);
    // BYOK is disabled in v1 — reject switching the default to byok (correction #2).
    if (patch.default_provider_mode === "byok" && !config.byokEnabled) {
      res.status(403).json({ error: "BYOK_DISABLED", message: "BYOK is not enabled in this deployment" });
      return;
    }
    res.json(await updatePreferences(ownerId, patch as Record<string, string>));
  }));

  // --- Quote (estimate only) ----------------------------------------------------------------
  const quoteSchema = z.object({
    provider: z.string(),
    model: z.string(),
    messages: z.array(z.object({ role: z.string(), content: z.string(), name: z.string().optional() })),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
  });
  app.post("/api/copilot/llm/quote", wrap(async (req, res) => {
    requireOwnerId(req);
    const body = quoteSchema.parse(req.body);
    res.json(await llmGateway.quote(body as Parameters<typeof llmGateway.quote>[0]));
  }));

  // --- Usage --------------------------------------------------------------------------------
  app.get("/api/copilot/usage", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const r = await db.query(
      `SELECT id, thread_id, run_id, step_id, purpose, provider_mode, provider, model,
              input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
              provider_cost_micro_usd, duality_credit_debit_micro_usd, metering_quality,
              status, error_code, latency_ms, created_at
         FROM agent_llm_usage_events
        WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [ownerId, limit],
    );
    res.json({ events: r.rows });
  }));

  app.get("/api/copilot/usage/runs/:runId", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const runId = req.params.runId;
    const rollup = await getRunUsage(ownerId, runId);
    const r = await db.query(
      `SELECT step_id, purpose, provider, model, provider_cost_micro_usd,
              duality_credit_debit_micro_usd, metering_quality, status, created_at
         FROM agent_llm_usage_events
        WHERE owner_id = $1 AND run_id = $2 ORDER BY created_at ASC, id ASC`,
      [ownerId, runId],
    );
    res.json({ runId, rollup, events: r.rows });
  }));

  // --- Memory (Phase 3) ---------------------------------------------------------------------
  app.get("/api/copilot/memory", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const type = req.query.type === "episodes" || req.query.type === "semantic" || req.query.type === "policy"
      ? req.query.type : undefined;
    const query = typeof req.query.query === "string" ? req.query.query : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await listMemory(ownerId, { type, query, limit }));
  }));

  app.get("/api/copilot/memory/:id", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const table = req.query.table === "semantic" ? "semantic" : "episodes";
    const row = await getMemory(ownerId, table, Number(req.params.id));
    if (!row) { res.status(404).json({ error: "MEMORY_NOT_FOUND" }); return; }
    res.json(row);
  }));

  app.patch("/api/copilot/memory/:id", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const table = req.query.table === "semantic" ? "semantic" : "episodes";
    const ok = await patchMemory(ownerId, table, Number(req.params.id), {
      note: typeof req.body?.note === "string" ? req.body.note : undefined,
      confidence: typeof req.body?.confidence === "number" ? req.body.confidence : undefined,
    });
    res.status(ok ? 200 : 404).json({ updated: ok });
  }));

  app.delete("/api/copilot/memory/:id", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const table = req.query.table === "semantic" ? "semantic" : "episodes";
    const ok = await forgetMemory(ownerId, table, Number(req.params.id), typeof req.body?.reason === "string" ? req.body.reason : undefined);
    res.status(ok ? 200 : 404).json({ deleted: ok, logged_to: "agent_memory_deletions" });
  }));

  // --- Triggers + governance (Phase 4/5) ----------------------------------------------------
  app.get("/api/copilot/triggers", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const settings = await getOwnerSettings(ownerId);
    const cfg = (await db.query(`SELECT trigger_type, armed, threshold, cooldown_seconds, default_mode, quiet_hours FROM agent_trigger_config WHERE owner_id=$1 ORDER BY trigger_type`, [ownerId])).rows;
    const recent = (await db.query(`SELECT id, trigger_type, symbol, regime, mode, acted, confidence, woke_reason, ts FROM agent_trigger_events WHERE owner_id=$1 ORDER BY ts DESC LIMIT 20`, [ownerId])).rows;
    res.json({ autonomy_level: settings.autonomy_level, triggers: cfg, recent });
  }));

  const triggerCfgSchema = z.object({
    trigger_type: z.enum(["volatility_spike", "regime_flip", "funding_extreme", "volume_spike", "drawdown", "coverage"]),
    armed: z.boolean().optional(),
    threshold: z.number().optional(),
    cooldown_seconds: z.number().int().optional(),
    default_mode: z.enum(["shadow", "live"]).optional(),
    quiet_hours: z.array(z.number().int()).optional(),
  });
  app.put("/api/copilot/triggers", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const b = triggerCfgSchema.parse(req.body);
    const r = await db.query(
      `INSERT INTO agent_trigger_config (owner_id, trigger_type, armed, threshold, cooldown_seconds, default_mode, quiet_hours, updated_at)
       VALUES ($1,$2,COALESCE($3,false),$4,COALESCE($5,1800),COALESCE($6,'shadow'),COALESCE($7::int[],'{}'::int[]),now())
       ON CONFLICT (owner_id, trigger_type) DO UPDATE SET
         armed = COALESCE($3, agent_trigger_config.armed),
         threshold = COALESCE($4, agent_trigger_config.threshold),
         cooldown_seconds = COALESCE($5, agent_trigger_config.cooldown_seconds),
         default_mode = COALESCE($6, agent_trigger_config.default_mode),
         quiet_hours = COALESCE($7::int[], agent_trigger_config.quiet_hours),
         updated_at = now()
       RETURNING *`,
      [ownerId, b.trigger_type, b.armed ?? null, b.threshold ?? null, b.cooldown_seconds ?? null, b.default_mode ?? null, b.quiet_hours ?? null],
    );
    res.json(r.rows[0]);
  }));

  // Inject a synthetic market event and evaluate the owner's armed triggers (deterministic test +
  // the path the Redis bar-close subscriber drives in production).
  app.post("/api/copilot/triggers/evaluate", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    res.json(await evaluateEvent(ownerId, (req.body ?? {}) as MarketEvent));
  }));

  app.get("/api/copilot/shadow-mode", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const rows = (await db.query(
      `SELECT id, trigger_type, symbol, regime, signal, confidence, proposed_playbook, plan, woke_reason, ts
         FROM agent_trigger_events WHERE owner_id=$1 AND mode='shadow' AND acted=false ORDER BY ts DESC LIMIT 50`,
      [ownerId],
    )).rows;
    res.json({ triggers: rows });
  }));

  // Promote a shadow trigger to live: execute its stored read-only review plan, and (optionally)
  // default future triggers of this type to live.
  app.post("/api/copilot/shadow-mode", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const ownerToken = req.ownerToken!;
    const id = String(req.body?.trigger_event_id ?? "");
    const row = (await db.query(`SELECT * FROM agent_trigger_events WHERE id=$1 AND owner_id=$2`, [id, ownerId])).rows[0];
    if (!row) { res.status(404).json({ error: "TRIGGER_NOT_FOUND" }); return; }
    if (row.acted) { res.status(409).json({ error: "ALREADY_ACTED", run_id: row.run_id }); return; }
    const runId = await executeTriggerPlan(ownerId, id, row.plan, ownerToken);
    if (req.body?.future_live === true) {
      await db.query(`UPDATE agent_trigger_config SET default_mode='live', updated_at=now() WHERE owner_id=$1 AND trigger_type=$2`, [ownerId, row.trigger_type]);
    }
    res.json({ promoted: true, run_id: runId, future_triggers_mode: req.body?.future_live === true ? "live" : "unchanged" });
  }));

  app.get("/api/copilot/kill-switch", wrap(async (req, res) => {
    res.json(await killSwitchState(requireOwnerId(req)));
  }));

  // --- Budget (Phase 5) ---------------------------------------------------------------------
  app.get("/api/copilot/budget", wrap(async (req, res) => {
    res.json(await budgetState(requireOwnerId(req)));
  }));

  // --- Global / team insights (Phase 8) -----------------------------------------------------
  app.get("/api/copilot/global", wrap(async (_req, res) => {
    res.json(await listGlobal());
  }));
  app.post("/api/copilot/global/promote", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const statement = String(req.body?.statement ?? "");
    res.json(await promoteToGlobal(ownerId, statement));
  }));
  app.get("/api/copilot/admin/budget", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    if (!isAdmin(ownerId)) { res.status(403).json({ error: "ADMIN_ONLY" }); return; }
    res.json(await adminBudget());
  }));

  // --- Web research (Phase 7) — dual-LLM quarantine; notes only, never trading actions --------
  const researchSchema = z.object({ url: z.string().url().optional(), content: z.string().optional(), query: z.string().optional() });
  app.post("/api/copilot/research", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    res.json(await researchNote(ownerId, researchSchema.parse(req.body ?? {})));
  }));

  // --- Learning / reflection (Phase 6) ------------------------------------------------------
  app.post("/api/copilot/reflect", wrap(async (req, res) => {
    res.json(await runReflection(requireOwnerId(req)));
  }));
  app.get("/api/copilot/memory/report/learned", wrap(async (req, res) => {
    res.json(await learnedReport(requireOwnerId(req)));
  }));

  // --- Approvals (Phase 5) ------------------------------------------------------------------
  app.get("/api/copilot/approvals", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const rows = (await db.query(
      `SELECT id, run_id, step_id, tool, status, created_at, decided_at FROM agent_approvals
         WHERE owner_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 50`,
      [ownerId],
    )).rows;
    res.json({ approvals: rows });
  }));

  // Approve/deny a pending approval. Approving resumes the run from the gated step (same path as
  // /runs/:id/approve); denying records the decision and leaves the run paused.
  app.post("/api/copilot/approvals/:id", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const ownerToken = req.ownerToken!;
    const approved = req.body?.approved !== false;
    const apr = (await db.query(`SELECT * FROM agent_approvals WHERE id=$1 AND owner_id=$2`, [req.params.id, ownerId])).rows[0];
    if (!apr) { res.status(404).json({ error: "APPROVAL_NOT_FOUND" }); return; }
    if (apr.status !== "pending") { res.status(409).json({ error: "ALREADY_DECIDED", status: apr.status }); return; }
    await db.query(`UPDATE agent_approvals SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`,
      [apr.id, approved ? "approved" : "denied", String(ownerId)]);
    if (!approved) { res.json({ status: "denied", run_resumed: false }); return; }
    const run = await getRun(ownerId, apr.run_id);
    const planRaw = run ? await getRunPlan(ownerId, run.id) : null;
    if (!run || !planRaw) { res.status(409).json({ error: "RUN_HAS_NO_PLAN" }); return; }
    const plan = parsePlan(planRaw);
    setImmediate(async () => {
      try {
        const mcp = await connectMcp(ownerToken);
        try { await executePlan({ plan, mcp, runId: run.id, approvals: new Set([apr.step_id]) }); }
        finally { await mcp.close().catch(() => {}); }
      } catch (e) { log.error("approval resume failed", { runId: run.id, message: (e as Error).message }); }
    });
    res.json({ status: "approved", run_resumed: true, runId: run.id });
  }));

  const settingsSchema = z.object({
    autonomy_level: z.enum(["L0", "L1", "L1_5_shadow", "L2", "L3"]).optional(),
    agent_enabled: z.boolean().optional(),
    disable_triggers: z.boolean().optional(),
    disable_web: z.boolean().optional(),
    disable_memory_writes: z.boolean().optional(),
    disable_live_paper_start: z.boolean().optional(),
    contribute_global: z.boolean().optional(),
  });
  app.post("/api/copilot/kill-switch", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    res.json(await updateOwnerSettings(ownerId, settingsSchema.parse(req.body ?? {})));
  }));

  // --- Living trader: positions + reasoning + risk (Phase 17) -------------------------------
  // Open a managed position. The exit_policy is MANDATORY (a stop-loss at minimum) — the guardrail
  // and openManagedPosition both refuse a naked entry. At L1 this returns awaiting_approval.
  const openPosSchema = z.object({
    threadId: z.string().optional(),
    bot_id: z.string().min(1),
    symbol: z.string().min(1),
    category: z.enum(["spot", "linear", "xstock"]).default("linear"),
    side: z.enum(["long", "short"]).default("long"),
    entry_price: z.number().positive(),
    exit_policy: ExitPolicySchema,
    atr: z.number().positive().optional(),
    max_runtime_seconds: z.number().int().positive().optional(),
    investment_quote: z.number().positive().optional(),
  });
  app.post("/api/copilot/positions/open", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const b = openPosSchema.parse(req.body);
    const settings = await getOwnerSettings(ownerId);
    const autonomy = settings.autonomy_level === "L2" || settings.autonomy_level === "L3" ? "L2" : "L1";
    const threadId = b.threadId ?? (await createThread(ownerId, `Position: ${b.symbol}`)).id;
    const r = await openManagedPosition({
      ownerId, threadId, botId: b.bot_id, symbol: b.symbol, category: b.category, side: b.side,
      entryPrice: b.entry_price, exitPolicy: b.exit_policy, atr: b.atr, autonomy,
      maxRuntimeSeconds: b.max_runtime_seconds, investmentQuote: b.investment_quote, ownerToken: req.ownerToken!,
    });
    res.status(r.status === "blocked" ? 422 : 200).json(r);
  }));

  app.get("/api/copilot/positions", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const state = req.query.state === "open" || req.query.state === "closed" ? req.query.state : undefined;
    res.json({ positions: await listIntents(ownerId, { state }) });
  }));

  app.get("/api/copilot/positions/:id", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const intent = await getIntent(ownerId, req.params.id);
    if (!intent) { res.status(404).json({ error: "POSITION_NOT_FOUND" }); return; }
    res.json({ intent, events: await listPositionEvents(ownerId, intent.id) });
  }));

  // Deterministic mark injection — drives the monitor exactly as the rt:session:* subscriber does.
  // Either tick a whole symbol ({symbol, mark}) or one position ({intent_id, mark}).
  const tickSchema = z.object({ symbol: z.string().optional(), mark: z.number().positive(), intent_id: z.string().optional() });
  app.post("/api/copilot/positions/tick", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const b = tickSchema.parse(req.body);
    if (b.intent_id) {
      const intent = await getIntent(ownerId, b.intent_id);
      if (!intent) { res.status(404).json({ error: "POSITION_NOT_FOUND" }); return; }
      res.json({ results: [await evaluateIntent(intent, b.mark)] });
      return;
    }
    if (!b.symbol) { res.status(400).json({ error: "SYMBOL_OR_INTENT_REQUIRED" }); return; }
    res.json({ results: await onMark(b.symbol, b.mark) });
  }));

  // Manual close (the protective path the monitor uses, on demand).
  app.post("/api/copilot/positions/:id/close", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const intent = await getIntent(ownerId, req.params.id);
    if (!intent) { res.status(404).json({ error: "POSITION_NOT_FOUND" }); return; }
    if (intent.state === "closed" || !intent.session_id) { res.status(409).json({ error: "NOT_OPEN" }); return; }
    const threadId = (await createThread(ownerId, `Manual close ${intent.symbol}`)).id;
    const plan = buildClosePositionPlan({ ownerId, threadId, sessionId: intent.session_id, symbol: intent.symbol, category: intent.category as "spot" | "linear" | "xstock", reason: "manual" });
    const mcp = await connectMcp(req.ownerToken!);
    try {
      const outcome = await executePlan({ plan, mcp, agentAction: "manage_position manual" });
      res.json({ runId: outcome.runId, status: outcome.status });
    } finally { await mcp.close().catch(() => {}); }
  }));

  app.post("/api/copilot/positions/sweep", wrap(async (req, res) => {
    requireOwnerId(req);
    res.json({ results: await sweepOpenPositions() });
  }));

  // Run the multi-agent trading firm and return a structured decision + proposed exit policy.
  const analyzeSchema = z.object({ symbol: z.string().min(1), category: z.enum(["spot", "linear", "xstock"]).default("linear"), use_web: z.boolean().optional() });
  app.post("/api/copilot/analyze", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const b = analyzeSchema.parse(req.body);
    const mcp = await connectMcp(req.ownerToken!).catch(() => null);
    try {
      res.json(await runTradingDecision({ ownerId, symbol: b.symbol, category: b.category, useWeb: b.use_web, mcp: mcp ?? undefined }));
    } finally { if (mcp) await mcp.close().catch(() => {}); }
  }));

  // Risk state (circuit breakers). GET reads (auto-clears expired cooldown); POST manually overrides.
  app.get("/api/copilot/risk", wrap(async (req, res) => {
    res.json(await getRiskState(requireOwnerId(req)));
  }));
  const riskSchema = z.object({ state: z.enum(["normal", "risk_averse", "halted"]), reason: z.string().optional(), cooldown_seconds: z.number().int().positive().optional() });
  app.post("/api/copilot/risk", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const b = riskSchema.parse(req.body);
    await setRiskState(ownerId, b.state, b.reason ?? null, b.cooldown_seconds);
    res.json(await getRiskState(ownerId));
  }));

  // Deep multi-factor token screen (Phase 29) — momentum/trend/RSI/MACD/funding/OI/vol + news
  // sentiment → risk-weighted ranking + an xStocks block. Deterministic enough to assert in tests.
  const screenSchema = z.object({
    risk: z.enum(["conservative", "moderate", "aggressive"]).default("moderate"),
    style: z.enum(["quality", "balanced", "momentum"]).default("balanced"),
    category: z.enum(["linear", "spot"]).default("linear"),
    top: z.number().int().positive().max(15).optional(),
    include_xstocks: z.boolean().optional(),
    use_web: z.boolean().optional(),
  });
  app.post("/api/copilot/screen", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const b = screenSchema.parse(req.body ?? {});
    const mcp = await connectMcp(req.ownerToken!).catch(() => null);
    try {
      res.json(await screenTokens(ownerId, { risk: b.risk, style: b.style, category: b.category, top: b.top, includeXstocks: b.include_xstocks, useWeb: b.use_web }, mcp ?? undefined));
    } finally { if (mcp) await mcp.close().catch(() => {}); }
  }));

  // --- Market awareness: screener + news (Phase 19) -----------------------------------------
  app.get("/api/copilot/market/scan", wrap(async (req, res) => {
    requireOwnerId(req);
    const sort = (typeof req.query.sort === "string" ? req.query.sort : "best") as ScanSort;
    const category = req.query.category === "spot" ? "spot" : "linear";
    const top = req.query.top ? Number(req.query.top) : undefined;
    res.json(await scanMarket({ sort, category, top }));
  }));
  app.get("/api/copilot/market/overview", wrap(async (req, res) => {
    requireOwnerId(req);
    res.json(await marketOverview({ category: req.query.category === "spot" ? "spot" : "linear" }));
  }));
  app.get("/api/copilot/news", wrap(async (req, res) => {
    requireOwnerId(req);
    const query = typeof req.query.query === "string" ? req.query.query : "";
    if (!query) { res.status(400).json({ error: "QUERY_REQUIRED" }); return; }
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
    res.json(await fetchTokenNews({ query, symbol, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  }));

  // --- Saved setups (Phase 27): design → save → revisit → launch (live-paper) -----------------
  const setupSpecSchema = z.object({
    budget_usd: z.number().positive(),
    risk: z.enum(["conservative", "moderate", "aggressive"]),
    asset_classes: z.array(z.enum(["spot", "linear", "xstock"])).min(1),
    legs: z.array(z.object({ symbol: z.string().min(1), allocation: z.number() }).passthrough()).min(1),
    weighting: z.string().optional(),
    rebalance_threshold: z.number().optional(),
    duration_days: z.number().optional(),
    summary: z.record(z.unknown()).optional(),
  });
  app.post("/api/copilot/setups", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const body = z.object({ name: z.string().min(1).max(120), spec: setupSpecSchema }).parse(req.body);
    const id = `setup_${randomUUID()}`;
    await db.query(`INSERT INTO agent_setups (id, owner_id, name, spec) VALUES ($1,$2,$3,$4::jsonb)`, [id, ownerId, body.name, JSON.stringify(body.spec)]);
    res.json({ id, name: body.name, status: "draft" });
  }));
  app.get("/api/copilot/setups", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const rows = (await db.query(`SELECT id, name, spec, status, last_run_id, created_at, updated_at FROM agent_setups WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 100`, [ownerId])).rows;
    res.json({ setups: rows });
  }));
  app.get("/api/copilot/setups/:id", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const r = await db.query(`SELECT * FROM agent_setups WHERE id=$1 AND owner_id=$2`, [req.params.id, ownerId]);
    if (!r.rowCount) { res.status(404).json({ error: "SETUP_NOT_FOUND" }); return; }
    res.json(r.rows[0]);
  }));
  app.delete("/api/copilot/setups/:id", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const r = await db.query(`DELETE FROM agent_setups WHERE id=$1 AND owner_id=$2`, [req.params.id, ownerId]);
    res.json({ deleted: (r.rowCount ?? 0) > 0 });
  }));
  // Launch a saved setup as a live-paper portfolio session (Bybit live is a separate gated build).
  app.post("/api/copilot/setups/:id/launch", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const row = (await db.query(`SELECT * FROM agent_setups WHERE id=$1 AND owner_id=$2`, [req.params.id, ownerId])).rows[0];
    if (!row) { res.status(404).json({ error: "SETUP_NOT_FOUND" }); return; }
    const spec = row.spec as z.infer<typeof setupSpecSchema>;
    const weights: Record<string, number> = {}; const symbols: string[] = [];
    for (const l of spec.legs) { weights[l.symbol] = l.allocation; symbols.push(l.symbol); }
    const params: MultiassetParams = { budgetUsd: spec.budget_usd, risk: spec.risk as RiskAppetite, durationDays: spec.duration_days, assetClasses: spec.asset_classes as AssetClass[], symbols, weights };
    const { legs, weighting, intervalMinutes } = composeLegs(params);
    const settings = await getOwnerSettings(ownerId);
    const autonomy = settings.autonomy_level === "L2" || settings.autonomy_level === "L3" ? "L2" : "L1";
    const threadId = (await createThread(ownerId, `Launch: ${row.name}`)).id;
    const r = await startMultiassetPaper({ ownerId, threadId, params, legs, weighting, intervalMinutes, rebalanceThreshold: spec.rebalance_threshold, autonomy, ownerToken: req.ownerToken! });
    if (r.status === "started") await db.query(`UPDATE agent_setups SET status='launched', last_run_id=$2, updated_at=now() WHERE id=$1`, [row.id, r.runId]).catch(() => {});
    res.status(r.status === "blocked" ? 422 : 200).json(r);
  }));

  // --- Multi-asset basket (Phase 18) --------------------------------------------------------
  const maParamsSchema = z.object({
    budget_usd: z.number().positive(),
    risk: z.enum(["conservative", "moderate", "aggressive"]).default("moderate"),
    style: z.enum(["quality", "balanced", "momentum"]).optional(),
    duration_days: z.number().int().positive().optional(),
    asset_classes: z.array(z.enum(["spot", "linear", "xstock"])).min(1),
    symbols: z.array(z.string()).optional(),
    rebalance_threshold: z.number().positive().optional(),
    bots: z.record(z.string()).optional(),
    with_bots: z.boolean().optional(),
  });
  const toParams = (b: z.infer<typeof maParamsSchema>): MultiassetParams => ({
    budgetUsd: b.budget_usd, risk: b.risk as RiskAppetite, style: b.style, durationDays: b.duration_days,
    assetClasses: b.asset_classes as AssetClass[], symbols: b.symbols, bots: b.bots, withBots: b.with_bots,
  });
  // Backtest + bull/bear cross-validate a basket and return outcomes (no trading).
  app.post("/api/copilot/multiasset/propose", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const b = maParamsSchema.parse(req.body);
    const mcp = await connectMcp(req.ownerToken!);
    try { res.json(await runMultiassetProposal(ownerId, toParams(b), mcp)); }
    finally { await mcp.close().catch(() => {}); }
  }));
  // Re-run the setup with EDITED weights (from the editable basket). Deterministic + STREAMED: creates
  // a run, drives runMultiassetProposal with an emit that publishes board widgets, so the UI streams
  // the fresh flow exactly like a chat run — no LLM in the loop. `rationale` records why the user edited.
  const rerunSchema = maParamsSchema.extend({
    weights: z.record(z.number()).optional(),
    rationale: z.string().optional(),
    thread_id: z.string().optional(),
  });
  app.post("/api/copilot/multiasset/rerun", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const b = rerunSchema.parse(req.body);
    const ownerToken = req.ownerToken!;
    const threadId = b.thread_id ?? (await createThread(ownerId, "Multiasset re-run")).id;
    const run = await createRun(ownerId, threadId, "multiasset re-run", "build_and_backtest_multiasset");
    res.json({ runId: run.id, threadId });
    setImmediate(async () => {
      publish(run.id, "run.started", { runId: run.id });
      if (b.rationale) publish(run.id, "message", { role: "assistant", content: `Re-analyzing with your edits: ${b.rationale}` });
      const mcp = await connectMcp(ownerToken).catch(() => null);
      if (!mcp) { publish(run.id, "run.error", { message: "agent could not reach the Lab" }); await finishRun(run.id, "error", 0).catch(() => {}); return; }
      try {
        const params: MultiassetParams = { ...toParams(b), weights: b.weights };
        const proposal = await runMultiassetProposal(ownerId, params, mcp, (w) => publish(run.id, "widget", w));
        publish(run.id, "message", { role: "assistant", content: `Done — re-ran the full flow with your basket. ${proposal.recommendation} ${proposal.warnings.length ? "Notes: " + proposal.warnings.join("; ") : ""}` });
        publish(run.id, "run.done", { status: "completed" });
        await finishRun(run.id, "completed", 0).catch(() => {});
      } catch (e) {
        publish(run.id, "run.error", { message: (e as Error).message });
        await finishRun(run.id, "error", 0).catch(() => {});
      } finally { await mcp.close().catch(() => {}); }
    });
  }));

  // Go live (paper) for a confirmed basket (L2+).
  app.post("/api/copilot/multiasset/start", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const b = maParamsSchema.parse(req.body);
    const settings = await getOwnerSettings(ownerId);
    const autonomy = settings.autonomy_level === "L2" || settings.autonomy_level === "L3" ? "L2" : "L1";
    const p = toParams(b);
    const { legs, weighting, intervalMinutes } = composeLegs(p);
    const threadId = (await createThread(ownerId, `Multiasset $${b.budget_usd}`)).id;
    const r = await startMultiassetPaper({ ownerId, threadId, params: p, legs, weighting, intervalMinutes, rebalanceThreshold: b.rebalance_threshold, autonomy, ownerToken: req.ownerToken! });
    res.status(r.status === "blocked" ? 422 : 200).json(r);
  }));

  // --- Chat spine ---------------------------------------------------------------------------
  app.post("/api/copilot/threads", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const title = typeof req.body?.title === "string" ? req.body.title : undefined;
    res.json(await createThread(ownerId, title));
  }));

  app.get("/api/copilot/threads", wrap(async (req, res) => {
    res.json({ threads: await listThreads(requireOwnerId(req)) });
  }));

  const msgSchema = z.object({ content: z.string().min(1).max(8000) });
  app.post("/api/copilot/threads/:id/message", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const thread = await getThread(ownerId, req.params.id);
    if (!thread) {
      res.status(404).json({ error: "THREAD_NOT_FOUND" });
      return;
    }
    const body = msgSchema.parse(req.body);
    const { runId } = await startChatTurn(ownerId, thread.id, body.content, req.ownerToken!);
    res.json({ runId, threadId: thread.id });
  }));

  app.get("/api/copilot/threads/:id/messages", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const thread = await getThread(ownerId, req.params.id);
    if (!thread) {
      res.status(404).json({ error: "THREAD_NOT_FOUND" });
      return;
    }
    res.json({ messages: await getMessages(ownerId, thread.id) });
  }));

  app.get("/api/copilot/threads/:id/snapshot", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const thread = await getThread(ownerId, req.params.id);
    if (!thread) {
      res.status(404).json({ error: "THREAD_NOT_FOUND" });
      return;
    }
    const [messages, runs, events] = await Promise.all([
      getMessages(ownerId, thread.id),
      listRunsForThread(ownerId, thread.id),
      getThreadEvents(ownerId, thread.id),
    ]);
    res.json({ thread, messages, runs, events });
  }));

  // SSE trace stream for a run. EventSource can't set headers, so the token arrives as ?token=
  // (authMiddleware honors it). Ownership is enforced before subscribing.
  app.get("/api/copilot/stream", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const runId = typeof req.query.runId === "string" ? req.query.runId : "";
    const run = runId ? await getRun(ownerId, runId) : null;
    if (!run) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(`: connected\n\n`);

    // Writing to a client that has gone away throws synchronously (or after the socket closes).
    // Swallow it: SSE delivery is best-effort, and an EventEmitter callback throwing would
    // otherwise become an uncaught exception. Returns false once the stream is no longer writable.
    const send = (ev: { type: string; seq: number; data: unknown }): boolean => {
      if (res.writableEnded) return false;
      try {
        res.write(`event: ${ev.type}\n`);
        res.write(`data: ${JSON.stringify({ seq: ev.seq, ...(ev.data as object) })}\n\n`);
        return true;
      } catch {
        return false;
      }
    };

    // If the run already finished before the client connected, replay buffered events (if any) or
    // synthesize a terminal event from the persisted run, then close.
    const buffered = replay(runId);
    if (buffered.length === 0 && run.status && run.status !== "running") {
      send({ type: run.status === "completed" ? "run.done" : "run.error", seq: 1, data: { status: run.status, costMicroUsd: run.cost_micro_usd } });
      res.end();
      return;
    }

    // subscribe() synchronously replays the buffered events before it returns, so the callback can
    // fire (and hit a terminal event) while `unsubscribe` is still being assigned. Seed it with a
    // no-op and guard with a `finished` flag so a synchronously-replayed run.done doesn't reference
    // the binding in its temporal dead zone, and so we never double-close.
    let unsubscribe: () => void = () => {};
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    unsubscribe = subscribe(runId, (ev) => {
      send(ev);
      if (isTerminal(ev)) finish();
    });
    // If a terminal event was replayed synchronously above, finish() ran against the no-op; detach
    // the now-assigned real listener.
    if (finished) unsubscribe();
    req.on("close", () => { finished = true; unsubscribe(); });
  }));

  app.get("/api/copilot/runs/:id", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const run = await getRun(ownerId, req.params.id);
    if (!run) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    res.json(run);
  }));

  app.get("/api/copilot/runs/:id/steps", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const run = await getRun(ownerId, req.params.id);
    if (!run) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    res.json({ runId: run.id, steps: await getSteps(ownerId, run.id) });
  }));

  app.get("/api/copilot/runs/:id/events", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const run = await getRun(ownerId, req.params.id);
    if (!run) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    res.json({ runId: run.id, events: await getRunEvents(ownerId, run.id) });
  }));

  // --- Playbooks (MVP: build_and_backtest_bot) ----------------------------------------------
  const buildSchema = z.object({
    threadId: z.string().min(1),
    symbol: z.string().min(1),
    category: z.enum(["spot", "linear", "xstock"]),
    autonomy: z.enum(["L0", "L1", "L1_5_shadow", "L2", "L3"]).optional(),
    template: z.string().optional(),
    interval: z.string().optional(),
    botParams: z.record(z.unknown()).optional(),
  });
  app.post("/api/copilot/playbooks/build_and_backtest_bot", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const ownerToken = req.ownerToken!;
    const body = buildSchema.parse(req.body);
    const thread = await getThread(ownerId, body.threadId);
    if (!thread) {
      res.status(404).json({ error: "THREAD_NOT_FOUND" });
      return;
    }
    // Phase 6 — let the learned policy (bandit) pick the param bucket for this context, falling back
    // to the seed defaults. The chosen params flow into the plan as botParams.
    const seed = defaultBotFor(body.category, body.template, body.botParams as Record<string, unknown> | undefined);
    const choice = await selectParamBucket(ownerId, { regime: "any", symbolClass: body.category, botType: seed.botType }, seed.params, Math.random);
    const plan = buildAndBacktestPlan({
      ownerId, ...body, threadId: thread.id,
      botParams: { ...(body.botParams ?? {}), botType: seed.botType, params: choice.paramBucket as Record<string, unknown> },
    });
    const run = await createRun(ownerId, thread.id, "build_and_backtest_bot", plan.playbook_id, plan);
    log.info("bandit selection", { ownerId, botType: seed.botType, source: choice.source, promoted: choice.promoted });
    // Process asynchronously; the client opens the SSE stream for the trace.
    setImmediate(async () => {
      try {
        const mcp = await connectMcp(ownerToken);
        try {
          await executePlan({ plan, mcp, runId: run.id, agentAction: `build_and_backtest_bot ${body.symbol}` });
        } finally {
          await mcp.close().catch(() => {});
        }
      } catch (e) {
        log.error("playbook run failed", { runId: run.id, message: (e as Error).message });
      }
    });
    res.json({ runId: run.id, planId: plan.plan_id });
  }));

  // Approve a pending step and resume the run (already-completed steps are skipped).
  const approveSchema = z.object({ stepId: z.string().min(1) });
  app.post("/api/copilot/runs/:id/approve", wrap(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const ownerToken = req.ownerToken!;
    const run = await getRun(ownerId, req.params.id);
    if (!run) {
      res.status(404).json({ error: "RUN_NOT_FOUND" });
      return;
    }
    const { stepId } = approveSchema.parse(req.body);
    const planRaw = await getRunPlan(ownerId, run.id);
    if (!planRaw) {
      res.status(409).json({ error: "RUN_HAS_NO_PLAN" });
      return;
    }
    const plan = parsePlan(planRaw);
    await db.query(`UPDATE agent_approvals SET status='approved', decided_by=$3, decided_at=now() WHERE run_id=$1 AND step_id=$2 AND status='pending'`,
      [run.id, stepId, String(ownerId)]).catch(() => {});
    setImmediate(async () => {
      try {
        const mcp = await connectMcp(ownerToken);
        try {
          await executePlan({ plan, mcp, runId: run.id, approvals: new Set([stepId]) });
        } finally {
          await mcp.close().catch(() => {});
        }
      } catch (e) {
        log.error("playbook resume failed", { runId: run.id, message: (e as Error).message });
      }
    });
    res.json({ ok: true, runId: run.id, approved: stepId });
  }));

  return app;
}

// Boot when run directly (tsx src/server.ts), not when imported by tests. Compare via pathToFileURL so
// paths with spaces/special chars (e.g. a local checkout under "netrunner quant lab") match correctly —
// a bare `file://${argv1}` doesn't %20-encode spaces, so the guard silently failed in such checkouts.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // A single bad request or stray async throw (e.g. an SSE write after the client vanished) must
  // not take the whole agent down for every owner. Log and keep serving; per-request errors are
  // still surfaced by the wrap() handler above.
  process.on("unhandledRejection", (reason) =>
    logger.error("unhandledRejection", { message: reason instanceof Error ? reason.message : String(reason) }),
  );
  process.on("uncaughtException", (err) =>
    logger.error("uncaughtException", { message: err.message, stack: err.stack }),
  );

  const app = createApp();
  app.listen(config.port, () => logger.info("agent listening", { port: config.port }));
  // Phase 4 — production trigger wiring (best-effort; tests drive evaluateEvent via the API).
  startTriggerSubscriber();
  // Phase 17 — always-on position monitor (periodic time-exit safety sweep; real-time marks arrive
  // via the rt:session:*/rt:barclose:* subscriber above).
  startPositionMonitor();
  // Phase 17 — scheduled reflection so learned lessons keep getting promoted/decayed on a cadence.
  if (config.reflectionIntervalMs > 0) {
    const t = setInterval(() => {
      runScheduledReflection().catch((e) => logger.warn("scheduled reflection error", { message: (e as Error).message }));
    }, config.reflectionIntervalMs);
    t.unref?.();
  }
}
