"""WS-G: queue-aware maker fills. A resting order behind a large queue does not fill on a
light touch but does once cumulative through-volume exceeds the queue; a sweep fills fully."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from quant_core.orders import queue_aware_fill_qty, Bar, Order, OrderType
from quant_core.portfolio import Portfolio, RiskConfig
from quant_core.paper_runtime import PaperRuntime
from quant_core.strategies.base import Strategy, StrategyDecision

D = Decimal


class QueueModelTests(unittest.TestCase):
    def test_behind_queue_no_fill_on_light_touch(self):
        # queue_ahead 100, only 30 traded through -> still behind -> 0
        self.assertEqual(queue_aware_fill_qty(D("10"), D("100"), D("30")), D("0"))

    def test_overflow_fills_after_queue_consumed(self):
        # queue 100, 105 traded through -> 5 overflow -> fill min(remaining 10, 5) = 5
        self.assertEqual(queue_aware_fill_qty(D("10"), D("100"), D("105")), D("5"))

    def test_large_overflow_fills_full_remaining(self):
        self.assertEqual(queue_aware_fill_qty(D("10"), D("100"), D("200")), D("10"))

    def test_sweep_fills_full(self):
        self.assertEqual(queue_aware_fill_qty(D("10"), D("100"), D("0"), swept=True), D("10"))


def dt(i):
    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=15 * i)


class _RestLimit(Strategy):
    def __init__(self, order):
        super().__init__({})
        self._order = order
        self._done = False

    def on_bar(self, ctx):
        if self._done:
            return StrategyDecision()
        self._done = True
        return StrategyDecision(place=[self._order])


class QueueWiringTests(unittest.TestCase):
    def _run(self, provider):
        # A passive buy limit at 99; bars dip to let can_fill_limit penetrate.
        bars = [Bar(ts=dt(i), open=D("100"), high=D("101"), low=D("98"),
                    close=D("100"), volume=D("1000")) for i in range(3)]
        o = Order(symbol="BTCUSDT", side="buy", qty=D("10"), order_type=OrderType.LIMIT,
                  limit_price=D("99"))
        port = Portfolio(starting_equity=D("1000000"),
                         risk=RiskConfig(max_position_fraction=D("1.0"), max_total_exposure_fraction=D("5.0")))
        rt = PaperRuntime(symbol="BTCUSDT", portfolio=port, strategy=_RestLimit(o),
                          fee_bps_taker=D("0"), slippage_bps_one_way=D("0"))
        rt.l2_queue_provider = provider
        r = rt.run(bars=bars)
        return rt, r

    def test_no_fill_when_behind_queue(self):
        rt, r = self._run(lambda order, bar: (D("100"), D("30"), False))   # behind queue every bar
        self.assertTrue(rt.l2_aware_used)
        self.assertEqual(len(r.fills), 0)

    def test_fills_once_through_volume_exceeds_queue(self):
        rt, r = self._run(lambda order, bar: (D("0"), D("1000"), False))   # nothing ahead
        self.assertTrue(rt.l2_aware_used)
        self.assertGreater(len(r.fills), 0)


if __name__ == "__main__":
    unittest.main()
