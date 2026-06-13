#!/usr/bin/env bash
# Phase 17 end-to-end verification against the live docker stack.
# Exercises: risk state (migration columns) → analyze pipeline → naked-entry guardrail →
# position monitor stop-loss exit (via a synthetic open intent + mark tick).
set -uo pipefail
API=http://localhost:4400
AGENT=http://localhost:4500
OWNER=3
PG="docker exec infra-postgres-1 psql -U duality -d duality -tAc"

say() { printf "\n\033[1;36m== %s ==\033[0m\n" "$1"; }

say "agent health"
curl -s $AGENT/health | jq -c . || { echo "agent not up"; exit 1; }

say "dev token for owner $OWNER"
TOK=$(curl -s "$API/auth/dev-token?ownerId=$OWNER" | jq -r '.token // .ownerToken // .access_token')
[ -n "$TOK" ] && [ "$TOK" != "null" ] && echo "got token (${#TOK} chars)" || { echo "no token"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOK")
# The token's `sub` is the real users.id (did:dev:N maps to an auto-assigned id, not literally N).
# Read it straight from the DB to avoid JWT-decode fragility (and bash's readonly $UID).
OWNER_ID=$($PG "SELECT id FROM users WHERE privy_did='did:dev:$OWNER'")
echo "real owner id = $OWNER_ID"

say "set autonomy L2 (managed positions require it) for owner $OWNER_ID"
curl -s "${AUTH[@]}" -H 'Content-Type: application/json' -X POST $AGENT/api/copilot/kill-switch \
  -d '{"autonomy_level":"L2"}' | jq -c '{autonomy_level}'

say "risk state (proves migration columns exist) — GET then halt then GET"
curl -s "${AUTH[@]}" $AGENT/api/copilot/risk | jq -c .
curl -s "${AUTH[@]}" -H 'Content-Type: application/json' -X POST $AGENT/api/copilot/risk \
  -d '{"state":"risk_averse","reason":"verify","cooldown_seconds":60}' | jq -c .
curl -s "${AUTH[@]}" -X POST $AGENT/api/copilot/risk -H 'Content-Type: application/json' -d '{"state":"normal"}' >/dev/null
echo "risk reset to normal"

say "multi-agent analyze pipeline (mock or real LLM)"
curl -s "${AUTH[@]}" -H 'Content-Type: application/json' -X POST $AGENT/api/copilot/analyze \
  -d '{"symbol":"BTCUSDT","category":"linear"}' | jq -c '{action,confidence,risk_verdict,has_policy:(.proposed_exit_policy!=null)}'

say "NAKED ENTRY guardrail — open with NO exit_policy must be rejected (expect 400)"
curl -s -o /dev/null -w "HTTP %{http_code}\n" "${AUTH[@]}" -H 'Content-Type: application/json' \
  -X POST $AGENT/api/copilot/positions/open -d '{"bot_id":"b1","symbol":"BTCUSDT","entry_price":100}'

say "open WITH a valid exit_policy (start_live_paper may not be wired in dev — status shows the path ran)"
curl -s "${AUTH[@]}" -H 'Content-Type: application/json' -X POST $AGENT/api/copilot/positions/open \
  -d '{"bot_id":"b1","symbol":"BTCUSDT","category":"linear","side":"long","entry_price":100,
       "exit_policy":{"stop_loss":{"type":"fixed_pct","value":0.05},
         "take_profit":{"ladder":[{"target_pct":0.04,"reduce_fraction":0.5},{"target_pct":0.09,"reduce_fraction":0.5}]},
         "trailing":{"activate_at_pct":0.04,"trail_pct":0.02,"ratchet":true}}}' | jq -c '{status,reason}'

say "MONITOR: inject a synthetic OPEN position, then tick a mark through the stop → expect autonomous close"
ID="pos_verify_$(date +%s)"
$PG "INSERT INTO agent_position_intents (id,owner_id,symbol,category,side,entry_price,exit_policy,runtime,state,last_mark)
 VALUES ('$ID',$OWNER_ID,'ETHTEST','linear','long',100,
  '{\"stop_loss\":{\"type\":\"fixed_pct\",\"value\":0.05}}'::jsonb,
  '{\"high_water\":100,\"low_water\":100,\"cleared_tiers\":[],\"current_stop_price\":95}'::jsonb,'open',100);" \
  && echo "inserted $ID"

echo "-- tick at 98 (above stop) → expect hold"
curl -s "${AUTH[@]}" -H 'Content-Type: application/json' -X POST $AGENT/api/copilot/positions/tick \
  -d "{\"intent_id\":\"$ID\",\"mark\":98}" | jq -c '.results[0]'
echo "-- tick at 94 (below 95 stop) → expect close/stop_loss"
curl -s "${AUTH[@]}" -H 'Content-Type: application/json' -X POST $AGENT/api/copilot/positions/tick \
  -d "{\"intent_id\":\"$ID\",\"mark\":94}" | jq -c '.results[0]'

say "final position state (expect state=closed, close_reason=stop_loss)"
curl -s "${AUTH[@]}" "$AGENT/api/copilot/positions/$ID" | jq -c '.intent | {id,state,close_reason,realized_return,last_mark}'
$PG "DELETE FROM agent_position_events WHERE intent_id='$ID'; DELETE FROM agent_position_intents WHERE id='$ID';" >/dev/null && echo "cleaned up $ID"
