"""BotSpec semantic validator. Single source of truth (called by worker, not the API).

Combines:
- per-bot ``validate()`` implementation (already on each BotRuntime subclass)
- §E0 execution-data doctrine: TWAP/VP/Chase/Iceberg/Scaled cannot earn a verified
  tier without L1/L2; candle-only is APPROXIMATE_FILLS + LOCAL_ONLY.
- spec_hash stamping (stable JSON sort).
- compiler_version stamping (every validation report carries it).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from decimal import Decimal
from typing import Any

from .models import BotSpec, BotValidation
from .registry import BOT_REGISTRY
from .templates import COMPILER_VERSION
from ..xstocks import is_xstock

EXECUTION_BOT_TYPES = {"twap", "vp_pov", "chase_limit", "iceberg", "scaled_order"}
FUTURES_BOT_TYPES = {"futures_grid", "futures_dca", "futures_martingale", "futures_combo",
                     "funding_arbitrage", "position_snowball"}


def _referenced_symbols(spec: BotSpec) -> list[str]:
    syms: list[str] = list(spec.symbols or [])
    p = spec.params or {}
    for key in ("symbol", "perp_symbol", "spot_symbol"):
        v = p.get(key)
        if isinstance(v, str) and v.strip():
            syms.append(v.strip())
    for leg in (p.get("symbols") or p.get("legs") or []):
        if isinstance(leg, dict) and leg.get("symbol"):
            syms.append(str(leg["symbol"]))
    return syms


def enforce_xstock_rules(spec: BotSpec) -> tuple[list[str], list[str], list[str]]:
    """Universal tokenized-equity guardrails applied to EVERY bot type.

    xStocks on Bybit are spot-only, long-only, unleveraged. Returns
    (errors, warnings, eligibility_labels).
    """
    syms = _referenced_symbols(spec)
    xsyms = sorted({s for s in syms if is_xstock(s)})
    if not xsyms:
        return [], [], []
    errors: list[str] = []
    p = spec.params or {}
    # No perps/futures on a tokenized equity.
    if spec.bot_type in FUTURES_BOT_TYPES:
        errors.append(f"XSTOCK_NO_PERP_OR_FUTURES:{spec.bot_type}")
    # No leverage anywhere.
    try:
        if Decimal(str(p.get("leverage", "1"))) > 1:
            errors.append("XSTOCK_LEVERAGE_NOT_ALLOWED")
    except Exception:
        pass
    for leg in (p.get("symbols") or p.get("legs") or []):
        if isinstance(leg, dict) and is_xstock(str(leg.get("symbol", ""))):
            if str(leg.get("side", "long")) == "short":
                errors.append(f"XSTOCK_SHORT_NOT_ALLOWED:{leg.get('symbol')}")
            try:
                if Decimal(str(leg.get("leverage", "1"))) > 1:
                    errors.append(f"XSTOCK_LEVERAGE_NOT_ALLOWED:{leg.get('symbol')}")
            except Exception:
                pass
    # No explicit short direction on a spot equity.
    if str(p.get("direction", "")).lower() == "short":
        errors.append("XSTOCK_SHORT_NOT_ALLOWED")
    warnings = [
        "XSTOCK_REGION_GATED_LIVE: EEA/AU/JP blocked for live Bybit deployment",
        "XSTOCK_SHORT_HISTORY: tokenized-equity history begins mid-2025",
        "XSTOCK_OFF_HOURS_LIQUIDITY: fills outside US RTH use a widened spread model",
    ]
    return errors, warnings, ["XSTOCK_SPOT_24_7"]


def stable_hash(payload: Any) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def spec_hash(spec: BotSpec) -> str:
    return stable_hash({
        "bot_type": spec.bot_type, "name": spec.name,
        "symbols": spec.symbols, "params": spec.params,
        "risk": spec.risk, "accounting": spec.accounting,
    })


def validate_bot_spec(spec: BotSpec, coverage: dict[str, Any] | None = None, *, requested_tier: str = "LOCAL ONLY") -> dict:
    """Return a validation report including spec_hash + compiler_version."""
    coverage = coverage or {}

    if spec.bot_type not in BOT_REGISTRY:
        return {
            "valid": False, "errors": [f"UNKNOWN_BOT_TYPE:{spec.bot_type}"],
            "warnings": [], "eligibility_labels": [], "risk_class": "EXTREME",
            "spec_hash": spec_hash(spec), "compiler_version": COMPILER_VERSION,
            "fill_model_available": None, "data_requirements": {},
        }

    bot = BOT_REGISTRY[spec.bot_type](spec.params)
    report = bot.validate(spec, coverage)
    errors = list(report.errors)
    warnings = list(report.warnings)
    labels = list(report.eligibility_labels)

    # Universal tokenized-equity (xStock) guardrails for every bot type.
    xs_errors, xs_warnings, xs_labels = enforce_xstock_rules(spec)
    errors.extend(e for e in xs_errors if e not in errors)
    warnings.extend(w for w in xs_warnings if w not in warnings)
    labels.extend(xs_labels)

    # §E0: execution bots cannot earn a verified tier without L1/L2 data.
    has_l2 = bool(coverage.get("has_recorded_l2") or coverage.get("has_l2"))
    has_live_l1 = bool(coverage.get("has_live_l1"))
    is_execution = spec.bot_type in EXECUTION_BOT_TYPES
    if is_execution and not (has_l2 or has_live_l1):
        labels = list(set(labels) | {"APPROXIMATE_FILLS"})
        warnings.append("E0_EXECUTION_BOT_CANDLE_ONLY_NOT_VERIFIABLE")
        if requested_tier in {"BACKTEST_VERIFIED", "LIVE_PAPER_VERIFIED"}:
            errors.append("E0_VERIFIED_EXECUTION_TIER_REQUIRES_L1_L2")

    # Data requirements summary for the GUI.
    data_req: dict[str, str] = {"candles": "REQUIRED"}
    if spec.bot_type.startswith("futures") or spec.bot_type in {"funding_arbitrage", "position_snowball"}:
        data_req["mark_price"] = "REQUIRED_FOR_PERPS"
        data_req["funding_rates"] = "REQUIRED_FOR_PERPS"
    if is_execution:
        data_req["orderbook_depth"] = "REQUIRED_FOR_VERIFIED_EXECUTION_METRICS"

    fill_model = "RECORDED_L2_REPLAY" if has_l2 else ("STRICT_CANDLE_PENETRATION" if not is_execution else "APPROXIMATE_FILLS")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "eligibility_labels": sorted(set(labels)),
        "risk_class": report.risk_class,
        "spec_hash": spec_hash(spec),
        "compiler_version": COMPILER_VERSION,
        "fill_model_available": fill_model,
        "data_requirements": data_req,
    }
