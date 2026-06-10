-- 0025: Liquidity-pool positions (the third sleeve: tokens + stocks + LP).
-- Raw Uniswap v3 / Algebra position state synced from The Graph; valuation (amounts, fees, in-range,
-- IL) is computed on read by the worker (quant_core.lp_math). owner_id links a position to a Duality
-- user once their wallet is verified (wallet_links); positions for unlinked wallets carry owner_id NULL.

CREATE TABLE IF NOT EXISTS lp_positions (
  position_id    TEXT PRIMARY KEY,          -- 'univ3:arbitrum:<nftId>'
  owner_id       BIGINT,                    -- Duality owner (via wallet_links); NULL if unlinked
  wallet_address TEXT NOT NULL,
  chain_id       BIGINT NOT NULL,
  pool_id        TEXT NOT NULL REFERENCES dex_pools(pool_id),
  venue_id       TEXT,
  nft_id         TEXT,                      -- subgraph position id / NFT tokenId
  tick_lower     BIGINT NOT NULL,
  tick_upper     BIGINT NOT NULL,
  liquidity      NUMERIC(80,0) NOT NULL,
  deposited_token0           NUMERIC(80,0),
  deposited_token1           NUMERIC(80,0),
  collected_fees_token0      NUMERIC(80,0),
  collected_fees_token1      NUMERIC(80,0),
  fee_growth_inside0_last_x128 NUMERIC(80,0),
  fee_growth_inside1_last_x128 NUMERIC(80,0),
  status         TEXT NOT NULL DEFAULT 'open',  -- 'open' (liquidity>0) | 'closed'
  source         TEXT NOT NULL,
  metadata_json  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lp_positions_wallet_idx ON lp_positions (lower(wallet_address), chain_id);
CREATE INDEX IF NOT EXISTS lp_positions_owner_idx  ON lp_positions (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lp_positions_pool_idx   ON lp_positions (pool_id);
