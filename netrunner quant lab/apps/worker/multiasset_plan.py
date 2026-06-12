"""Single-deposit multi-sleeve portfolio planner: tokens + tokenized stocks + LP.

The product thesis: the user deposits once; the AI splits it across three sleeves and rebalances.
This service turns a deposit + sleeve allocation + leg specs into a concrete per-leg USD plan, sizes
each LP leg via the concentrated-liquidity simulator, and reports blended risk. Deterministic and
honesty-labeled; it plans, it does not execute.

Sleeves:
  - crypto: spot tokens on Arbitrum DEXes (Uniswap v3 / Camelot)
  - stock:  tokenized equities on Robinhood Chain testnet (oracle-priced; see Phase E)
  - lp:     Uniswap v3 concentrated-liquidity positions (valued via quant_core.lp_math)
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

import asyncpg

import lp_service

SLEEVES = ("crypto", "stock", "lp")
WEIGHTINGS = ("equal", "fixed")  # vol-based schemes reuse quant_core.portfolio_engine when bars are supplied


def _d(v: Any, default: str = "0") -> Decimal:
    if v is None or v == "":
        return Decimal(default)
    return v if isinstance(v, Decimal) else Decimal(str(v))


def _normalize_sleeves(sleeves: dict[str, Any]) -> dict[str, Decimal]:
    out = {k: _d(sleeves.get(k)) for k in SLEEVES if sleeves.get(k) is not None}
    total = sum(out.values())
    if total <= 0:
        raise ValueError("sleeve weights must sum to > 0")
    return {k: v / total for k, v in out.items()}


def _leg_weights(legs: list[Any], weighting: str, fixed: dict[str, float] | None) -> dict[str, Decimal]:
    if not legs:
        return {}
    if weighting == "fixed" and fixed:
        raw = {str(s): _d(fixed.get(str(s), 0)) for s in legs}
        tot = sum(raw.values()) or Decimal(1)
        return {k: v / tot for k, v in raw.items()}
    # equal weight
    w = Decimal(1) / Decimal(len(legs))
    return {str(s): w for s in legs}


async def plan(
    pool: asyncpg.Pool,
    *,
    deposit_usd: Decimal,
    sleeves: dict[str, Any],
    crypto_legs: list[str] | None = None,
    stock_legs: list[str] | None = None,
    lp_legs: list[dict[str, Any]] | None = None,
    weighting: str = "equal",
    fixed_weights: dict[str, float] | None = None,
) -> dict[str, Any]:
    sleeve_w = _normalize_sleeves(sleeves)
    crypto_legs = crypto_legs or []
    stock_legs = stock_legs or []
    lp_legs = lp_legs or []

    allocations: list[dict[str, Any]] = []

    # crypto + stock sleeves: weight within sleeve, then size in USD.
    for sleeve, legs in (("crypto", crypto_legs), ("stock", stock_legs)):
        if sleeve not in sleeve_w or not legs:
            continue
        sleeve_usd = deposit_usd * sleeve_w[sleeve]
        weights = _leg_weights(legs, weighting, fixed_weights)
        for sym, w in weights.items():
            allocations.append({
                "sleeve": sleeve,
                "symbol": sym,
                "weight_in_sleeve": str(w),
                "target_usd": str((sleeve_usd * w).quantize(Decimal("0.01"))),
                "venue": "arbitrum_dex" if sleeve == "crypto" else "robinhood_testnet",
            })

    # lp sleeve: size each LP leg and simulate its concentrated position.
    lp_plans: list[dict[str, Any]] = []
    if "lp" in sleeve_w and lp_legs:
        lp_usd = deposit_usd * sleeve_w["lp"]
        # equal split across lp legs (or fixed by pool_id)
        n = len(lp_legs)
        for leg in lp_legs:
            pool_id = str(leg.get("pool_id") or leg.get("poolId") or "")
            cap = _d(leg.get("target_usd")) if leg.get("target_usd") else lp_usd / Decimal(n)
            range_pct = _d(leg.get("range_pct") or leg.get("rangePct") or "10")
            sim = await lp_service.simulate_range(pool, pool_id=pool_id, capital_usd=cap, range_pct=range_pct)
            lp_plans.append(sim)
            allocations.append({
                "sleeve": "lp",
                "pool_id": pool_id,
                "target_usd": str(cap.quantize(Decimal("0.01"))),
                "range_pct": str(range_pct),
                "in_range": sim.get("in_range"),
                "venue": "uniswap_v3_arbitrum",
                "sim_ok": sim.get("ok"),
            })

    # blended risk summary
    n_legs = len(allocations)
    max_alloc = max((Decimal(a["target_usd"]) for a in allocations), default=Decimal(0))
    concentration = float(max_alloc / deposit_usd) if deposit_usd > 0 else 0.0
    return {
        "ok": True,
        "deposit_usd": str(deposit_usd),
        "sleeves": {k: str(v) for k, v in sleeve_w.items()},
        "weighting": weighting,
        "allocations": allocations,
        "lp_plans": lp_plans,
        "blended_risk": {
            "n_legs": n_legs,
            "n_sleeves": len(sleeve_w),
            "max_single_leg_pct": round(concentration * 100, 2),
            "notes": [
                "Single-deposit split; AI rebalances per drift threshold.",
                "Cross-sleeve correlation: crypto and tokenized stocks can decouple; LP adds fee yield + IL.",
            ],
        },
        "truth": {
            "result_tier": "PLAN",
            "data_source": "blended",
            "can_execute_real_money": False,
            "note": "Allocation plan only — execution is testnet-gated (Phase E oracle mint/redeem for stocks).",
        },
    }


def rebalance(
    *,
    targets: list[dict[str, Any]],   # [{key, target_usd}]
    current: dict[str, Any],         # {key: current_usd}
    threshold_pct: Decimal = Decimal("5"),
) -> dict[str, Any]:
    actions: list[dict[str, Any]] = []
    total_target = sum(_d(t.get("target_usd")) for t in targets) or Decimal(1)
    for t in targets:
        key = str(t.get("key"))
        tgt = _d(t.get("target_usd"))
        cur = _d(current.get(key))
        drift_usd = cur - tgt
        drift_pct = (drift_usd / total_target) * 100
        if abs(drift_pct) >= threshold_pct:
            actions.append({
                "key": key,
                "action": "trim" if drift_usd > 0 else "add",
                "delta_usd": str(drift_usd.quantize(Decimal("0.01"))),
                "drift_pct": str(drift_pct.quantize(Decimal("0.01"))),
            })
    return {
        "ok": True,
        "threshold_pct": str(threshold_pct),
        "rebalance_needed": bool(actions),
        "actions": actions,
        "truth": {"result_tier": "PLAN", "can_execute_real_money": False},
    }
