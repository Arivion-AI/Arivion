-- Phase 5 — Copilot budget governance + approvals.
-- agent_budget_events is the non-LLM autonomous-action ledger (runs/sweeps/live sessions per day);
-- agent_approvals is the durable record behind every approval gate.

CREATE TABLE IF NOT EXISTS agent_budget_events (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      BIGINT NOT NULL REFERENCES users(id),
  run_id        TEXT,
  kind          TEXT NOT NULL,            -- run|sweep|live_session|tokens
  amount        BIGINT NOT NULL DEFAULT 1,
  reason        TEXT,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_budget_events_owner_ts_idx ON agent_budget_events (owner_id, kind, ts DESC);

CREATE TABLE IF NOT EXISTS agent_approvals (
  id            TEXT PRIMARY KEY,         -- uuid
  run_id        TEXT NOT NULL,
  step_id       TEXT NOT NULL,
  owner_id      BIGINT NOT NULL REFERENCES users(id),
  tool          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|denied
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_approvals_run_idx ON agent_approvals (run_id, step_id);
CREATE INDEX IF NOT EXISTS agent_approvals_owner_status_idx ON agent_approvals (owner_id, status, created_at DESC);
