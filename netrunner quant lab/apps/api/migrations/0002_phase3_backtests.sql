CREATE TABLE IF NOT EXISTS backtest_runs (
  run_id TEXT PRIMARY KEY,
  strategy_version_id TEXT NOT NULL,
  data_version TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  seed INTEGER NOT NULL,
  status TEXT NOT NULL,
  result_tier TEXT NOT NULL,
  config_json JSONB NOT NULL,
  metrics_json JSONB NOT NULL,
  coverage_proof_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (strategy_version_id) REFERENCES strategy_versions(strategy_version_id)
);

CREATE TABLE IF NOT EXISTS backtest_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_ts TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (run_id) REFERENCES backtest_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_strategy_created ON backtest_runs (strategy_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_events_run_time ON backtest_events (run_id, event_ts);
