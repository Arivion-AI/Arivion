# auto-generated from strategy.schema.json; schema_sha256=346ef87abaa0d0fb
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal

RequirementValue = Literal["REQUIRED", "REQUIRED_NATIVE_CADENCE", "OPTIONAL_SUBJECT_TO_RETENTION", "NOT_USED"]


@dataclass
class Universe:
    category: str
    symbols: List[str]
    timeframe: str
    timezone: str


@dataclass
class Sizing:
    type: str
    max_position_fraction: float
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Risk:
    max_leverage: float
    max_daily_loss_fraction: float
    max_drawdown_kill_fraction: float
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Accounting:
    perp_funding: Literal["funding_history_timestamp_driven"]
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Strategy:
    name: str
    universe: Universe
    data_requirements: Dict[str, RequirementValue]
    features: Dict[str, Any]
    entry: Dict[str, Any]
    exit: Dict[str, Any]
    sizing: Sizing
    risk: Risk
    accounting: Accounting


@dataclass
class StrategySpec:
    strategy: Strategy
