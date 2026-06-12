"""AMM quote/fill helpers for DEX-modeled simulation.

The MVP supports constant-product reserve snapshots and explicit mid-price fallback. Concentrated
liquidity tick walking belongs in a stronger adapter, but this module keeps the honesty labels crisp.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, getcontext
from typing import Literal

getcontext().prec = 50

AmmMode = Literal["amm_mid_only", "amm_quote_snapshot", "amm_swap_replay"]


@dataclass(frozen=True)
class RouteLeg:
    pool_id: str
    venue: str
    token_in: str
    token_out: str
    fee_bps: Decimal = Decimal("30")


@dataclass(frozen=True)
class AmmQuote:
    mode: AmmMode
    amount_in: Decimal
    expected_out: Decimal
    min_out: Decimal
    fee_bps: Decimal
    slippage_bps: Decimal
    price_impact_bps: Decimal
    gas_estimate: int | None
    result_tier: str
    warnings: list[str] = field(default_factory=list)

    def truth(self) -> dict:
        return {
            "result_tier": self.result_tier,
            "data_source": "dex",
            "execution_fidelity": self.mode,
            "liquidity_proof": {
                "price_impact_bps": str(self.price_impact_bps),
                "fee_bps": str(self.fee_bps),
            },
            "manipulation_warnings": self.warnings,
            "can_execute_real_money": False,
        }


def quote_constant_product(
    *,
    amount_in: Decimal,
    reserve_in: Decimal,
    reserve_out: Decimal,
    fee_bps: Decimal = Decimal("30"),
    slippage_bps: Decimal = Decimal("50"),
) -> AmmQuote:
    if amount_in <= 0:
        raise ValueError("amount_in must be positive")
    if reserve_in <= 0 or reserve_out <= 0:
        raise ValueError("reserves must be positive")
    amount_after_fee = amount_in * (Decimal("1") - fee_bps / Decimal("10000"))
    expected_out = (amount_after_fee * reserve_out) / (reserve_in + amount_after_fee)
    mid_out = amount_in * (reserve_out / reserve_in)
    impact = Decimal("0") if mid_out <= 0 else max(Decimal("0"), (Decimal("1") - expected_out / mid_out) * Decimal("10000"))
    min_out = expected_out * (Decimal("1") - slippage_bps / Decimal("10000"))
    warnings: list[str] = []
    if amount_in / reserve_in > Decimal("0.01"):
        warnings.append("TRADE_EXCEEDS_1_PERCENT_POOL_RESERVE")
    return AmmQuote(
        mode="amm_quote_snapshot",
        amount_in=amount_in,
        expected_out=expected_out,
        min_out=min_out,
        fee_bps=fee_bps,
        slippage_bps=slippage_bps,
        price_impact_bps=impact,
        gas_estimate=None,
        result_tier="DEX MODELED",
        warnings=warnings,
    )


def quote_mid_only(
    *,
    amount_in: Decimal,
    mid_price: Decimal,
    fee_bps: Decimal = Decimal("30"),
    slippage_bps: Decimal = Decimal("50"),
    reason: str = "NO_POOL_SNAPSHOT",
) -> AmmQuote:
    if amount_in <= 0:
        raise ValueError("amount_in must be positive")
    if mid_price <= 0:
        raise ValueError("mid_price must be positive")
    expected_out = amount_in * mid_price * (Decimal("1") - fee_bps / Decimal("10000"))
    min_out = expected_out * (Decimal("1") - slippage_bps / Decimal("10000"))
    return AmmQuote(
        mode="amm_mid_only",
        amount_in=amount_in,
        expected_out=expected_out,
        min_out=min_out,
        fee_bps=fee_bps,
        slippage_bps=slippage_bps,
        price_impact_bps=Decimal("0"),
        gas_estimate=None,
        result_tier="LOCAL ONLY",
        warnings=[reason],
    )
