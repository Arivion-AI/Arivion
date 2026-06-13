from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from quant_core.bot_os.models import BotContext, BotSpec
from quant_core.bot_os.registry import build_bot


def dt(i: int) -> datetime:
    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=15 * i)


def ctx(i: int, prices: dict[str, str], marks: dict[str, str] | None = None, prior_volume: dict[str, str] | None = None, positions: dict[str, str] | None = None) -> BotContext:
    return BotContext(
        ts=dt(i),
        prices={k: Decimal(v) for k, v in prices.items()},
        marks={k: Decimal(v) for k, v in (marks or prices).items()},
        prior_bar_volume={k: Decimal(v) for k, v in (prior_volume or {}).items()},
        positions={k: Decimal(v) for k, v in (positions or {}).items()},
        cash=Decimal("100000"),
        equity=Decimal("100000"),
    )


class BotOsV4Tests(unittest.TestCase):
    def test_g1_spot_grid_paired_replacement(self) -> None:
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
        start = bot.on_start(ctx(0, {"BTCUSDT": "110"}))
        self.assertEqual(len(start.place), 2)
        buy_prices = [o.limit_price for o in start.place if o.side == "buy"]
        self.assertEqual(buy_prices, [Decimal("100")])

        pair = bot.on_fill({"side": "buy", "price": "100", "qty": "1"}, ctx(1, {"BTCUSDT": "109"}))
        self.assertEqual(len(pair.place), 1)
        self.assertEqual(pair.place[0].side, "sell")
        self.assertEqual(pair.place[0].limit_price, Decimal("110"))

    def test_g3_dca_exact_schedule(self) -> None:
        bot = build_bot(
            "dca",
            {
                "symbol": "BTCUSDT",
                "investment_quote_per_order": "10",
                "frequency_bars": 1,
                "max_total_investment": "100",
            },
        )
        orders = 0
        for i in range(10):
            d = bot.on_bar(ctx(i, {"BTCUSDT": "100"}))
            orders += len(d.place)
        self.assertEqual(orders, 10)

    def test_g4_futures_dca_tp_recompute(self) -> None:
        bot = build_bot(
            "futures_dca",
            {
                "symbol": "BTCUSDT",
                "direction": "long",
                "base_order_margin": "100",
                "dca_order_margin": "90",
                "price_deviation_fraction": "0.10",
                "take_profit_fraction": "0.01",
                "max_dca_orders": 3,
            },
        )
        first = bot.on_bar(ctx(0, {"BTCUSDT": "100"}, {"BTCUSDT": "100"}))
        self.assertEqual(len(first.place), 2)

        second = bot.on_bar(ctx(1, {"BTCUSDT": "90"}, {"BTCUSDT": "90"}))
        tp_orders = [o for o in second.place if o.tag == "f_dca_tp"]
        self.assertEqual(len(tp_orders), 1)
        self.assertEqual(tp_orders[0].limit_price, Decimal("95.95"))

    def test_g5_martingale_max_safety_orders(self) -> None:
        bot = build_bot(
            "futures_martingale",
            {
                "symbol": "BTCUSDT",
                "direction": "long",
                "base_order_margin": "100",
                "safety_order_margin": "100",
                "price_deviation_fraction": "0.02",
                "deviation_multiplier": "1",
                "max_safety_orders": 2,
                "hard_stop_loss_fraction": "0.03",
            },
        )
        bot.on_bar(ctx(0, {"BTCUSDT": "100"}, {"BTCUSDT": "100"}))
        add_orders = 0
        for i, px in enumerate(["97", "94", "91", "88"], start=1):
            d = bot.on_bar(ctx(i, {"BTCUSDT": px}, {"BTCUSDT": px}))
            add_orders += len([o for o in d.place if o.tag and o.tag.startswith("f_dca_add_")])
        self.assertEqual(add_orders, 2)

    def test_g6b_combo_short_leveraged_weight_validation(self) -> None:
        bot = build_bot(
            "futures_combo",
            {
                "symbols": [
                    {"symbol": "BTCUSDT", "side": "long", "target_weight_fraction": "0.5", "leverage": "1"},
                    {"symbol": "SOLUSDT", "side": "short", "target_weight_fraction": "0.5", "leverage": "2"},
                ],
                "total_investment": "10000",
                "rebalance": {"threshold_fraction": "0.05"},
            },
        )
        report = bot.validate(
            BotSpec(
                bot_type="futures_combo",
                name="combo",
                symbols=["BTCUSDT", "SOLUSDT"],
                params={},
            )
        )
        self.assertTrue(report.valid)

    def test_g7_funding_arb_sign_per_regime(self) -> None:
        pos = build_bot(
            "funding_arbitrage",
            {
                "spot_symbol": "BTCUSDT",
                "perp_symbol": "BTCUSDT-PERP",
                "base_notional": "1000",
                "entry_min_funding_rate": "0.0001",
            },
        )
        d_pos = pos.on_bar(
            BotContext(
                ts=dt(0),
                prices={"BTCUSDT": Decimal("100"), "BTCUSDT-PERP": Decimal("100")},
                marks={"BTCUSDT": Decimal("100"), "BTCUSDT-PERP": Decimal("100")},
                funding_rates={"BTCUSDT-PERP": Decimal("0.001")},
            )
        )
        self.assertEqual([o.side for o in d_pos.place], ["buy", "sell"])

        neg = build_bot(
            "funding_arbitrage",
            {
                "spot_symbol": "BTCUSDT",
                "perp_symbol": "BTCUSDT-PERP",
                "base_notional": "1000",
                "entry_min_funding_rate": "0.0001",
                "allow_reverse_carry": True,
            },
        )
        d_neg = neg.on_bar(
            BotContext(
                ts=dt(0),
                prices={"BTCUSDT": Decimal("100"), "BTCUSDT-PERP": Decimal("100")},
                marks={"BTCUSDT": Decimal("100"), "BTCUSDT-PERP": Decimal("100")},
                funding_rates={"BTCUSDT-PERP": Decimal("-0.001")},
            )
        )
        self.assertEqual([o.side for o in d_neg.place], ["sell", "buy"])

    def test_g8_twap_exact_slices(self) -> None:
        bot = build_bot("twap", {"symbol": "BTCUSDT", "side": "buy", "total_qty": "10", "slice_count": 5})
        qty = Decimal("0")
        fills = 0
        for i in range(7):
            d = bot.on_bar(ctx(i, {"BTCUSDT": "100"}))
            for o in d.place:
                fills += 1
                qty += o.qty
        self.assertEqual(fills, 5)
        self.assertEqual(qty, Decimal("10"))

    def test_g9b_vp_uses_prior_bar_volume(self) -> None:
        bot = build_bot(
            "vp_pov",
            {
                "symbol": "BTCUSDT",
                "side": "buy",
                "target_qty": "1000",
                "participation_rate_fraction": "0.05",
                "max_participation_rate_fraction": "0.10",
                "min_slice_qty": "1",
                "max_slice_qty": "1000",
            },
        )
        d = bot.on_bar(
            BotContext(
                ts=dt(0),
                prices={"BTCUSDT": Decimal("100"), "__volume__:BTCUSDT": Decimal("4000")},
                marks={"BTCUSDT": Decimal("100")},
                prior_bar_volume={"BTCUSDT": Decimal("1000")},
            )
        )
        self.assertEqual(d.place[0].qty, Decimal("50"))

    def test_g10_chase_max_distance(self) -> None:
        bot = build_bot(
            "chase_limit",
            {
                "symbol": "BTCUSDT",
                "side": "buy",
                "qty": "1",
                "offset_bps": "0",
                "max_chase_distance_bps": "300",
                "timeout_bars": 20,
            },
        )
        bot.on_start(ctx(0, {"BTCUSDT": "100"}, {"BTCUSDT": "100"}))
        d = bot.on_bar(ctx(1, {"BTCUSDT": "120"}, {"BTCUSDT": "120"}))
        self.assertEqual(d.place[0].limit_price, Decimal("103"))

    def test_g11_iceberg_single_child(self) -> None:
        bot = build_bot("iceberg", {"symbol": "BTCUSDT", "side": "buy", "total_qty": "2", "visible_qty": "1", "price_limit": "100"})
        start = bot.on_start(ctx(0, {"BTCUSDT": "100"}))
        self.assertEqual(len(start.place), 1)
        self.assertEqual(start.place[0].qty, Decimal("1"))

        nxt = bot.on_fill({"qty": "1"}, ctx(1, {"BTCUSDT": "100"}))
        self.assertEqual(len(nxt.place), 1)
        self.assertEqual(nxt.place[0].qty, Decimal("1"))

    def test_g12_scaled_order_one_shot(self) -> None:
        bot = build_bot(
            "scaled_order",
            {
                "symbol": "BTCUSDT",
                "side": "buy",
                "total_qty": "10",
                "lower_price": "90",
                "upper_price": "110",
                "order_count": 5,
                "distribution": "equal",
            },
        )
        start = bot.on_start(ctx(0, {"BTCUSDT": "100"}))
        self.assertEqual(len(start.place), 5)
        self.assertEqual(sum((o.qty for o in start.place), Decimal("0")), Decimal("10"))

    def test_g13_and_g13b_snowball_add_logic(self) -> None:
        bot = build_bot(
            "position_snowball",
            {
                "symbol": "BTCUSDT",
                "direction": "long",
                "initial_margin": "100",
                "add_trigger_roi_fraction": "0.02",
                "profit_reinvestment_fraction": "0.5",
                "max_adds": 3,
                "cooldown_bars_between_adds": 1,
                "liquidation_distance_floor_fraction": "0.01",
                "take_profit_roi_fraction": "0.5",
                "stop_loss_roi_fraction": "0.5",
            },
        )
        bot.on_bar(ctx(0, {"BTCUSDT": "100"}, {"BTCUSDT": "100"}))
        no_add = bot.on_bar(ctx(1, {"BTCUSDT": "98"}, {"BTCUSDT": "98"}))
        self.assertEqual(len(no_add.place), 0)
        yes_add = bot.on_bar(ctx(2, {"BTCUSDT": "102"}, {"BTCUSDT": "102"}))
        self.assertEqual(len(yes_add.place), 1)

        blocked = build_bot(
            "position_snowball",
            {
                "symbol": "BTCUSDT",
                "direction": "long",
                "initial_margin": "100",
                "add_trigger_roi_fraction": "0.02",
                "profit_reinvestment_fraction": "0.5",
                "max_adds": 3,
                "cooldown_bars_between_adds": 1,
                "liquidation_distance_floor_fraction": "0.20",
                "take_profit_roi_fraction": "0.5",
                "stop_loss_roi_fraction": "0.5",
            },
        )
        blocked.on_bar(ctx(0, {"BTCUSDT": "100"}, {"BTCUSDT": "100"}))
        rej = blocked.on_bar(ctx(1, {"BTCUSDT": "102"}, {"BTCUSDT": "102"}))
        self.assertEqual(len(rej.place), 0)
        self.assertTrue(any("LIQUIDATION_FLOOR_BREACH" in note for note in rej.risk_notes))


if __name__ == "__main__":
    unittest.main()
