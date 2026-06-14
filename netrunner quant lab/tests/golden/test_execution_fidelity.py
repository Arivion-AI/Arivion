"""Phases 0-2: ExecutionConfig flags, the normalized fill_model contract + verification
gate, and the conservative L2 sweep-only provider wired through PaperRuntime."""
from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from quant_core.orders import Bar, Order, OrderType
from quant_core.portfolio import Portfolio, RiskConfig
from quant_core.paper_runtime import PaperRuntime
from quant_core.strategies.base import Strategy, StrategyDecision
from quant_core.execution import (
    ExecutionConfig, Fidelity, FillModelStats, build_fill_model, verify_execution_tier,
    MODE_BAR, MODE_SWEEP, MODE_QUEUE,
)
from quant_core.l2_replay import (
    L2Snapshot, TradePrint, L2SweepProvider, L2QueueProvider,
    snapshot_lookup_from_list, trade_lookup_from_list,
)

D = Decimal


def dt(i):
    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=i)


class _RestLimit(Strategy):
    """Places one resting limit on the first bar, then nothing."""

    def __init__(self, order):
        super().__init__({})
        self._order = order
        self._done = False

    def on_bar(self, ctx):
        if self._done:
            return StrategyDecision()
        self._done = True
        return StrategyDecision(place=[self._order])


# ---------------------------------------------------------------- Phase 0: flags

class ConfigTests(unittest.TestCase):
    def test_defaults_are_bar_based(self):
        cfg = ExecutionConfig.from_env()
        self.assertEqual(cfg.fidelity, Fidelity.BAR_BASED)
        self.assertFalse(cfg.enable_public_trades)
        self.assertEqual(cfg.l2_depth, 50)
        self.assertFalse(cfg.latency.enabled)

    def test_env_overrides(self):
        for k in ("EXECUTION_FIDELITY", "ENABLE_PUBLIC_TRADES", "L2_DEPTH", "ENABLE_LATENCY_MODEL"):
            os.environ.pop(k, None)
        os.environ["EXECUTION_FIDELITY"] = "l2_queue"
        os.environ["ENABLE_PUBLIC_TRADES"] = "true"
        os.environ["L2_DEPTH"] = "200"
        os.environ["ENABLE_LATENCY_MODEL"] = "true"
        try:
            cfg = ExecutionConfig.from_env()
            self.assertEqual(cfg.fidelity, Fidelity.L2_QUEUE)
            self.assertTrue(cfg.enable_public_trades)
            self.assertEqual(cfg.l2_depth, 200)
            self.assertTrue(cfg.latency.enabled)
            self.assertTrue(cfg.requires_l2 and cfg.requires_trades)
        finally:
            for k in ("EXECUTION_FIDELITY", "ENABLE_PUBLIC_TRADES", "L2_DEPTH", "ENABLE_LATENCY_MODEL"):
                os.environ.pop(k, None)

    def test_bad_depth_falls_back_to_50(self):
        os.environ["L2_DEPTH"] = "37"
        try:
            self.assertEqual(ExecutionConfig.from_env().l2_depth, 50)
        finally:
            os.environ.pop("L2_DEPTH", None)


# ------------------------------------------------- Phase 1: fill_model + gate

