-- Phase 4 — Copilot event-driven autonomy (shadow triggers).
-- agent_trigger_events records every fire (and why); agent_trigger_config is the per-owner armed set.

CREATE TABLE IF NOT EXISTS agent_trigger_events (
  id            TEXT PRIMARY KEY,                 -- uuid
  owner_id      BIGINT NOT NULL REFERENCES users(id),
  trigger_type  TEXT NOT NULL,                    -- volatility_spike|regime_flip|funding_extreme|volume_spike|drawdown|coverage|scheduled
  symbol        TEXT,
  regime        TEXT,
  signal        JSONB,                            -- raw condition values {vol_pct, threshold, funding_rate, …}
  confidence    DOUBLE PRECISION,                 -- 0..1; low confidence is forced to shadow
  dedupe_key    TEXT,                             -- hash(owner, type, symbol, regime, bar bucket)
  mode          TEXT NOT NULL,                    -- shadow|live
  acted         BOOLEAN NOT NULL DEFAULT false,   -- did we execute a playbook?
  proposed_playbook TEXT,                         -- which playbook would run / ran
  plan          JSONB,                            -- the proposed typed plan (shadow) for review
  run_id        TEXT,                             -- FK to agent_runs.id if executed; NULL if shadow
  woke_reason   TEXT,                             -- human-readable "why I woke up"
  ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_trigger_events_dedupe_idx ON agent_trigger_events (owner_id, dedupe_key, ts DESC);
CREATE INDEX IF NOT EXISTS agent_trigger_events_owner_ts_idx ON agent_trigger_events (owner_id, ts DESC);
CREATE INDEX IF NOT EXISTS agent_trigger_events_mode_idx ON agent_trigger_events (owner_id, mode, acted, ts DESC);

-- Per-owner trigger arming + thresholds. One row per (owner, trigger_type).
CREATE TABLE IF NOT EXISTS agent_trigger_config (
  owner_id        BIGINT NOT NULL REFERENCES users(id),
  trigger_type    TEXT NOT NULL,
  armed           BOOLEAN NOT NULL DEFAULT false,
  threshold       DOUBLE PRECISION,               -- type-specific (vol multiple, funding rate, etc.)
  cooldown_seconds INT NOT NULL DEFAULT 1800,
  default_mode    TEXT NOT NULL DEFAULT 'shadow',  -- shadow|live (live requires L2+ at fire time)
  quiet_hours     INT[] DEFAULT '{}',             -- UTC hours during which the trigger never fires
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, trigger_type)
);

-- Per-owner kill switches / autonomy (Phase 4/5 governance).
CREATE TABLE IF NOT EXISTS agent_owner_settings (
  owner_id              BIGINT PRIMARY KEY REFERENCES users(id),
  autonomy_level        TEXT NOT NULL DEFAULT 'L1',  -- L0|L1|L1_5_shadow|L2|L3
  agent_enabled         BOOLEAN NOT NULL DEFAULT true,
  disable_triggers      BOOLEAN NOT NULL DEFAULT false,
  disable_web           BOOLEAN NOT NULL DEFAULT false,
  disable_memory_writes BOOLEAN NOT NULL DEFAULT false,
  disable_live_paper_start BOOLEAN NOT NULL DEFAULT false,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
