import { db } from "../db.js";
import { config } from "../config.js";
import { writeEpisode, contextKey } from "../memory/store.js";
import { getSteps } from "../chat/store.js";
import type { AgentPlan } from "../orchestrator/plan.js";

// Phase 6 — Learning. The reward is computed ONLY from the Lab's honesty-gated metrics (never from
// agent narration), an unverified local result can never out-rank a verified one (hard cap), and
// optimistic fills / thin coverage / small samples all subtract. The bandit is Thompson sampling
// over discretized param buckets per (regime, symbol_class, bot) context, with conservative,
// reversible promotion gates.

export interface OutcomeMetrics {
  total_return: number;
  sharpe: number;
  max_drawdown: number;
  coverage: number; // 0..1
  maker_fills_optimistic: boolean;
  liquidity_free_upper_bound: boolean;
  risk_hard_blocks: boolean;
  result_tier: string;
  verified: boolean;
  live_paper: boolean;
  sample_size_n: number;
  // On-chain / multi-venue terms (optional; 0 when absent). Make the policy prefer LP only when fee
  // yield genuinely beats IL+gas, and leverage/hold only when carry is favorable (§8 of the plan).
  il_drag?: number;       // modeled impermanent-loss drag (fraction, ≥0)
  carry_cost?: number;    // net funding+borrow PAID (fraction, ≥0; receipts are negative)
  gas_cost?: number;      // rebalance/exec gas as a fraction of position (≥0)
}

// reward = weighted blend of return + risk-adjusted, minus penalties for drawdown, fill optimism,
// thin coverage, hard blocks. Unverified results are hard-capped so they can never beat verified.
export function computeReward(m: OutcomeMetrics): number {
  let reward = 0;
  reward += 0.15 * m.total_return;
  reward += 0.25 * m.sharpe;
  if (m.verified) reward += 1.0;
  if (m.live_paper) reward += 0.2;
  reward -= 0.2 * Math.max(0, m.max_drawdown);
  if (m.maker_fills_optimistic || m.liquidity_free_upper_bound) reward -= 0.15;
  reward -= 0.1 * (1 - Math.min(1, Math.max(0, m.coverage)));
  if (m.risk_hard_blocks) reward -= 1.0;
  // On-chain penalties (w6..w8): IL drag, net carry paid, gas. These make the learned policy favor LP
  // only when fees beat IL+gas, and leverage/hold only when carry works for (not against) the position.
  reward -= 0.2 * Math.max(0, m.il_drag ?? 0);
  reward -= 0.15 * Math.max(0, m.carry_cost ?? 0);
  reward -= 0.1 * Math.max(0, m.gas_cost ?? 0);
  // Bayesian shrinkage toward 0 when the sample is tiny — one lucky run never dominates.
  const shrink = Math.exp(-m.sample_size_n / 10);
  reward *= 1 - shrink;
  // Hard cap: an unverified local result can never out-rank a verified one.
  if (!m.verified) reward = Math.min(reward, config.rewardCapUnverified);
  return Number(reward.toFixed(6));
}

