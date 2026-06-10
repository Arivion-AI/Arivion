-- 0028: Per-user agent-controlled wallets (TESTNET). Each owner gets their own EOA the agent signs
-- with; the private key is encrypted at rest (AES-256-GCM, app master key). New wallets are auto-funded
-- with a little gas from the treasury on first use. Testnet-only; never reuse for mainnet.

CREATE TABLE IF NOT EXISTS agent_wallets (
  owner_id     BIGINT PRIMARY KEY,
  address      TEXT NOT NULL,
  enc_privkey  TEXT NOT NULL,          -- iv:tag:ciphertext (hex)
  funded_arb   BOOLEAN NOT NULL DEFAULT FALSE,
  funded_rh    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_wallets_addr_idx ON agent_wallets (lower(address));
