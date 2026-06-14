"""WS-F: order-type semantics wired into PaperRuntime intake/processing (opt-in).
PostOnly-reject-if-crossing, reduceOnly-clamp, IOC/FOK, triggerBy reference."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from quant_core.orders import Bar, Order, OrderType, TimeInForce
from quant_core.portfolio import Portfolio, RiskConfig
from quant_core.paper_runtime import PaperRuntime
from quant_core.strategies.base import Strategy, StrategyDecision
from quant_core.bybit_venue import resolve_trigger_price

D = Decimal


def dt(i):
    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=15 * i)


def bars(prices):
    return [Bar(ts=dt(i), open=D(p), high=D(str(float(p) + 1)), low=D(str(float(p) - 1)),
                close=D(p), volume=D("1000")) for i, p in enumerate(prices)]


class _PlaceOnce(Strategy):
    """Emits a single supplied order on bar 0, nothing after."""
    def __init__(self, order: Order):
        super().__init__({})
        self._order = order
        self._done = False

    def on_bar(self, ctx):
        if self._done:
            return StrategyDecision()
        self._done = True
        return StrategyDecision(place=[self._order])


def _runtime(order, enforce=True):
    port = Portfolio(starting_equity=D("100000"),
                     risk=RiskConfig(max_position_fraction=D("1.0"), max_total_exposure_fraction=D("1.0")))
    rt = PaperRuntime(symbol="BTCUSDT", portfolio=port, strategy=_PlaceOnce(order),
                      fee_bps_taker=D("0"), slippage_bps_one_way=D("0"))
    rt.enforce_order_semantics = enforce
    return rt


class PostOnlyTests(unittest.TestCase):
    def test_marketable_postonly_rejected(self):
        # buy limit 101 vs bar.close 100 -> would cross -> rejected
        o = Order(symbol="BTCUSDT", side="buy", qty=D("0.01"), order_type=OrderType.LIMIT,
                  limit_price=D("101"), post_only=True)
        rt = _runtime(o)
        r = rt.run(bars=bars(["100", "100", "100"]))
        rej = [e for e in r.events if e.type == "REJECTED" and e.payload.get("reason") == "POST_ONLY_WOULD_CROSS"]
        self.assertEqual(len(rej), 1)

    def test_passive_postonly_accepted(self):
        o = Order(symbol="BTCUSDT", side="buy", qty=D("0.01"), order_type=OrderType.LIMIT,
                  limit_price=D("99"), post_only=True)
        rt = _runtime(o)
        r = rt.run(bars=bars(["100", "100", "100"]))
        self.assertFalse([e for e in r.events if e.type == "REJECTED"])

    def test_off_by_default_no_rejection(self):
        o = Order(symbol="BTCUSDT", side="buy", qty=D("0.01"), order_type=OrderType.LIMIT,
                  limit_price=D("101"), post_only=True)
        rt = _runtime(o, enforce=False)
        r = rt.run(bars=bars(["100", "100", "100"]))
        self.assertFalse([e for e in r.events if e.type == "REJECTED" and e.payload.get("reason") == "POST_ONLY_WOULD_CROSS"])


class ReduceOnlyTests(unittest.TestCase):
    def test_reduce_only_with_no_position_rejected(self):
        o = Order(symbol="BTCUSDT", side="sell", qty=D("0.01"), order_type=OrderType.MARKET,
                  reduce_only=True)
        rt = _runtime(o)
        r = rt.run(bars=bars(["100", "100", "100"]))
        rej = [e for e in r.events if e.type == "REJECTED" and e.payload.get("reason") == "REDUCE_ONLY_NO_POSITION"]
        self.assertEqual(len(rej), 1)


class IocFokTests(unittest.TestCase):
    def test_fok_unfilled_cancelled(self):
        # buy limit far below the bar low -> cannot fill -> FOK cancels immediately
        o = Order(symbol="BTCUSDT", side="buy", qty=D("0.01"), order_type=OrderType.LIMIT,
                  limit_price=D("50"), tif=TimeInForce.FOK)
        rt = _runtime(o)
        r = rt.run(bars=bars(["100", "100", "100"]))
        canc = [e for e in r.events if e.type == "CANCELLED" and "FOK" in (e.payload.get("reason") or "")]
        self.assertTrue(canc)
        self.assertEqual(len(r.fills), 0)


class TriggerByTests(unittest.TestCase):
    def test_resolve_reference_series(self):
        self.assertEqual(resolve_trigger_price("LastPrice", D("100"), mark=D("101"), index=D("102")), D("100"))
        self.assertEqual(resolve_trigger_price("MarkPrice", D("100"), mark=D("101"), index=D("102")), D("101"))
        self.assertEqual(resolve_trigger_price("IndexPrice", D("100"), mark=D("101"), index=D("102")), D("102"))
        # missing series -> fall back to last
        self.assertEqual(resolve_trigger_price("MarkPrice", D("100")), D("100"))


if __name__ == "__main__":
    unittest.main()
