from __future__ import annotations

from decimal import Decimal
from typing import Any

from ..amm_execution import quote_constant_product, quote_mid_only
from .base import DataRequirements, EvidenceBundle, FillResult, MarketRef, QuoteResult, ValidationResult


class UniswapV3ArbitrumDataAdapter:
    venue_id = "uniswap-v3-arbitrum"
    chain_id = 42161
    venue_type = "amm"

    def list_markets(self) -> list[MarketRef]:
        return []

    def get_data_requirements(self, market: MarketRef, strategy: Any) -> DataRequirements:
        return DataRequirements(candles=True, swaps=True, pool_snapshots=True, notes=["DEX candles must be source-labeled."])

    def quote_order(self, order: Any, market_state: Any) -> QuoteResult:
        amount_in = Decimal(str(getattr(order, "amount_in", None) or order.get("amount_in", "0")))
        fee_bps = Decimal(str(getattr(market_state, "fee_bps", None) or market_state.get("fee_bps", "30")))
        slippage_bps = Decimal(str(getattr(order, "slippage_bps", None) or order.get("slippage_bps", "50")))
        reserve_in = market_state.get("reserve_in")
        reserve_out = market_state.get("reserve_out")
        if reserve_in is not None and reserve_out is not None:
            q = quote_constant_product(
                amount_in=amount_in,
                reserve_in=Decimal(str(reserve_in)),
                reserve_out=Decimal(str(reserve_out)),
                fee_bps=fee_bps,
                slippage_bps=slippage_bps,
            )
        else:
            q = quote_mid_only(
                amount_in=amount_in,
                mid_price=Decimal(str(market_state.get("mid_price", "0"))),
                fee_bps=fee_bps,
                slippage_bps=slippage_bps,
            )
        return QuoteResult(
            expected_out=q.expected_out,
            min_out=q.min_out,
            price_impact_bps=q.price_impact_bps,
            fee_bps=q.fee_bps,
            result_tier=q.result_tier,
            evidence=q.truth(),
        )

    def simulate_fill(self, order: Any, market_state: Any, config: Any) -> FillResult:
        q = self.quote_order(order, market_state)
        return FillResult(
            qty=q.expected_out,
            price=Decimal("0"),
            fee=Decimal("0"),
            result_tier=q.result_tier,
            evidence=q.evidence,
        )

    def validate_order(self, order: Any, policy: Any) -> ValidationResult:
        amount_in = Decimal(str(getattr(order, "amount_in", None) or order.get("amount_in", "0")))
        if amount_in <= 0:
            return ValidationResult(ok=False, errors=["AMOUNT_IN_MUST_BE_POSITIVE"])
        return ValidationResult(ok=True)

    def evidence(self, fill_or_quote: Any) -> EvidenceBundle:
        ev = getattr(fill_or_quote, "evidence", {}) or {}
        return EvidenceBundle(
            result_tier=str(ev.get("result_tier", "DEX MODELED")),
            data_source=str(ev.get("data_source", "dex")),
            execution_fidelity=str(ev.get("execution_fidelity", "amm_quote_snapshot")),
            liquidity_proof=ev.get("liquidity_proof", {}),
            warnings=ev.get("manipulation_warnings", []),
        )
