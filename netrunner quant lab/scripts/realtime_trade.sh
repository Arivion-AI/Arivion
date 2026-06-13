#!/usr/bin/env bash
# Live 5-minute managed-position run: real GPT-5 decision + real BYBIT mark-price feed driving the
# monitor every 10s (Duality is Bybit-native; the Lab's own candles are Bybit too). The position
# carries a TIGHT exit policy so real intra-5-minute micro-moves exercise the stop / take-profit /
# trailing logic. (The live-paper session plumbing needs the data-ingestor; here the position is fed
# real Bybit marks directly, exercising the same monitor path.)
set -uo pipefail
API=http://localhost:4400; AGENT=http://localhost:4500; OWNER=3
BYBIT=${BYBIT_BASE_URL:-https://api.bybit.com}
PG="docker exec infra-postgres-1 psql -U duality -d duality -tAc"
# Bybit v5 linear (perp) ticker — use markPrice (what Bybit uses for perp PnL), fall back to lastPrice.
px() { curl -s --max-time 5 "$BYBIT/v5/market/tickers?category=linear&symbol=BTCUSDT" \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"]["list"][0];print(r.get("markPrice") or r["lastPrice"])' 2>/dev/null; }
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }

TOK=$(curl -s "$API/auth/dev-token?ownerId=$OWNER" | J 'print(d.get("token",""))')
OWNER_ID=$($PG "SELECT id FROM users WHERE privy_did='did:dev:$OWNER'")
AUTH=(-H "Authorization: Bearer $TOK" -H 'Content-Type: application/json')
curl -s "${AUTH[@]}" -X POST $AGENT/api/copilot/kill-switch -d '{"autonomy_level":"L2"}' >/dev/null

echo "=== GPT-5 trading-firm decision (recorded) ==="
curl -s "${AUTH[@]}" -X POST $AGENT/api/copilot/analyze -d '{"symbol":"BTCUSDT","category":"linear","use_web":true}' \
  | J 'print("  action:",d.get("action"),"conf:",d.get("confidence"));print("  rationale:",d.get("rationale"))'

ENTRY=$(px); [ -z "$ENTRY" ] && { echo "no price feed"; exit 1; }
echo "=== OPEN long BTCUSDT @ live \$$ENTRY with a tight 5-min exit policy ==="
ID="pos_rt_$(date +%s)"
STOP=$(python3 -c "print($ENTRY*0.998)")
$PG "INSERT INTO agent_position_intents (id,owner_id,symbol,category,side,entry_price,exit_policy,runtime,state,last_mark,time_exit_at)
 VALUES ('$ID',$OWNER_ID,'BTCUSDT','linear','long',$ENTRY,
  '{\"stop_loss\":{\"type\":\"fixed_pct\",\"value\":0.002},
    \"take_profit\":{\"ladder\":[{\"target_pct\":0.0012,\"reduce_fraction\":0.5},{\"target_pct\":0.003,\"reduce_fraction\":0.5}]},
    \"trailing\":{\"activate_at_pct\":0.0012,\"trail_pct\":0.0008,\"ratchet\":true},
    \"time_exit\":{\"max_hold_seconds\":600}}'::jsonb,
  '{\"high_water\":$ENTRY,\"low_water\":$ENTRY,\"cleared_tiers\":[],\"current_stop_price\":$STOP}'::jsonb,
  'open',$ENTRY, now()+interval '600 seconds');" >/dev/null && echo "  opened $ID  stop≈\$$STOP  tp1=+0.12%  tp2=+0.30%  trail 0.08%"

echo "=== LIVE management — real Bybit mark-price every 10s for 5 minutes ==="
printf "  %-8s %-12s %-10s %-6s %s\n" "t(s)" "mark" "uPnL%" "act" "reason"
START=$(date +%s); CLOSED=""
for i in $(seq 1 30); do
  P=$(px); [ -z "$P" ] && { sleep 10; continue; }
  RES=$(curl -s "${AUTH[@]}" -X POST $AGENT/api/copilot/positions/tick -d "{\"symbol\":\"BTCUSDT\",\"mark\":$P}")
  LINE=$(echo "$RES" | J "r=[x for x in d.get('results',[]) if x and x.get('intentId')=='$ID'];print(r[0].get('action','-'),r[0].get('reason','') or '',r[0].get('closed','')) if r else print('hold','(no-match)','')")
  ACT=$(echo "$LINE" | awk '{print $1}'); RSN=$(echo "$LINE" | cut -d' ' -f2)
  UPNL=$(python3 -c "print(round(($P-$ENTRY)/$ENTRY*100,3))")
  printf "  %-8s %-12s %-10s %-6s %s\n" "$(( $(date +%s)-START ))" "$P" "$UPNL" "$ACT" "$RSN"
  [ "$ACT" = "close" ] && { CLOSED=1; break; }
  sleep 10
done

echo "=== ANALYSIS ==="
curl -s "${AUTH[@]}" "$AGENT/api/copilot/positions/$ID" | J '
i=d["intent"];e=d.get("events",[])
print("  final state   :",i["state"],"| reason:",i.get("close_reason"))
print("  entry / exit  :",i["entry_price"],"->",i.get("last_mark"))
rr=i.get("realized_return"); print("  realized ret  :",(str(round(rr*100,3))+"%") if rr is not None else "open")
print("  events        :",len(e),"->", ", ".join(f"{x[\"action\"]}@{x[\"mark\"]}({x[\"reason\"]})" for x in e[:8]))'
[ -z "$CLOSED" ] && echo "  (still open after 5m — time_exit would fire on the next sweep)"
$PG "DELETE FROM agent_position_events WHERE intent_id='$ID'; DELETE FROM agent_position_intents WHERE id='$ID';" >/dev/null && echo "  cleaned up $ID"
