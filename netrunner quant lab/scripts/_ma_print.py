import sys, json
d = json.load(sys.stdin)
print(" weighting:", d.get("weighting"), "| interval:", d.get("interval_minutes"),
      "| opt_chosen:", d.get("optimization", {}).get("chosen"),
      "| tested:", d.get("optimization", {}).get("tested"))
for s in d.get("scenarios", []):
    m = s.get("metrics", {})
    err = (" ERR:" + s["error"]) if s.get("error") else ""
    print("  {:10s} ret={:7.2f}%  sharpe={:6.2f}  maxDD={:5.1f}%  rebal={}{}".format(
        s.get("name", "?"), m.get("total_return", 0) * 100, m.get("sharpe", 0),
        m.get("max_drawdown", 0) * 100, s.get("rebalances", 0), err))
print(" recommendation:", d.get("recommendation"))
print(" warnings:", d.get("warnings"))
