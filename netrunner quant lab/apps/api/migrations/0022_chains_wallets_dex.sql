-- 0022: Duality on-chain data plane.
-- Additive schema for Arbitrum DEX data, testnet wallet links, and guarded testnet intents.

CREATE TABLE IF NOT EXISTS chains (
  chain_id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('evm')),
  rpc_url_key TEXT NOT NULL,
  ws_url_key TEXT,
  explorer_url TEXT,
  native_currency_symbol TEXT NOT NULL,
  native_currency_decimals INTEGER NOT NULL DEFAULT 18,
  is_testnet BOOLEAN NOT NULL DEFAULT FALSE,
  data_role TEXT NOT NULL CHECK (data_role IN ('none','market_data','reference','testnet')),
  execution_role TEXT NOT NULL CHECK (execution_role IN ('none','testnet','mainnet')),
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO chains (
  chain_id, name, slug, kind, rpc_url_key, ws_url_key, explorer_url,
  native_currency_symbol, native_currency_decimals, is_testnet, data_role,
  execution_role, capabilities
) VALUES
  (42161, 'Arbitrum One', 'arbitrum-one', 'evm', 'ARBITRUM_ONE_RPC_URL', 'ARBITRUM_ONE_WS_URL',
   'https://arbiscan.io', 'ETH', 18, FALSE, 'market_data', 'none',
   '{"dex_data":true,"testnet_actions":false,"data_only":true}'::jsonb),
  (421614, 'Arbitrum Sepolia', 'arbitrum-sepolia', 'evm', 'ARBITRUM_SEPOLIA_RPC_URL', 'ARBITRUM_SEPOLIA_WS_URL',
   'https://sepolia.arbiscan.io', 'ETH', 18, TRUE, 'testnet', 'testnet',
   '{"dex_data":false,"testnet_actions":true,"wallet_balances":true}'::jsonb),
  (46630, 'Robinhood Chain Testnet', 'robinhood-testnet', 'evm', 'ROBINHOOD_TESTNET_RPC_URL', 'ROBINHOOD_TESTNET_WS_URL',
   'https://explorer.testnet.chain.robinhood.com', 'ETH', 18, TRUE, 'testnet', 'testnet',
   '{"wallet_balances":true,"test_stock_tokens":true,"testnet_actions":true}'::jsonb)
ON CONFLICT (chain_id) DO UPDATE SET
  name = EXCLUDED.name,
  slug = EXCLUDED.slug,
  rpc_url_key = EXCLUDED.rpc_url_key,
  ws_url_key = EXCLUDED.ws_url_key,
  explorer_url = EXCLUDED.explorer_url,
  native_currency_symbol = EXCLUDED.native_currency_symbol,
  native_currency_decimals = EXCLUDED.native_currency_decimals,
  is_testnet = EXCLUDED.is_testnet,
  data_role = EXCLUDED.data_role,
  execution_role = EXCLUDED.execution_role,
  capabilities = EXCLUDED.capabilities,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS token_registry (
  chain_id BIGINT NOT NULL REFERENCES chains(chain_id),
  address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 18,
  asset_class TEXT NOT NULL DEFAULT 'crypto',
  is_testnet_asset BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'manual',
  underlying_symbol TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, address)
);
CREATE INDEX IF NOT EXISTS token_registry_chain_symbol_idx ON token_registry (chain_id, symbol);
CREATE INDEX IF NOT EXISTS token_registry_lower_address_idx ON token_registry (chain_id, lower(address));

