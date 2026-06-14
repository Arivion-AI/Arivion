from __future__ import annotations

import unittest
from decimal import Decimal

from quant_core.optimizer import CandidateMetrics, ParityThresholds, compute_parity
from quant_core.paper import PaperSessionState, Tick, evaluate_tick


class Phase5PaperRuntimeTests(unittest.TestCase):
    def test_staleness_gate_pauses_before_signal(self) -> None:
        state = PaperSessionState(
            session_id="s1",
            status="active",
            reconnecting=False,
            required_fresh_ticks=3,
            fresh_ticks_seen=0,
            max_data_age_ms=30_000,
            last_price=Decimal("100"),
        )
        decision = evaluate_tick(
            state,
            Tick(symbol="BTCUSDT", price=Decimal("101"), ts_ms=1000, now_ms=40_001),
        )
        self.assertEqual(decision.status, "paused")
        self.assertFalse(decision.create_fill)
        self.assertEqual(decision.events[0]["event_type"], "DATA_STALE_PAUSE")

    def test_reconnect_waits_n_fresh_ticks(self) -> None:
        state = PaperSessionState(
            session_id="s2",
            status="paused",
            reconnecting=True,
            required_fresh_ticks=3,
            fresh_ticks_seen=0,
            max_data_age_ms=30_000,
            last_price=Decimal("100"),
        )
        d1 = evaluate_tick(state, Tick(symbol="BTCUSDT", price=Decimal("101"), ts_ms=1, now_ms=2))
        self.assertEqual(d1.status, "waiting_fresh_ticks")
        self.assertFalse(d1.create_fill)

        state.fresh_ticks_seen = d1.fresh_ticks_seen
        d2 = evaluate_tick(state, Tick(symbol="BTCUSDT", price=Decimal("102"), ts_ms=3, now_ms=4))
        self.assertEqual(d2.status, "waiting_fresh_ticks")
        self.assertFalse(d2.create_fill)

        state.fresh_ticks_seen = d2.fresh_ticks_seen
        d3 = evaluate_tick(state, Tick(symbol="BTCUSDT", price=Decimal("103"), ts_ms=5, now_ms=6))
        self.assertEqual(d3.status, "active")


class Phase6OptimizationTests(unittest.TestCase):
    def test_parity_within_threshold(self) -> None:
        thresholds = ParityThresholds(0.005, 0.01, 2)
        vector = CandidateMetrics(total_return=0.20, max_drawdown=0.10, trade_count=30)
        event = CandidateMetrics(total_return=0.198, max_drawdown=0.106, trade_count=29)
        parity = compute_parity(vector, event, thresholds)
        self.assertTrue(parity.within_threshold)

    def test_parity_outside_threshold(self) -> None:
        thresholds = ParityThresholds(0.005, 0.01, 2)
        vector = CandidateMetrics(total_return=0.20, max_drawdown=0.10, trade_count=30)
        event = CandidateMetrics(total_return=0.18, max_drawdown=0.13, trade_count=24)
        parity = compute_parity(vector, event, thresholds)
        self.assertFalse(parity.within_threshold)


if __name__ == "__main__":
    unittest.main()
