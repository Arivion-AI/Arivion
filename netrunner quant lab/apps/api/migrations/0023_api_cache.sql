-- 0023: External-API cache + monthly usage governor.
-- Backs the rate-limited ingestion layer (GeckoTerminal/CoinGecko/The Graph). The limiter itself
-- lives in Redis (cross-process token bucket); this is the durable cache + month-to-date call ledger.

CREATE TABLE IF NOT EXISTS api_cache (
  cache_key      TEXT PRIMARY KEY,        -- e.g. 'cg:price:bitcoin,ethereum:usd', 'gt:pool:arbitrum:0xabc'
  provider       TEXT NOT NULL,           -- 'coingecko' | 'geckoterminal' | 'thegraph'
  data_type      TEXT NOT NULL,           -- 'spot_price'|'markets'|'ohlcv'|'pool_meta'|'token_meta'|'top_pools'|'trades'|'subgraph'
  payload        JSONB NOT NULL,
  etag           TEXT,                    -- for If-None-Match
  last_modified  TEXT,                    -- for If-Modified-Since
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_seconds    INTEGER NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  is_immutable   BOOLEAN NOT NULL DEFAULT FALSE,  -- closed OHLCV bars never change
  priority       SMALLINT NOT NULL DEFAULT 5
);

-- Scheduler picks only stale, non-immutable rows.
CREATE INDEX IF NOT EXISTS idx_api_cache_refresh
  ON api_cache (provider, expires_at)
  WHERE NOT is_immutable;

-- Month-to-date call ledger per provider (CoinGecko's 10k/month cap is the binding constraint).
CREATE TABLE IF NOT EXISTS api_usage (
  provider    TEXT NOT NULL,
  month       DATE NOT NULL,             -- first day of the month (UTC)
  call_count  BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, month)
);
