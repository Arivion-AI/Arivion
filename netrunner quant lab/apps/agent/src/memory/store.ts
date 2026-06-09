import { db } from "../db.js";
import { config } from "../config.js";
import { llmGateway } from "../llm-gateway/index.js";

// Phase 3 — Copilot memory store. Episodic (what happened), semantic (distilled knowledge), and a
// forget ledger. Vectors are pgvector(1536); recall always filters by embedding_model so vectors
// from different models are never compared, and by deleted_at IS NULL.

// pgvector accepts a vector literal like '[0.1,0.2,...]'. node-pg has no native type, so we format
// it and cast with ::vector in SQL.
function vecLiteral(vec: number[]): string {
  return `[${vec.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
}

export interface EpisodeInput {
  kind: string; // run|trigger|approval|error|web_research|reflection
  regime?: string | null;
  symbol?: string | null;
  symbolClass?: string | null;
  botOrStrategy?: string | null;
  params?: unknown;
  resultTier?: string | null;
  reward?: number | null;
  metrics?: unknown;
  runId?: string | null;
  summary: string;
  source?: string; // local|live_paper|verified|web
  verificationWeight?: number;
  confidence?: number;
  decayScore?: number;
  evidence?: unknown;
}

const SOURCE_WEIGHT: Record<string, number> = { local: 0.3, live_paper: 0.7, verified: 1.0, web: 0.3 };

// Embed the summary and persist an episode. Returns the new id (or null if embedding was skipped).
export async function writeEpisode(ownerId: number, ep: EpisodeInput): Promise<number> {
  const { vector, model } = await llmGateway.embedText({ ownerId, text: ep.summary, runId: ep.runId ?? undefined, purpose: "embedding" });
  const source = ep.source ?? "local";
  const vw = ep.verificationWeight ?? SOURCE_WEIGHT[source] ?? 0.3;
  const r = await db.query<{ id: string }>(
    `INSERT INTO agent_episodes
       (owner_id, kind, regime, symbol, symbol_class, bot_or_strategy, params, result_tier, reward,
        metrics, run_id, summary, source, verification_weight, confidence, decay_score,
        embedding_model, embedding, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::vector,$19)
     RETURNING id`,
    [
      ownerId, ep.kind, ep.regime ?? null, ep.symbol ?? null, ep.symbolClass ?? null,
      ep.botOrStrategy ?? null, ep.params == null ? null : JSON.stringify(ep.params), ep.resultTier ?? null,
      ep.reward ?? null, ep.metrics == null ? null : JSON.stringify(ep.metrics), ep.runId ?? null,
      ep.summary, source, vw, ep.confidence ?? 0.5, ep.decayScore ?? 1.0,
      model, vecLiteral(vector), ep.evidence == null ? null : JSON.stringify(ep.evidence),
    ],
  );
  return Number(r.rows[0].id);
}

// Upsert a semantic statement (produced by reflection). Statements are de-duplicated by exact text
// per owner+scope; a repeat corroborates (confidence up), evidence is merged.
export async function writeSemantic(
  ownerId: number,
  statement: string,
  opts: { scope?: "owner" | "global"; confidence?: number; verificationWeight?: number; evidence?: unknown } = {},
): Promise<number> {
  const scope = opts.scope ?? "owner";
  // Embedding is always metered against the real contributing owner; global rows store owner_id NULL
  // (de-identified, shared) while owner rows store the owner.
  const storeOwner = scope === "global" ? null : ownerId;
  const { vector, model } = await llmGateway.embedText({ ownerId, text: statement, purpose: "embedding" });
  const existing = await db.query<{ id: string; confidence: string }>(
    `SELECT id, confidence FROM agent_semantic WHERE statement=$1 AND scope=$2 AND ((owner_id=$3) OR ($3 IS NULL AND owner_id IS NULL)) AND deleted_at IS NULL`,
    [statement, scope, storeOwner],
  );
  if (existing.rowCount) {
    const conf = Math.min(0.99, Number(existing.rows[0].confidence) + 0.05);
    await db.query(
      `UPDATE agent_semantic SET confidence=$2, evidence=COALESCE($3::jsonb, evidence), updated_at=now() WHERE id=$1`,
      [existing.rows[0].id, conf, opts.evidence == null ? null : JSON.stringify(opts.evidence)],
    );
    return Number(existing.rows[0].id);
  }
  const r = await db.query<{ id: string }>(
    `INSERT INTO agent_semantic (owner_id, scope, statement, evidence, confidence, verification_weight, embedding_model, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector) RETURNING id`,
    [storeOwner, scope, statement, opts.evidence == null ? null : JSON.stringify(opts.evidence),
      opts.confidence ?? 0.6, opts.verificationWeight ?? 0.5, model, vecLiteral(vector)],
  );
  return Number(r.rows[0].id);
}

export interface RecallResult {
  episodes: Array<Record<string, unknown> & { score: number }>;
  semantic: Array<Record<string, unknown> & { score: number }>;
  policy: Array<Record<string, unknown>>;
}

// Recall: embed the goal, vector-search episodes + semantic (owner-scoped + opt-in global semantic),
// score by relevance × decay × verification, and hard-pull the exact policy rows for this context.
export async function recall(
  ownerId: number,
  goal: string,
  context: { regime?: string; symbolClass?: string; botType?: string } = {},
  topN = config.memoryRecallTopN,
): Promise<RecallResult> {
  const { vector, model } = await llmGateway.embedText({ ownerId, text: goal, purpose: "embedding" });
  const qv = vecLiteral(vector);

  const epRows = (await db.query(
    `SELECT id, ts, kind, regime, symbol, symbol_class, bot_or_strategy, result_tier, reward, summary,
            source, verification_weight, decay_score, (embedding <=> $3::vector) AS distance
       FROM agent_episodes
      WHERE owner_id = $1 AND deleted_at IS NULL AND embedding_model = $2 AND embedding IS NOT NULL
      ORDER BY embedding <=> $3::vector LIMIT 20`,
    [ownerId, model, qv],
  )).rows as Array<Record<string, unknown>>;

  const semRows = (await db.query(
    `SELECT id, scope, statement, confidence, verification_weight, decay_score,
            (embedding <=> $2::vector) AS distance
       FROM agent_semantic
      WHERE deleted_at IS NULL AND embedding_model = $1 AND embedding IS NOT NULL
        AND (owner_id = $3 OR scope = 'global')
      ORDER BY embedding <=> $2::vector LIMIT 20`,
    [model, qv, ownerId],
  )).rows as Array<Record<string, unknown>>;

  const score = (row: Record<string, unknown>, typeWeight: number): number => {
    const dist = Number(row.distance ?? 1);
    const relevance = Math.max(0, 1 - dist);
    const decay = Number(row.decay_score ?? 1);
    const vw = Number(row.verification_weight ?? 0.5);
    return relevance * decay * vw * typeWeight;
  };

  const episodes = epRows
    .map((r) => ({ ...r, score: score(r, 1.0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
  const semantic = semRows
    .map((r) => ({ ...r, score: score(r, 1.2) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  let policy: Array<Record<string, unknown>> = [];
  if (context.regime || context.symbolClass || context.botType) {
    const ck = contextKey(context);
    policy = (await db.query(
      `SELECT context_key, param_bucket, n, reward_mean, verified_n, live_paper_n, windows, promoted
         FROM agent_policy WHERE owner_id = $1 AND context_key = $2 ORDER BY promoted DESC, reward_mean DESC`,
      [ownerId, ck],
    )).rows as Array<Record<string, unknown>>;
  }
  return { episodes, semantic, policy };
}

export function contextKey(ctx: { regime?: string; symbolClass?: string; botType?: string }): string {
  return `regime=${ctx.regime ?? "any"}|class=${ctx.symbolClass ?? "any"}|bot=${ctx.botType ?? "any"}`;
}

// Render recalled memory into a compact, token-budgeted block for the system prompt.
export function renderRecallBlock(r: RecallResult): string {
  if (!r.episodes.length && !r.semantic.length && !r.policy.length) return "";
  const lines: string[] = ["Relevant memory (most relevant first):"];
  for (const s of r.semantic) lines.push(`- [knowledge] ${s.statement} (confidence ${Number(s.confidence ?? 0).toFixed(2)})`);
  for (const e of r.episodes) {
    lines.push(`- [past run] ${e.summary}` + (e.result_tier ? ` (tier: ${e.result_tier}, reward ${e.reward ?? "n/a"})` : ""));
  }
  for (const p of r.policy) {
    lines.push(`- [learned policy] ${p.promoted ? "PREFERRED " : ""}${JSON.stringify(p.param_bucket)} — mean reward ${Number(p.reward_mean).toFixed(3)} over n=${p.n}`);
  }
  return lines.join("\n");
}

export interface ListOpts {
  type?: "episodes" | "semantic" | "policy";
  query?: string;
  limit?: number;
}

// Browse/search memory. With a query, episodes/semantic are vector-ranked; otherwise most-recent.
export async function listMemory(ownerId: number, opts: ListOpts = {}): Promise<Record<string, unknown>> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const out: Record<string, unknown> = {};
  const want = (t: string) => !opts.type || opts.type === t;

  let qv: string | null = null;
  let model: string | null = null;
  if (opts.query) {
    const e = await llmGateway.embedText({ ownerId, text: opts.query, purpose: "embedding" });
    qv = vecLiteral(e.vector);
    model = e.model;
  }

  if (want("episodes")) {
    out.episodes = qv
      ? (await db.query(
          `SELECT id, ts, kind, regime, symbol, bot_or_strategy, result_tier, reward, summary, source,
                  verification_weight, decay_score
             FROM agent_episodes WHERE owner_id=$1 AND deleted_at IS NULL AND embedding_model=$2
             ORDER BY embedding <=> $3::vector LIMIT $4`,
          [ownerId, model, qv, limit],
        )).rows
      : (await db.query(
          `SELECT id, ts, kind, regime, symbol, bot_or_strategy, result_tier, reward, summary, source,
                  verification_weight, decay_score
             FROM agent_episodes WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY ts DESC LIMIT $2`,
          [ownerId, limit],
        )).rows;
  }
  if (want("semantic")) {
    out.semantic = (await db.query(
      `SELECT id, scope, statement, confidence, verification_weight, decay_score, evidence, updated_at
         FROM agent_semantic WHERE (owner_id=$1 OR scope='global') AND deleted_at IS NULL
         ORDER BY confidence DESC, updated_at DESC LIMIT $2`,
      [ownerId, limit],
    )).rows;
  }
  if (want("policy")) {
    out.policy = (await db.query(
      `SELECT context_key, param_bucket, n, reward_mean, verified_n, live_paper_n, windows, promoted, last_used
         FROM agent_policy WHERE owner_id=$1 ORDER BY promoted DESC, n DESC LIMIT $2`,
      [ownerId, limit],
    )).rows;
  }
  return out;
}

export async function getMemory(ownerId: number, table: "episodes" | "semantic", id: number): Promise<Record<string, unknown> | null> {
  const tbl = table === "episodes" ? "agent_episodes" : "agent_semantic";
  const r = await db.query(
    `SELECT * FROM ${tbl} WHERE id=$1 AND (owner_id=$2 OR ($2 IS NOT NULL AND scope='global'))`,
    [id, ownerId],
  ).catch(() => db.query(`SELECT * FROM ${tbl} WHERE id=$1 AND owner_id=$2`, [id, ownerId]));
  return r.rowCount ? (r.rows[0] as Record<string, unknown>) : null;
}

// Forget: soft-delete + audit row. Recompute confidence of any semantic statement whose evidence
// references this episode (its support shrank).
export async function forgetMemory(
  ownerId: number,
  table: "episodes" | "semantic",
  id: number,
  reason?: string,
): Promise<boolean> {
  const tbl = table === "episodes" ? "agent_episodes" : "agent_semantic";
  const upd = await db.query(`UPDATE ${tbl} SET deleted_at = now() WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL`, [id, ownerId]);
  if (!upd.rowCount) return false;
  await db.query(
    `INSERT INTO agent_memory_deletions (owner_id, memory_table, memory_id, reason) VALUES ($1,$2,$3,$4)`,
    [ownerId, tbl, id, reason ?? null],
  );
  if (table === "episodes") {
    // Shrink confidence of semantic rows citing this episode id in their evidence.
    await db.query(
      `UPDATE agent_semantic SET confidence = GREATEST(0, confidence - 0.1), updated_at = now()
         WHERE owner_id=$1 AND deleted_at IS NULL AND evidence @> $2::jsonb`,
      [ownerId, JSON.stringify({ episode_ids: [id] })],
    ).catch(() => {});
  }
  return true;
}

export async function patchMemory(
  ownerId: number,
  table: "episodes" | "semantic",
  id: number,
  patch: { note?: string; confidence?: number },
): Promise<boolean> {
  if (table === "semantic" && patch.confidence !== undefined) {
    const r = await db.query(
      `UPDATE agent_semantic SET confidence=$3, updated_at=now() WHERE id=$1 AND owner_id=$2`,
      [id, ownerId, patch.confidence],
    );
    return Boolean(r.rowCount);
  }
  if (patch.note !== undefined) {
    const r = await db.query(
      `UPDATE agent_episodes SET summary = summary || ' | note: ' || $3, updated_at=now() WHERE id=$1 AND owner_id=$2`,
      [id, ownerId, patch.note],
    );
    return Boolean(r.rowCount);
  }
  return false;
}
