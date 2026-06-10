-- 0012: §25 P0.2 — normalize owner_id to BIGINT (matches users.id BIGSERIAL).
-- Drift today: BIGINT (strategies/strategy_versions/paper_accounts/marketplace_cards),
-- INTEGER (bot_specs/bot_recommendations), TEXT (live_paper_sessions/live_paper_checkpoints).

-- INTEGER -> BIGINT is a lossless widening with no app-side ripple.
ALTER TABLE bot_specs           ALTER COLUMN owner_id TYPE BIGINT;
ALTER TABLE bot_recommendations ALTER COLUMN owner_id TYPE BIGINT;

-- §25 A.2 — live_paper_* TEXT -> BIGINT. The worker's 'anon' default is removed (owner_id is now
-- required + numeric, apps/worker/security.py:parse_owner_id), and ensure_table() now declares the
-- column BIGINT. Fail loud if any legacy non-numeric owner_id remains: it must be cleaned first
-- rather than silently corrupting the conversion. (live_paper_sessions may not exist yet if the
-- worker has never started — guard with to_regclass.)
DO $$
DECLARE bad INT;
BEGIN
  -- Only convert if the column is still TEXT (a fresh DB created it BIGINT in 0008; an existing
  -- prod DB has it TEXT from the worker). Type-aware so this is safe in both cases.
  IF to_regclass('public.live_paper_sessions') IS NOT NULL
     AND (SELECT data_type FROM information_schema.columns WHERE table_name='live_paper_sessions' AND column_name='owner_id') = 'text' THEN
    SELECT count(*) INTO bad FROM live_paper_sessions WHERE owner_id !~ '^[0-9]+$';
    IF bad > 0 THEN RAISE EXCEPTION 'live_paper_sessions has % non-numeric owner_id (e.g. legacy ''anon'') — clean before TEXT->BIGINT', bad; END IF;
    EXECUTE 'ALTER TABLE live_paper_sessions ALTER COLUMN owner_id TYPE BIGINT USING owner_id::bigint';
  END IF;
  IF to_regclass('public.live_paper_checkpoints') IS NOT NULL
     AND (SELECT data_type FROM information_schema.columns WHERE table_name='live_paper_checkpoints' AND column_name='owner_id') = 'text' THEN
    SELECT count(*) INTO bad FROM live_paper_checkpoints WHERE owner_id !~ '^[0-9]+$';
    IF bad > 0 THEN RAISE EXCEPTION 'live_paper_checkpoints has % non-numeric owner_id', bad; END IF;
    EXECUTE 'ALTER TABLE live_paper_checkpoints ALTER COLUMN owner_id TYPE BIGINT USING owner_id::bigint';
  END IF;
END $$;
-- The wire format (stringified int) is unchanged, so Redis rt:session:{ownerId} keys are unaffected.
