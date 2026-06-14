from __future__ import annotations

import unittest
from datetime import datetime, timezone
from decimal import Decimal

from quant_core.portfolio import Portfolio, RiskConfig


def dt(h: int) -> datetime:
    return datetime(2026, 1, 1, h, 0, tzinfo=timezone.utc)


class PortfolioTests(unittest.TestCase):
    def test_long_then_close_realizes_pnl(self) -> None:
        p = Portfolio(starting_equity=Decimal("10000"))
        p.apply_fill(symbol="BTCUSDT", side="buy", qty=Decimal("1"), price=Decimal("100"), fee=Decimal(0))
        realized = p.apply_fill(symbol="BTCUSDT", side="sell", qty=Decimal("1"), price=Decimal("110"), fee=Decimal(0))
        self.assertEqual(realized, Decimal("10"))
        self.assertEqual(p.positions["BTCUSDT"].realized_pnl, Decimal("10"))
        self.assertEqual(p.positions["BTCUSDT"].side, "flat")

    def test_short_then_close_realizes_pnl(self) -> None:
        p = Portfolio(starting_equity=Decimal("10000"))
        p.apply_fill(symbol="BTCUSDT", side="sell", qty=Decimal("1"), price=Decimal("110"), fee=Decimal(0))
        realized = p.apply_fill(symbol="BTCUSDT", side="buy", qty=Decimal("1"), price=Decimal("100"), fee=Decimal(0))
        self.assertEqual(realized, Decimal("10"))

    def test_pre_trade_rejects_oversized(self) -> None:
        p = Portfolio(starting_equity=Decimal("1000"), risk=RiskConfig(max_position_fraction=Decimal("0.1")))
        ok, reason = p.check_pretrade(symbol="BTCUSDT", qty=Decimal("10"), price=Decimal("100"), marks={"BTCUSDT": Decimal("100")})
        self.assertFalse(ok)
        self.assertEqual(reason, "EXCEEDS_MAX_POSITION_FRACTION")

    def test_drawdown_kill_triggers(self) -> None:
        p = Portfolio(starting_equity=Decimal("1000"), risk=RiskConfig(max_drawdown_kill_fraction=Decimal("0.10"), max_daily_loss_fraction=Decimal("0.95"), max_position_fraction=Decimal("1.0"), max_total_exposure_fraction=Decimal("5.0")))
        p.update_equity_marks(dt(0), {"BTCUSDT": Decimal("100")})
        p.apply_fill(symbol="BTCUSDT", side="buy", qty=Decimal("5"), price=Decimal("100"), fee=Decimal(0))
        p.apply_fill(symbol="BTCUSDT", side="sell", qty=Decimal("5"), price=Decimal("70"), fee=Decimal(0))  # -150 PnL = -15%
        p.update_equity_marks(dt(1), {"BTCUSDT": Decimal("70")})
        self.assertTrue(p.state.killed)
        self.assertEqual(p.state.kill_reason, "MAX_DRAWDOWN_KILL")

    def test_daily_loss_kill(self) -> None:
        p = Portfolio(starting_equity=Decimal("1000"), risk=RiskConfig(max_daily_loss_fraction=Decimal("0.05"), max_drawdown_kill_fraction=Decimal("0.95"), max_position_fraction=Decimal("1.0"), max_total_exposure_fraction=Decimal("5.0")))
        p.update_equity_marks(dt(0), {"BTCUSDT": Decimal("100")})
        p.apply_fill(symbol="BTCUSDT", side="buy", qty=Decimal("4"), price=Decimal("100"), fee=Decimal(0))
        p.apply_fill(symbol="BTCUSDT", side="sell", qty=Decimal("4"), price=Decimal("80"), fee=Decimal(0))  # -80 = -8%
        p.update_equity_marks(dt(1), {"BTCUSDT": Decimal("80")})
        self.assertTrue(p.state.killed)
        self.assertEqual(p.state.kill_reason, "MAX_DAILY_LOSS")

    def test_funding_reduces_cash(self) -> None:
        p = Portfolio(starting_equity=Decimal("1000"))
        p.apply_funding("BTCUSDT", Decimal("5"))
        self.assertEqual(p.cash, Decimal("995"))
        self.assertEqual(p.positions["BTCUSDT"].funding_pnl, Decimal("-5"))


if __name__ == "__main__":
    unittest.main()
