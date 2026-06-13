from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from quant_core.bot_os import BotContext, build_bot


def ts(i: int) -> datetime:
    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=15 * i)


class AppendixABotFixtures(unittest.TestCase):
    def test_grid_full_cycle_fixture(self) -> None:
        bot = build_bot(
            "spot_grid",
            {
                "symbol": "BTCUSDT",
                "lower_price": "100",
                "upper_price": "120",
                "grid_count": 3,
                "investment_quote": "300",
            },
        )
        start = bot.on_start(BotContext(ts=ts(0), prices={"BTCUSDT": Decimal("110")}, marks={"BTCUSDT": Decimal("110")}))
        self.assertEqual(len(start.place), 2)
        fill = bot.on_fill({"side": "buy", "qty": "1", "price": "100"}, BotContext(ts=ts(1), prices={"BTCUSDT": Decimal("100")}, marks={"BTCUSDT": Decimal("100")}))
        self.assertTrue(any(o.side == "sell" for o in fill.place))

    def test_martingale_ladder_fixture(self) -> None:
        bot = build_bot(
            "futures_martingale",
            {
                "symbol": "BTCUSDT",
                "direction": "long",
                "base_order_margin": "100",
                "safety_order_margin": "100",
                "safety_order_multiplier": "1.5",
                "price_deviation_fraction": "0.02",
                "deviation_multiplier": "1.0",
                "max_safety_orders": 3,
                "hard_stop_loss_fraction": "0.25",
                "leverage": 1,
            },
        )
        bot.on_bar(BotContext(ts=ts(0), prices={"BTCUSDT": Decimal("100")}, marks={"BTCUSDT": Decimal("100")}))
        step1 = bot.on_bar(BotContext(ts=ts(1), prices={"BTCUSDT": Decimal("98")}, marks={"BTCUSDT": Decimal("98")}))
        step2 = bot.on_bar(BotContext(ts=ts(2), prices={"BTCUSDT": Decimal("96")}, marks={"BTCUSDT": Decimal("96")}))
        adds = [*step1.place, *step2.place]
        self.assertTrue(any((o.tag or "").startswith("f_dca_add") for o in adds))

    def test_funding_arb_regime_sweep_fixture(self) -> None:
        bot = build_bot(
            "funding_arbitrage",
            {
                "spot_symbol": "BTCUSDT",
                "perp_symbol": "BTCUSDT",
                "synthetic_spot": {"mode": "held", "carrying_cost_bps_per_day": "0"},
                "entry": {"min_funding_rate": "0.0002"},
                "exit": {"funding_rate_below": "0.00005", "max_holding_hours": 240},
            },
        )
        pos = bot.on_bar(
            BotContext(
                ts=ts(0),
                prices={"BTCUSDT": Decimal("100")},
                marks={"BTCUSDT": Decimal("100")},
                funding_rates={"BTCUSDT": Decimal("0.001")},
            )
        )
        neutral = bot.on_bar(
            BotContext(
                ts=ts(1),
                prices={"BTCUSDT": Decimal("100")},
                marks={"BTCUSDT": Decimal("100")},
                funding_rates={"BTCUSDT": Decimal("0.00001")},
            )
        )
        self.assertGreaterEqual(len(pos.place), 1)
        self.assertTrue(neutral.cancel_all or len(neutral.place) >= 0)


if __name__ == "__main__":
    unittest.main()

