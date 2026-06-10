-- 0015: Duality Copilot v1.1 — Phase 3. Chat spine base tables (threads, messages, runs, steps).
-- Forward-only. owner_id BIGINT REFERENCES users(id). Runs/steps carry honesty + cost so the Agent
-- Console can audit every step (honesty fields are never dropped — core rule).

CREATE TABLE IF NOT EXISTS agent_threads (
  id             TEXT PRIMARY KEY,
  owner_id       BIGINT NOT NULL REFERENCES users(id),
  title          TEXT,
  autonomy_level TEXT NOT NULL DEFAULT 'L1',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_threads_autonomy_check CHECK (autonomy_level IN ('L0','L1','L1_5_shadow','L2','L3'))
);
CREATE INDEX IF NOT EXISTS agent_threads_owner_idx ON agent_threads(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
  id         BIGSERIAL PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES agent_threads(id),
  owner_id   BIGINT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL,
  content    TEXT,
  tool_calls JSONB,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_messages_thread_idx ON agent_messages(thread_id, ts ASC, id ASC);

CREATE TABLE IF NOT EXISTS agent_runs (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT REFERENCES agent_threads(id),
  owner_id    BIGINT NOT NULL REFERENCES users(id),
  goal        TEXT,
  plan        JSONB,
  playbook_id TEXT,
  status      TEXT,
  cost_tokens BIGINT DEFAULT 0,
  cost_micro_usd BIGINT DEFAULT 0,
  started     TIMESTAMPTZ,
  ended       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_runs_owner_idx ON agent_runs(owner_id, started DESC);
CREATE INDEX IF NOT EXISTS agent_runs_thread_idx ON agent_runs(thread_id);

CREATE TABLE IF NOT EXISTS agent_run_steps (
  id                 BIGSERIAL PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES agent_runs(id),
  owner_id           BIGINT NOT NULL REFERENCES users(id),
  step_id            TEXT,
  state              TEXT,
  tool               TEXT,
  rationale          TEXT,
  params             JSONB,
  result             JSONB,
  honesty            JSONB,
  guardrail_decision TEXT,
  cost_tokens        INT DEFAULT 0,
  cost_micro_usd     BIGINT DEFAULT 0,
  ts                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_run_steps_run_idx ON agent_run_steps(run_id, ts ASC, id ASC);
