#!/usr/bin/env bash
# §25 — stand up an EPHEMERAL Postgres + Redis + WORKER + a freshly-booted API on a throwaway
# docker network, apply migrations, and EXECUTE the multi-tenant/identity/lifecycle/erasure +
# worker-compute-isolation + erasure-quiesce tests against it. NEVER touches the shared dev DB or
# shared containers. Everything is torn down on exit.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SUF="$$"
NET="duality-eph-net-$SUF"
PG="duality-eph-pg-$SUF"
RD="duality-eph-rd-$SUF"
WK="duality-eph-wk-$SUF"
PG_PORT=55432
RD_PORT=56379
WK_PORT=57000
API_PORT=57002
ISECRET="eph-internal-$SUF"
JSECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
API_PID=""

cleanup() {
  echo "--- teardown ---"
  lsof -ti tcp:$API_PORT 2>/dev/null | xargs -r kill -9 2>/dev/null
  pkill -f "tsx src/index.ts" 2>/dev/null
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  docker rm -f "$WK" "$PG" "$RD" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -f /tmp/duality_eph_priv_$SUF.pem /tmp/duality_eph_pub_$SUF.pem
}
trap cleanup EXIT

# Pre-clean a stale API on the port (prevents hitting a server with a mismatched keypair).
lsof -ti tcp:$API_PORT 2>/dev/null | xargs -r kill -9 2>/dev/null
pkill -f "tsx src/index.ts" 2>/dev/null
sleep 1

echo "--- generate test ES256 keypair (synthetic Privy IdP) ---"
node -e '
const {generateKeyPairSync}=require("crypto");
const {privateKey,publicKey}=generateKeyPairSync("ec",{namedCurve:"P-256"});
const fs=require("fs"); const s=process.argv[1];
fs.writeFileSync("/tmp/duality_eph_priv_"+s+".pem", privateKey.export({type:"pkcs8",format:"pem"}));
fs.writeFileSync("/tmp/duality_eph_pub_"+s+".pem", publicKey.export({type:"spki",format:"pem"}));
' "$SUF" || { echo "keygen failed"; exit 1; }
PRIV="$(cat /tmp/duality_eph_priv_$SUF.pem)"
PUB="$(cat /tmp/duality_eph_pub_$SUF.pem)"

echo "--- create network + start ephemeral postgres + redis + worker ---"
docker network create "$NET" >/dev/null || exit 1
docker run -d --rm --network "$NET" --name "$PG" -e POSTGRES_USER=duality -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=duality -p $PG_PORT:5432 timescale/timescaledb:latest-pg16 >/dev/null || exit 1
docker run -d --rm --network "$NET" --name "$RD" -p $RD_PORT:6379 redis:7-alpine >/dev/null || exit 1

export DATABASE_URL="postgres://localhost:$PG_PORT/duality"
export REDIS_URL="redis://localhost:$RD_PORT"

echo "--- wait for postgres ---"
for i in $(seq 1 60); do
  docker exec "$PG" pg_isready -U duality -d duality >/dev/null 2>&1 && break
  sleep 1
done

echo "--- apply migrations ---"
( cd apps/api && DATABASE_URL="$DATABASE_URL" npx tsx scripts/migrate.ts ) || { echo "migrate failed"; exit 1; }

echo "--- start worker (cached infra-worker image, current source mounted) ---"
# Worker reaches PG/RD by container name on the shared network; my updated source is mounted over
# the image's copy so the running code is current (no rebuild). Fast tick so live-paper publishes.
docker run -d --rm --network "$NET" --name "$WK" \
  -e DATABASE_URL="postgres://$PG:5432/duality" \
  -e REDIS_URL="redis://$RD:6379" \
  -e INTERNAL_SECRET="$ISECRET" \
  -e LIVE_PAPER_TICK_SECONDS=1 \
  -v "$ROOT/apps/worker:/app/apps/worker" \
  -v "$ROOT/packages/quant-core:/app/packages/quant-core" \
  -p $WK_PORT:7000 infra-worker:latest >/dev/null || { echo "worker start failed"; exit 1; }

echo "--- boot API on :$API_PORT ---"
( cd apps/api && \
  DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" \
  API_PORT=$API_PORT ALLOW_DEV_TOKEN=true JWT_SECRET="$JSECRET" \
  PRIVY_APP_ID="test-privy-app" PRIVY_VERIFICATION_KEY="$PUB" \
  OWNER_TOKEN_TTL=12h AUTH_SESSION_RATE_PER_MIN=20 \
  INTERNAL_SECRET="$ISECRET" \
  QUANT_WORKER_URL="http://localhost:$WK_PORT" \
  DATA_INGESTOR_URL="http://localhost:1" \
  npx tsx src/index.ts ) &
API_PID=$!

echo "--- wait for API + worker health ---"
HEALTHY=0
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:$API_PORT/health" >/dev/null 2>&1 \
     && curl -fsS "http://localhost:$WK_PORT/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 1
done
if [ "$HEALTHY" != "1" ]; then echo "API/worker did not become healthy"; docker logs "$WK" 2>&1 | tail -20; exit 1; fi

echo "--- run integration tests ---"
cd apps/api
API_BASE="http://localhost:$API_PORT" \
DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" \
PRIVY_APP_ID="test-privy-app" ITEST_PRIVY_PRIVATE_KEY="$PRIV" \
ITEST_WORKER=1 \
npx vitest run test/multiTenant.integration.test.ts test/workerTenant.integration.test.ts
RC=$?
exit $RC
