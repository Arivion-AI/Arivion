CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS candles (
  id BIGSERIAL,
  symbol TEXT NOT NULL,
  category TEXT NOT NULL,
  interval TEXT NOT NULL,
  open_time TIMESTAMPTZ NOT NULL,
  open NUMERIC(20,10) NOT NULL,
  high NUMERIC(20,10) NOT NULL,
  low NUMERIC(20,10) NOT NULL,
  close NUMERIC(20,10) NOT NULL,
  volume NUMERIC(38,18) NOT NULL,
  turnover NUMERIC(38,18) NOT NULL,
  data_version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  source_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, open_time),
  UNIQUE (symbol, category, interval, open_time)
);
SELECT create_hypertable('candles', 'open_time', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS mark_candles (
  id BIGSERIAL,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  open_time TIMESTAMPTZ NOT NULL,
  open NUMERIC(20,10) NOT NULL,
  high NUMERIC(20,10) NOT NULL,
  low NUMERIC(20,10) NOT NULL,
  close NUMERIC(20,10) NOT NULL,
  data_version TEXT NOT NULL,
  source_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, open_time),
  UNIQUE (symbol, interval, open_time)
);
SELECT create_hypertable('mark_candles', 'open_time', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS funding_rates (
  id BIGSERIAL,
  symbol TEXT NOT NULL,
  category TEXT NOT NULL,
  funding_rate NUMERIC(18,12) NOT NULL,
  funding_rate_timestamp TIMESTAMPTZ NOT NULL,
  source_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_version TEXT NOT NULL,
  PRIMARY KEY (id, funding_rate_timestamp),
  UNIQUE (symbol, category, funding_rate_timestamp)
);
SELECT create_hypertable('funding_rates', 'funding_rate_timestamp', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS open_interest (
  id BIGSERIAL,
  symbol TEXT NOT NULL,
  interval_time TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  open_interest NUMERIC(38,18) NOT NULL,
  data_version TEXT NOT NULL,
  source_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, ts),
  UNIQUE (symbol, interval_time, ts)
);
SELECT create_hypertable('open_interest', 'ts', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS long_short_ratio (
  id BIGSERIAL,
  symbol TEXT NOT NULL,
  period TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  buy_ratio NUMERIC(18,12) NOT NULL,
  sell_ratio NUMERIC(18,12) NOT NULL,
  data_version TEXT NOT NULL,
  source_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, ts),
  UNIQUE (symbol, period, ts)
);
SELECT create_hypertable('long_short_ratio', 'ts', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS instrument_snapshots (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  tick_size NUMERIC(20,10) NOT NULL,
  qty_step NUMERIC(20,10) NOT NULL,
  funding_interval_minutes INTEGER,
  max_leverage NUMERIC(10,4),
  maintenance_margin_tiers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  data_version TEXT NOT NULL,
  source_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, valid_from)
);

CREATE TABLE IF NOT EXISTS data_coverage (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  category TEXT NOT NULL,
  interval TEXT NOT NULL,
  range_start TIMESTAMPTZ NOT NULL,
  range_end TIMESTAMPTZ NOT NULL,
  expected_bars INTEGER NOT NULL,
  actual_bars INTEGER NOT NULL,
  missing_bars INTEGER NOT NULL,
  duplicate_bars INTEGER NOT NULL,
  data_version TEXT NOT NULL,
  subject_to_retention BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(symbol, category, interval, range_start, range_end, data_version)
);

CREATE TABLE IF NOT EXISTS strategy_versions (
  strategy_version_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  dsl_json JSONB NOT NULL,
  validation_report_json JSONB,
  hash TEXT,
  schema_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backfill_jobs (
  id BIGSERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL,
  category TEXT NOT NULL,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  start_ts TIMESTAMPTZ NOT NULL,
  end_ts TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  pages_requested INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  gaps_found INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_candles_symbol_interval_time ON candles (symbol, category, interval, open_time);
CREATE INDEX IF NOT EXISTS idx_funding_symbol_time ON funding_rates (symbol, category, funding_rate_timestamp);
CREATE INDEX IF NOT EXISTS idx_oi_symbol_time ON open_interest (symbol, interval_time, ts);
CREATE INDEX IF NOT EXISTS idx_lsr_symbol_time ON long_short_ratio (symbol, period, ts);

ALTER TABLE candles SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol,category,interval');
ALTER TABLE mark_candles SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol,interval');
ALTER TABLE funding_rates SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol,category');
ALTER TABLE open_interest SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol,interval_time');
ALTER TABLE long_short_ratio SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol,period');

DO $$ BEGIN
  PERFORM add_compression_policy('candles', INTERVAL '14 days');
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  PERFORM add_compression_policy('mark_candles', INTERVAL '14 days');
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  PERFORM add_compression_policy('funding_rates', INTERVAL '30 days');
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  PERFORM add_compression_policy('open_interest', INTERVAL '30 days');
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  PERFORM add_compression_policy('long_short_ratio', INTERVAL '30 days');
EXCEPTION WHEN others THEN NULL; END $$;
