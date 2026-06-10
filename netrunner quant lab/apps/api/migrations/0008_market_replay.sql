-- 0008: Bybit market-replay execution fidelity.
-- Additive-only foundation for publicTrade capture, queue-aware replay coverage, and
-- live-paper recovery metadata. Defaults preserve the existing bar-based engine.

CREATE TABLE IF NOT EXISTS trades (
  ts TIMESTAMPTZ NOT NULL,
  trade_time_ms BIGINT NOT NULL,
  symbol TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'linear',
  trade_id TEXT NOT NULL,
  side TEXT NOT NULL,
  price NUMERIC(38,18) NOT NULL,
  qty NUMERIC(38,18) NOT NULL,
  source_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_version TEXT NOT NULL DEFAULT 'rt-trade-v1',
  -- The partition column (ts) MUST be part of every unique index on a TimescaleDB hypertable,
  -- so the dedup key is (symbol, category, trade_id, ts). trade_id is stable per
  -- (symbol, category) and ts is derived from the trade time, so one print maps to one row.
  PRIMARY KEY (symbol, category, trade_id, ts)
);

SELECT create_hypertable('trades', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_trades_symbol_time
  ON trades (symbol, category, trade_time_ms);

ALTER TABLE trades
  SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol,category');

DO $$ BEGIN
  PERFORM add_compression_policy('trades', INTERVAL '3 days');
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  PERFORM add_retention_policy('trades', INTERVAL '7 days');
EXCEPTION WHEN others THEN NULL; END $$;

-- live_paper_sessions is normally created lazily by the worker's ensure_table(); create a base
-- here so migrations are self-contained on a fresh DB (the worker's CREATE IF NOT EXISTS then
-- no-ops, and adds its remaining columns). owner_id is BIGINT (the §25-normalized owner type).
CREATE TABLE IF NOT EXISTS live_paper_sessions (
  session_id TEXT PRIMARY KEY,
  owner_id BIGINT,
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'linear',
  params_json JSONB NOT NULL DEFAULT '{}',
  starting_equity NUMERIC NOT NULL DEFAULT 10000,
  interval_minutes INT NOT NULL DEFAULT 1,
  risk_json JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'running',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_tick_at TIMESTAMPTZ,
  last_bar_ms BIGINT,
  bars_seen INT DEFAULT 0,
  final_equity NUMERIC,
  fills_count INT DEFAULT 0,
  performance_json JSONB DEFAULT '{}',
  positions_json JSONB DEFAULT '{}',
  risk_state_json JSONB DEFAULT '{}',
  last_price NUMERIC
);

ALTER TABLE live_paper_sessions
  ADD COLUMN IF NOT EXISTS allow_fallback BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS l2_depth INT DEFAULT 50,
  ADD COLUMN IF NOT EXISTS latency_json JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS runtime_checkpoint_json JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS recovery_blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS recording_json JSONB DEFAULT '{}'::jsonb;

ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS fill_model_json JSONB DEFAULT '{}'::jsonb;