class FillModelContractTests(unittest.TestCase):
    def test_bar_based_block(self):
        st = FillModelStats(maker_fills=3, taker_fills=1)
        fm = build_fill_model(Fidelity.BAR_BASED, st)
        self.assertEqual(fm["mode"], MODE_BAR)
        self.assertFalse(fm["l2_aware"])
        self.assertFalse(fm["l2_provider_used"])
        self.assertFalse(fm["trade_prints_used"])
        self.assertTrue(fm["maker_fills_optimistic"])  # maker fills exist
        self.assertTrue(fm["liquidity_free_upper_bound"])

    def test_requested_l2_but_provider_never_ran_is_bar_based(self):
        st = FillModelStats(maker_fills=2, l2_provider_used=False)
        fm = build_fill_model(Fidelity.L2_SWEEP, st)
        self.assertEqual(fm["mode"], MODE_BAR)
        self.assertFalse(fm["l2_aware"])

    def test_sweep_block(self):
        st = FillModelStats(maker_fills=2, l2_provider_used=True, snapshot_coverage_pct=1.0)
        fm = build_fill_model(Fidelity.L2_SWEEP, st)
        self.assertEqual(fm["mode"], MODE_SWEEP)
        self.assertTrue(fm["l2_aware"])
        self.assertFalse(fm["trade_prints_used"])
        self.assertFalse(fm["maker_fills_optimistic"])

    def test_queue_block(self):
        st = FillModelStats(maker_fills=2, l2_provider_used=True, trade_prints_used=True,
                            snapshot_coverage_pct=1.0, trade_coverage_pct=1.0)
        fm = build_fill_model(Fidelity.L2_QUEUE, st)
        self.assertEqual(fm["mode"], MODE_QUEUE)
        self.assertTrue(fm["trade_prints_used"])

    def test_queue_requested_without_trades_degrades_to_sweep(self):
        st = FillModelStats(l2_provider_used=True, trade_prints_used=False, snapshot_coverage_pct=1.0)
        fm = build_fill_model(Fidelity.L2_QUEUE, st)
        self.assertEqual(fm["mode"], MODE_SWEEP)

    # ---- verification gate ----
    def test_recorded_l2_but_not_consumed_is_not_verified(self):
        # The whole point: snapshots existing in the DB is irrelevant; the engine ran bar-based.
        fm = build_fill_model(Fidelity.BAR_BASED, FillModelStats(maker_fills=1))
        dec = verify_execution_tier(fm)
        self.assertFalse(dec.l2_verified)
        self.assertFalse(dec.queue_verified)
        self.assertIn("L2_PROVIDER_NOT_USED", dec.reasons)

    def test_sweep_is_l2_verified_not_queue_verified(self):
        st = FillModelStats(maker_fills=1, l2_provider_used=True, snapshot_coverage_pct=1.0)
        dec = verify_execution_tier(build_fill_model(Fidelity.L2_SWEEP, st))
        self.assertTrue(dec.l2_verified)
        self.assertFalse(dec.queue_verified)

    def test_queue_is_fully_verified(self):
        st = FillModelStats(maker_fills=1, l2_provider_used=True, trade_prints_used=True,
                            snapshot_coverage_pct=1.0, trade_coverage_pct=1.0)
        dec = verify_execution_tier(build_fill_model(Fidelity.L2_QUEUE, st))
        self.assertTrue(dec.l2_verified)
        self.assertTrue(dec.queue_verified)

    def test_low_trade_coverage_rejects_queue_verification(self):
        st = FillModelStats(maker_fills=1, l2_provider_used=True, trade_prints_used=True,
                            snapshot_coverage_pct=1.0, trade_coverage_pct=0.5)
        dec = verify_execution_tier(build_fill_model(Fidelity.L2_QUEUE, st))
        self.assertFalse(dec.queue_verified)
        self.assertTrue(any("TRADE_COVERAGE_BELOW_THRESHOLD" in r for r in dec.reasons))


# ----------------------------------------- Phase 2: sweep provider end-to-end

