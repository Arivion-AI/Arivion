-- 0035: 1Shot relayer task ledger. Each delegated execution submitted to the 1Shot permissionless
-- relayer (smartAccountExec.executeViaOneShot) records a row keyed by the relayer TaskId. The
-- POST /webhooks/1shot endpoint (and/or status polling) updates status + tx hash as the relayer
-- progresses (100 pending -> 110 submitted -> 200 confirmed / 400 rejected / 500 reverted). This is
-- the source of truth for delegated-execution status across GMX / LP / stock sleeves.
CREATE TABLE IF NOT EXISTS agent_relay_tasks (
  task_id     TEXT PRIMARY KEY,        -- 1Shot TaskId (0x..64)
  owner_id    BIGINT NOT NULL,
  role        TEXT,                    -- orchestrator | gmx | lp | stock
  kind        TEXT,                    -- gmx_order | lp_mint | stock_buy | ... (free-form)
  ref_id      TEXT,                    -- optional FK into a sleeve ledger (e.g. agent_gmx_live_orders.id)
  chain_id    BIGINT NOT NULL,
  status      INTEGER NOT NULL DEFAULT 100,  -- mirrors 1Shot status codes
  tx_hash     TEXT,
  fee_usdc    NUMERIC,
  raw         JSONB,                   -- last webhook/status payload (audit)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_relay_tasks_owner_idx ON agent_relay_tasks (owner_id, created_at DESC);
