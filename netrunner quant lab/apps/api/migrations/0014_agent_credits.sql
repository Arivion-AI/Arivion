-- 0014: Duality Copilot v1.1 — Phase 1. LLM Gateway managed-credit ledger.
-- Forward-only (the runner has no down-migrations). All owner_id are BIGINT REFERENCES users(id),
-- consistent with 0012_owner_id_bigint.sql. Money is stored as integer micro-USD (1e-6 USD) so the
-- ledger is exact under concurrency (no float drift). Every reserve/debit/refund is idempotent
-- (idempotency_key) and is written inside a DB transaction that locks the owner's account row.

-- ---------------------------------------------------------------------------------------------
-- Account: one row per owner. managed_balance_micro_usd is the spendable managed credit. It is
-- only ever mutated under SELECT … FOR UPDATE on this row (see apps/agent llm-gateway).
CREATE TABLE IF NOT EXISTS agent_credit_accounts (
  owner_id                  BIGINT PRIMARY KEY REFERENCES users(id),
  currency                  TEXT NOT NULL DEFAULT 'USD',
  managed_balance_micro_usd BIGINT NOT NULL DEFAULT 0,
  lifetime_grants_micro_usd BIGINT NOT NULL DEFAULT 0,
  lifetime_spend_micro_usd  BIGINT NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'active',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_credit_accounts_status_check CHECK (status IN ('active','frozen')),
  CONSTRAINT agent_credit_accounts_balance_nonneg CHECK (managed_balance_micro_usd >= 0)
);

