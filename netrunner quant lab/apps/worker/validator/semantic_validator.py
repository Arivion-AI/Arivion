from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import asyncpg
from jsonschema import ValidationError, Draft202012Validator

REQUIREMENT_VOCAB = {
    "REQUIRED",
    "REQUIRED_NATIVE_CADENCE",
    "OPTIONAL_SUBJECT_TO_RETENTION",
    "NOT_USED",
}

ELIGIBILITY_LABELS = {
    "HISTORICAL_FACTOR_OK",
    "SUBJECT_TO_RETENTION",
    "RECORDED_L2_REQUIRED",
    "PAPER_ONLY_LIVE",
    "APPROXIMATE_FILLS",
}


@dataclass
class ValidationResult:
    valid: bool
    errors: list[str]
    warnings: list[str]
    eligibility_label: Literal[
        "HISTORICAL_FACTOR_OK",
        "SUBJECT_TO_RETENTION",
        "RECORDED_L2_REQUIRED",
        "PAPER_ONLY_LIVE",
        "APPROXIMATE_FILLS",
    ]


def _load_schema() -> dict[str, Any]:
    schema_path = (
        Path(__file__).resolve().parents[3]
        / "packages"
        / "strategy-dsl"
        / "strategy.schema.json"
    )
    return json.loads(schema_path.read_text(encoding="utf-8"))


SCHEMA = _load_schema()
SCHEMA_VALIDATOR = Draft202012Validator(SCHEMA)


def _features_reference(features: dict[str, Any], needles: set[str]) -> bool:
    """Structured check: does any feature group / feature / source mention a needle?"""
    if not isinstance(features, dict):
        return False
    for group_name, group in features.items():
        if any(n in group_name.lower() for n in needles):
            return True
        if not isinstance(group, dict):
            continue
        for feat_name, feat in group.items():
            if any(n in feat_name.lower() for n in needles):
                return True
            if isinstance(feat, dict):
                src = str(feat.get("source", "")).lower()
                typ = str(feat.get("type", "")).lower()
                if any(n in src or n in typ for n in needles):
                    return True
    return False


async def _has_complete_coverage(
    conn: asyncpg.Connection,
    symbol: str,
    category: str,
    interval: str,
    start_ts: int,
    end_ts: int,
    subject_to_retention: bool,
) -> bool:
    row = await conn.fetchrow(
        """
        SELECT 1
        FROM data_coverage
        WHERE symbol = $1
          AND category = $2
          AND interval = $3
          AND range_start <= to_timestamp($4 / 1000.0)
          AND range_end >= to_timestamp($5 / 1000.0)
          AND missing_bars = 0
          AND duplicate_bars = 0
          AND subject_to_retention = $6
        ORDER BY updated_at DESC
        LIMIT 1
        """,
        symbol,
        category,
        interval,
        start_ts,
        end_ts,
        subject_to_retention,
    )
    return row is not None


async def validate_semantics(
    conn: asyncpg.Connection,
    payload: dict[str, Any],
) -> ValidationResult:
    errors: list[str] = []
    warnings: list[str] = []

    strategy = payload.get("strategy")
    if strategy is None:
        return ValidationResult(
            valid=False,
            errors=["Missing 'strategy' payload."],
            warnings=[],
            eligibility_label="HISTORICAL_FACTOR_OK",
        )

    try:
        SCHEMA_VALIDATOR.validate(strategy)
    except ValidationError as exc:
        errors.append(f"Schema validation failed: {exc.message}")
        return ValidationResult(
            valid=False,
            errors=errors,
            warnings=warnings,
            eligibility_label="HISTORICAL_FACTOR_OK",
        )

    data_requirements = strategy["strategy"].get("data_requirements", {})

    for key, value in data_requirements.items():
        if value in ELIGIBILITY_LABELS:
            errors.append(
                f"data_requirements.{key} uses eligibility label '{value}'. Requirement vocabulary only."
            )
        elif value not in REQUIREMENT_VOCAB:
            errors.append(f"data_requirements.{key} has unsupported requirement value '{value}'.")

    if not strategy["strategy"].get("exit"):
        errors.append("Missing required exit block.")

    max_leverage = strategy["strategy"].get("risk", {}).get("max_leverage", 1)
    approximate_liquidation = False
    if isinstance(max_leverage, (int, float)) and max_leverage > 1:
        tiers = payload.get("maintenance_margin_tiers") or []
        if not tiers:
            approximate_liquidation = True
            warnings.append(
                "Leverage > 1 without maintenance-margin tiers -> APPROXIMATE_LIQUIDATION (cannot earn a verified tier)."
            )
            if payload.get("require_verified_tier"):
                errors.append(
                    "Verified tier requires maintenance_margin_tiers for leverage > 1."
                )

    requested_mode = payload.get("mode", "historical_backtest")
    wants_historical = requested_mode == "historical_backtest"

    orderbook_req = data_requirements.get("orderbook_depth")
    uses_orderbook_feature = _features_reference(strategy["strategy"].get("features", {}), {"orderbook", "l2", "depth"})
    if wants_historical and (orderbook_req == "REQUIRED" or uses_orderbook_feature):
        errors.append(
            "Historical backtest rejected: strategy requires orderbook/L2 but recorded L2 data is unavailable."
        )
        eligibility = "RECORDED_L2_REQUIRED"
    else:
        oi_req = data_requirements.get("open_interest")
        ls_req = data_requirements.get("long_short_ratio")
        features = strategy["strategy"].get("features", {})
        uses_oi = oi_req in {"REQUIRED", "REQUIRED_NATIVE_CADENCE", "OPTIONAL_SUBJECT_TO_RETENTION"} or _features_reference(
            features, {"open_interest", "oi_delta", "oi_native"}
        )
        uses_ls = ls_req in {"REQUIRED", "REQUIRED_NATIVE_CADENCE", "OPTIONAL_SUBJECT_TO_RETENTION"} or _features_reference(
            features, {"long_short", "account_ratio", "ls_ratio"}
        )

        if uses_oi or uses_ls:
            eligibility = "SUBJECT_TO_RETENTION"

            coverage = payload.get("coverage", {})
            symbol = coverage.get("symbol") or strategy["strategy"].get("universe", {}).get("symbols", [None])[0]
            interval = coverage.get("interval") or strategy["strategy"].get("universe", {}).get("timeframe")
            category = coverage.get("category") or strategy["strategy"].get("universe", {}).get("category", "linear")
            start_ts = coverage.get("startTs")
            end_ts = coverage.get("endTs")

            if not all([symbol, interval, category, start_ts, end_ts]):
                errors.append(
                    "OI/LS strategy requires coverage window (symbol/category/interval/startTs/endTs)."
                )
            else:
                has_coverage = await _has_complete_coverage(
                    conn,
                    str(symbol),
                    str(category),
                    str(interval),
                    int(start_ts),
                    int(end_ts),
                    True,
                )
                if not has_coverage:
                    errors.append(
                        "Coverage missing for OI/LS over requested window (SUBJECT_TO_RETENTION rule)."
                    )
        else:
            eligibility = "HISTORICAL_FACTOR_OK"

    return ValidationResult(
        valid=len(errors) == 0,
        errors=errors,
        warnings=warnings,
        eligibility_label=eligibility,
    )
