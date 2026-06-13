from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal


BotType = Literal[
    "spot_grid",
    "futures_grid",
    "dca",
    "futures_dca",
    "futures_martingale",
    "futures_combo",
    "rebalancer",
    "funding_arbitrage",
    "twap",
    "vp_pov",
    "chase_limit",
    "iceberg",
    "scaled_order",
    "position_snowball",
    "cross_asset_allocator",
]

OrderType = Literal["market", "limit", "stop_market", "stop_limit", "trailing_stop"]
Side = Literal["buy", "sell"]


@dataclass(frozen=True)
class OrderIntent:
    symbol: str
    side: Side
    qty: Decimal
    order_type: OrderType
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    reduce_only: bool = False
    post_only: bool = False
    tif: str = "gtc"
    trigger_by: str = "LastPrice"
    tag: str | None = None


@dataclass
class BotSpec:
    bot_type: BotType
    name: str
    symbols: list[str]
    params: dict[str, Any]
    risk: dict[str, Any] = field(default_factory=dict)
    accounting: dict[str, Any] = field(default_factory=dict)


@dataclass
class BotContext:
    ts: datetime
    prices: dict[str, Decimal]
    marks: dict[str, Decimal]
    prior_bar_volume: dict[str, Decimal] = field(default_factory=dict)
    funding_rates: dict[str, Decimal] = field(default_factory=dict)
    positions: dict[str, Decimal] = field(default_factory=dict)
    equity: Decimal = Decimal(0)
    cash: Decimal = Decimal(0)

    def price(self, symbol: str) -> Decimal:
        if symbol in self.prices:
            return self.prices[symbol]
        if symbol in self.marks:
            return self.marks[symbol]
        raise KeyError(f"missing price for {symbol}")

    def mark(self, symbol: str) -> Decimal:
        if symbol in self.marks:
            return self.marks[symbol]
        if symbol in self.prices:
            return self.prices[symbol]
        raise KeyError(f"missing mark for {symbol}")


@dataclass
class BotDecision:
    place: list[OrderIntent] = field(default_factory=list)
    cancel_all: bool = False
    cancel_tags: list[str] = field(default_factory=list)
    risk_notes: list[str] = field(default_factory=list)
    logs: list[str] = field(default_factory=list)


@dataclass
class BotValidation:
    valid: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    eligibility_labels: list[str] = field(default_factory=list)
    risk_class: str = "MODERATE"
