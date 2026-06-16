-- 0034: Signed EIP-7710 delegations (the security upgrade — the agent holds a scoped delegation,
-- not the user's keys). A row is the user's signed root delegation granting an agent account
-- (delegate_address, e.g. the orchestrator) bounded authority: an ERC-20 spend scope + caveats
-- (allowedTargets, timestamp, limitedCalls). Redelegations (orchestrator -> specialist) are stored
-- as further rows linked by parent_id. The signed delegation JSON is what gets encoded into the
-- `permissionContext` redeemed on-chain via the DelegationManager (W5).
CREATE TABLE IF NOT EXISTS agent_delegations (
  id                TEXT PRIMARY KEY,
  owner_id          BIGINT NOT NULL,
  parent_id         TEXT REFERENCES agent_delegations(id),  -- null = user root; set = redelegation
  delegator_address TEXT NOT NULL,        -- the `from` (user SA, or an agent for redelegations)
  delegate_address  TEXT NOT NULL,        -- the `to` (agent account that receives authority)
  chain_id          BIGINT NOT NULL,
  signed_delegation JSONB NOT NULL,       -- { delegate, delegator, authority, caveats, salt, signature }
  scope             JSONB,                -- the ScopeConfig used (for display/audit)
  caveats           JSONB,                -- resolved caveats (for display/audit)
  eip7702_auth      JSONB,                -- optional EIP-7702 authorization tuple (user-account upgrade)
  status            TEXT NOT NULL DEFAULT 'active',  -- active | revoked | expired
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One active delegation per (owner, delegate, chain) link.
CREATE UNIQUE INDEX IF NOT EXISTS agent_delegations_active_link_idx
  ON agent_delegations (owner_id, delegate_address, chain_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS agent_delegations_owner_idx ON agent_delegations (owner_id, created_at DESC);
