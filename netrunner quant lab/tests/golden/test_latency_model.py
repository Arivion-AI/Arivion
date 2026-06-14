"""Phase 5: deterministic latency model in PaperRuntime.

Covers the acceptance criteria: orders don't join before their effective time, a cancel
can't undo a fill that happened before the cancel took effect, jitter is deterministic
under a fixed seed, order events carry the lifecycle timestamps, and latency-off is a no-op.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from quant_core.orders import Bar, Order, OrderType
from quant_core.portfolio import Portfolio, RiskConfig
from quant_core.paper_runtime import PaperRuntime
from quant_core.strategies.base import Strategy, StrategyDecision
from quant_core.execution import LatencyConfig

D = Decimal
MIN = 60_000


def dt(i):
    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=i)


def bars(n, **ohlc):
    o = {"open": D("100"), "high": D("100"), "low": D("100"), "close": D("100"), "volume": D("1000")}
    o.update({k: D(str(v)) for k, v in ohlc.items()})
    return [Bar(ts=dt(i), **o) for i in range(n)]


def _pf():
    return Portfolio(starting_equity=D("1000000"),
                     risk=RiskConfig(max_position_fraction=D("1.0"), max_total_exposure_fraction=D("5.0")))


class _PlaceOnBar0(Strategy):
    def __init__(self, order):
        super().__init__({}); self._o = order; self._done = False

    def on_bar(self, ctx):
        if self._done:
            return StrategyDecision()
        self._done = True
        return StrategyDecision(place=[self._o])


class _PlaceThenCancel(Strategy):
    """Place a resting buy limit on bar 0, request cancel on a chosen bar."""
    def __init__(self, order, cancel_bar):
        super().__init__({}); self._o = order; self._cancel_bar = cancel_bar; self._i = -1; self._placed = False

    def on_bar(self, ctx):
        self._i += 1
        if not self._placed:
            self._placed = True
            return StrategyDecision(place=[self._o])
        if self._i == self._cancel_bar:
            return StrategyDecision(cancel_order_ids=[self._o.order_id])
        return StrategyDecision()


def _mk(strategy, latency=None):
    rt = PaperRuntime(symbol="X", portfolio=_pf(), strategy=strategy, fee_bps_taker=D("0"), slippage_bps_one_way=D("0"))
    if latency is not None:
        rt.latency = latency
    return rt


class LatencyModelTests(unittest.TestCase):
    def test_disabled_is_noop(self):
        # A market order placed bar 0 fills at bar 1 open regardless; latency off == on(0ms).
        o = Order(symbol="X", side="buy", qty=D("1"), order_type=OrderType.MARKET)
        rt = _mk(_PlaceOnBar0(o))
        r = rt.run(bars=bars(3))
        self.assertEqual(len(r.fills), 1)
        self.assertFalse(rt.fill_model()["latency_model_used"])

    def test_order_entry_latency_delays_join(self):
        # entry latency = 1 bar. A market order placed bar 0 normally fills at bar 1 open;
        # with a 1-bar join delay it can't be processed until bar 1 -> fills at bar 2 open.
        o = Order(symbol="X", side="buy", qty=D("1"), order_type=OrderType.MARKET)
        lat = LatencyConfig(enabled=True, order_entry_latency_ms=MIN)
        rt = _mk(_PlaceOnBar0(o), lat)
        r = rt.run(bars=bars(4))
        self.assertEqual(len(r.fills), 1)
        self.assertEqual(r.fills[0].ts, dt(2))            # delayed one bar vs the no-latency dt(1)
        self.assertTrue(rt.fill_model()["latency_model_used"])

    def test_order_events_carry_lifecycle_timestamps(self):
        o = Order(symbol="X", side="buy", qty=D("1"), order_type=OrderType.MARKET)
        lat = LatencyConfig(enabled=True, order_entry_latency_ms=MIN, exchange_ack_latency_ms=500)
        rt = _mk(_PlaceOnBar0(o), lat)
        r = rt.run(bars=bars(4))
        created = [e for e in r.events if e.type == "ORDER_CREATED"][0]
        for k in ("decision_time_ms", "send_time_ms", "effective_exchange_time_ms", "ack_time_ms"):
            self.assertIn(k, created.payload)
        self.assertEqual(created.payload["effective_exchange_time_ms"],
                         created.payload["decision_time_ms"] + MIN)
        self.assertEqual(created.payload["ack_time_ms"],
                         created.payload["effective_exchange_time_ms"] + 500)

    def test_deterministic_jitter_same_seed(self):
        lat = LatencyConfig(enabled=True, jitter_ms=1000, seed=7)
        rt = _mk(_PlaceOnBar0(Order(symbol="X", side="buy", qty=D("1"), order_type=OrderType.MARKET)), lat)
        j1 = rt._lat_jitter_ms("ord-abc")
        j2 = rt._lat_jitter_ms("ord-abc")
        self.assertEqual(j1, j2)                         # deterministic
        self.assertTrue(0 <= j1 <= 1000)
        self.assertNotEqual(rt._lat_jitter_ms("ord-xyz"), None)

    def test_cancel_latency_does_not_undo_prior_fill(self):
        # Resting buy limit at 99; bar 1 sweeps (low 98) so it fills at bar 1. Strategy also
        # requests cancel on bar 1, but with a 1-bar cancel latency the cancel isn't effective
        # until bar 2 -> the bar-1 fill stands.
        o = Order(symbol="X", side="buy", qty=D("1"), order_type=OrderType.LIMIT, limit_price=D("99"))
        b = [Bar(ts=dt(0), open=D("100"), high=D("100"), low=D("100"), close=D("100"), volume=D("1000"))]
        b += [Bar(ts=dt(i), open=D("100"), high=D("100"), low=D("98"), close=D("100"), volume=D("1000")) for i in range(1, 4)]
        lat = LatencyConfig(enabled=True, cancel_latency_ms=MIN)
        rt = _mk(_PlaceThenCancel(o, cancel_bar=1), lat)
        r = rt.run(bars=b)
        self.assertEqual(len(r.fills), 1)                # fill happened before cancel took effect

    def test_cancel_latency_blocks_later_fill(self):
        # Same setup but the limit only becomes marketable on bar 2 (low dips then). The cancel
        # requested bar 1 becomes effective bar 2 -> the order is cancelled before it can fill.
        o = Order(symbol="X", side="buy", qty=D("1"), order_type=OrderType.LIMIT, limit_price=D("90"))
        b = [Bar(ts=dt(0), open=D("100"), high=D("100"), low=D("100"), close=D("100"), volume=D("1000"))]
        b += [Bar(ts=dt(1), open=D("100"), high=D("100"), low=D("100"), close=D("100"), volume=D("1000"))]
        b += [Bar(ts=dt(i), open=D("100"), high=D("100"), low=D("80"), close=D("100"), volume=D("1000")) for i in range(2, 4)]
        lat = LatencyConfig(enabled=True, cancel_latency_ms=MIN)
        rt = _mk(_PlaceThenCancel(o, cancel_bar=1), lat)
        r = rt.run(bars=b)
        self.assertEqual(len(r.fills), 0)


if __name__ == "__main__":
    unittest.main()
