-- 0031: Advanced tokenized-stock orders on top of the existing DualityStockVault.
-- Limit orders + multi-leg baskets (one-shot, condition-triggered) and DCA bots (recurring). The
-- always-on stock order engine (apps/api/src/lib/stockOrderEngine.ts) fills these by calling the same
-- executeStockBuy/executeStockSell primitives — no new contract, same on-chain state.

CREATE TABLE IF NOT EXISTS stock_orders (
  id                TEXT PRIMARY KEY,
  owner_id          BIGINT NOT NULL REFERENCES users(id),
  kind              TEXT NOT NULL,                 -- 'limit' | 'basket'
  side              TEXT NOT NULL,                 -- 'buy' | 'sell'
  legs              JSONB NOT NULL,                -- [{symbol, usdg?, stock?}]
  trigger_price_1e8 NUMERIC,                       -- NULL = fill on next tick (market basket)
  comparator        TEXT,                          -- 'lte' | 'gte' (limit only)
  trigger_symbol    TEXT,                          -- symbol whose oracle price arms the trigger
  state             TEXT NOT NULL DEFAULT 'pending', -- pending|filling|filled|cancelled|failed
  created_by        TEXT NOT NULL DEFAULT 'user',  -- user|copilot
  run_id            TEXT,
  fill_tx           TEXT,
  fill_price_1e8    NUMERIC,
  last_error        TEXT,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_orders_state_idx ON stock_orders (state, owner_id);

CREATE TABLE IF NOT EXISTS stock_dca_bots (
  id                TEXT PRIMARY KEY,
  owner_id          BIGINT NOT NULL REFERENCES users(id),
  legs              JSONB NOT NULL,                -- [{symbol, usdg}]
  side              TEXT NOT NULL DEFAULT 'buy',
  usdg_per_run      NUMERIC NOT NULL,
  interval_seconds  BIGINT NOT NULL,
  next_run_at       TIMESTAMPTZ NOT NULL,
  runs_done         INTEGER NOT NULL DEFAULT 0,
  max_runs          INTEGER,
  state             TEXT NOT NULL DEFAULT 'active', -- active|running|paused|done
  created_by        TEXT NOT NULL DEFAULT 'user',
  run_id            TEXT,
  last_tx           TEXT,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_dca_bots_due_idx ON stock_dca_bots (state, next_run_at);

CREATE TABLE IF NOT EXISTS stock_order_events (
  id          BIGSERIAL PRIMARY KEY,
  owner_id    BIGINT NOT NULL,
  order_id    TEXT,
  bot_id      TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  tx          TEXT,
  price_1e8   NUMERIC,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_order_events_owner_idx ON stock_order_events (owner_id, ts DESC);
