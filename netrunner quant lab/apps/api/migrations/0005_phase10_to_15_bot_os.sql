-- v4.1 Bybit Bot OS — Phases 10–15
-- §4 unified ledger: bots reuse backtest_runs / paper_sessions; only structure + link tables are new.

CREATE TABLE IF NOT EXISTS bot_templates (
  template_id   TEXT PRIMARY KEY,
  bot_type      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  description   TEXT NOT NULL,
  category      TEXT NOT NULL,
  risk_class    TEXT NOT NULL,
  default_params_json JSONB NOT NULL,
  param_schema_json   JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_template_versions (
  version_id        TEXT PRIMARY KEY,
  template_id       TEXT NOT NULL REFERENCES bot_templates(template_id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,
  param_schema_json JSONB NOT NULL,
  compiler_version  TEXT NOT NULL,
  changelog         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, version)
);

CREATE TABLE IF NOT EXISTS bot_specs (
  bot_spec_id     TEXT PRIMARY KEY,
  owner_id        INTEGER NOT NULL,
  template_version_id TEXT NOT NULL REFERENCES bot_template_versions(version_id),
  bot_type        TEXT NOT NULL,
  name            TEXT NOT NULL,
  universe_json   JSONB NOT NULL,
  params_json     JSONB NOT NULL,
  risk_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  accounting_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_report_json JSONB,
  spec_hash       TEXT NOT NULL,
  parent_bot_spec_id TEXT REFERENCES bot_specs(bot_spec_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_specs_owner ON bot_specs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_specs_type  ON bot_specs(bot_type);

-- §4.1 Link bot_spec_id + compiler_version onto core run tables. NO parallel ledger.
ALTER TABLE backtest_runs  ADD COLUMN IF NOT EXISTS bot_spec_id      TEXT REFERENCES bot_specs(bot_spec_id);
ALTER TABLE backtest_runs  ADD COLUMN IF NOT EXISTS compiler_version TEXT;
ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS bot_spec_id      TEXT REFERENCES bot_specs(bot_spec_id);
ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS compiler_version TEXT;

-- §4.2 Bot structure (NOT accounting — accounting lives in backtest_events / paper_events)
CREATE TABLE IF NOT EXISTS grid_levels (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  run_kind      TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  level_index   INTEGER NOT NULL,
  price         NUMERIC(30,10) NOT NULL,
  side          TEXT NOT NULL,
  qty           NUMERIC(30,10) NOT NULL,
  status        TEXT NOT NULL,
  paired_level_index INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_grid_levels_run ON grid_levels(run_id, run_kind);

CREATE TABLE IF NOT EXISTS bot_cycles (
  cycle_id     TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  run_kind     TEXT NOT NULL,
  cycle_type   TEXT NOT NULL,
  symbol       TEXT,
  cycle_index  INTEGER NOT NULL,
  status       TEXT NOT NULL,
  opened_ts    TIMESTAMPTZ,
  closed_ts    TIMESTAMPTZ,
  pnl          NUMERIC(30,10),
  payload_json JSONB
);
CREATE INDEX IF NOT EXISTS idx_bot_cycles_run ON bot_cycles(run_id, run_kind);

CREATE TABLE IF NOT EXISTS rebalance_events (
  rebalance_id        TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  run_kind            TEXT NOT NULL,
  trigger_type        TEXT NOT NULL,
  target_weights_json JSONB NOT NULL,
  pre_weights_json    JSONB NOT NULL,
  post_weights_json   JSONB,
  orders_json         JSONB,
  timestamp           TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rebalance_events_run ON rebalance_events(run_id, run_kind);

CREATE TABLE IF NOT EXISTS execution_slices (
  slice_id        TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  run_kind        TEXT NOT NULL,
  parent_order_id TEXT,
  slice_index     INTEGER NOT NULL,
  scheduled_ts    TIMESTAMPTZ,
  target_qty      NUMERIC(30,10) NOT NULL,
  executed_qty    NUMERIC(30,10) NOT NULL DEFAULT 0,
  avg_fill_price  NUMERIC(30,10),
  status          TEXT NOT NULL,
  payload_json    JSONB
);
CREATE INDEX IF NOT EXISTS idx_execution_slices_run ON execution_slices(run_id, run_kind);

CREATE TABLE IF NOT EXISTS marketplace_cards (
  card_id          TEXT PRIMARY KEY,
  bot_spec_id      TEXT NOT NULL REFERENCES bot_specs(bot_spec_id),
  run_id           TEXT NOT NULL,
  run_kind         TEXT NOT NULL,
  title            TEXT NOT NULL,
  bot_type         TEXT NOT NULL,
  symbol_set       TEXT[] NOT NULL,
  summary_json     JSONB NOT NULL,
  metrics_json     JSONB NOT NULL,
  risk_json        JSONB NOT NULL,
  data_version     TEXT NOT NULL,
  engine_version   TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  verification_hash TEXT,
  result_tier      TEXT NOT NULL,
  published        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_published ON marketplace_cards(published, result_tier, created_at DESC);

CREATE TABLE IF NOT EXISTS bot_recommendations (
  recommendation_id  TEXT PRIMARY KEY,
  owner_id           INTEGER,
  symbol             TEXT NOT NULL,
  bot_type           TEXT NOT NULL,
  regime_label       TEXT NOT NULL,
  params_json        JSONB NOT NULL,
  expected_risk_json JSONB NOT NULL,
  backtest_run_id    TEXT,
  reason_json        JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_recs_symbol ON bot_recommendations(symbol, created_at DESC);
