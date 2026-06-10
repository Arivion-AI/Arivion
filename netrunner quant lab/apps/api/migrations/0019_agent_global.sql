-- Phase 8 — opt-in global/team insights. Owners must opt in to contribute de-identified, structural
-- semantic insights to the shared scope='global' pool (agent_semantic already has the scope column).
ALTER TABLE agent_owner_settings ADD COLUMN IF NOT EXISTS contribute_global BOOLEAN NOT NULL DEFAULT false;