INSERT INTO token_registry (
  chain_id, address, symbol, name, decimals, asset_class, is_testnet_asset, source, underlying_symbol, metadata_json
) VALUES
  (46630, '0x7943e237c7F95DA44E0301572D358911207852Fa', 'WETH', 'Wrapped Ether', 18, 'crypto', TRUE, 'robinhood_docs', 'ETH', '{"testnet_only":true}'::jsonb),
  (46630, '0x7E955252E15c84f5768B83c41a71F9eba181802F', 'USDG', 'USDG', 18, 'stablecoin', TRUE, 'robinhood_docs', 'USD', '{"testnet_only":true}'::jsonb),
  (46630, '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E', 'TSLA', 'Tesla Test Stock Token', 18, 'test_stock', TRUE, 'robinhood_docs', 'TSLA', '{"testnet_only":true,"no_production_rights":true}'::jsonb),
  (46630, '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02', 'AMZN', 'Amazon Test Stock Token', 18, 'test_stock', TRUE, 'robinhood_docs', 'AMZN', '{"testnet_only":true,"no_production_rights":true}'::jsonb),
  (46630, '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0', 'PLTR', 'Palantir Test Stock Token', 18, 'test_stock', TRUE, 'robinhood_docs', 'PLTR', '{"testnet_only":true,"no_production_rights":true}'::jsonb),
  (46630, '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93', 'NFLX', 'Netflix Test Stock Token', 18, 'test_stock', TRUE, 'robinhood_docs', 'NFLX', '{"testnet_only":true,"no_production_rights":true}'::jsonb),
  (46630, '0x71178BAc73cBeb415514eB542a8995b82669778d', 'AMD', 'AMD Test Stock Token', 18, 'test_stock', TRUE, 'robinhood_docs', 'AMD', '{"testnet_only":true,"no_production_rights":true}'::jsonb)
