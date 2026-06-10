-- 0011: §25 P0.1 — reshape `users` for Privy identity (consumer multi-tenancy v1).
-- The identity anchor becomes `privy_did` (did:privy:… for real users, did:dev:{id} for the
-- dev-token path) — NOT email, since wallet-only Privy logins have no email. Adds server-side-only
-- entitlement fields (tier/status) with enum CHECKs so they can never be escalated from a request.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS privy_did       TEXT,
  ADD COLUMN IF NOT EXISTS primary_wallet  TEXT,
  ADD COLUMN IF NOT EXISTS tier            TEXT NOT NULL DEFAULT 'consumer',
  ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_login_at   TIMESTAMPTZ;

-- Backfill a deterministic dev DID for any pre-existing rows (the single-owner ownerId=1 stack),
-- so the same `ON CONFLICT (privy_did)` provisioning path serves both dev-token and Privy.
UPDATE users SET privy_did = 'did:dev:' || id WHERE privy_did IS NULL;

-- privy_did is the identity key: unique, and now required.
CREATE UNIQUE INDEX IF NOT EXISTS users_privy_did_key ON users (privy_did);
ALTER TABLE users ALTER COLUMN privy_did SET NOT NULL;

-- Relax email/display_name: wallet-only logins have neither. email stays UNIQUE (Postgres permits
-- multiple NULLs); it is no longer the identity key.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN display_name DROP NOT NULL;

-- Entitlement enums — server-side only, never settable from a request body.
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_tier_check   CHECK (tier   IN ('consumer','pro','vip'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active','suspended'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
