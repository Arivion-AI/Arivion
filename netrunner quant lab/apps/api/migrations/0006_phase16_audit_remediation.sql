-- Phase 16 audit remediation: canonical replay, ranking hardening,
-- durable backfill queue state, and L2 orderbook storage.

ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS replay_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS event_digest TEXT,
  ADD COLUMN IF NOT EXISTS canonical_range_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS canonical_range_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS canonical_source TEXT NOT NULL DEFAULT 'candles_v1',
  ADD COLUMN IF NOT EXISTS official_metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE leaderboard_passports
  ADD COLUMN IF NOT EXISTS rank_score NUMERIC(18,8);

ALTER TABLE marketplace_cards
  ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS rank_score NUMERIC(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS eligibility_labels_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS published_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_marketplace_rank_score
  ON marketplace_cards (published, result_tier, rank_score DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS l2_snapshots (
  id BIGSERIAL,
  ts TIMESTAMPTZ NOT NULL,
  symbol TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'linear',
  sequence_id BIGINT,
  checksum TEXT,
  best_bid NUMERIC(38,18),
  best_ask NUMERIC(38,18),
  bid_levels_json JSONB NOT NULL,
  ask_levels_json JSONB NOT NULL,
  source_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_version TEXT NOT NULL DEFAULT 'v1',
  PRIMARY KEY (id, ts),
  UNIQUE (symbol, category, ts, sequence_id)
);
SELECT create_hypertable('l2_snapshots', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_l2_snapshots_symbol_ts
  ON l2_snapshots (symbol, category, ts DESC);

ALTER TABLE l2_snapshots
  SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol,category');
DO $$ BEGIN
  PERFORM add_compression_policy('l2_snapshots', INTERVAL '3 days');
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  PERFORM add_retention_policy('l2_snapshots', INTERVAL '7 days');
EXCEPTION WHEN others THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS backfill_queue_state (
  id BIGSERIAL PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  queue_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  next_run_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backfill_queue_state_status
  ON backfill_queue_state (queue_name, status, next_run_at NULLS LAST, updated_at DESC);

CREATE TABLE IF NOT EXISTS backfill_schedules (
  schedule_id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  category TEXT NOT NULL,
  interval TEXT NOT NULL,
  cadence_cron TEXT NOT NULL,
  lookback_ms BIGINT NOT NULL,
  payload_template_json JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backfill_schedules_enabled
  ON backfill_schedules (enabled, queue_name, endpoint, symbol, interval);
