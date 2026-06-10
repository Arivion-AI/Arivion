-- 0007: Bybit-exactness data foundation (duality_final.md WS-0)
-- Additive only. Captures the public instrument filters and funding-rate caps needed by the
-- venue layer (WS-A conform_order, WS-D funding clamp). All values come from the PUBLIC
-- /v5/market/instruments-info snapshot (no keys, no private endpoints).

ALTER TABLE instrument_snapshots
  ADD COLUMN IF NOT EXISTS extra_filters_json JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Helpful index for point-in-time lookups by data_version (pin a backtest to a snapshot).
CREATE INDEX IF NOT EXISTS idx_instrument_snapshots_symbol_version
  ON instrument_snapshots (symbol, data_version, valid_from DESC);

-- Mark-candle lookups for WS-C liquidation (mark series, not last-trade).
CREATE INDEX IF NOT EXISTS idx_mark_candles_symbol_interval_time
  ON mark_candles (symbol, interval, open_time);

-- WS-0: index-price OHLC series (basis / funding sanity). Public /v5/market/index-price-kline.
CREATE TABLE IF NOT EXISTS index_candles (
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
DO $$ BEGIN PERFORM create_hypertable('index_candles', 'open_time', if_not_exists => TRUE);
EXCEPTION WHEN others THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_index_candles_symbol_interval_time
  ON index_candles (symbol, interval, open_time);
