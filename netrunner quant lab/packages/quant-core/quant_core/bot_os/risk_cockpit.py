"""§22 Bot Risk Cockpit modules. Each returns a scalar + label + breakdown.

Composite score (§22):
  0.20*drawdown + 0.15*liquidation + 0.15*cost_fragility + 0.15*parameter_sensitivity
+ 0.10*data_quality + 0.10*funding_fragility + 0.10*exposure_concentration + 0.05*complexity
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from .models import BotSpec
from ..xstocks import XSTOCK_POSITION_CAP_USDT, asset_class_of, is_xstock


def _d(v: Any, default: str = "0") -> Decimal:
    if v is None:
        return Decimal(default)
    return Decimal(str(v))


@dataclass
class CockpitReport:
    risk_score: float       # 0..100, lower is safer
    risk_class: str         # LOW / MODERATE / HIGH / VERY_HIGH / EXTREME
    hard_blocks: list[str]
    modules: dict[str, Any]


def _classify(score: float) -> str:
    if score < 20: return "LOW"
    if score < 40: return "MODERATE"
    if score < 60: return "HIGH"
    if score < 80: return "VERY_HIGH"
    return "EXTREME"


def ruin_simulator(spec: BotSpec) -> dict:
    """§10 Futures Martingale ruin simulator (correction #6)."""
    p = spec.params
    base = _d(p.get("base_order_margin", "100"))
    safety = _d(p.get("safety_order_margin", "100"))
    multiplier = _d(p.get("safety_order_multiplier", "1.5"))
    max_safety = int(p.get("max_safety_orders", 5))
    dev = _d(p.get("price_deviation_fraction", "0.02"))
    dev_mult = _d(p.get("deviation_multiplier", "1.0"))
    leverage = _d(p.get("leverage", "1"))
    fee_bps_round = _d(p.get("fee_bps_round_trip", "11"))
    funding_shock = _d(p.get("funding_shock_pct", "0.01"))

    # Ladder notional with funding+fees, worst case includes all safety orders filled.
    total_margin = base
    total_notional = base * leverage
    cur_safety = safety
    cur_dev = dev
    for _ in range(max_safety):
        total_margin += cur_safety
        total_notional += cur_safety * leverage
        cur_safety *= multiplier
        cur_dev = cur_dev * dev_mult + dev
    fees = total_notional * (fee_bps_round / Decimal(10000))
    funding_cost = total_notional * funding_shock
    worst_case_required = total_margin + fees + funding_cost
    return {
        "max_safety_orders": max_safety,
        "total_margin_required": str(total_margin),
        "fees_estimated": str(fees),
        "funding_shock_cost": str(funding_cost),
        "worst_case_required_margin": str(worst_case_required),
        "price_move_to_max_safety_fraction": str(cur_dev),
    }


def liquidation_heatmap(spec: BotSpec) -> dict:
    p = spec.params
    lev = _d(p.get("leverage", "1"))
    if lev <= 1:
        return {"applicable": False}
    # Simple uniform-tier approximation when full MM tiers aren't available.
    mmr = _d(p.get("mmr_fraction", "0.005"))
    initial_margin_fraction = Decimal(1) / lev
    liq_distance = initial_margin_fraction - mmr
    return {
        "applicable": True,
        "leverage": str(lev),
        "initial_margin_fraction": str(initial_margin_fraction),
        "maintenance_margin_fraction": str(mmr),
        "approx_liquidation_distance_fraction": str(liq_distance),
        "label": "APPROXIMATE_LIQUIDATION" if not p.get("mmr_tiers_provided") else "ACCURATE_TIERED_MARGIN",
    }


def funding_shock(spec: BotSpec) -> dict:
    if not spec.bot_type.startswith("futures") and spec.bot_type not in {"funding_arbitrage", "position_snowball"}:
        return {"applicable": False}
    shock = _d(spec.params.get("funding_shock_pct", "0.01"))
    return {"applicable": True, "shock_fraction": str(shock), "note": "Equity impact = notional × shock_fraction."}


def fee_slippage_shock(spec: BotSpec) -> dict:
    fee_round = _d(spec.params.get("fee_bps_round_trip", "11"))
    slip = _d(spec.params.get("slippage_bps_one_way", "2"))
    return {"fee_bps_round_trip": str(fee_round), "slippage_bps_one_way": str(slip)}


def range_breakout_stress(spec: BotSpec) -> dict:
    if spec.bot_type not in {"spot_grid", "futures_grid"}:
        return {"applicable": False}
    lower = _d(spec.params.get("lower_price", "0"))
    upper = _d(spec.params.get("upper_price", "0"))
    width = upper - lower if upper > lower else Decimal(0)
    return {"applicable": True, "range_width": str(width), "label": "BREAKOUT_RISK_HIGH" if width <= 0 else "BREAKOUT_RISK_MODERATE"}


def rebalance_cost_stress(spec: BotSpec) -> dict:
    if spec.bot_type not in {"futures_combo", "rebalancer", "cross_asset_allocator"}:
        return {"applicable": False}
    rebalance = spec.params.get("rebalance", {}) or {}
    return {"applicable": True, "mode": rebalance.get("mode", "threshold"), "interval_hours": rebalance.get("interval_hours")}


def execution_shortfall(spec: BotSpec, coverage: dict | None = None) -> dict:
    if spec.bot_type not in {"twap", "vp_pov", "chase_limit", "iceberg", "scaled_order"}:
        return {"applicable": False}
    coverage = coverage or {}
    l2 = bool(coverage.get("has_recorded_l2") or coverage.get("has_l2") or coverage.get("has_live_l1"))
    return {
        "applicable": True,
        "verified_metric_available": l2,
        "note": "verified" if l2 else "APPROXIMATE_FILLS: candle-only execution metric is not verifiable (§E0).",
    }


def xstock_constraints(spec: BotSpec) -> dict:
    """Tokenized-equity (xStock) constraint surface. Applies to any bot whose legs
    or symbol reference an xStock pair."""
    legs = _combo_legs(spec)
    p = spec.params or {}
    single_syms = [str(p.get(k)) for k in ("symbol", "perp_symbol", "spot_symbol") if p.get(k)]
    leg_syms = ([str(l.get("symbol")) for l in legs] if legs else []) + list(spec.symbols) + single_syms
    equity_syms = sorted({s for s in leg_syms if is_xstock(s)})
    if not equity_syms:
        return {"applicable": False}
    futures_types = {"futures_grid", "futures_dca", "futures_martingale", "futures_combo",
                     "funding_arbitrage", "position_snowball"}
    violations: list[str] = []
    # No perps/futures on a tokenized equity (any bot type).
    if spec.bot_type in futures_types:
        violations.append(f"XSTOCK_NO_PERP_OR_FUTURES:{spec.bot_type}")
    # Bot-level leverage / short direction.
    if _d(p.get("leverage", "1")) > 1:
        violations.append("XSTOCK_LEVERAGE_NOT_ALLOWED")
    if str(p.get("direction", "")).lower() == "short":
        violations.append("XSTOCK_SHORT_NOT_ALLOWED")
    # short / leverage violations on equity legs
    for l in legs:
        sym = str(l.get("symbol"))
        if not is_xstock(sym):
            continue
        if str(l.get("side", "long")) == "short":
            violations.append(f"XSTOCK_SHORT_NOT_ALLOWED:{sym}")
        if _d(l.get("leverage", "1")) > 1:
            violations.append(f"XSTOCK_LEVERAGE_NOT_ALLOWED:{sym}")
    # per-token notional cap (static weight estimate)
    total = _d(spec.params.get("total_investment", "0"))
    cap_warn: list[str] = []
    for l in legs:
        sym = str(l.get("symbol"))
        if is_xstock(sym) and total > 0:
            notional = total * abs(_d(l.get("target_weight_fraction", "0")))
            if notional > XSTOCK_POSITION_CAP_USDT:
                cap_warn.append(f"{sym}:{notional}")
    return {
        "applicable": True,
        "equity_symbols": equity_syms,
        "spot_only": True,
        "short_allowed": False,
        "leverage_allowed": False,
        "trades_24_7": True,
        "underlying_rth_only": True,
        "position_cap_usdt": str(XSTOCK_POSITION_CAP_USDT),
        "position_cap_warnings": cap_warn,
        "restricted_regions_live": ["EEA", "AU", "JP"],
        "violations": violations,
        "note": "xStocks are spot-only, long-only, unleveraged, no funding/dividends; region-gated for LIVE.",
    }


def _combo_legs(spec: BotSpec) -> list[dict]:
    """Combo/Rebalancer leg list. v4.1 spec calls it ``legs`` in docs but the bot
    reads ``symbols``; accept either."""
    return spec.params.get("legs") or spec.params.get("symbols") or []


def concentration_risk(spec: BotSpec) -> dict:
    if spec.bot_type not in {"futures_combo", "rebalancer", "cross_asset_allocator"}:
        return {"applicable": False, "symbols": spec.symbols, "n_symbols": len(spec.symbols)}
    legs = _combo_legs(spec)
    if not legs:
        return {"applicable": True, "n_legs": 0, "hhi": 1.0}
    weights = [float(l.get("target_weight_fraction", 0)) for l in legs]
    hhi = sum(w * w for w in weights)
    return {"applicable": True, "n_legs": len(legs), "hhi": hhi, "max_weight": max(weights) if weights else 0.0}


def regime_flip_test(spec: BotSpec) -> dict:
    return {"note": "Placeholder regime-flip test; covered separately by walk-forward + bootstrap (§12)."}


def compute_cockpit(spec: BotSpec, coverage: dict | None = None) -> CockpitReport:
    coverage = coverage or {}

    modules = {
        "ruin_simulator": ruin_simulator(spec) if spec.bot_type == "futures_martingale" else {"applicable": False},
        "liquidation_heatmap": liquidation_heatmap(spec),
        "funding_shock": funding_shock(spec),
        "fee_slippage_shock": fee_slippage_shock(spec),
        "range_breakout_stress": range_breakout_stress(spec),
        "rebalance_cost_stress": rebalance_cost_stress(spec),
        "execution_shortfall": execution_shortfall(spec, coverage),
        "concentration_risk": concentration_risk(spec),
        "regime_flip_test": regime_flip_test(spec),
        "xstock_constraints": xstock_constraints(spec),
    }

    # Component subscores
    drawdown = 60.0 if spec.bot_type in {"futures_martingale", "position_snowball"} else 30.0
    leverage = float(_d(spec.params.get("leverage", "1")))
    liquidation = min(100.0, 10.0 * max(0.0, leverage - 1))
    cost_fragility = 30.0 if spec.bot_type in {"spot_grid", "futures_grid"} else 20.0
    param_sensitivity = 40.0 if spec.bot_type in {"futures_martingale", "position_snowball"} else 20.0
    data_quality = 0.0 if coverage.get("data_complete", True) else 70.0
    funding_fragility = 50.0 if spec.bot_type == "funding_arbitrage" else (30.0 if spec.bot_type.startswith("futures") else 0.0)
    exposure_concentration = (modules["concentration_risk"].get("hhi", 0.0) or 0.0) * 100.0
    complexity = 60.0 if spec.bot_type in {"futures_combo", "rebalancer", "funding_arbitrage"} else 20.0

    score = (
        0.20 * drawdown + 0.15 * liquidation + 0.15 * cost_fragility
        + 0.15 * param_sensitivity + 0.10 * data_quality + 0.10 * funding_fragility
        + 0.10 * exposure_concentration + 0.05 * complexity
    )

    # Martingale without stop-loss is categorically high-risk regardless of arithmetic score.
    if spec.bot_type == "futures_martingale" and not _d(spec.params.get("hard_stop_loss_fraction", "0")) > 0:
        score = max(score, 80.0)

    # Hard blocks (§22 + §E0)
    hard_blocks: list[str] = []
    if spec.bot_type.startswith("futures") and leverage > 1 and not coverage.get("has_margin_tiers"):
        hard_blocks.append("FUTURES_LEVERAGE_WITHOUT_MARGIN_TIERS")
    if spec.bot_type == "futures_martingale" and not _d(spec.params.get("hard_stop_loss_fraction", "0")) > 0:
        hard_blocks.append("MARTINGALE_WITHOUT_STOP_LOSS")
    if spec.bot_type in {"spot_grid", "futures_grid"} and _d(spec.params.get("lower_price")) >= _d(spec.params.get("upper_price")):
        hard_blocks.append("GRID_LOWER_GTE_UPPER")
    if spec.bot_type == "vp_pov" and not coverage.get("has_volume", True):
        hard_blocks.append("VP_MISSING_VOLUME")
    if spec.bot_type in {"futures_combo", "rebalancer"} or (
        spec.bot_type == "cross_asset_allocator" and spec.params.get("mode", "static") == "static"
    ):
        legs = _combo_legs(spec)
        gross = sum(abs(float(l.get("target_weight_fraction", 0))) for l in legs)
        if legs and abs(gross - 1.0) > 0.01:
            hard_blocks.append("COMBO_GROSS_WEIGHTS_NOT_ONE")
    # xStock (tokenized equity) hard blocks — spot-only, long-only, unleveraged.
    xc = modules["xstock_constraints"]
    if xc.get("applicable"):
        for v in xc.get("violations", []):
            hard_blocks.append(v)
    if spec.bot_type in {"twap", "vp_pov", "chase_limit", "iceberg", "scaled_order"} and not (coverage.get("has_l2") or coverage.get("has_recorded_l2") or coverage.get("has_live_l1")):
        # §E0: this is a verified-tier block only — flagged here so the GUI can show it.
        hard_blocks.append("E0_VERIFIED_EXECUTION_REQUIRES_L1_L2")

    return CockpitReport(
        risk_score=round(score, 2),
        risk_class=_classify(score),
        hard_blocks=hard_blocks,
        modules=modules,
    )
