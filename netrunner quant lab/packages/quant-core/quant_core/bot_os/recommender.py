"""§21 Strategy Recommender. Detects regime + matches to bot types + parameter seeds.

Pipeline: scan bars -> regime features -> candidate bot types -> param ranges.
The actual event-engine rescore of finalists happens in the worker via the
existing optimizer/run_bot loop; this module is the candidate generator.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from ..indicators import ATR, EMA, ZScore
from ..orders import Bar

REGIMES = [
    "sideways_low_vol", "sideways_high_vol",
    "trend_up_low_vol", "trend_up_high_vol",
    "trend_down_low_vol", "trend_down_high_vol",
    "funding_extreme_pos", "funding_extreme_neg",
    "basis_wide", "volume_spike", "illiquid", "data_unhealthy",
]

# Bot-regime affinity matrix per §21
AFFINITY = {
    "sideways_low_vol":      ["spot_grid", "futures_grid", "twap", "dca"],
    "sideways_high_vol":     ["futures_grid", "spot_grid"],          # avoid snowball
    "trend_up_low_vol":      ["dca", "position_snowball", "twap", "cross_asset_allocator"],
    "trend_up_high_vol":     ["dca", "position_snowball", "cross_asset_allocator"],
    "trend_down_low_vol":    ["dca", "twap"],                        # avoid long martingale
    "trend_down_high_vol":   ["twap", "scaled_order"],
    "funding_extreme_pos":   ["funding_arbitrage"],
    "funding_extreme_neg":   ["funding_arbitrage"],
    "basis_wide":            ["funding_arbitrage", "rebalancer", "cross_asset_allocator"],
    "volume_spike":          ["twap", "vp_pov"],
    "illiquid":              ["dca"],                                # warn-only
    "data_unhealthy":        [],
}


@dataclass
class Recommendation:
    bot_type: str
    regime_label: str
    confidence: float                  # 0..1
    params: dict[str, Any]
    expected_risk: dict[str, Any]
    reason: dict[str, Any]


def detect_regime(
    *,
    bars: list[Bar],
    funding_rate_last: Decimal | None = None,
    data_complete: bool = True,
    median_volume: Decimal | None = None,
) -> tuple[str, dict[str, float]]:
    if not data_complete:
        return "data_unhealthy", {}
    if not bars or len(bars) < 30:
        return "data_unhealthy", {"reason": "insufficient_bars"}

    closes = [float(b.close) for b in bars]
    # trend
    n = len(closes)
    short = sum(closes[-10:]) / 10
    long = sum(closes[-30:]) / 30
    trend = (short - long) / long if long > 0 else 0.0
    # vol
    rets = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, n) if closes[i - 1] > 0]
    mean = sum(rets) / len(rets) if rets else 0.0
    var = sum((r - mean) ** 2 for r in rets) / max(1, len(rets) - 1) if rets else 0.0
    vol = math.sqrt(var)
    features = {"trend": trend, "vol": vol}

    # funding regime
    if funding_rate_last is not None:
        if funding_rate_last > Decimal("0.0008"):
            return "funding_extreme_pos", features | {"funding_rate": float(funding_rate_last)}
        if funding_rate_last < Decimal("-0.0008"):
            return "funding_extreme_neg", features | {"funding_rate": float(funding_rate_last)}

    # volume spike
    if median_volume is not None and bars[-1].volume > median_volume * Decimal("3"):
        return "volume_spike", features | {"vol_spike": float(bars[-1].volume / median_volume) if median_volume > 0 else 0.0}

    if abs(trend) < 0.005:
        return "sideways_high_vol" if vol > 0.005 else "sideways_low_vol", features
    if trend > 0:
        return "trend_up_high_vol" if vol > 0.005 else "trend_up_low_vol", features
    return "trend_down_high_vol" if vol > 0.005 else "trend_down_low_vol", features


def _seed_params(bot_type: str, bars: list[Bar], features: dict[str, float]) -> dict[str, Any]:
    last = float(bars[-1].close) if bars else 65000.0
    if bot_type == "spot_grid":
        width = max(0.02, features.get("vol", 0.01) * 8)
        return {"symbol": "BTCUSDT", "lower_price": str(round(last * (1 - width), 2)), "upper_price": str(round(last * (1 + width), 2)), "grid_count": 10, "investment_quote": "1000"}
    if bot_type == "futures_grid":
        width = max(0.02, features.get("vol", 0.01) * 8)
        return {"symbol": "BTCUSDT", "lower_price": str(round(last * (1 - width), 2)), "upper_price": str(round(last * (1 + width), 2)), "grid_count": 10, "direction": "neutral", "leverage": 1, "investment_quote": "1000"}
    if bot_type == "dca":
        return {"symbol": "BTCUSDT", "investment_quote_per_order": "100", "frequency_bars": 96, "max_total_investment": "1000"}
    if bot_type == "position_snowball":
        return {"symbol": "BTCUSDT", "direction": "long" if features.get("trend", 0) > 0 else "short", "initial_margin": "100", "leverage": 1, "add_trigger_roi_fraction": "0.02", "max_adds": 3, "take_profit_roi_fraction": "0.06", "stop_loss_roi_fraction": "0.04"}
    if bot_type == "twap":
        return {"symbol": "BTCUSDT", "side": "buy", "total_qty": "1.0", "slice_count": 10}
    if bot_type == "vp_pov":
        return {"symbol": "BTCUSDT", "side": "buy", "target_qty": "1.0", "participation_rate_fraction": "0.05", "max_participation_rate_fraction": "0.10", "min_slice_qty": "0.001", "max_slice_qty": "0.5"}
    if bot_type == "funding_arbitrage":
        return {"perp_symbol": "BTCUSDT", "spot_symbol": "BTCUSDT", "synthetic_spot": {"mode": "held", "carrying_cost_bps_per_day": "0"}, "entry": {"min_funding_rate": "0.0005"}, "exit": {"funding_rate_below": "0.0001", "max_holding_hours": 240}}
    if bot_type == "rebalancer":
        return {"total_investment": "10000", "rebalance": {"mode": "threshold_or_time", "threshold_fraction": "0.05", "interval_hours": 168}, "symbols": [{"symbol": "BTCUSDT", "side": "long", "target_weight_fraction": "0.6", "leverage": 1}, {"symbol": "ETHUSDT", "side": "long", "target_weight_fraction": "0.4", "leverage": 1}]}
    if bot_type == "cross_asset_allocator":
        return {
            "mode": "regime_switch", "total_investment": "100000", "lookback_bars": 20, "top_n": 3,
            "pause_equity_off_hours": False,
            "rebalance": {"mode": "threshold_or_time", "threshold_fraction": "0.05", "interval_hours": 24},
            "symbols": [
                {"symbol": "BTCUSDT", "asset_class": "crypto", "side": "long", "target_weight_fraction": "0.5", "leverage": 1, "sleeve": "risk_on"},
                {"symbol": "NVDAXUSDT", "asset_class": "equity", "side": "long", "target_weight_fraction": "0.25", "leverage": 1, "sleeve": "risk_off"},
                {"symbol": "GOOGLXUSDT", "asset_class": "equity", "side": "long", "target_weight_fraction": "0.25", "leverage": 1, "sleeve": "risk_off"},
            ],
        }
    if bot_type == "scaled_order":
        width = max(0.02, features.get("vol", 0.01) * 8)
        return {"symbol": "BTCUSDT", "side": "buy", "total_qty": "1.0", "lower_price": str(round(last * (1 - width), 2)), "upper_price": str(round(last * (1 + width), 2)), "order_count": 5, "distribution": "equal", "post_only": True}
    return {"symbol": "BTCUSDT"}


def recommend(
    *,
    bars: list[Bar],
    funding_rate_last: Decimal | None = None,
    data_complete: bool = True,
    median_volume: Decimal | None = None,
    risk_tolerance: str = "moderate",
) -> list[Recommendation]:
    regime, features = detect_regime(
        bars=bars, funding_rate_last=funding_rate_last,
        data_complete=data_complete, median_volume=median_volume,
    )
    if regime == "data_unhealthy":
        return []
    candidates = list(AFFINITY.get(regime, []))
    # Risk filter
    if risk_tolerance == "low":
        deny = {"futures_martingale", "position_snowball", "futures_dca", "funding_arbitrage"}
        candidates = [c for c in candidates if c not in deny]
    elif risk_tolerance == "moderate":
        deny = {"futures_martingale"}
        candidates = [c for c in candidates if c not in deny]

    out: list[Recommendation] = []
    n = len(candidates)
    for i, bot_type in enumerate(candidates):
        confidence = max(0.3, 1.0 - i * 0.15) if n else 0.0
        params = _seed_params(bot_type, bars, features)
        out.append(Recommendation(
            bot_type=bot_type, regime_label=regime, confidence=round(confidence, 2),
            params=params,
            expected_risk={"vol_annualized": features.get("vol", 0.0) * math.sqrt(35040), "regime_vol": features.get("vol")},
            reason={"regime": regime, "trend": features.get("trend"), "vol": features.get("vol"), "match_rank": i + 1, "matched_via": "AFFINITY_MATRIX"},
        ))
    return out
