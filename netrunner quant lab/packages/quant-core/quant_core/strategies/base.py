"""Strategy interface for the paper-trading runtime.

A Strategy receives bars/funding/marks via ``on_bar`` and returns a list of
order-intents. The runtime applies risk gates, places orders, and processes fills.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any

from ..orders import Order, OrderType, Side, TimeInForce


@dataclass
class StrategyContext:
    """Read-only view of portfolio + market state passed to strategy on each bar."""
    ts: datetime
    symbol: str
    bar_open: Decimal
    bar_high: Decimal
    bar_low: Decimal
    bar_close: Decimal
    bar_volume: Decimal
    position_qty: Decimal     # signed: positive long, negative short
    position_side: str        # "long" | "short" | "flat"
    avg_entry: Decimal
    cash: Decimal
    equity: Decimal
    open_orders: list[Order]
    funding_rate_last: Decimal | None = None


@dataclass
class StrategyDecision:
    """Strategy output for a single bar."""
    place: list[Order] = field(default_factory=list)
    cancel_order_ids: list[str] = field(default_factory=list)
    cancel_all: bool = False
    log: list[str] = field(default_factory=list)


class Strategy:
    """Strategy base class. Subclasses override ``on_bar``."""

    name: str = "base"

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        self.params = params or {}

    def on_bar(self, ctx: StrategyContext) -> StrategyDecision:
        raise NotImplementedError

    def on_fill(self, order: Order, fill_price: Decimal, fill_qty: Decimal) -> None:
        """Optional hook — default no-op."""

    @staticmethod
    def buy_market(symbol: str, qty: Decimal, *, tag: str | None = None, reduce_only: bool = False) -> Order:
        return Order(symbol=symbol, side="buy", qty=qty, order_type=OrderType.MARKET, client_tag=tag, reduce_only=reduce_only)

    @staticmethod
    def sell_market(symbol: str, qty: Decimal, *, tag: str | None = None, reduce_only: bool = False) -> Order:
        return Order(symbol=symbol, side="sell", qty=qty, order_type=OrderType.MARKET, client_tag=tag, reduce_only=reduce_only)

    @staticmethod
    def limit(symbol: str, side: Side, qty: Decimal, price: Decimal, *, post_only: bool = True, tif: TimeInForce = TimeInForce.GTC, tag: str | None = None) -> Order:
        return Order(symbol=symbol, side=side, qty=qty, order_type=OrderType.LIMIT, limit_price=price, post_only=post_only, tif=tif, client_tag=tag)

    @staticmethod
    def stop_market(symbol: str, side: Side, qty: Decimal, stop: Decimal, *, reduce_only: bool = True, tag: str | None = None) -> Order:
        return Order(symbol=symbol, side=side, qty=qty, order_type=OrderType.STOP_MARKET, stop_price=stop, reduce_only=reduce_only, client_tag=tag)

    @staticmethod
    def trailing_stop(symbol: str, side: Side, qty: Decimal, offset: Decimal, *, reduce_only: bool = True, tag: str | None = None) -> Order:
        return Order(symbol=symbol, side=side, qty=qty, order_type=OrderType.TRAILING_STOP, trailing_offset=offset, reduce_only=reduce_only, client_tag=tag)
