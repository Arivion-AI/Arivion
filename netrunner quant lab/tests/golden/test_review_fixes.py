"""Regression tests for the audit-review fixes:
  #5 stop gap-through fills at the worse of stop/open (not optimistically at stop)
  B  size-dependent square-root market impact (off by default)
  #3 mixed crypto/xStock calendar uses a UNION timeline (crypto bars not dropped)
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from quant_core import orders as orders_mod
from quant_core.orders import Bar, market_impact_bps
from quant_core.engine import BacktestBar, resolve_intrabar_exit
from quant_core.portfolio_engine import PortfolioLeg, run_portfolio

_WEEKDAY = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)   # Mon 10:00 ET (RTH)
_RISK = {"max_position_fraction": "1.0", "max_total_exposure_fraction": "5.0",
         "max_daily_loss_fraction": "0.95", "max_drawdown_kill_fraction": "0.95"}


class StopGapThroughTests(unittest.TestCase):
    def _bar(self, o, h, l, c):
        return BacktestBar(ts=_WEEKDAY, open=Decimal(str(o)), high=Decimal(str(h)),
                           low=Decimal(str(l)), close=Decimal(str(c)))

    def test_long_stop_gap_down_fills_at_open_not_stop(self):
        # Long with SL=100; bar GAPS down, opening at 90 (below the stop).
        kind, price = resolve_intrabar_exit("long", entry_price=Decimal("110"),
            stop_loss=Decimal("100"), take_profit=Decimal("130"), bar=self._bar(90, 92, 88, 91))
        self.assertEqual(kind, "stop_loss")
        self.assertEqual(price, Decimal("90"))     # filled at the worse open, not 100

    def test_long_stop_intrabar_no_gap_fills_at_stop(self):
        # Bar opens above the stop and dips through it intrabar -> fills at the stop.
        kind, price = resolve_intrabar_exit("long", entry_price=Decimal("110"),
            stop_loss=Decimal("100"), take_profit=Decimal("130"), bar=self._bar(105, 106, 99, 101))
        self.assertEqual(kind, "stop_loss")
        self.assertEqual(price, Decimal("100"))

    def test_short_stop_gap_up_fills_at_open(self):
        kind, price = resolve_intrabar_exit("short", entry_price=Decimal("90"),
            stop_loss=Decimal("100"), take_profit=Decimal("70"), bar=self._bar(110, 112, 108, 111))
        self.assertEqual(kind, "stop_loss")
        self.assertEqual(price, Decimal("110"))    # gap-up fills at the worse open, not 100


class MarketImpactTests(unittest.TestCase):
    def test_off_by_default(self):
        self.assertEqual(orders_mod.MARKET_IMPACT_COEF, 0.0)
        self.assertEqual(market_impact_bps(Decimal("1000"), Decimal("10")), Decimal(0))

    def test_size_dependent_when_enabled(self):
        orig = orders_mod.MARKET_IMPACT_COEF
        orders_mod.MARKET_IMPACT_COEF = 0.5
        try:
            small = market_impact_bps(Decimal("1"), Decimal("1000"))
            big = market_impact_bps(Decimal("100"), Decimal("1000"))
            self.assertGreater(big, small)          # bigger order => more impact
            self.assertGreater(small, Decimal(0))
        finally:
            orders_mod.MARKET_IMPACT_COEF = orig


class MakerFillRealismTests(unittest.TestCase):
    def test_off_by_default_fills_full(self):
        self.assertEqual(orders_mod.MAKER_PARTICIPATION_RATE, 0.0)
        from quant_core.orders import maker_fill_qty
        self.assertEqual(maker_fill_qty(Decimal("10"), Decimal("30")), Decimal("10"))

    def test_volume_participation_cap_when_enabled(self):
        from quant_core.orders import maker_fill_qty
        orig = orders_mod.MAKER_PARTICIPATION_RATE
        orders_mod.MAKER_PARTICIPATION_RATE = 0.1
        try:
            # order 10, bar volume 30 -> capped at 0.1*30 = 3 (partial maker fill)
            self.assertEqual(maker_fill_qty(Decimal("10"), Decimal("30")), Decimal("3.0"))
            # order 1, bar volume 100 -> under cap -> full
            self.assertEqual(maker_fill_qty(Decimal("1"), Decimal("100")), Decimal("1"))
        finally:
            orders_mod.MAKER_PARTICIPATION_RATE = orig


class MixedCalendarTests(unittest.TestCase):
    def test_union_timeline_preserves_crypto_bars(self):
        # BTC has 24 hourly bars (24/7); NVDAx has only 6 (a partial RTH window).
        btc = [Bar(ts=_WEEKDAY + timedelta(hours=i), open=Decimal("65000"), high=Decimal("65100"),
                   low=Decimal("64900"), close=Decimal(str(65000 + i)), volume=Decimal("100")) for i in range(24)]
        nvda = [Bar(ts=_WEEKDAY + timedelta(hours=i), open=Decimal("1000"), high=Decimal("1005"),
                    low=Decimal("995"), close=Decimal(str(1000 + i)), volume=Decimal("100")) for i in range(6)]
        r = run_portfolio(legs=[PortfolioLeg("BTCUSDT", btc, "crypto", "linear", Decimal("0.6")),
                                PortfolioLeg("NVDAXUSDT", nvda, "equity", "spot", Decimal("0.4"))],
                          weighting="fixed", total_equity=Decimal("100000"), risk=_RISK,
                          rebalance_threshold=Decimal("0.02"))
        self.assertEqual(r.errors, [])
        # Union timeline => as many steps as the longest (crypto) leg, not the 6-bar intersection.
        self.assertGreaterEqual(len(r.equity_curve), 20)
        # Crypto traded; equity fills (if any) are RTH-flagged.
        syms = {f["symbol"] for f in r.fills}
        self.assertIn("BTCUSDT", syms)


if __name__ == "__main__":
    unittest.main()
