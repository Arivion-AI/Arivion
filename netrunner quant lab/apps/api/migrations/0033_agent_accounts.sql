-- 0033: Named agent delegate accounts for A2A redelegation (orchestrator + specialists).
-- The hackathon port introduces MetaMask Smart Account delegation: the user signs a scoped EIP-7710
-- delegation to an ORCHESTRATOR agent account, which redelegates narrowed scope to specialist agents
-- (gmx / lp / stock). Each agent account is a backend-held signer keypair (its address is the EIP-7710
-- `delegate`); security comes from the scoped delegation + caveats, NOT key secrecy (MetaMask's
-- canonical "session account" model). Keys encrypted at rest exactly like agent_wallets
-- (AES-256-GCM, app master key, iv:tag:ciphertext).
--
-- This is a SEPARATE table from agent_wallets on purpose: agent_wallets (owner_id PK) remains the
-- proven per-user signer for the existing GMX-live / stock paths and is left untouched. These are the
-- new delegation-chain accounts, keyed (owner_id, role).
CREATE TABLE IF NOT EXISTS agent_accounts (
  owner_id     BIGINT NOT NULL,
  role         TEXT NOT NULL,           -- orchestrator | gmx | lp | stock
  address      TEXT NOT NULL,           -- the agent EOA address = EIP-7710 delegate
  enc_privkey  TEXT NOT NULL,           -- iv:tag:ciphertext (hex), AES-256-GCM
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, role)
);
CREATE INDEX IF NOT EXISTS agent_accounts_addr_idx ON agent_accounts (lower(address));
