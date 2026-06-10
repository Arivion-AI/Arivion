CREATE TABLE IF NOT EXISTS strategies (
  strategy_id TEXT PRIMARY KEY,
  owner_id BIGINT REFERENCES users(id),
  name TEXT NOT NULL,
  current_version_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE strategy_versions
  ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS dependency_lock TEXT,
  ADD COLUMN IF NOT EXISTS schema_version TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

INSERT INTO strategies (strategy_id, owner_id, name, current_version_id)
SELECT DISTINCT sv.strategy_id, sv.owner_id, sv.strategy_id, sv.strategy_version_id
FROM strategy_versions sv
ON CONFLICT (strategy_id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_strategy_versions_strategy'
  ) THEN
    ALTER TABLE strategy_versions
      ADD CONSTRAINT fk_strategy_versions_strategy
      FOREIGN KEY (strategy_id) REFERENCES strategies(strategy_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS paper_accounts (
  account_id TEXT PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id),
  starting_balance NUMERIC(38,18) NOT NULL,
  quote_currency TEXT NOT NULL DEFAULT 'USDT',
  mode TEXT NOT NULL DEFAULT 'paper',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES paper_accounts(account_id),
  strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(strategy_version_id),
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ,
  last_seen_ts TIMESTAMPTZ,
  max_data_age_ms INTEGER NOT NULL DEFAULT 30000,
  required_fresh_ticks INTEGER NOT NULL DEFAULT 3,
  reconnecting BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS paper_events (
  event_id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
  strategy_version_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paper_events_session_time ON paper_events (session_id, created_at);

CREATE TABLE IF NOT EXISTS paper_fills (
  fill_id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty NUMERIC(38,18) NOT NULL,
  fill_price NUMERIC(38,18) NOT NULL,
  fee NUMERIC(38,18) NOT NULL DEFAULT 0,
  slippage NUMERIC(38,18) NOT NULL DEFAULT 0,
  ts TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_positions (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  qty NUMERIC(38,18) NOT NULL,
  avg_entry NUMERIC(38,18) NOT NULL,
  realized_pnl NUMERIC(38,18) NOT NULL DEFAULT 0,
  unrealized_pnl NUMERIC(38,18) NOT NULL DEFAULT 0,
  funding_pnl NUMERIC(38,18) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, symbol)
);

CREATE TABLE IF NOT EXISTS optimization_runs (
  run_id TEXT PRIMARY KEY,
  strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(strategy_version_id),
  status TEXT NOT NULL,
  method TEXT NOT NULL,
  config_json JSONB NOT NULL,
  parity_threshold_json JSONB NOT NULL,
  summary_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS optimization_candidates (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES optimization_runs(run_id) ON DELETE CASCADE,
  candidate_rank INTEGER NOT NULL,
  params_json JSONB NOT NULL,
  vector_metrics_json JSONB NOT NULL,
  event_metrics_json JSONB,
  parity_json JSONB,
  event_rescored BOOLEAN NOT NULL DEFAULT FALSE,
  promoteable BOOLEAN NOT NULL DEFAULT FALSE,
  badge TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_optimization_candidates_run_rank ON optimization_candidates (run_id, candidate_rank);
