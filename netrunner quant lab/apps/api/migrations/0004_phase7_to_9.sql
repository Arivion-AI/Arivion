ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS run_hash TEXT,
  ADD COLUMN IF NOT EXISTS strategy_hash_at_run TEXT,
  ADD COLUMN IF NOT EXISTS data_snapshot_id TEXT NOT NULL DEFAULT 'canonical-v1',
  ADD COLUMN IF NOT EXISTS liquidation_events INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approximate_fills BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS risk_snapshots (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES backtest_runs(run_id) ON DELETE CASCADE,
  total_return_after_fees_funding NUMERIC(18,8) NOT NULL,
  sharpe NUMERIC(18,8) NOT NULL,
  calmar NUMERIC(18,8) NOT NULL,
  max_drawdown NUMERIC(18,8) NOT NULL,
  consistency NUMERIC(18,8) NOT NULL,
  robustness NUMERIC(18,8) NOT NULL,
  live_paper_score NUMERIC(18,8) NOT NULL DEFAULT 0,
  liquidation_events INTEGER NOT NULL DEFAULT 0,
  data_coverage_complete BOOLEAN NOT NULL DEFAULT TRUE,
  overfit_penalty NUMERIC(18,8) NOT NULL DEFAULT 0,
  approximate_fills BOOLEAN NOT NULL DEFAULT FALSE,
  hard_gates_passed BOOLEAN NOT NULL,
  gate_failures_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  base_score NUMERIC(18,8) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leaderboard_passports (
  passport_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES backtest_runs(run_id) ON DELETE CASCADE,
  strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(strategy_version_id),
  tier TEXT NOT NULL,
  status TEXT NOT NULL,
  ranked BOOLEAN NOT NULL DEFAULT FALSE,
  local_score NUMERIC(18,8),
  official_score NUMERIC(18,8),
  final_score NUMERIC(18,8),
  local_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  official_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification_hash TEXT,
  run_hash TEXT,
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_passports_ranked
  ON leaderboard_passports (ranked, tier, final_score DESC NULLS LAST);
