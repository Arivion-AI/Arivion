from __future__ import annotations

from typing import Any

from .base import DataRequirements, EvidenceBundle, MarketRef, ValidationResult


class RobinhoodChainTestStockAdapter:
    venue_id = "rh-testnet-stock"
    chain_id = 46630
    venue_type = "testnet_stock"
    supported_symbols = ("TSLA", "AMZN", "PLTR", "NFLX", "AMD")

    def list_markets(self) -> list[MarketRef]:
        return [
            MarketRef(symbol=s, venue_id=self.venue_id, chain_id=self.chain_id, venue_type="testnet_stock", metadata={"testnet_only": True})
            for s in self.supported_symbols
        ]

    def get_data_requirements(self, market: MarketRef, strategy: Any) -> DataRequirements:
        return DataRequirements(candles=False, notes=["Robinhood Chain stock tokens are testnet-only in this phase."])

    def validate_order(self, order: Any, policy: Any) -> ValidationResult:
        symbol = str(getattr(order, "symbol", None) or order.get("symbol", "")).upper()
        side = str(getattr(order, "side", None) or order.get("side", "buy")).lower()
        errors: list[str] = []
        if symbol not in self.supported_symbols:
            errors.append("UNSUPPORTED_RH_TEST_STOCK")
        if side in {"short", "sell_short"}:
            errors.append("RH_TEST_STOCK_LONG_ONLY")
        return ValidationResult(ok=not errors, errors=errors, warnings=["TESTNET_STOCK_TOKEN_NO_PRODUCTION_RIGHTS"])

    def evidence(self, fill_or_quote: Any) -> EvidenceBundle:
        return EvidenceBundle(
            result_tier="LOCAL ONLY",
            data_source="robinhood_testnet",
            execution_fidelity="testnet_read_only",
            warnings=["TESTNET_STOCK_TOKEN_NO_PRODUCTION_RIGHTS"],
        )
