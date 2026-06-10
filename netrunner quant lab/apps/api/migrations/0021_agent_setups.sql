-- Phase 27 — saved trading setups. A "setup" is a finalized, editable basket spec (legs + allocations
-- + risk + budget + the backtest summary it was validated with). The user designs it on the Nexa board,
-- saves it, revisits it later, and launches it as a live-paper portfolio session (Bybit live is a
-- separate, deliberately-gated build). Owner-scoped.

CREATE TABLE IF NOT EXISTS agent_setups (
  id           TEXT PRIMARY KEY,                 -- setup_<uuid>
  owner_id     BIGINT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  spec         JSONB NOT NULL,                   -- {budget_usd, risk, asset_classes, legs:[{symbol,allocation,price,category,asset_class}], weighting, rebalance_threshold, duration_days, summary}
  status       TEXT NOT NULL DEFAULT 'draft',    -- draft|launched
  last_run_id  TEXT,                             -- the run that opened the live-paper session on launch
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_setups_owner_idx ON agent_setups (owner_id, updated_at DESC);
