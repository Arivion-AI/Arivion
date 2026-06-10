-- Phase 17 — "Living trader": position lifecycle + risk-state escalation.
-- A managed position binds its EXIT consequences (stop-loss / take-profit ladder / trailing / time
-- exit / max-loss) at ENTRY time. An always-on monitor evaluates open positions against this intent
-- and fires exits autonomously. This is the difference between a static strategy-setter and a living
-- trader: every entry decides what closes it. The Lab is paper-only, so a "position" is a capped
-- live-paper session and an "exit" closes that session — there is no real-order path anywhere.

CREATE TABLE IF NOT EXISTS agent_position_intents (
  id              TEXT PRIMARY KEY,                 -- pos_<uuid>
  owner_id        BIGINT NOT NULL REFERENCES users(id),
  run_id          TEXT,                             -- the run that opened the position
  session_id      TEXT,                             -- live-paper session id (filled once known)
  bot_id          TEXT,
  symbol          TEXT NOT NULL,
  category        TEXT NOT NULL,                    -- spot|linear|xstock
  side            TEXT NOT NULL DEFAULT 'long',     -- long|short
  entry_price     DOUBLE PRECISION NOT NULL,
  -- The exit policy bound at entry (the "consequences"). Validated by positions/exitPolicy.ts.
  exit_policy     JSONB NOT NULL,                   -- {stop_loss, take_profit?, trailing?, time_exit?, max_loss_pct?}
  -- Mutable runtime state the monitor advances each tick.
  runtime         JSONB NOT NULL DEFAULT '{}'::jsonb, -- {high_water, low_water, cleared_tiers:[], current_stop_price}
  state           TEXT NOT NULL DEFAULT 'open',     -- open|closing|closed
  close_reason    TEXT,                             -- stop_loss|trailing_stop|take_profit_final|time_exit|max_loss|risk_halt|manual
  last_mark       DOUBLE PRECISION,
  realized_return DOUBLE PRECISION,                 -- fraction at close (mark vs entry, side-adjusted)
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  time_exit_at    TIMESTAMPTZ                        -- precomputed deadline (opened_at + max_hold_seconds)
);
CREATE INDEX IF NOT EXISTS agent_position_intents_owner_state_idx ON agent_position_intents (owner_id, state, updated_at DESC);
-- The monitor sweeps all OPEN positions across owners; partial index keeps that scan tight.
CREATE INDEX IF NOT EXISTS agent_position_intents_open_idx ON agent_position_intents (state) WHERE state <> 'closed';
CREATE INDEX IF NOT EXISTS agent_position_intents_symbol_idx ON agent_position_intents (symbol, state);

-- Append-only log of every monitor decision on a position (hold/reduce/close + why), so the
-- "living trader" is fully auditable: you can replay exactly why it exited and at what mark.
CREATE TABLE IF NOT EXISTS agent_position_events (
  id            BIGSERIAL PRIMARY KEY,
  intent_id     TEXT NOT NULL REFERENCES agent_position_intents(id),
  owner_id      BIGINT NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL,                      -- hold|reduce|close
  reason        TEXT NOT NULL,                      -- stop_loss|take_profit|trailing_stop|time_exit|max_loss|risk_halt
  mark          DOUBLE PRECISION,
  fraction      DOUBLE PRECISION,                   -- fraction reduced (1.0 = full close)
  unrealized    DOUBLE PRECISION,                   -- unrealized return fraction at decision time
  run_id        TEXT,                               -- the manage_position run that executed an exit
  detail        JSONB,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_position_events_intent_idx ON agent_position_events (intent_id, ts);
CREATE INDEX IF NOT EXISTS agent_position_events_owner_ts_idx ON agent_position_events (owner_id, ts DESC);

-- Risk-state escalation (FinCon-style): a CVaR drop / drawdown breach / consecutive-loss streak can
-- push an owner's agent from 'normal' into 'risk_averse' (no new entries) or 'halted' (exits only),
-- with a cooldown. This complements the existing global + per-owner kill switches.
ALTER TABLE agent_owner_settings
  ADD COLUMN IF NOT EXISTS risk_state        TEXT NOT NULL DEFAULT 'normal',  -- normal|risk_averse|halted
  ADD COLUMN IF NOT EXISTS risk_reason       TEXT,
  ADD COLUMN IF NOT EXISTS risk_cooldown_until TIMESTAMPTZ;
