"""Order types + lifecycle for the paper-trading engine.

Supports market, limit, stop-market, stop-limit, trailing-stop, with OCO grouping
and post-only / reduce-only flags. Strict-penetration limit fills (§10.1 spec).
"""
from __future__ import annotations

import itertools
import math
import os
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Literal

# Square-root market-impact law (Almgren-Chriss): extra slippage ∝ sqrt(order/volume).
# Default 0 => OFF (preserves determinism and existing tests). Set MARKET_IMPACT_COEF
# to model size-dependent impact so a $1M order no longer fills like a $100 one.
MARKET_IMPACT_COEF = float(os.getenv("MARKET_IMPACT_COEF", "0"))


def market_impact_bps(order_qty: Decimal, bar_volume: Decimal) -> Decimal:
    if MARKET_IMPACT_COEF <= 0 or bar_volume is None or bar_volume <= 0:
        return Decimal(0)
    participation = float(order_qty) / float(bar_volume)
    return Decimal(str(MARKET_IMPACT_COEF * math.sqrt(max(0.0, participation)) * 10000.0))


# Bar-based maker fills are optimistic: without L2/queue data, an order can't realistically
# capture more than a small fraction of the bar's volume. MAKER_PARTICIPATION_RATE caps the
# per-bar limit-fill qty to (rate × bar_volume). Default 0 => OFF (fills full remaining,
# preserves determinism/tests). Set e.g. 0.1 for a conservative 10% participation cap.
MAKER_PARTICIPATION_RATE = float(os.getenv("MAKER_PARTICIPATION_RATE", "0"))


def maker_fill_qty(remaining: Decimal, bar_volume: Decimal) -> Decimal:
    """Realistic per-bar maker fill quantity (volume-participation cap)."""
    if MAKER_PARTICIPATION_RATE <= 0 or bar_volume is None or bar_volume <= 0:
        return remaining
    cap = Decimal(str(MAKER_PARTICIPATION_RATE)) * bar_volume
    return remaining if remaining <= cap else cap


def queue_aware_fill_qty(
    remaining: Decimal, queue_ahead: Decimal, through_volume: Decimal, swept: bool = False,
) -> Decimal:
    """WS-G — principled maker fill from queue position (subsumes MAKER_PARTICIPATION_RATE).

    A resting limit at price ``p`` only fills once cumulative traded volume THROUGH ``p`` has
    first consumed the size resting ahead of it in the queue (``queue_ahead``), then fills the
    overflow. If price strictly sweeps past ``p`` (``swept``), the order fills in full.

    Pure & deterministic — a function of the recorded L2 queue + the bar's through-volume:
        swept                       -> remaining
        through <= queue_ahead      -> 0      (still behind the queue)
        else                        -> min(remaining, through - queue_ahead)
    """
    if swept:
        return remaining
    overflow = through_volume - queue_ahead
    if overflow <= 0:
        return Decimal(0)
    return remaining if remaining <= overflow else overflow


Side = Literal["buy", "sell"]
PosSide = Literal["long", "short"]


class OrderType(str, Enum):
    MARKET = "market"
    LIMIT = "limit"
    STOP_MARKET = "stop_market"
    STOP_LIMIT = "stop_limit"
    TRAILING_STOP = "trailing_stop"


class OrderStatus(str, Enum):
    NEW = "new"
    OPEN = "open"
    PARTIAL = "partial"
    FILLED = "filled"
    CANCELLED = "cancelled"
    REJECTED = "rejected"


class TimeInForce(str, Enum):
    GTC = "gtc"
    IOC = "ioc"
    FOK = "fok"


_order_id_counter = itertools.count(1)


def _next_id() -> str:
    return f"ord-{next(_order_id_counter)}"


@dataclass
class Order:
    symbol: str
    side: Side
    qty: Decimal
    order_type: OrderType
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    trailing_offset: Decimal | None = None  # absolute price offset
    tif: TimeInForce = TimeInForce.GTC
    post_only: bool = False
    reduce_only: bool = False
    trigger_by: str = "LastPrice"   # WS-F: LastPrice (default) | MarkPrice | IndexPrice
    oco_group: str | None = None
    client_tag: str | None = None
    order_id: str = field(default_factory=_next_id)
    status: OrderStatus = OrderStatus.NEW
    filled_qty: Decimal = Decimal(0)
    avg_fill_price: Decimal = Decimal(0)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    # Trailing-stop state: best price seen since order was placed (max for sell-stop, min for buy-stop).
    _trail_extreme: Decimal | None = None

    @property
    def remaining(self) -> Decimal:
        return self.qty - self.filled_qty

    def is_terminal(self) -> bool:
        return self.status in {OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.REJECTED}

    def update_trailing(self, last_price: Decimal) -> Decimal | None:
        """Update trailing-stop extreme + return effective stop price."""
        if self.order_type != OrderType.TRAILING_STOP or self.trailing_offset is None:
            return self.stop_price
        if self.side == "sell":
            if self._trail_extreme is None or last_price > self._trail_extreme:
                self._trail_extreme = last_price
            self.stop_price = self._trail_extreme - self.trailing_offset
        else:
            if self._trail_extreme is None or last_price < self._trail_extreme:
                self._trail_extreme = last_price
            self.stop_price = self._trail_extreme + self.trailing_offset
        return self.stop_price


@dataclass
class Fill:
    order_id: str
    symbol: str
    side: Side
    qty: Decimal
    price: Decimal
    fee: Decimal
    slippage_bps: Decimal
    ts: datetime
    is_maker: bool = False


@dataclass
class Bar:
    ts: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal = Decimal(0)


def can_fill_market(bar: Bar, order: Order, slippage_bps: Decimal) -> tuple[Decimal, Decimal]:
    """Return (fill_price, slippage_bps_applied) for a market order against a bar.

    Uses next-bar open + slippage convention from the spec, so the caller must
    pass the *next* bar after the signal bar. For tokenized-equity (xStock)
    symbols filled outside US Regular Trading Hours, slippage is widened to model
    the thin off-hours/weekend book (no effect on crypto symbols).
    """
    from .xstocks import effective_slippage_bps  # local import to avoid cycle
    eff = effective_slippage_bps(getattr(order, "symbol", None), bar.ts, slippage_bps)
    eff = eff + market_impact_bps(order.qty, bar.volume)   # size-dependent impact (off by default)
    factor = eff / Decimal(10000)
    if order.side == "buy":
        return bar.open * (Decimal(1) + factor), eff
    return bar.open * (Decimal(1) - factor), eff


def can_fill_limit(bar: Bar, order: Order, tick_buffer: Decimal) -> Decimal | None:
    """Strict penetration limit fill (§10.1). Returns fill price or None."""
    if order.limit_price is None:
        return None
    if order.side == "buy":
        return order.limit_price if bar.low < order.limit_price - tick_buffer else None
    return order.limit_price if bar.high > order.limit_price + tick_buffer else None


def can_fill_stop(bar: Bar, order: Order) -> bool:
    """Stop triggers when intra-bar range crosses stop price."""
    sp = order.stop_price
    if sp is None:
        return False
    if order.side == "sell":
        return bar.low <= sp  # protective stop on a long, triggers if price falls
    return bar.high >= sp     # protective stop on a short, triggers if price rises


@dataclass
class OcoGroup:
    """One-Cancels-Other group: when one order fills, the others cancel."""
    group_id: str
    order_ids: list[str] = field(default_factory=list)
