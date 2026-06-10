-- 0009: Live-paper checkpointing + restart recovery (Phase 6).
-- A dedicated checkpoint table (one row per confirmed-bar tick) plus a recovery event
-- ledger column. Recovery itself is deterministic replay from the session start with gap
-- detection; the checkpoint row records the expected post-recovery state for verification.

CREATE TABLE IF NOT EXISTS live_paper_checkpoints (
  checkpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'linear',
  checkpoint_bar_ms BIGINT NOT NULL,
  strategy_id TEXT NOT NULL,
  start_bar_ms BIGINT,
  strategy_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  portfolio_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  open_orders_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  queue_state_json JSONB,
  positions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  equity NUMERIC NOT NULL,
  fills_count INTEGER NOT NULL DEFAULT 0,
  performance_json JSONB,
  fill_model_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lp_checkpoints_session
  ON live_paper_checkpoints (session_id, checkpoint_bar_ms DESC);

-- Lightweight recovery event ledger on the session (RECOVERY_* events, capped).
ALTER TABLE live_paper_sessions
  ADD COLUMN IF NOT EXISTS recovery_events_json JSONB DEFAULT '[]'::jsonb;
