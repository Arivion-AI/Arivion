"""DEX/on-chain market data records.

These records are chain-neutral. They deliberately carry provenance and coverage fields so a
strategy cannot silently treat DEX candles as Bybit candles.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any


@dataclass(frozen=True)
class DexCandle:
    pool_id: str
    interval: str
    open_time: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume0: Decimal = Decimal("0")
    volume1: Decimal = Decimal("0")
    volume_usd: Decimal = Decimal("0")
    source: str = "unknown"
    coverage_score: Decimal = Decimal("0")
    synthetic_symbol: str | None = None
    blend_config: dict[str, Any] | None = None


@dataclass(frozen=True)
class DexSwap:
    tx_hash: str
    log_index: int
    pool_id: str
    block_number: int
    ts: datetime
    amount0: Decimal | None = None
    amount1: Decimal | None = None
    amount_usd: Decimal | None = None
    price_usd: Decimal | None = None
    source: str = "unknown"


@dataclass(frozen=True)
class DexPoolSnapshot:
    pool_id: str
    block_number: int
    ts: datetime
    reserve0: Decimal | None = None
    reserve1: Decimal | None = None
    liquidity: Decimal | None = None
    price_usd: Decimal | None = None
    source: str = "unknown"
    checksum: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DexCoverage:
    pool_id: str
    interval: str
    source: str
    expected_bars: int
    actual_bars: int
    swap_rows: int = 0
    snapshot_rows: int = 0
    coverage_score: Decimal = Decimal("0")

    @property
    def strong_enough_for_modeled(self) -> bool:
        return self.coverage_score >= Decimal("0.65") and self.actual_bars > 0
