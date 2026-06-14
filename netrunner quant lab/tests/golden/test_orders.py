from __future__ import annotations

import unittest
from datetime import datetime, timezone
from decimal import Decimal

from quant_core.orders import (
    Bar, Order, OrderType, Side, TimeInForce,
    can_fill_limit, can_fill_market, can_fill_stop,
)


def b(open_, high, low, close):
    return Bar(ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
               open=Decimal(open_), high=Decimal(high), low=Decimal(low), close=Decimal(close))


class OrderTests(unittest.TestCase):
    def test_market_buy_includes_slippage(self) -> None:
        o = Order(symbol="X", side="buy", qty=Decimal(1), order_type=OrderType.MARKET)
        price, _ = can_fill_market(b("100", "100", "100", "100"), o, Decimal(2))
        self.assertEqual(price, Decimal("100.02"))

    def test_market_sell_subtracts_slippage(self) -> None:
        o = Order(symbol="X", side="sell", qty=Decimal(1), order_type=OrderType.MARKET)
        price, _ = can_fill_market(b("100", "100", "100", "100"), o, Decimal(2))
        self.assertEqual(price, Decimal("99.98"))

    def test_limit_buy_strict_penetration(self) -> None:
        o = Order(symbol="X", side="buy", qty=Decimal(1), order_type=OrderType.LIMIT, limit_price=Decimal(100))
        # touch only -> no fill
        self.assertIsNone(can_fill_limit(b("100", "101", "100", "100.5"), o, Decimal("0.1")))
        # strict penetration
        self.assertEqual(can_fill_limit(b("100", "101", "99.8", "100.5"), o, Decimal("0.1")), Decimal(100))

    def test_limit_sell_strict_penetration(self) -> None:
        o = Order(symbol="X", side="sell", qty=Decimal(1), order_type=OrderType.LIMIT, limit_price=Decimal(100))
        self.assertIsNone(can_fill_limit(b("99", "100", "99", "99.5"), o, Decimal("0.1")))
        self.assertEqual(can_fill_limit(b("99", "100.2", "99", "99.5"), o, Decimal("0.1")), Decimal(100))

    def test_stop_sell_triggers_when_low_breaches(self) -> None:
        o = Order(symbol="X", side="sell", qty=Decimal(1), order_type=OrderType.STOP_MARKET, stop_price=Decimal(95))
        self.assertTrue(can_fill_stop(b("100", "101", "94", "97"), o))
        self.assertFalse(can_fill_stop(b("100", "101", "96", "97"), o))

    def test_trailing_stop_updates_extreme(self) -> None:
        o = Order(symbol="X", side="sell", qty=Decimal(1), order_type=OrderType.TRAILING_STOP, trailing_offset=Decimal(5))
        o.update_trailing(Decimal(100))
        self.assertEqual(o.stop_price, Decimal(95))
        o.update_trailing(Decimal(110))
        self.assertEqual(o.stop_price, Decimal(105))
        o.update_trailing(Decimal(108))  # extreme stays at 110
        self.assertEqual(o.stop_price, Decimal(105))


if __name__ == "__main__":
    unittest.main()
