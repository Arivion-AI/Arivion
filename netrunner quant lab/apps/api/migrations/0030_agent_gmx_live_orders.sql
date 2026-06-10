-- 0030: Owner-scoped GMX live order ledger.
-- GMX positions are still read from the GMX SDK/account, but launch attempts are recorded here so
-- Copilot can show which strategy/bot produced each live ticket.

CREATE TABLE IF NOT EXISTS agent_gmx_live_orders (
  id            TEXT PRIMARY KEY,
  owner_id      BIGINT NOT NULL REFERENCES users(id),
  chain_id      BIGINT NOT NULL,
  account       TEXT,
  request_id    TEXT,
  status        TEXT NOT NULL DEFAULT 'submitted',
  symbol        TEXT NOT NULL,
  strategy_id   TEXT,
  bot_type      TEXT,
  direction     TEXT,
  collateral_usd DOUBLE PRECISION,
  leverage      DOUBLE PRECISION,
  size_usd      DOUBLE PRECISION,
  ticket        JSONB NOT NULL,
  submitted     JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_gmx_live_orders_owner_idx
  ON agent_gmx_live_orders(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_gmx_live_orders_request_idx
  ON agent_gmx_live_orders(request_id)
  WHERE request_id IS NOT NULL;
