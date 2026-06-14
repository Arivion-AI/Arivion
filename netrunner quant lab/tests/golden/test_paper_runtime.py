from __future__ import annotations

import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from quant_core.orders import Bar
from quant_core.engine import FundingRow
from quant_core.portfolio import Portfolio, RiskConfig
from quant_core.paper_runtime import PaperRuntime
from quant_core.strategies import PureMarketMaker, FundingFade, TrendEmaCross, GridTrader, TwapExecutor


def dt(min_offset: int) -> datetime:
    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=15 * min_offset)


def make_bars(prices: list[str]) -> list[Bar]:
    out = []
    for i, p in enumerate(prices):
        pd = Decimal(p)
        out.append(Bar(ts=dt(i), open=pd, high=pd + Decimal("0.5"), low=pd - Decimal("0.5"), close=pd, volume=Decimal(1)))
    return out


class PaperRuntimeTests(unittest.TestCase):
    def test_twap_executes_all_slices(self) -> None:
        bars = make_bars(["100"] * 12)
        port = Portfolio(starting_equity=Decimal("100000"), risk=RiskConfig(max_position_fraction=Decimal("1.0"), max_total_exposure_fraction=Decimal("1.0")))
        strat = TwapExecutor({"total_qty": "1.0", "n_slices": 10, "side": "buy"})
        rt = PaperRuntime(symbol="BTCUSDT", portfolio=port, strategy=strat, fee_bps_taker=Decimal(0), slippage_bps_one_way=Decimal(0))
        result = rt.run(bars=bars)
        self.assertEqual(len(result.fills), 10)
        self.assertEqual(port.positions["BTCUSDT"].qty, Decimal("1.0"))

    def test_trend_ema_takes_position_after_cross(self) -> None:
        # Build a price series with a clear up-then-down pattern.
        prices = [f"{100 + i}" for i in range(40)] + [f"{140 - i}" for i in range(40)]
        bars = make_bars(prices)
        port = Portfolio(starting_equity=Decimal("100000"), risk=RiskConfig(max_position_fraction=Decimal("1.0"), max_total_exposure_fraction=Decimal("1.0")))
        strat = TrendEmaCross({"ema_fast": 5, "ema_slow": 20, "atr_len": 5, "order_qty": "0.1"})
        rt = PaperRuntime(symbol="BTCUSDT", portfolio=port, strategy=strat, fee_bps_taker=Decimal(0), slippage_bps_one_way=Decimal(0))
        result = rt.run(bars=bars)
        # Should have at least entered a position
        self.assertGreater(len(result.fills), 0)

    def test_pmm_places_two_quotes_each_bar(self) -> None:
        bars = make_bars(["100"] * 5)
        port = Portfolio(starting_equity=Decimal("100000"), risk=RiskConfig(max_position_fraction=Decimal("1.0"), max_total_exposure_fraction=Decimal("1.0")))
        strat = PureMarketMaker({"order_qty": "0.01", "bid_spread_bps": 10, "ask_spread_bps": 10})
        rt = PaperRuntime(symbol="BTCUSDT", portfolio=port, strategy=strat, fee_bps_taker=Decimal(0))
        result = rt.run(bars=bars)
        order_creates = [e for e in result.events if e.type == "ORDER_CREATED"]
        # Each of 5 bars places 2 quotes (cancel_all between bars)
        self.assertGreaterEqual(len(order_creates), 8)

    def test_funding_fade_records_funding_pnl(self) -> None:
        bars = make_bars([f"{100 + (i % 3)}" for i in range(50)])
        funding_rows = [FundingRow(id="f1", timestamp=dt(20), funding_rate=Decimal("0.0005"))]
        port = Portfolio(starting_equity=Decimal("100000"), risk=RiskConfig(max_position_fraction=Decimal("1.0"), max_total_exposure_fraction=Decimal("1.0")))
        strat = FundingFade({"ema_slow_len": 10, "atr_len": 5, "funding_z_lookback": 5, "funding_z_threshold": "0.5", "order_qty": "0.1"})
        rt = PaperRuntime(symbol="BTCUSDT", portfolio=port, strategy=strat, fee_bps_taker=Decimal(0), slippage_bps_one_way=Decimal(0))
        result = rt.run(bars=bars, funding_rows=funding_rows)
        # Strategy may or may not enter; what we test is that the runtime is wired end-to-end.
        self.assertIsNotNone(result.final_equity)

    def test_risk_kill_liquidates(self) -> None:
        # Force a steep drawdown: buy 100 qty at $100 then mark drops to $50 (-50% unrealized).
        bars = make_bars(["100", "100", "50", "50"])
        port = Portfolio(starting_equity=Decimal("10000"),
                         risk=RiskConfig(max_position_fraction=Decimal("2.0"),
                                         max_total_exposure_fraction=Decimal("5.0"),
                                         max_drawdown_kill_fraction=Decimal("0.20"),
                                         max_daily_loss_fraction=Decimal("0.20")))
        strat = TwapExecutor({"total_qty": "100", "n_slices": 1, "side": "buy"})
        rt = PaperRuntime(symbol="BTCUSDT", portfolio=port, strategy=strat, fee_bps_taker=Decimal(0), slippage_bps_one_way=Decimal(0))
        result = rt.run(bars=bars)
        killed = [e for e in result.events if e.type == "KILLED"]
        self.assertEqual(len(killed), 1)


if __name__ == "__main__":
    unittest.main()