class SweepProviderTests(unittest.TestCase):
    def _book(self, ts_i, bid_px, ask_px, size="100"):
        return L2Snapshot.from_levels(
            ts_ms=int(dt(ts_i).timestamp() * 1000),
            bids=[(bid_px, size)], asks=[(ask_px, size)], sequence_id=ts_i)

    def _run_buy_limit(self, low, high, limit="99"):
        # Bar 0 places the order; bars 1+ test fill. low/high apply to all post-placement bars.
        bars = [Bar(ts=dt(0), open=D("100"), high=D("100"), low=D("100"), close=D("100"), volume=D("1000"))]
        bars += [Bar(ts=dt(i), open=D("100"), high=D(high), low=D(low), close=D("100"), volume=D("1000"))
                 for i in range(1, 3)]
        snaps = [self._book(i, D("99"), D("101")) for i in range(3)]
        o = Order(symbol="BTCUSDT", side="buy", qty=D("10"), order_type=OrderType.LIMIT, limit_price=D(limit))
        port = Portfolio(starting_equity=D("1000000"),
                         risk=RiskConfig(max_position_fraction=D("1.0"), max_total_exposure_fraction=D("5.0")))
        rt = PaperRuntime(symbol="BTCUSDT", portfolio=port, strategy=_RestLimit(o),
                          fee_bps_taker=D("0"), slippage_bps_one_way=D("0"))
        rt.requested_fidelity = Fidelity.L2_SWEEP
        rt.l2_queue_provider = L2SweepProvider(snapshot_lookup_from_list(snaps))
        r = rt.run(bars=bars)
        return rt, r

    def test_buy_limit_touched_but_not_crossed_no_fill(self):
        # low == limit (99) ⇒ touch, not strict penetration ⇒ no fill
        rt, r = self._run_buy_limit(low="99", high="100", limit="99")
        self.assertEqual(len(r.fills), 0)
        self.assertEqual(rt.fill_model()["mode"], MODE_SWEEP)

    def test_buy_limit_strictly_crossed_fills(self):
        rt, r = self._run_buy_limit(low="98", high="100", limit="99")
        self.assertGreater(len(r.fills), 0)
        self.assertTrue(all(f.is_maker for f in r.fills))
        fm = rt.fill_model()
        self.assertEqual(fm["mode"], MODE_SWEEP)
        self.assertTrue(fm["l2_provider_used"])
        self.assertFalse(fm["maker_fills_optimistic"])
        self.assertEqual(fm["snapshot_coverage_pct"], 1.0)

    def test_sell_limit_touched_no_fill_strict_crossed_fills(self):
        def run_sell(low, high, limit="101"):
            bars = [Bar(ts=dt(0), open=D("100"), high=D("100"), low=D("100"), close=D("100"), volume=D("1000"))]
            bars += [Bar(ts=dt(i), open=D("100"), high=D(high), low=D(low), close=D("100"), volume=D("1000"))
                     for i in range(1, 3)]
            snaps = [self._book(i, D("99"), D("101")) for i in range(3)]
            o = Order(symbol="BTCUSDT", side="sell", qty=D("10"), order_type=OrderType.LIMIT, limit_price=D(limit))
            port = Portfolio(starting_equity=D("1000000"),
                             risk=RiskConfig(max_position_fraction=D("1.0"), max_total_exposure_fraction=D("5.0")))
            rt = PaperRuntime(symbol="BTCUSDT", portfolio=port, strategy=_RestLimit(o),
                              fee_bps_taker=D("0"), slippage_bps_one_way=D("0"))
            rt.requested_fidelity = Fidelity.L2_SWEEP
            rt.l2_queue_provider = L2SweepProvider(snapshot_lookup_from_list(snaps))
            return rt.run(bars=bars)

        self.assertEqual(len(run_sell(low="100", high="101", limit="101").fills), 0)  # touch
        self.assertGreater(len(run_sell(low="100", high="102", limit="101").fills), 0)  # crossed

    def test_no_snapshot_still_decides_on_sweep_and_reports_zero_coverage(self):
        bars = [Bar(ts=dt(0), open=D("100"), high=D("100"), low=D("100"), close=D("100"), volume=D("1000"))]
        bars += [Bar(ts=dt(i), open=D("100"), high=D("100"), low=D("98"), close=D("100"), volume=D("1000"))
                 for i in range(1, 3)]
        o = Order(symbol="BTCUSDT", side="buy", qty=D("10"), order_type=OrderType.LIMIT, limit_price=D("99"))
        port = Portfolio(starting_equity=D("1000000"),
                         risk=RiskConfig(max_position_fraction=D("1.0"), max_total_exposure_fraction=D("5.0")))
        rt = PaperRuntime(symbol="BTCUSDT", portfolio=port, strategy=_RestLimit(o),
                          fee_bps_taker=D("0"), slippage_bps_one_way=D("0"))
        rt.requested_fidelity = Fidelity.L2_SWEEP
        rt.l2_queue_provider = L2SweepProvider(snapshot_lookup_from_list([]))  # no books
        r = rt.run(bars=bars)
        self.assertGreater(len(r.fills), 0)  # sweep decided on OHLC
        self.assertEqual(rt.fill_model()["snapshot_coverage_pct"], 0.0)


# --------------------------------- Phase 4 seed: queue provider through-volume

