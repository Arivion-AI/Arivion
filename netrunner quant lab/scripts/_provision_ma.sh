#!/usr/bin/env bash
set -uo pipefail
API=http://localhost:4400
TOK=$(curl -s "$API/auth/dev-token?ownerId=3" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
H=(-H "Authorization: Bearer $TOK" -H 'Content-Type: application/json')
pg() { docker exec infra-postgres-1 psql -U duality -d duality -tAc "$1"; }

echo "triggering backfills (240 + 4 regimes)..."
for s in BTCUSDT ETHUSDT; do
  curl -s "${H[@]}" -X POST "$API/api/candles/ensure" -d "{\"symbol\":\"$s\",\"category\":\"linear\",\"interval\":\"240\",\"minBars\":400}" -o /dev/null
done
for rid in btc_2021_bull eth_2021_bull btc_2022_bear eth_2022_bear; do
  curl -s "${H[@]}" -X POST "$API/api/regimes/$rid/load" -o /dev/null
done

echo "polling (max ~5m)..."
for i in $(seq 1 60); do
  c240=$(pg "SELECT count(*) FROM candles WHERE symbol='BTCUSDT' AND interval='240'")
  cD=$(pg "SELECT count(*) FROM candles WHERE symbol='BTCUSDT' AND interval='D'")
  echo "  t=$((i*5))s  BTC240=$c240  BTC_D=$cD"
  if [ "${c240:-0}" -ge 150 ] && [ "${cD:-0}" -ge 250 ]; then echo "READY"; break; fi
  sleep 5
done
pg "SELECT symbol,interval,count(*),min(open_time)::date,max(open_time)::date FROM candles WHERE interval IN ('240','D') GROUP BY 1,2 ORDER BY 1,2;"
