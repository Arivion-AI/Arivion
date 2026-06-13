from __future__ import annotations

import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from quant_core.engine import (
    BacktestBar,
    EventBacktestEngine,
    FundingRow,
    Position,
    apply_funding_events,
    market_fill_from_signal,
    resolve_intrabar_exit,
    strict_limit_penetration,
)
from quant_core.metrics import sharpe_annualized


def dt(y: int, mo: int, d: int, h: int, mi: int = 0) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)


class Phase3GoldenFixtureTests(unittest.TestCase):
    def test_a1_linear_positive_rate_long_pays(self) -> None:
        pos = Position(symbol="BTCUSDT", side="long", category="linear", qty=Decimal("0.5"), opened_at=dt(2026, 1, 1, 0))
        row = FundingRow(id="f1", timestamp=dt(2026, 1, 1, 8), funding_rate=Decimal("0.0001"))

        events = apply_funding_events(
            position=pos,
            bar_start=dt(2026, 1, 1, 7, 59),
            bar_end=dt(2026, 1, 1, 8),
            funding_rows=[row],
            mark_price_lookup=lambda _s, _t: Decimal("60000"),
        )

        self.assertEqual(len(events), 1)
        self.assertEqual(pos.cash_quote, Decimal("-3.00000"))
        self.assertEqual(pos.funding_pnl_quote, Decimal("-3.00000"))

    def test_a2_linear_positive_rate_short_receives(self) -> None:
        pos = Position(symbol="BTCUSDT", side="short", category="linear", qty=Decimal("0.5"), opened_at=dt(2026, 1, 1, 0))
        row = FundingRow(id="f2", timestamp=dt(2026, 1, 1, 8), funding_rate=Decimal("0.0001"))

        apply_funding_events(
            position=pos,
            bar_start=dt(2026, 1, 1, 7, 59),
            bar_end=dt(2026, 1, 1, 8),
            funding_rows=[row],
            mark_price_lookup=lambda _s, _t: Decimal("60000"),
        )

        self.assertEqual(pos.cash_quote, Decimal("3.00000"))
        self.assertEqual(pos.funding_pnl_quote, Decimal("3.00000"))

    def test_a3_linear_negative_rate_long_receives(self) -> None:
        pos = Position(symbol="BTCUSDT", side="long", category="linear", qty=Decimal("0.5"), opened_at=dt(2026, 1, 1, 0))
        row = FundingRow(id="f3", timestamp=dt(2026, 1, 1, 8), funding_rate=Decimal("-0.0001"))

        apply_funding_events(
            position=pos,
            bar_start=dt(2026, 1, 1, 7, 59),
            bar_end=dt(2026, 1, 1, 8),
            funding_rows=[row],
            mark_price_lookup=lambda _s, _t: Decimal("60000"),
        )

        self.assertEqual(pos.cash_quote, Decimal("3.00000"))
        self.assertEqual(pos.funding_pnl_quote, Decimal("3.00000"))

    def test_a4_inverse_positive_rate_long_pays_base(self) -> None:
        pos = Position(
            symbol="BTCUSD",
            side="long",
            category="inverse",
            contract_qty=Decimal("30000"),
            opened_at=dt(2026, 1, 1, 0),
        )
        row = FundingRow(id="f4", timestamp=dt(2026, 1, 1, 8), funding_rate=Decimal("0.0001"))

        apply_funding_events(
            position=pos,
            bar_start=dt(2026, 1, 1, 7, 59),
            bar_end=dt(2026, 1, 1, 8),
            funding_rows=[row],
            mark_price_lookup=lambda _s, _t: Decimal("60000"),
        )

        self.assertEqual(pos.cash_base, Decimal("-0.00005"))
        self.assertEqual(pos.funding_pnl_base, Decimal("-0.00005"))

    def test_a5_dynamic_interval_uses_actual_rows_only(self) -> None:
        pos = Position(symbol="BTCUSDT", side="long", category="linear", qty=Decimal("1"), opened_at=dt(2026, 1, 1, 0))
        rows = [
            FundingRow(id="t1", timestamp=dt(2026, 1, 1, 0), funding_rate=Decimal("0.0001")),
            FundingRow(id="t2", timestamp=dt(2026, 1, 1, 8), funding_rate=Decimal("0.0001")),
            FundingRow(id="t3", timestamp=dt(2026, 1, 1, 9), funding_rate=Decimal("0.0001")),
            FundingRow(id="t4", timestamp=dt(2026, 1, 1, 10), funding_rate=Decimal("0.0001")),
        ]

        events = apply_funding_events(
            position=pos,
            bar_start=dt(2025, 12, 31, 23, 59),
            bar_end=dt(2026, 1, 1, 10),
            funding_rows=rows,
            mark_price_lookup=lambda _s, _t: Decimal("100"),
        )

        self.assertEqual([e.event_ts for e in events], [dt(2026, 1, 1, 0), dt(2026, 1, 1, 8), dt(2026, 1, 1, 9), dt(2026, 1, 1, 10)])
        self.assertNotIn(dt(2026, 1, 1, 16), [e.event_ts for e in events])

    def test_a6_no_lookahead_next_open_fill(self) -> None:
        bars = [
            BacktestBar(ts=dt(2026, 1, 1, 0, 0), open=Decimal("100"), high=Decimal("102"), low=Decimal("99"), close=Decimal("101")),
            BacktestBar(ts=dt(2026, 1, 1, 0, 15), open=Decimal("101.5"), high=Decimal("103"), low=Decimal("101"), close=Decimal("102.5")),
        ]

        fill_ts, fill_price = market_fill_from_signal(
            bars=bars,
            signal_bar_index=0,
            side="long",
            slippage_bps_one_way=Decimal("2"),
        )

        self.assertEqual(fill_ts, dt(2026, 1, 1, 0, 15))
        self.assertEqual(fill_price.quantize(Decimal("0.0001")), Decimal("101.5203"))

    def test_a7_intrabar_stop_first(self) -> None:
        bar = BacktestBar(ts=dt(2026, 1, 1, 0, 15), open=Decimal("100.5"), high=Decimal("102.5"), low=Decimal("98.5"), close=Decimal("101"))
        reason, price = resolve_intrabar_exit(
            side="long",
            entry_price=Decimal("100"),
            stop_loss=Decimal("99"),
            take_profit=Decimal("102"),
            bar=bar,
        )

        self.assertEqual(reason, "stop_loss")
        self.assertEqual(price, Decimal("99"))

    def test_a8_strict_limit_penetration(self) -> None:
        touch_bar = BacktestBar(ts=dt(2026, 1, 1, 0), open=Decimal("100"), high=Decimal("101"), low=Decimal("100.0"), close=Decimal("100.2"))
        penetration_bar = BacktestBar(ts=dt(2026, 1, 1, 0, 15), open=Decimal("100"), high=Decimal("101"), low=Decimal("99.8"), close=Decimal("100.2"))

        self.assertFalse(strict_limit_penetration("long", Decimal("100"), Decimal("0.1"), touch_bar))
        self.assertTrue(strict_limit_penetration("long", Decimal("100"), Decimal("0.1"), penetration_bar))

    def test_a9_sharpe_annualization_sqrt_n(self) -> None:
        sharpe = sharpe_annualized(
            mean_bar_excess=Decimal("0.00001"),
            std_bar=Decimal("0.001"),
            interval_minutes=15,
        )
        self.assertEqual(sharpe.quantize(Decimal("0.001")), Decimal("1.872"))