class QueueProviderTests(unittest.TestCase):
    def test_through_volume_buy_counts_sell_aggressor_at_or_below_limit(self):
        snaps = [L2Snapshot.from_levels(int(dt(0).timestamp() * 1000), [(D("99"), D("100"))], [(D("101"), D("100"))])]
        trades = [
            TradePrint(int(dt(1).timestamp() * 1000) + 5, D("99"), D("40"), "Sell"),   # qualifies
            TradePrint(int(dt(1).timestamp() * 1000) + 6, D("99.5"), D("50"), "Buy"),   # wrong aggressor
            TradePrint(int(dt(1).timestamp() * 1000) + 7, D("98"), D("30"), "Sell"),    # qualifies (<= limit)
        ]
        prov = L2QueueProvider(snapshot_lookup_from_list(snaps), trade_lookup_from_list(trades))
        o = Order(symbol="BTCUSDT", side="buy", qty=D("10"), order_type=OrderType.LIMIT, limit_price=D("99"))
        bar = Bar(ts=dt(1), open=D("100"), high=D("100"), low=D("100"), close=D("100"), volume=D("999"))
        qa, thru, swept = prov(o, bar)
        self.assertEqual(thru, D("70"))         # 40 + 30, candle volume (999) ignored
        self.assertEqual(qa, D("100"))          # resting bid size at >= 99
        self.assertFalse(swept)
        self.assertTrue(prov.trade_prints_used)

    def test_queue_provider_uses_configured_bar_interval(self):
        snaps = [L2Snapshot.from_levels(int(dt(0).timestamp() * 1000), [(D("99"), D("10"))], [(D("101"), D("100"))])]
        # This print is ten minutes into the bar. A hard-coded 60s window would miss it.
        trades = [TradePrint(int(dt(1).timestamp() * 1000) + 10 * 60_000, D("99"), D("25"), "Sell")]
        prov = L2QueueProvider(
            snapshot_lookup_from_list(snaps),
            trade_lookup_from_list(trades),
            bar_interval_ms=15 * 60_000,
        )
        o = Order(symbol="BTCUSDT", side="buy", qty=D("10"), order_type=OrderType.LIMIT, limit_price=D("99"))
        bar = Bar(ts=dt(1), open=D("100"), high=D("100"), low=D("100"), close=D("100"), volume=D("999"))
        qa, thru, swept = prov(o, bar)
        self.assertEqual(qa, D("10"))
        self.assertEqual(thru, D("25"))
        self.assertFalse(swept)
        self.assertEqual(prov.last_evidence["trade_window_end_ms"], int(dt(1).timestamp() * 1000) + 15 * 60_000)

    def test_queue_provider_consumes_trade_feed_even_with_zero_through_volume(self):
        snaps = [L2Snapshot.from_levels(int(dt(0).timestamp() * 1000), [(D("99"), D("10"))], [(D("101"), D("100"))])]
        trades = [TradePrint(int(dt(1).timestamp() * 1000) + 5, D("100"), D("1"), "Buy")]
        prov = L2QueueProvider(snapshot_lookup_from_list(snaps), trade_lookup_from_list(trades))
        o = Order(symbol="BTCUSDT", side="buy", qty=D("10"), order_type=OrderType.LIMIT, limit_price=D("99"))
        bar = Bar(ts=dt(1), open=D("100"), high=D("100"), low=D("100"), close=D("100"), volume=D("999"))
        _qa, thru, _swept = prov(o, bar)
        self.assertEqual(thru, D("0"))
        self.assertTrue(prov.trade_prints_used)
        self.assertEqual(prov.trade_coverage_pct, 1.0)


