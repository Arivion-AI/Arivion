from __future__ import annotations

from typing import Any

from .base import DataRequirements, EvidenceBundle, MarketRef, ValidationResult


class BybitAdapter:
    venue_id = "bybit"
    chain_id = None
    venue_type = "cex"

    def list_markets(self) -> list[MarketRef]:
        return []

    def get_data_requirements(self, market: MarketRef, strategy: Any) -> DataRequirements:
        return DataRequirements(candles=True, funding=True, l2_orderbook=False)

    def validate_order(self, order: Any, policy: Any) -> ValidationResult:
        return ValidationResult(ok=True)

    def evidence(self, fill_or_quote: Any) -> EvidenceBundle:
        return EvidenceBundle(result_tier="LOCAL ONLY", data_source="bybit", execution_fidelity="bar_based")