class EventLoopSmokeTest(unittest.TestCase):
    def test_event_loop_signal_then_next_bar_fill(self) -> None:
        bars = [
            BacktestBar(ts=dt(2026, 1, 1, 0, 0), open=Decimal("100"), high=Decimal("101"), low=Decimal("99"), close=Decimal("100.5")),
            BacktestBar(ts=dt(2026, 1, 1, 0, 15), open=Decimal("101"), high=Decimal("102"), low=Decimal("100"), close=Decimal("101.5")),
            BacktestBar(ts=dt(2026, 1, 1, 0, 30), open=Decimal("102"), high=Decimal("103"), low=Decimal("101"), close=Decimal("102.5")),
        ]

        engine = EventBacktestEngine()
        result = engine.run(
            symbol="BTCUSDT",
            bars=bars,
            funding_rows=[],
            mark_price_lookup=lambda _s, _t: Decimal("100"),
            signals={0: "long"},
            slippage_bps_one_way=Decimal("0"),
            qty=Decimal("1"),
            category="linear",
            seed=42,
        )

        fill_events = [evt for evt in result.events if evt.event_type == "FILL"]
        self.assertEqual(len(fill_events), 1)
        self.assertEqual(fill_events[0].event_ts, dt(2026, 1, 1, 0, 15))


if __name__ == "__main__":
    unittest.main()
