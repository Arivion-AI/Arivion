import { db } from "../db.js";
import { config } from "../config.js";
import { writeSemantic } from "../memory/store.js";

// Phase 6 — reflection + promotion. Runs over the learned policy: checks the conservative,
// reversible promotion gates for each (context, param) bucket, promotes/demotes, and distills a
// semantic statement for each newly-promoted bucket. Deterministic (no LLM) so it is testable and
// cheap; an Opus-distilled narrative is a fast-follow.

export interface PromotionResult {
  context_key: string;
  param_bucket: unknown;
  eligible: boolean;
  reasons: string[];
}

// All gates must hold (§10): enough trials, ≥2 windows, evidence beyond local backtests, drawdown
// under ceiling, coverage above floor, no reliance on optimistic fills, and the reward CI lower
// bound beats the baseline (the seed/worst bucket in the same context).
export async function checkPromotionGates(bucket: {
  owner_id: number; context_key: string; param_bucket: unknown;
  n: number; reward_mean: number; reward_m2: number; verified_n: number; live_paper_n: number; windows: number;
}, baselineMean: number): Promise<PromotionResult> {
  const reasons: string[] = [];
  if (bucket.n < config.promoteMinN) reasons.push(`n=${bucket.n} < ${config.promoteMinN}`);
  if (bucket.windows < config.promoteMinWindows) reasons.push(`windows=${bucket.windows} < ${config.promoteMinWindows}`);
  if (bucket.verified_n < 1 && bucket.live_paper_n < 1) reasons.push(`no verified/live-paper evidence`);

  // Aggregate the bucket's episode metrics for drawdown / coverage / fill-optimism gates.
  const agg = (await db.query(
    `SELECT
        COALESCE(MAX((metrics->>'max_drawdown')::float8),0) AS max_dd,
        COALESCE(AVG((metrics->>'coverage')::float8),1) AS avg_cov,
        COALESCE(BOOL_OR((metrics->>'maker_fills_optimistic')::boolean OR (metrics->>'liquidity_free_upper_bound')::boolean),false) AS optimistic
       FROM agent_episodes
      WHERE owner_id=$1 AND kind='run' AND deleted_at IS NULL AND bot_or_strategy IS NOT NULL`,
    [bucket.owner_id],
  )).rows[0] as { max_dd: number; avg_cov: number; optimistic: boolean };
  if (Number(agg.max_dd) > 0.2) reasons.push(`max_dd=${Number(agg.max_dd).toFixed(2)} > 0.20`);
  if (Number(agg.avg_cov) < 0.9) reasons.push(`avg_coverage=${Number(agg.avg_cov).toFixed(2)} < 0.90`);
  if (agg.optimistic) reasons.push(`relies on optimistic fills`);

  // Reward CI lower bound must beat baseline.
  const std = bucket.n > 1 ? Math.sqrt(Math.max(0, bucket.reward_m2 / (bucket.n - 1))) : Infinity;
  const ciLower = bucket.reward_mean - 1.96 * (std / Math.sqrt(Math.max(1, bucket.n)));
  if (!(ciLower > baselineMean)) reasons.push(`CI lower ${ciLower.toFixed(3)} ≤ baseline ${baselineMean.toFixed(3)}`);

  return { context_key: bucket.context_key, param_bucket: bucket.param_bucket, eligible: reasons.length === 0, reasons };
}

export interface ReflectionReport {
  ran_at_note: string;
  buckets_checked: number;
  promoted: PromotionResult[];
  demoted: PromotionResult[];
  new_semantic: number;
}

