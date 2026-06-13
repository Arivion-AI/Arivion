"""Missing goldens (G.2, G.6) + validator + recommender + risk cockpit tests."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from quant_core.bot_os import (
    BotContext, BotDecision, BotSpec,
    build_bot, validate_bot_spec, spec_hash, compute_cockpit,
    recommend, detect_regime, COMPILER_VERSION, TEMPLATES,
)
from quant_core.orders import Bar


def dt(h: int) -> datetime:
    return datetime(2026, 1, 1, h, 0, tzinfo=timezone.utc)


def bar(ts, px: str) -> Bar:
    p = Decimal(px)
    return Bar(ts=ts, open=p, high=p + Decimal("0.5"), low=p - Decimal("0.5"), close=p, volume=Decimal("1"))


class G2_FuturesGridFundingBeforeDecision(unittest.TestCase):
    """Short across a funding settlement, positive rate -> short RECEIVES; the
    futures grid bot must see updated funding state on the bar it decides on."""

    def test_funding_state_visible_to_bot_decision(self) -> None:
        bot = build_bot("futures_grid", {
            "symbol": "BTCUSDT", "lower_price": "100", "upper_price": "110",
            "grid_count": 5, "direction": "short", "leverage": 1, "investment_quote": "1000",
        })
        ctx = BotContext(
            ts=dt(8), prices={"BTCUSDT": Decimal("105")}, marks={"BTCUSDT": Decimal("105")},
            funding_rates={"BTCUSDT": Decimal("0.0001")},
            positions={"BTCUSDT": Decimal("-1")},
        )
        decision = bot.on_bar(ctx)
        # The bot must surface that funding has already been applied before its decision.
        self.assertIn("FUNDING_APPLIED_BEFORE_DECISION", decision.risk_notes)


class G6_ComboLongOnlyThresholdRebalance(unittest.TestCase):
    """Target BTC50/ETH50 long-only; BTC drifts to ~56% gross weight, threshold 5%
    -> rebalance triggers."""

    def test_long_only_threshold_triggers_rebalance(self) -> None:
        bot = build_bot("futures_combo", {
            "total_investment": "10000",
            "rebalance": {"mode": "threshold", "threshold_fraction": "0.05"},
            "symbols": [
                {"symbol": "BTCUSDT", "side": "long", "target_weight_fraction": "0.5", "leverage": 1},
                {"symbol": "ETHUSDT", "side": "long", "target_weight_fraction": "0.5", "leverage": 1},
            ],
        })
        start = bot.on_start(BotContext(ts=dt(0), prices={"BTCUSDT": Decimal("100"), "ETHUSDT": Decimal("100")},
                                        marks={"BTCUSDT": Decimal("100"), "ETHUSDT": Decimal("100")}))
        self.assertGreater(len(start.place), 0)
        # Drift BTC up so it's >58% of gross notional (clearly past 5% threshold)
        decision = bot.on_bar(BotContext(
            ts=dt(1),
            prices={"BTCUSDT": Decimal("140"), "ETHUSDT": Decimal("100")},
            marks={"BTCUSDT": Decimal("140"), "ETHUSDT": Decimal("100")},
            positions={"BTCUSDT": Decimal("50"), "ETHUSDT": Decimal("50")},
        ))
        # The combo bot must produce rebalance orders or surface a rebalance note.
        rebalanced = bool(decision.place) or any("REBALANCE" in n.upper() for n in decision.risk_notes + decision.logs)
        self.assertTrue(rebalanced, f"expected a rebalance signal, got {decision}")


class ValidatorTests(unittest.TestCase):
    def test_spec_hash_stable(self) -> None:
        s = BotSpec(bot_type="dca", name="x", symbols=["BTCUSDT"], params={"investment_quote_per_order": "100", "frequency_bars": 96})
        self.assertEqual(spec_hash(s), spec_hash(s))
        s2 = BotSpec(bot_type="dca", name="x", symbols=["BTCUSDT"], params={"frequency_bars": 96, "investment_quote_per_order": "100"})
        self.assertEqual(spec_hash(s), spec_hash(s2), "spec_hash must be order-insensitive on params")

    def test_e0_blocks_verified_execution_without_l2(self) -> None:
        s = BotSpec(bot_type="twap", name="x", symbols=["BTCUSDT"],
                    params={"symbol": "BTCUSDT", "side": "buy", "total_qty": "1.0", "slice_count": 5})
        rep = validate_bot_spec(s, coverage={"has_l2": False}, requested_tier="BACKTEST_VERIFIED")
        self.assertFalse(rep["valid"])
        self.assertIn("E0_VERIFIED_EXECUTION_TIER_REQUIRES_L1_L2", rep["errors"])

    def test_e0_local_tier_allowed_without_l2(self) -> None:
        s = BotSpec(bot_type="twap", name="x", symbols=["BTCUSDT"],
                    params={"symbol": "BTCUSDT", "side": "buy", "total_qty": "1.0", "slice_count": 5})
        rep = validate_bot_spec(s, coverage={"has_l2": False}, requested_tier="LOCAL ONLY")
        self.assertTrue(rep["valid"])
        self.assertIn("APPROXIMATE_FILLS", rep["eligibility_labels"])

    def test_compiler_version_pinned(self) -> None:
        s = BotSpec(bot_type="dca", name="x", symbols=["BTCUSDT"], params={"investment_quote_per_order": "100", "frequency_bars": 96})
        rep = validate_bot_spec(s)
        self.assertEqual(rep["compiler_version"], COMPILER_VERSION)


class RecommenderTests(unittest.TestCase):
    def test_sideways_low_vol_recommends_grids(self) -> None:
        bars = [bar(dt(0) + timedelta(minutes=15 * i), "100") for i in range(40)]
        recs = recommend(bars=bars)
        self.assertGreater(len(recs), 0)
        types = [r.bot_type for r in recs]
        self.assertIn("spot_grid", types)

    def test_funding_extreme_recommends_funding_arb(self) -> None:
        bars = [bar(dt(0) + timedelta(minutes=15 * i), "100") for i in range(40)]
        recs = recommend(bars=bars, funding_rate_last=Decimal("0.0015"))
        self.assertGreater(len(recs), 0)
        self.assertEqual(recs[0].regime_label, "funding_extreme_pos")
        self.assertIn("funding_arbitrage", [r.bot_type for r in recs])

    def test_data_unhealthy_returns_nothing(self) -> None:
        self.assertEqual(recommend(bars=[], data_complete=False), [])

    def test_low_risk_tolerance_filters_dangerous_bots(self) -> None:
        bars = [bar(dt(0) + timedelta(minutes=15 * i), str(100 + i * 0.1)) for i in range(40)]
        recs = recommend(bars=bars, risk_tolerance="low")
        types = {r.bot_type for r in recs}
        self.assertNotIn("futures_martingale", types)
        self.assertNotIn("position_snowball", types)


class CockpitTests(unittest.TestCase):
    def test_martingale_without_stop_loss_blocks(self) -> None:
        s = BotSpec(bot_type="futures_martingale", name="m", symbols=["BTCUSDT"], params={"hard_stop_loss_fraction": "0"})
        report = compute_cockpit(s)
        self.assertIn("MARTINGALE_WITHOUT_STOP_LOSS", report.hard_blocks)
        self.assertIn(report.risk_class, {"VERY_HIGH", "EXTREME", "HIGH"})

    def test_martingale_ruin_simulator_present(self) -> None:
        s = BotSpec(bot_type="futures_martingale", name="m", symbols=["BTCUSDT"],
                    params={"hard_stop_loss_fraction": "0.3", "base_order_margin": "100", "safety_order_margin": "100",
                            "safety_order_multiplier": "1.5", "max_safety_orders": 5})
        report = compute_cockpit(s)
        self.assertIn("ruin_simulator", report.modules)
        self.assertIn("worst_case_required_margin", report.modules["ruin_simulator"])

    def test_combo_gross_weight_block(self) -> None:
        s = BotSpec(bot_type="futures_combo", name="c", symbols=["BTCUSDT", "ETHUSDT"],
                    params={"symbols": [
                        {"symbol": "BTCUSDT", "side": "long", "target_weight_fraction": "0.7", "leverage": 1},
                        {"symbol": "ETHUSDT", "side": "long", "target_weight_fraction": "0.5", "leverage": 1},
                    ]})
        report = compute_cockpit(s)
        self.assertIn("COMBO_GROSS_WEIGHTS_NOT_ONE", report.hard_blocks)


class TemplatesTests(unittest.TestCase):
    def test_templates_present(self) -> None:
        # 14 v4.1 bots + cross_asset_allocator (xStocks integration) = 15
        self.assertEqual(len(TEMPLATES), 15)
        types = {t["bot_type"] for t in TEMPLATES}
        expected = {"spot_grid", "futures_grid", "dca", "futures_dca", "futures_martingale",
                    "futures_combo", "rebalancer", "funding_arbitrage",
                    "twap", "vp_pov", "chase_limit", "iceberg", "scaled_order", "position_snowball",
                    "cross_asset_allocator"}
        self.assertEqual(types, expected)


if __name__ == "__main__":
    unittest.main()
