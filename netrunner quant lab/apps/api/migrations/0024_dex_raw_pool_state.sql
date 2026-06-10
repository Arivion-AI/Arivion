-- 0024: Raw Uniswap v3 / Algebra pool state on dex_pool_snapshots.
-- The existing liquidity/reserve columns are NUMERIC(38,18) (USD/reserve scale). Raw on-chain values
-- are large integers: liquidity L is a uint128 (up to ~3.4e38) and feeGrowthGlobalNX128 are uint256
-- accumulators. These wide, scale-0 columns feed the LP position math (value, fees, IL) in Phase C.

ALTER TABLE dex_pool_snapshots
  ADD COLUMN IF NOT EXISTS liquidity_raw NUMERIC(80,0),
  ADD COLUMN IF NOT EXISTS fee_growth_global0_x128 NUMERIC(80,0),
  ADD COLUMN IF NOT EXISTS fee_growth_global1_x128 NUMERIC(80,0);