export async function runReflection(ownerId: number): Promise<ReflectionReport> {
  const rows = (await db.query(
    `SELECT owner_id, context_key, param_bucket, n, reward_mean, reward_m2, verified_n, live_paper_n, windows, promoted
       FROM agent_policy WHERE owner_id=$1`,
    [ownerId],
  )).rows as Array<{ owner_id: number; context_key: string; param_bucket: unknown; n: string; reward_mean: string; reward_m2: string; verified_n: number; live_paper_n: number; windows: number; promoted: boolean }>;

  // Baseline per context = the lowest reward_mean bucket in that context.
  const baselineByCtx = new Map<string, number>();
  for (const r of rows) {
    const m = Number(r.reward_mean);
    const cur = baselineByCtx.get(r.context_key);
    if (cur === undefined || m < cur) baselineByCtx.set(r.context_key, m);
  }

  const promoted: PromotionResult[] = [];
  const demoted: PromotionResult[] = [];
  let newSemantic = 0;

  for (const r of rows) {
    const res = await checkPromotionGates(
      { owner_id: Number(r.owner_id), context_key: r.context_key, param_bucket: r.param_bucket,
        n: Number(r.n), reward_mean: Number(r.reward_mean), reward_m2: Number(r.reward_m2),
        verified_n: r.verified_n, live_paper_n: r.live_paper_n, windows: r.windows },
      baselineByCtx.get(r.context_key) ?? 0,
    );
    if (res.eligible && !r.promoted) {
      await db.query(`UPDATE agent_policy SET promoted=true WHERE owner_id=$1 AND context_key=$2 AND param_bucket=$3::jsonb`,
        [ownerId, r.context_key, JSON.stringify(r.param_bucket)]);
      promoted.push(res);
      await writeSemantic(ownerId,
        `For ${r.context_key}, params ${JSON.stringify(r.param_bucket)} are preferred (mean reward ${Number(r.reward_mean).toFixed(3)} over n=${r.n}, verified_n=${r.verified_n}).`,
        { confidence: 0.7, verificationWeight: r.verified_n > 0 ? 1.0 : 0.7, evidence: { context_key: r.context_key } },
      ).then(() => { newSemantic++; }).catch(() => {});
    } else if (!res.eligible && r.promoted) {
      await db.query(`UPDATE agent_policy SET promoted=false WHERE owner_id=$1 AND context_key=$2 AND param_bucket=$3::jsonb`,
        [ownerId, r.context_key, JSON.stringify(r.param_bucket)]);
      demoted.push(res);
    }
  }

  // Decay old episodes (half-life ~30 days) so stale evidence loses recall weight.
  await db.query(
    `UPDATE agent_episodes SET decay_score = GREATEST(0.05, exp(-EXTRACT(EPOCH FROM (now()-ts))/(30*86400)))
       WHERE owner_id=$1 AND deleted_at IS NULL`,
    [ownerId],
  ).catch(() => {});

  return { ran_at_note: "reflection complete", buckets_checked: rows.length, promoted, demoted, new_semantic: newSemantic };
}

// Scheduled reflection: run runReflection() for every owner who has accumulated policy buckets, so
// promotions/demotions and episode decay happen on a cadence (CryptoTrade's periodic reflection
// agent — feeding refined lessons back into recall) rather than only on demand. Best-effort per owner.
export async function runScheduledReflection(): Promise<{ owners: number; promoted: number }> {
  const owners = (await db.query(`SELECT DISTINCT owner_id FROM agent_policy`)).rows as Array<{ owner_id: string }>;
  let promoted = 0;
  for (const o of owners) {
    const r = await runReflection(Number(o.owner_id)).catch(() => null);
    if (r) promoted += r.promoted.length;
  }
  return { owners: owners.length, promoted };
}

// The "what I learned" report: currently-promoted buckets + recent semantic facts.
export async function learnedReport(ownerId: number): Promise<Record<string, unknown>> {
  const promoted = (await db.query(
    `SELECT context_key, param_bucket, n, round(reward_mean::numeric,3) AS reward_mean, verified_n, live_paper_n, windows
       FROM agent_policy WHERE owner_id=$1 AND promoted=true ORDER BY reward_mean DESC`,
    [ownerId],
  )).rows;
  const semantic = (await db.query(
    `SELECT statement, confidence, scope, updated_at FROM agent_semantic
       WHERE (owner_id=$1 OR scope='global') AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20`,
    [ownerId],
  )).rows;
  const policyCount = Number((await db.query(`SELECT COUNT(*) n FROM agent_policy WHERE owner_id=$1`, [ownerId])).rows[0].n);
  return { promoted_buckets: promoted, semantic_facts: semantic, total_policy_buckets: policyCount };
}
