-- 0013: harden `users` identity around privy_did.
--
-- (a) Drop the legacy UNIQUE on email. Identity is `privy_did` (set in 0011); email is now just a
--     profile attribute. Two distinct DIDs presenting the same email (or a profile-update upsert)
--     must not hit a unique-violation. Drop both the original column constraint name and any index.
-- (b) Advance the id sequence past MAX(id). Older code inserted explicit `id` values on the
--     dev-token path; the BIGSERIAL sequence is unaware of those, so the next sequence-assigned id
--     could collide with an existing row on users_pkey (ON CONFLICT (privy_did) would NOT catch a
--     primary-key conflict). All provisioning now goes through the sequence, so realign it once.

-- (a) email no longer unique.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
DROP INDEX IF EXISTS users_email_key;

-- (b) realign the BIGSERIAL sequence with the current MAX(id) (no-op on a clean DB).
SELECT setval(
  pg_get_serial_sequence('users', 'id'),
  GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1)
);