-- ---------------------------------------------------------------------------------------------
-- Append-only ledger. event_type ∈ grant|reserve|reserve_release|debit|refund|adjust.
-- amount_micro_usd is signed by convention: credits to the user are +, debits are -.
-- balance_after_micro_usd is the account balance immediately after applying this event.
CREATE TABLE IF NOT EXISTS agent_credit_ledger (
  id                      BIGSERIAL PRIMARY KEY,
  owner_id                BIGINT NOT NULL REFERENCES users(id),
  run_id                  TEXT,
  step_id                 TEXT,
  reservation_id          TEXT,
  idempotency_key         TEXT,
  event_type              TEXT NOT NULL,
  amount_micro_usd        BIGINT NOT NULL,
  balance_after_micro_usd BIGINT,
  provider_mode           TEXT,
  provider                TEXT,
  model                   TEXT,
  reason                  TEXT,
  metadata                JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: a (owner, idempotency_key) ledger row can exist at most once. This is the primary
-- guard against double-debit on BullMQ replay / network retry / provider timeout retry.
CREATE UNIQUE INDEX IF NOT EXISTS agent_credit_ledger_idem_idx
  ON agent_credit_ledger(owner_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_credit_ledger_owner_ts_idx
  ON agent_credit_ledger(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_credit_ledger_run_idx
  ON agent_credit_ledger(run_id) WHERE run_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Reservation: a pre-debit hold created before the provider call. status ∈
-- reserved|finalized|released. reserved_micro_usd is the worst-case hold; finalized_micro_usd is
-- the actual debit at finalize; the difference is refunded.
CREATE TABLE IF NOT EXISTS agent_credit_reservations (
  id                  TEXT PRIMARY KEY,
  owner_id            BIGINT NOT NULL REFERENCES users(id),
  run_id              TEXT,
  step_id             TEXT,
  idempotency_key     TEXT,
  provider_mode       TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  reserved_micro_usd  BIGINT NOT NULL,
  finalized_micro_usd BIGINT,
  status              TEXT NOT NULL DEFAULT 'reserved',
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at        TIMESTAMPTZ,
  CONSTRAINT agent_credit_reservations_status_check CHECK (status IN ('reserved','finalized','released'))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_credit_reservations_idem_idx
  ON agent_credit_reservations(owner_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_credit_reservations_owner_status_idx
  ON agent_credit_reservations(owner_id, status);

-- ---------------------------------------------------------------------------------------------
-- Usage event: one row per LLM gateway call (managed or BYOK). metering_quality ∈ actual|estimated.
-- duality_credit_debit_micro_usd is what we actually debited managed credit (0 for BYOK).
CREATE TABLE IF NOT EXISTS agent_llm_usage_events (
  id                            BIGSERIAL PRIMARY KEY,
  owner_id                      BIGINT NOT NULL REFERENCES users(id),
  thread_id                     TEXT,
  run_id                        TEXT,
  step_id                       TEXT,
  playbook_id                   TEXT,
  purpose                       TEXT NOT NULL,
  provider_mode                 TEXT NOT NULL,
  provider                      TEXT NOT NULL,
  model                         TEXT NOT NULL,
  request_id                    TEXT,
  provider_request_id           TEXT,
  reservation_id                TEXT,
  idempotency_key               TEXT,
  input_tokens                  BIGINT DEFAULT 0,
  cached_input_tokens           BIGINT DEFAULT 0,
  output_tokens                 BIGINT DEFAULT 0,
  reasoning_tokens              BIGINT DEFAULT 0,
  tool_call_count               BIGINT DEFAULT 0,
  provider_cost_micro_usd       BIGINT DEFAULT 0,
  duality_credit_debit_micro_usd BIGINT DEFAULT 0,
  metering_quality              TEXT NOT NULL DEFAULT 'actual',
  latency_ms                    BIGINT,
  status                        TEXT NOT NULL,
  error_code                    TEXT,
  metadata                      JSONB,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_llm_usage_metering_check CHECK (metering_quality IN ('actual','estimated','unknown'))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_llm_usage_events_idem_idx
  ON agent_llm_usage_events(owner_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_llm_usage_events_owner_ts_idx
  ON agent_llm_usage_events(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_llm_usage_events_run_idx
  ON agent_llm_usage_events(run_id) WHERE run_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Governed price book. A managed call is BLOCKED unless an active row exists (effective_from <= now
-- < effective_to-or-infinity). source_url/fetched_at/effective_from/effective_to make pricing
-- auditable and time-versioned. Prices are micro-USD per 1,000,000 tokens.
CREATE TABLE IF NOT EXISTS agent_model_price_book (
  id                                  BIGSERIAL PRIMARY KEY,
  provider                            TEXT NOT NULL,
  model                               TEXT NOT NULL,
  input_micro_usd_per_mtoken          BIGINT NOT NULL,
  cached_input_micro_usd_per_mtoken   BIGINT,
  output_micro_usd_per_mtoken         BIGINT NOT NULL,
  reasoning_micro_usd_per_mtoken      BIGINT,
  tool_pricing_json                   JSONB,
  context_thresholds_json             JSONB,
  source                              TEXT NOT NULL,
  source_url                          TEXT,
  fetched_at                          TIMESTAMPTZ,
  effective_from                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to                        TIMESTAMPTZ,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, model, effective_from)
);
CREATE INDEX IF NOT EXISTS agent_model_price_book_active_idx
  ON agent_model_price_book(provider, model, effective_from DESC);

-- ---------------------------------------------------------------------------------------------
-- Per-owner model preferences (which model the planner/actor/triage/embedding roles use).
CREATE TABLE IF NOT EXISTS agent_model_preferences (
  owner_id              BIGINT PRIMARY KEY REFERENCES users(id),
  default_provider_mode TEXT NOT NULL DEFAULT 'managed',
  default_provider      TEXT NOT NULL DEFAULT 'venice',
  default_model         TEXT NOT NULL,
  planner_model         TEXT,
  actor_model           TEXT,
  triage_model          TEXT,
  embedding_model       TEXT,
  fallback_policy       TEXT NOT NULL DEFAULT 'ask',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- SEED price rows. NOTE (correction #7/#8): these are PLACEHOLDER prices marked
-- source='SEED_PLACEHOLDER_UNVERIFIED'. They MUST be replaced via the governed price-book ingestion
-- (with verified source_url + fetched_at) before any production managed billing. They exist so the
-- gateway has an active price row in dev/test (a model with no active row is blocked, by design).
-- 'mock' is a deterministic local/test provider (no external call, no real key required).
INSERT INTO agent_model_price_book
  (provider, model, input_micro_usd_per_mtoken, cached_input_micro_usd_per_mtoken,
   output_micro_usd_per_mtoken, reasoning_micro_usd_per_mtoken, source, source_url, fetched_at)
VALUES
  ('mock', 'mock-echo', 0, 0, 0, NULL,
     'SEED_INTERNAL', NULL, now()),
  ('anthropic', 'claude-3-5-haiku', 800000, 80000, 4000000, NULL,
     'SEED_PLACEHOLDER_UNVERIFIED', 'https://www.anthropic.com/pricing', now()),
  ('anthropic', 'claude-3-5-sonnet', 3000000, 300000, 15000000, NULL,
     'SEED_PLACEHOLDER_UNVERIFIED', 'https://www.anthropic.com/pricing', now())
ON CONFLICT (provider, model, effective_from) DO NOTHING;
