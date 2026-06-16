-- Phase 3 — Copilot memory (episodic / semantic / procedural) + forget ledger.
-- pgvector is bundled in the timescaledb image (vector 0.8.1). HNSW supports up to 2000 dims for the
-- `vector` type; the embedding model is requested at 1536 dimensions, so vector(1536) fits.
CREATE EXTENSION IF NOT EXISTS vector;

-- Raw events the agent lived through: runs, triggers, approvals, errors, web research, reflections.
CREATE TABLE IF NOT EXISTS agent_episodes (
  id                   BIGSERIAL PRIMARY KEY,
  owner_id             BIGINT NOT NULL REFERENCES users(id),
  ts                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind                 TEXT NOT NULL,                 -- run|trigger|approval|error|web_research|reflection
  regime               TEXT,
  symbol               TEXT,
  symbol_class         TEXT,
  bot_or_strategy      TEXT,
  params               JSONB,
  result_tier          TEXT,                          -- verbatim from the Lab (unverified|verified|LOCAL ONLY|…)
  reward               DOUBLE PRECISION,
  metrics              JSONB,
  run_id               TEXT,
  summary              TEXT,
  source               TEXT NOT NULL DEFAULT 'local', -- local|live_paper|verified|web
  verification_weight  DOUBLE PRECISION NOT NULL DEFAULT 0.3, -- local=0.3, live_paper=0.7, verified=1.0
  confidence           DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  decay_score          DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  embedding_model      TEXT NOT NULL,                 -- recall must filter by this (no cross-model compare)
  embedding            vector(1536),
  evidence             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_episodes_embedding_idx ON agent_episodes USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS agent_episodes_ctx_idx ON agent_episodes (owner_id, regime, symbol_class, ts DESC);
CREATE INDEX IF NOT EXISTS agent_episodes_recall_idx ON agent_episodes (owner_id, deleted_at, embedding_model);

-- Distilled, reusable knowledge produced by the reflection job. scope='global' is the opt-in,
-- de-identified cross-owner pool (Phase 8); owner_id is the contributing owner (nullable for global).
CREATE TABLE IF NOT EXISTS agent_semantic (
  id                   BIGSERIAL PRIMARY KEY,
  owner_id             BIGINT REFERENCES users(id),
  scope                TEXT NOT NULL DEFAULT 'owner',  -- owner|global
  statement            TEXT NOT NULL,
  evidence             JSONB,
  confidence           DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  verification_weight  DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  decay_score          DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  embedding_model      TEXT NOT NULL,
  embedding            vector(1536),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_semantic_embedding_idx ON agent_semantic USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS agent_semantic_scope_idx ON agent_semantic (owner_id, scope, deleted_at);

-- Procedural memory: the learned policy (bandit stats) keyed by context + discretized param bucket.
CREATE TABLE IF NOT EXISTS agent_policy (
  id                   BIGSERIAL PRIMARY KEY,
  owner_id             BIGINT NOT NULL REFERENCES users(id),
  context_key          TEXT NOT NULL,                  -- "regime=R|class=C|bot=B"
  param_bucket         JSONB NOT NULL,                 -- discretized param set
  n                    INT NOT NULL DEFAULT 0,
  reward_mean          DOUBLE PRECISION NOT NULL DEFAULT 0,
  reward_m2            DOUBLE PRECISION NOT NULL DEFAULT 0, -- Welford variance accumulator
  verified_n           INT NOT NULL DEFAULT 0,
  live_paper_n         INT NOT NULL DEFAULT 0,
  windows              INT NOT NULL DEFAULT 0,          -- distinct market windows seen
  promoted             BOOLEAN NOT NULL DEFAULT false,
  last_used            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, context_key, param_bucket)
);
CREATE INDEX IF NOT EXISTS agent_policy_ctx_idx ON agent_policy (owner_id, context_key);

-- Forget ledger: every deletion is auditable; deletions cascade to semantic-confidence recompute.
CREATE TABLE IF NOT EXISTS agent_memory_deletions (
  id                   BIGSERIAL PRIMARY KEY,
  owner_id             BIGINT NOT NULL REFERENCES users(id),
  memory_table         TEXT NOT NULL,
  memory_id            BIGINT NOT NULL,
  reason               TEXT,
  ts                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Embedding model price (Venice AI text embedding, no output).
INSERT INTO agent_model_price_book
  (provider, model, input_micro_usd_per_mtoken, cached_input_micro_usd_per_mtoken,
   output_micro_usd_per_mtoken, reasoning_micro_usd_per_mtoken, source, source_url, fetched_at)
VALUES
  ('venice', 'text-embedding-bge-m3', 20000, 20000, 0, NULL,
     'SEED_PLACEHOLDER_UNVERIFIED', 'https://docs.venice.ai', now())
ON CONFLICT (provider, model, effective_from) DO NOTHING;
