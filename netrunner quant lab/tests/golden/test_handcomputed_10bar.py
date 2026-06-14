"""Hand-computed 10-bar end-to-end scenario (Phase 3 human checkpoint).

This test is the §25 / §32 "hand-compute one 10-bar end-to-end scenario yourself
and diff it against the engine" checkpoint. The expected values below are
computed by hand from the inputs — NOT by reading them back from the engine.

Scenario: BTCUSDT linear, qty=0.1 BTC, 15m bars.
- Signal at bar 1 close=100 -> long entry at bar 2 open=101 with 2bps slippage -> 101.0202
- SL 2%: 101.0202 * 0.98 = 98.999996  (rounded by Decimal precision)
- TP 4%: 101.0202 * 1.04 = 105.061008
- Funding row at bar 4 ts, rate=+0.0001, mark=110 -> long pays: 0.1 * 110 * 0.0001 = 0.0011 USDT
- Bar 6: high=106 hits TP=105.061008  ->  exit at TP, reason=take_profit
- No liquidation (leverage=1).
"""
from __future__ import annotations

import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from quant_core.engine import BacktestBar, EventBacktestEngine, FundingRow


def dt(min_offset: int) -> datetime:
    return datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc) + timedelta(minutes=15 * min_offset)


class HandComputedTenBarScenario(unittest.TestCase):
    def setUp(self) -> None:
        # 10 bars: monotonic rise from 100 to 109, then a spike bar that hits TP.
        d = lambda s: Decimal(s)
        self.bars = [
            BacktestBar(ts=dt(0), open=d("99.5"), high=d("100"), low=d("99"), close=d("100")),
            BacktestBar(ts=dt(1), open=d("100"), high=d("101"), low=d("99.5"), close=d("100")),   # signal at close=100
            BacktestBar(ts=dt(2), open=d("101"), high=d("102"), low=d("100.5"), close=d("101.5")),  # fill bar
            BacktestBar(ts=dt(3), open=d("101.5"), high=d("103"), low=d("101"), close=d("102.5")),
            BacktestBar(ts=dt(4), open=d("102.5"), high=d("104"), low=d("102"), close=d("103.5")),  # funding row at this ts
            BacktestBar(ts=dt(5), open=d("103.5"), high=d("105"), low=d("103"), close=d("104.5")),
            BacktestBar(ts=dt(6), open=d("104.5"), high=d("106"), low=d("104"), close=d("105.5")),  # high=106 hits TP=105.0610...
            BacktestBar(ts=dt(7), open=d("105.5"), high=d("107"), low=d("105"), close=d("106.5")),
            BacktestBar(ts=dt(8), open=d("106.5"), high=d("108"), low=d("106"), close=d("107.5")),
            BacktestBar(ts=dt(9), open=d("107.5"), high=d("109"), low=d("107"), close=d("108.5")),
        ]
        self.funding_rows = [
            FundingRow(id="fhc1", timestamp=dt(4), funding_rate=Decimal("0.0001")),
        ]

    def test_hand_computed_results(self) -> None:
        engine = EventBacktestEngine()
        result = engine.run(
            symbol="BTCUSDT",
            bars=self.bars,
            funding_rows=self.funding_rows,
            mark_price_lookup=lambda _s, _t: Decimal("110"),  # mark used at funding settlement
            signals={1: "long"},
            slippage_bps_one_way=Decimal("2"),
            qty=Decimal("0.1"),
            category="linear",
            seed=1,
            stop_loss_pct=Decimal("0.02"),
            take_profit_pct=Decimal("0.04"),
            max_holding_bars=20,
        )

        # 1 fill expected at bar 2 open with 2bps slippage: 101 * 1.0002 = 101.0202
        self.assertEqual(len(result.fills), 1)
        fill = result.fills[0]
        self.assertEqual(fill.event_ts, dt(2))
        self.assertEqual(Decimal(fill.payload["fill_price"]), Decimal("101.0202"))

        # 1 funding settlement at bar 4 ts:
        # notional = 0.1 * 110 = 11; fee = 11 * 0.0001 = 0.0011 USDT; long pays.
        self.assertEqual(len(result.funding_events), 1)
        funding = result.funding_events[0]
        self.assertEqual(funding.event_ts, dt(4))
        self.assertEqual(Decimal(funding.payload["amount"]), Decimal("0.00110000"))
        self.assertEqual(funding.payload["currency"], "quote")

        # 1 TP exit at bar 6 (first bar whose high >= entry*1.04 = 101.0202*1.04 = 105.061008).
        self.assertEqual(len(result.exits), 1)
        exit_evt = result.exits[0]
        self.assertEqual(exit_evt.event_ts, dt(6))
        self.assertEqual(exit_evt.payload["reason"], "take_profit")
        expected_tp = Decimal("101.0202") * Decimal("1.04")
        self.assertEqual(Decimal(exit_evt.payload["exit_price"]), expected_tp)

        # No liquidation at leverage=1.
        self.assertEqual(len(result.liquidations), 0)

        # Funding PnL on the position: long paid 0.0011 -> -0.0011.
        self.assertEqual(result.final_position.funding_pnl_quote, Decimal("-0.00110000"))
        self.assertEqual(result.final_position.cash_quote, Decimal("-0.00110000"))


class LiquidationLeveragedScenario(unittest.TestCase):
    def test_leverage_requires_margin_tiers(self) -> None:
        from quant_core.engine import MarginTier
        engine = EventBacktestEngine()
        with self.assertRaises(ValueError):
            engine.run(
                symbol="BTCUSDT",
                bars=[BacktestBar(ts=dt(0), open=Decimal("100"), high=Decimal("100"), low=Decimal("100"), close=Decimal("100"))],
                funding_rows=[],
                mark_price_lookup=lambda _s, _t: Decimal("100"),
                signals={},
                slippage_bps_one_way=Decimal("0"),
                qty=Decimal("0"),
                category="linear",
                seed=1,
                leverage=Decimal("5"),
                margin_tiers=None,
            )

    def test_liquidation_event_emitted_when_mark_collapses(self) -> None:
        from quant_core.engine import MarginTier
        d = lambda s: Decimal(s)
        bars = [
            BacktestBar(ts=dt(0), open=d("100"), high=d("100"), low=d("100"), close=d("100")),
            BacktestBar(ts=dt(1), open=d("100"), high=d("100"), low=d("100"), close=d("100")),
            BacktestBar(ts=dt(2), open=d("100"), high=d("100"), low=d("100"), close=d("100")),
        ]
        # leverage 10, mark drops to 85 -> long is well past liquidation.
        marks = {dt(0): d("100"), dt(1): d("100"), dt(2): d("85")}
        engine = EventBacktestEngine()
        result = engine.run(
            symbol="BTCUSDT",
            bars=bars,
            funding_rows=[],
            mark_price_lookup=lambda _s, ts: marks.get(ts, d("100")),
            signals={0: "long"},
            slippage_bps_one_way=Decimal("0"),
            qty=Decimal("1"),
            category="linear",
            seed=1,
            leverage=Decimal("10"),
            margin_tiers=[MarginTier(notional_cap=Decimal("100000"), mmr_fraction=Decimal("0.005"))],
        )
        self.assertEqual(len(result.liquidations), 1)
        self.assertEqual(result.liquidations[0].event_ts, dt(2))


if __name__ == "__main__":
    unittest.main()