function num(v: unknown, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// Pull the honesty-gated metrics out of the backtest step's stored result + accumulated honesty.
function extractMetrics(honesty: Record<string, unknown>, backtest: Record<string, unknown> | null): OutcomeMetrics {
  const perf = (backtest?.performance ?? {}) as Record<string, unknown>;
  const fillModel = (honesty.fill_model ?? backtest?.fill_model ?? {}) as Record<string, unknown>;
  const startEq = num(backtest?.starting_equity, 10000) || 10000;
  const finalEq = num(backtest?.final_equity, startEq);
  const total_return = startEq > 0 ? (finalEq - startEq) / startEq : 0;
  const tier = String(honesty.result_tier ?? backtest?.result_tier ?? "unverified");
  const verified = tier.toLowerCase() === "verified";
  const hb = honesty.hard_blocks;
  return {
    total_return,
    sharpe: num(perf.sharpe ?? perf.sharpe_ratio, 0),
    max_drawdown: Math.abs(num(perf.max_drawdown ?? perf.max_dd, 0)),
    coverage: num((honesty.coverage_proof as Record<string, unknown>)?.coverage ?? honesty.coverage, 1),
    maker_fills_optimistic: Boolean(fillModel.maker_fills_optimistic ?? honesty.maker_fills_optimistic),
    liquidity_free_upper_bound: Boolean(fillModel.liquidity_free_upper_bound ?? honesty.liquidity_free_upper_bound),
    risk_hard_blocks: Array.isArray(hb) ? hb.length > 0 : false,
    result_tier: tier,
    verified,
    live_paper: false,
    sample_size_n: 1,
  };
}

// Welford incremental update of a policy bucket's reward mean/variance, plus verified/live counts.
export async function updatePolicy(
  ownerId: number,
  ck: string,
  paramBucket: unknown,
  reward: number,
  verified: boolean,
  livePaper: boolean,
): Promise<void> {
  const bucket = JSON.stringify(paramBucket ?? {});
  const existing = await db.query<{ n: string; reward_mean: string; reward_m2: string }>(
    `SELECT n, reward_mean, reward_m2 FROM agent_policy WHERE owner_id=$1 AND context_key=$2 AND param_bucket=$3::jsonb`,
    [ownerId, ck, bucket],
  );
  if (!existing.rowCount) {
    await db.query(
      `INSERT INTO agent_policy (owner_id, context_key, param_bucket, n, reward_mean, reward_m2, verified_n, live_paper_n, windows, last_used)
       VALUES ($1,$2,$3::jsonb,1,$4,0,$5,$6,1,now())
       ON CONFLICT (owner_id, context_key, param_bucket) DO NOTHING`,
      [ownerId, ck, bucket, reward, verified ? 1 : 0, livePaper ? 1 : 0],
    );
    return;
  }
  const n0 = Number(existing.rows[0].n);
  const mean0 = Number(existing.rows[0].reward_mean);
  const m20 = Number(existing.rows[0].reward_m2);
  const n1 = n0 + 1;
  const delta = reward - mean0;
  const mean1 = mean0 + delta / n1;
  const m21 = m20 + delta * (reward - mean1);
  await db.query(
    `UPDATE agent_policy SET n=$4, reward_mean=$5, reward_m2=$6,
            verified_n = verified_n + $7, live_paper_n = live_paper_n + $8, last_used = now()
       WHERE owner_id=$1 AND context_key=$2 AND param_bucket=$3::jsonb`,
    [ownerId, ck, bucket, n1, mean1, m21, verified ? 1 : 0, livePaper ? 1 : 0],
  );
}

// Record a completed run: write the episode (Phase 3) and update the policy bucket (Phase 6).
export async function recordOutcome(opts: {
  ownerId: number;
  runId: string;
  plan: AgentPlan;
  honesty: Record<string, unknown>;
  agentAction?: string;
}): Promise<{ reward: number }> {
  const { ownerId, runId, plan, honesty } = opts;
  const steps = await getSteps(ownerId, runId);
  const backtestStep = steps.find((s) => (s as { tool?: string }).tool === "run_bot_backtest") as { result?: Record<string, unknown> } | undefined;
  const metrics = extractMetrics(honesty, backtestStep?.result ?? null);
  const reward = computeReward(metrics);

  const botType = (() => {
    const specStep = plan.steps.find((s) => s.tool === "create_bot_spec");
    return (specStep?.params?.botType as string) ?? (specStep?.params?.template as string) ?? "unknown";
  })();
  const ctx = { regime: (honesty.regime as string) ?? undefined, symbolClass: plan.category, botType };
  const ck = contextKey(ctx);

  await writeEpisode(ownerId, {
    kind: "run",
    runId,
    regime: ctx.regime ?? null,
    symbol: plan.symbol,
    symbolClass: plan.category,
    botOrStrategy: botType,
    params: backtestStep?.result ? undefined : undefined,
    resultTier: metrics.result_tier,
    reward,
    metrics: metrics as unknown,
    summary: `${opts.agentAction ?? `Ran ${plan.playbook_id}`} on ${plan.symbol}/${plan.category} (${botType}): tier=${metrics.result_tier}, return=${(metrics.total_return * 100).toFixed(2)}%, reward=${reward.toFixed(3)}`,
    source: metrics.verified ? "verified" : "local",
    evidence: { run_id: runId },
  });

  // Update the learned policy for this context + the bot's param bucket.
  const specStep = plan.steps.find((s) => s.tool === "create_bot_spec");
  const paramBucket = (specStep?.params?.params as unknown) ?? {};
  await updatePolicy(ownerId, ck, paramBucket, reward, metrics.verified, metrics.live_paper);

  return { reward };
}

// Thompson sampling over a context's param buckets. Returns the chosen bucket + whether it's a
// learned-promoted preference. Falls back to the seed bucket when no policy exists yet, and explores
// with probability banditExploreProb.
export async function selectParamBucket(
  ownerId: number,
  ctx: { regime?: string; symbolClass?: string; botType?: string },
  seedBucket: unknown,
  rand: () => number,
): Promise<{ paramBucket: unknown; promoted: boolean; explored: boolean; source: string }> {
  const ck = contextKey(ctx);
  const rows = (await db.query(
    `SELECT param_bucket, n, reward_mean, reward_m2, promoted FROM agent_policy WHERE owner_id=$1 AND context_key=$2`,
    [ownerId, ck],
  )).rows as Array<{ param_bucket: unknown; n: string; reward_mean: string; reward_m2: string; promoted: boolean }>;

  if (!rows.length) return { paramBucket: seedBucket, promoted: false, explored: false, source: "seed" };

  // Explore: occasionally pick a random known bucket (bounded, paper-only).
  if (rand() < config.banditExploreProb) {
    const pick = rows[Math.floor(rand() * rows.length)];
    return { paramBucket: pick.param_bucket, promoted: pick.promoted, explored: true, source: "explore" };
  }

  // Exploit: Thompson-sample each bucket's posterior mean and take the max.
  const gauss = (mean: number, std: number) => {
    // Box–Muller
    const u1 = Math.max(1e-9, rand());
    const u2 = rand();
    return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  let best = rows[0];
  let bestSample = -Infinity;
  for (const r of rows) {
    const n = Number(r.n);
    const variance = n > 1 ? Number(r.reward_m2) / (n - 1) : 1;
    const sample = gauss(Number(r.reward_mean), Math.sqrt(Math.max(1e-6, variance)) / Math.sqrt(Math.max(1, n)));
    if (sample > bestSample) { bestSample = sample; best = r; }
  }
  return { paramBucket: best.param_bucket, promoted: best.promoted, explored: false, source: "exploit" };
}
