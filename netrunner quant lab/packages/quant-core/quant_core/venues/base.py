from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal, Protocol


VenueType = Literal["cex", "amm", "perp", "testnet_stock"]


@dataclass(frozen=True)
class MarketRef:
    symbol: str
    venue_id: str
    chain_id: int | None = None
    pool_id: str | None = None
    venue_type: VenueType = "cex"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DataRequirements:
    candles: bool = True
    swaps: bool = False
    pool_snapshots: bool = False
    funding: bool = False
    l2_orderbook: bool = False
    notes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class QuoteResult:
    expected_out: Decimal
    min_out: Decimal
    price_impact_bps: Decimal
    fee_bps: Decimal
    result_tier: str
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class FillResult:
    qty: Decimal
    price: Decimal
    fee: Decimal
    result_tier: str
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class EvidenceBundle:
    result_tier: str
    data_source: str
    execution_fidelity: str
    coverage_proof: dict[str, Any] = field(default_factory=dict)
    liquidity_proof: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


class VenueAdapter(Protocol):
    venue_id: str
    chain_id: int | None
    venue_type: VenueType

    def list_markets(self) -> list[MarketRef]: ...
    def get_data_requirements(self, market: MarketRef, strategy: Any) -> DataRequirements: ...
    def quote_order(self, order: Any, market_state: Any) -> QuoteResult: ...
    def simulate_fill(self, order: Any, market_state: Any, config: Any) -> FillResult: ...
    def validate_order(self, order: Any, policy: Any) -> ValidationResult: ...
    def evidence(self, fill_or_quote: Any) -> EvidenceBundle: ...
