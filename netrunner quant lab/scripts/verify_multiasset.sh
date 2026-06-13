#!/usr/bin/env bash
# Phase 18 end-to-end: multiasset propose (backtest + bull/bear cross-val + optimize) → go-live paper.
set -uo pipefail
API=http://localhost:4400; AGENT=http://localhost:4500; OWNER=3
PG="docker exec infra-postgres-1 psql -U duality -d duality -tAc"
say() { printf "\n\033[1;36m== %s ==\033[0m\n" "$1"; }
J() { python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }

TOK=$(curl -s "$API/auth/dev-token?ownerId=$OWNER" | J 'print(d.get("token",""))')
OWNER_ID=$($PG "SELECT id FROM users WHERE privy_did='did:dev:$OWNER'")
AUTH=(-H "Authorization: Bearer $TOK" -H 'Content-Type: application/json')
echo "owner $OWNER_ID"
curl -s "${AUTH[@]}" -X POST $AGENT/api/copilot/kill-switch -d '{"autonomy_level":"L2"}' >/dev/null && echo "autonomy L2 set"

say "PROPOSE: multiasset \$500, moderate, linear (BTC/ETH perps) — backtest + bull/bear cross-validation + optimize"
curl -s "${AUTH[@]}" -X POST $AGENT/api/copilot/multiasset/propose \
  -d '{"budget_usd":500,"risk":"moderate","duration_days":30,"asset_classes":["linear"]}' | J '
print("  weighting:",d.get("weighting"),"| interval(min):",d.get("interval_minutes"))
print("  legs:",", ".join(f"{l[\"symbol\"]}({l[\"category\"]}@{l[\"target_weight\"]})" for l in d.get("legs",[])))
print("  optimize:",d.get("optimization",{}).get("knob"),"chosen=",d.get("optimization",{}).get("chosen"),"tested=",d.get("optimization",{}).get("tested"))
for s in d.get("scenarios",[]):
    m=s.get("metrics",{})
    print(f"  scenario {s[\"name\"]:10s} ret={m.get(\"total_return\",0)*100:6.2f}%  sharpe={m.get(\"sharpe\",0):6.2f}  maxDD={m.get(\"max_drawdown\",0)*100:5.1f}%  rebal={s.get(\"rebalances\")}  {(\"ERR:\"+s[\"error\"]) if s.get(\"error\") else \"\"}")
print("  L2 note:",d.get("l2_note","")[:90])
print("  recommendation:",d.get("recommendation"))
print("  warnings:",d.get("warnings"))'

say "GO LIVE (paper): start the forward multiasset session"
curl -s "${AUTH[@]}" -X POST $AGENT/api/copilot/multiasset/start \
  -d '{"budget_usd":500,"risk":"moderate","duration_days":30,"asset_classes":["linear"],"rebalance_threshold":0.05}' \
  | J 'print("  status:",d.get("status"),"| runId:",d.get("runId"),"| reason:",d.get("reason"))'

say "WORKER live_portfolio_sessions row (authoritative)"
$PG "SELECT session_id, status, weighting, total_equity, final_equity, rebalances, fills_count, interval_minutes FROM live_portfolio_sessions WHERE owner_id=$OWNER_ID ORDER BY created_at DESC LIMIT 3;" \
  | sed 's/^/  /'
echo
say "cleanup: stop + remove the verify sessions"
$PG "UPDATE live_portfolio_sessions SET status='stopped' WHERE owner_id=$OWNER_ID;" >/dev/null && echo "  stopped sessions for owner $OWNER_ID"