ON CONFLICT (chain_id, address) DO UPDATE SET
  symbol = EXCLUDED.symbol,
  name = EXCLUDED.name,
  decimals = EXCLUDED.decimals,
  asset_class = EXCLUDED.asset_class,
  is_testnet_asset = EXCLUDED.is_testnet_asset,
  source = EXCLUDED.source,
  underlying_symbol = EXCLUDED.underlying_symbol,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS dex_venues (
  venue_id TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL REFERENCES chains(chain_id),
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  router_address TEXT,
  factory_address TEXT,
  quoter_address TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dex_venues_chain_idx ON dex_venues (chain_id, status);

INSERT INTO dex_venues (venue_id, chain_id, name, adapter, status, metadata_json)
VALUES
  ('uniswap-v3-arbitrum', 42161, 'Uniswap v3 Arbitrum', 'uniswap_v3', 'api_backed', '{"source":"geckoterminal"}'::jsonb),
  ('camelot-arbitrum', 42161, 'Camelot Arbitrum', 'camelot', 'api_backed', '{"source":"geckoterminal"}'::jsonb),
  ('rh-testnet-stock', 46630, 'Robinhood Chain Test Stock Adapter', 'rh_testnet', 'read_only', '{"testnet_only":true}'::jsonb)
ON CONFLICT (venue_id) DO UPDATE SET
  chain_id = EXCLUDED.chain_id,
  name = EXCLUDED.name,
  adapter = EXCLUDED.adapter,
  status = EXCLUDED.status,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS dex_pools (
  pool_id TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL REFERENCES chains(chain_id),
  venue_id TEXT NOT NULL REFERENCES dex_venues(venue_id),
  pool_address TEXT NOT NULL,
  token0_address TEXT,
  token1_address TEXT,
  token0_symbol TEXT,
  token1_symbol TEXT,
  fee_bps INTEGER,
  tick_spacing INTEGER,
  created_block BIGINT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'manual',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dex_pools_chain_token_idx ON dex_pools (chain_id, token0_symbol, token1_symbol);
CREATE UNIQUE INDEX IF NOT EXISTS dex_pools_chain_lower_address_uidx ON dex_pools (chain_id, lower(pool_address));

CREATE TABLE IF NOT EXISTS dex_pool_snapshots (
  id BIGSERIAL,
  pool_id TEXT NOT NULL REFERENCES dex_pools(pool_id) ON DELETE CASCADE,
  block_number BIGINT NOT NULL DEFAULT 0,
  ts TIMESTAMPTZ NOT NULL,
  sqrt_price_x96 NUMERIC(80,0),
  tick BIGINT,
  liquidity NUMERIC(38,18),
  reserve0 NUMERIC(38,18),
  reserve1 NUMERIC(38,18),
  price_native NUMERIC(38,18),
  price_usd NUMERIC(38,18),
  source TEXT NOT NULL,
  checksum TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, ts),
  UNIQUE (pool_id, block_number, ts, source)
);
SELECT create_hypertable('dex_pool_snapshots', 'ts', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS dex_pool_snapshots_pool_block_idx ON dex_pool_snapshots (pool_id, block_number DESC);

CREATE TABLE IF NOT EXISTS dex_swaps (
  id BIGSERIAL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL DEFAULT 0,
  pool_id TEXT NOT NULL REFERENCES dex_pools(pool_id) ON DELETE CASCADE,
  block_number BIGINT NOT NULL DEFAULT 0,
  ts TIMESTAMPTZ NOT NULL,
  sender TEXT,
  recipient TEXT,
  amount0 NUMERIC(38,18),
  amount1 NUMERIC(38,18),
  amount_usd NUMERIC(38,18),
  price_usd NUMERIC(38,18),
  sqrt_price_x96 NUMERIC(80,0),
  tick BIGINT,
  liquidity NUMERIC(38,18),
  source TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, ts),
  UNIQUE (tx_hash, log_index, pool_id, ts)
);
SELECT create_hypertable('dex_swaps', 'ts', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS dex_swaps_pool_block_idx ON dex_swaps (pool_id, block_number, log_index);

CREATE TABLE IF NOT EXISTS dex_candles (
  id BIGSERIAL,
  pool_id TEXT NOT NULL REFERENCES dex_pools(pool_id) ON DELETE CASCADE,
  synthetic_symbol TEXT,
  interval TEXT NOT NULL,
  open_time TIMESTAMPTZ NOT NULL,
  open NUMERIC(38,18) NOT NULL,
  high NUMERIC(38,18) NOT NULL,
  low NUMERIC(38,18) NOT NULL,
  close NUMERIC(38,18) NOT NULL,
  volume0 NUMERIC(38,18) NOT NULL DEFAULT 0,
  volume1 NUMERIC(38,18) NOT NULL DEFAULT 0,
  volume_usd NUMERIC(38,18) NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  coverage_score NUMERIC(8,6) NOT NULL DEFAULT 0,
  blend_config_json JSONB,
  checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, open_time),
  UNIQUE (pool_id, interval, open_time, source)
);
SELECT create_hypertable('dex_candles', 'open_time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS dex_candles_pool_interval_time_idx ON dex_candles (pool_id, interval, open_time DESC);

CREATE TABLE IF NOT EXISTS dex_quotes (
  quote_id TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL REFERENCES chains(chain_id),
  venue_id TEXT NOT NULL REFERENCES dex_venues(venue_id),
  route_json JSONB NOT NULL,
  amount_in NUMERIC(38,18) NOT NULL,
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  expected_out NUMERIC(38,18),
  slippage_bps NUMERIC(18,8),
  gas_estimate NUMERIC(38,0),
  source TEXT NOT NULL,
  honesty_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dex_quotes_chain_time_idx ON dex_quotes (chain_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_links (
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  chain_id BIGINT NOT NULL REFERENCES chains(chain_id),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  proof_message_hash TEXT NOT NULL,
  label TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (owner_id, wallet_address, chain_id)
);
CREATE INDEX IF NOT EXISTS wallet_links_owner_lower_idx ON wallet_links (owner_id, lower(wallet_address), chain_id);

CREATE TABLE IF NOT EXISTS testnet_intents (
  intent_id TEXT PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL REFERENCES chains(chain_id),
  wallet_address TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  policy_result JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','submitted','confirmed','failed','cancelled')),
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS testnet_intents_owner_time_idx ON testnet_intents (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dex_data_coverage (
  id BIGSERIAL PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES dex_pools(pool_id) ON DELETE CASCADE,
  interval TEXT NOT NULL,
  range_start TIMESTAMPTZ NOT NULL,
  range_end TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  expected_bars INTEGER NOT NULL DEFAULT 0,
  actual_bars INTEGER NOT NULL DEFAULT 0,
  swap_rows INTEGER NOT NULL DEFAULT 0,
  snapshot_rows INTEGER NOT NULL DEFAULT 0,
  coverage_score NUMERIC(8,6) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pool_id, interval, range_start, range_end, source)
);