class QueueFillIntegrationTests(unittest.TestCase):
    """End-to-end queue mechanics through PaperRuntime (Phase 4)."""

    def _run(self, *, qty, queue_size, per_bar_through, n_bars, limit="99"):
        snaps = [L2Snapshot.from_levels(int(dt(0).timestamp() * 1000),
                                        [(D(limit), D(str(queue_size)))], [(D("101"), D("100"))], 0)]
        trades = [TradePrint(int(dt(i).timestamp() * 1000) + 5, D(limit), D(str(per_bar_through)), "Sell")
                  for i in range(1, n_bars + 1)]
        bars = [Bar(ts=dt(0), open=D("100"), high=D("100"), low=D("100"), close=D("100"), volume=D("1000"))]
        # Price only TOUCHES the limit (low==limit), never sweeps — fills must come from queue.
        bars += [Bar(ts=dt(i), open=D(limit), high=D("100"), low=D(limit), close=D(limit), volume=D("1000"))
                 for i in range(1, n_bars + 1)]
        o = Order(symbol="X", side="buy", qty=D(str(qty)), order_type=OrderType.LIMIT, limit_price=D(limit))
        pf = Portfolio(starting_equity=D("1000000"),
                       risk=RiskConfig(max_position_fraction=D("1.0"), max_total_exposure_fraction=D("5.0")))
        rt = PaperRuntime(symbol="X", portfolio=pf, strategy=_RestLimit(o), fee_bps_taker=D("0"), slippage_bps_one_way=D("0"))
        rt.requested_fidelity = Fidelity.L2_QUEUE
        rt.l2_queue_provider = L2QueueProvider(snapshot_lookup_from_list(snaps), trade_lookup_from_list(trades),
                                               bar_interval_ms=60_000)
        return rt, rt.run(bars=bars)

    def test_cumulative_through_depletes_queue_across_bars(self):
        # queue 100, 40/bar through. Per-bar 40 < 100 so a per-bar model never fills;
        # cumulative 120 > 100 by bar 3 -> the order MUST fill. (Regression for the bug.)
        rt, r = self._run(qty=10, queue_size=100, per_bar_through=40, n_bars=5)
        self.assertEqual(sum(float(f.qty) for f in r.fills), 10.0)
        self.assertEqual(rt.fill_model()["mode"], MODE_QUEUE)

    def test_behind_queue_never_reached_does_not_fill(self):
        # queue 1000, only 10/bar through over 5 bars (cumulative 50 << 1000) -> no fill.
        rt, r = self._run(qty=10, queue_size=1000, per_bar_through=10, n_bars=5)
        self.assertEqual(len(r.fills), 0)

    def test_partial_fill_then_completes(self):
        # queue 0, 4/bar through, qty 10 -> 4,4,2 across three bars (partials then full).
        rt, r = self._run(qty=10, queue_size=0, per_bar_through=4, n_bars=4)
        self.assertEqual(sum(float(f.qty) for f in r.fills), 10.0)
        self.assertGreaterEqual(len(r.fills), 2)  # filled across multiple bars

    def test_trade_coverage_reflects_empty_windows(self):
        # 4 bars rest; trades only on bars 1-2 -> coverage 2/ (bars consulted) < 1.0.
        snaps = [L2Snapshot.from_levels(int(dt(0).timestamp() * 1000), [(D("99"), D("5"))], [(D("101"), D("5"))], 0)]
        trades = [TradePrint(int(dt(i).timestamp() * 1000) + 5, D("99"), D("1"), "Sell") for i in (1, 2)]
        bars = [Bar(ts=dt(0), open=D("100"), high=D("100"), low=D("100"), close=D("100"), volume=D("10"))]
        bars += [Bar(ts=dt(i), open=D("99"), high=D("100"), low=D("99"), close=D("99"), volume=D("10")) for i in range(1, 5)]
        o = Order(symbol="X", side="buy", qty=D("100"), order_type=OrderType.LIMIT, limit_price=D("99"))
        pf = Portfolio(starting_equity=D("1000000"),
                       risk=RiskConfig(max_position_fraction=D("1.0"), max_total_exposure_fraction=D("5.0")))
        rt = PaperRuntime(symbol="X", portfolio=pf, strategy=_RestLimit(o), fee_bps_taker=D("0"), slippage_bps_one_way=D("0"))
        rt.requested_fidelity = Fidelity.L2_QUEUE
        prov = L2QueueProvider(snapshot_lookup_from_list(snaps), trade_lookup_from_list(trades), bar_interval_ms=60_000)
        rt.l2_queue_provider = prov
        rt.run(bars=bars)
        self.assertLess(prov.trade_coverage_pct, 1.0)   # some bars had empty trade windows
        self.assertGreater(prov.trade_coverage_pct, 0.0)

    def test_cancel_stops_queue_tracking(self):
        snaps = [L2Snapshot.from_levels(int(dt(0).timestamp() * 1000), [(D("99"), D("5"))], [(D("101"), D("5"))], 0)]
        prov = L2QueueProvider(snapshot_lookup_from_list(snaps), trade_lookup_from_list([]), bar_interval_ms=60_000)
        o = Order(symbol="X", side="buy", qty=D("1"), order_type=OrderType.LIMIT, limit_price=D("99"))
        bar = Bar(ts=dt(1), open=D("99"), high=D("100"), low=D("99"), close=D("99"), volume=D("1"))
        prov(o, bar)
        self.assertIn(o.order_id, prov._queue_state)
        prov.forget(o.order_id)
        self.assertNotIn(o.order_id, prov._queue_state)


if __name__ == "__main__":
    unittest.main()
