#!/usr/bin/env bash
# §25 Phase 1 — migration dry-run on a CLONE of real prod data. READ-ONLY on prod (pg_dump only);
# all writes go to a throwaway ephemeral Postgres, torn down after. Proves migrations 0010->0012
# apply on real data (esp. 0012's live_paper_* TEXT->BIGINT cast + 0011's users backfill) BEFORE
# any prod change. Clones full SCHEMA (all tables/types/FKs) + DATA only for the migration-relevant
# non-hypertable tables (skips the 2.3GB of market-data hypertables — irrelevant to these migrations).
set -uo pipefail
cd "$(dirname "$0")/.."
PRODC=infra-postgres-1
EPH="duality-dryrun-pg-$$"
EPH_PORT=55433
cleanup() { docker rm -f "$EPH" >/dev/null 2>&1; }
trap cleanup EXIT

echo "--- dump prod SCHEMA (read-only) ---"
docker exec "$PRODC" pg_dump -U duality -d duality --schema-only > /tmp/clone_schema.sql || { echo "schema dump failed"; exit 1; }
echo "schema dump: $(wc -l < /tmp/clone_schema.sql) lines"
echo "--- dump prod DATA for migration-relevant tables (read-only) ---"
docker exec "$PRODC" pg_dump -U duality -d duality --data-only \
  -t users -t live_paper_sessions -t live_paper_checkpoints -t schema_migrations \
  > /tmp/clone_data.sql || { echo "data dump failed"; exit 1; }
echo "data dump: $(wc -l < /tmp/clone_data.sql) lines"

echo "--- start ephemeral postgres for the clone ---"
docker run -d --rm --name "$EPH" -e POSTGRES_USER=duality -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=duality -p $EPH_PORT:5432 timescale/timescaledb:latest-pg16 >/dev/null || exit 1
for i in $(seq 1 60); do docker exec "$EPH" pg_isready -U duality -d duality >/dev/null 2>&1 && break; sleep 1; done

echo "--- restore schema then data into clone ---"
docker exec -i "$EPH" psql -U duality -d duality -v ON_ERROR_STOP=0 < /tmp/clone_schema.sql > /tmp/restore_schema.log 2>&1
docker exec -i "$EPH" psql -U duality -d duality -v ON_ERROR_STOP=0 < /tmp/clone_data.sql > /tmp/restore_data.log 2>&1
echo "schema restore errors: $(grep -ci 'ERROR' /tmp/restore_schema.log) | data restore errors: $(grep -ci 'ERROR' /tmp/restore_data.log)"
echo "--- clone state BEFORE migration ---"
docker exec -i "$EPH" psql -U duality -d duality -t -A -F'|' -c "
  SELECT 'users', count(*) FROM users
  UNION ALL SELECT 'live_paper_sessions', count(*) FROM live_paper_sessions
  UNION ALL SELECT 'live_paper_checkpoints', count(*) FROM live_paper_checkpoints;
  SELECT 'lp_sessions.owner_id type='||data_type FROM information_schema.columns WHERE table_name='live_paper_sessions' AND column_name='owner_id';
  SELECT 'applied: '||string_agg(name,',') FROM schema_migrations;" 2>&1

echo "--- RUN MIGRATIONS 0010->0012 on the clone ---"
( cd apps/api && DATABASE_URL="postgres://localhost:$EPH_PORT/duality" npx tsx scripts/migrate.ts ) 2>&1
MIG_RC=$?
echo "migrate exit: $MIG_RC"

echo "--- clone state AFTER migration (verify) ---"
docker exec -i "$EPH" psql -U duality -d duality -t -A -F'|' -c "
  SELECT 'owner_id types:';
  SELECT table_name||'='||data_type FROM information_schema.columns
    WHERE column_name='owner_id' AND table_name IN ('live_paper_sessions','live_paper_checkpoints','bot_specs','bot_recommendations') ORDER BY 1;
  SELECT 'users.privy_did NOT NULL count='||count(*) FROM users WHERE privy_did IS NOT NULL;
  SELECT 'users.privy_did distinct='||count(DISTINCT privy_did) FROM users;
  SELECT 'users.tier check ok='||bool_and(tier IN ('consumer','pro','vip'))::text FROM users;
  SELECT 'backtest_runs.canonical_event_digest exists='||(count(*)>0)::text FROM information_schema.columns WHERE table_name='backtest_runs' AND column_name='canonical_event_digest';
  SELECT 'schema_migrations now='||string_agg(name,',') FROM schema_migrations;" 2>&1

echo "--- DRY-RUN RESULT: migrate_rc=$MIG_RC ---"
exit $MIG_RC
