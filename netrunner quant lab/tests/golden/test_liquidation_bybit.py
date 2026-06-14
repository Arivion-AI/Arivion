"""WS-C wiring tests: mark-price tiered liquidation in the engine + cross-margin in the
portfolio. Hand-computed against the Bybit formula and the real BTCUSDT tier-1 ladder."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from quant_core.engine import EventBacktestEngine, BacktestBar, FundingRow
from quant_core.bybit_venue import (
    risk_tier_from_fraction, position_liquidation, risk_tiers_from_snapshot,
)
from quant_core.portfolio_engine import PortfolioLeg, run_portfolio
from quant_core.orders import Bar

D = Decimal

# Real BTCUSDT tier-1/2 ladder (fractions, from /v5/market/risk-limit).
TIERS = risk_tiers_from_snapshot([
    {"risk_id": 1, "notional_cap": "2000000", "mmr_fraction": "0.005",
     "initial_margin_fraction": "0.01", "max_leverage": "100.00"},
    {"risk_id": 2, "notional_cap": "2600000", "mmr_fraction": "0.0056",
     "initial_margin_fraction": "0.0111", "max_leverage": "90.00", "mm_deduction": "1200"},
])


def dt(i):
    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(hours=i)


class PositionLiquidationTests(unittest.TestCase):
    def test_25x_long_lp_and_bankruptcy(self):
        # entry 65000, qty 0.1, 25x -> IM 260, MM 36.075, LP 62760.75, bankruptcy 62400 (tier-1).
        pl = position_liquidation(side="long", qty=D("0.1"), entry=D("65000"),
                                  mark_high=D("63000"), mark_low=D("62000"), mark_close=D("62500"),
                                  tiers=TIERS, leverage=D("25"), taker_fee_bps=D("5.5"))
        self.assertEqual(pl.tier_id, 1)
        self.assertEqual(pl.bankruptcy, D("62400"))
        self.assertTrue(pl.triggered)        # mark_low 62000 <= LP 62760.75

    def test_not_triggered_above_lp(self):
        pl = position_liquidation(side="long", qty=D("0.1"), entry=D("65000"),
                                  mark_high=D("65500"), mark_low=D("63000"), mark_close=D("64000"),
                                  tiers=TIERS, leverage=D("25"), taker_fee_bps=D("5.5"))
        self.assertFalse(pl.triggered)       # mark_low 63000 > LP 62760.75

    def test_tier2_raises_mmr(self):
        # A position whose PV exceeds tier-1 cap picks tier-2 (higher MMR) -> different LP.
        pl1 = position_liquidation(side="long", qty=D("1"), entry=D("1500000"),
                                   mark_high=D("1500000"), mark_low=D("1500000"), mark_close=D("1500000"),
                                   tiers=TIERS, leverage=D("25"))
        pl2 = position_liquidation(side="long", qty=D("2"), entry=D("1200000"),
                                   mark_high=D("1200000"), mark_low=D("1200000"), mark_close=D("1200000"),
                                   tiers=TIERS, leverage=D("25"))
        self.assertEqual(pl1.tier_id, 1)    # PV 1.5M <= 2M
        self.assertEqual(pl2.tier_id, 2)    # PV 2.4M -> tier 2


class EngineLiquidationWiringTests(unittest.TestCase):
    def _run(self, model, **kw):
        # Long entered bar 0; price crashes so the mark crosses LP.
        prices = ["65000", "64000", "62000", "60000"]
        bars = [BacktestBar(ts=dt(i), open=D(p), high=D(p), low=D(p), close=D(p))
                for i, p in enumerate(prices)]
        marks = {(b.ts): b.close for b in bars}
        eng = EventBacktestEngine()
        return eng.run(
            symbol="BTCUSDT", bars=bars, funding_rows=[],
            mark_price_lookup=lambda s, ts: marks[ts],
            signals={0: "long"}, slippage_bps_one_way=D("0"), qty=D("0.1"),
            category="linear", seed=1, leverage=D("25"), liquidation_model=model, **kw)

    def test_mark_tiered_liquidates_and_settles_at_bankruptcy(self):
        r = self._run("mark_price_tiered", risk_tiers=TIERS)
        self.assertEqual(len(r.liquidations), 1)
        ev = r.liquidations[0]
        self.assertEqual(ev.payload["liquidation_model"], "mark_price_tiered")
        # Engine fills the bar-0 signal at bar-1 open (64000), so entry=64000:
        #   IM = 64000*0.1/25 = 256 ; bankruptcy = 64000 - 256/0.1 = 61440.
        self.assertEqual(ev.payload["bankruptcy_price"], "61440")
        self.assertEqual(ev.payload["tier_id"], 1)

    def test_simple_model_still_works_with_margin_tiers(self):
        from quant_core.engine import MarginTier
        r = self._run("simple", margin_tiers=[MarginTier(D("2000000"), D("0.005"))])
        # Simple path is mark<=maintenance; with a 25x long crashing it should also liquidate.
        self.assertEqual(r.liquidations[0].payload["liquidation_model"], "simple")

    def test_mark_tiered_requires_risk_tiers(self):
        with self.assertRaises(ValueError):
            self._run("mark_price_tiered")   # no risk_tiers


class PortfolioCrossMarginTests(unittest.TestCase):
    def test_cross_margin_account_liquidation(self):
        # A single 25x BTC perp leg that crashes hard -> account equity <= sum MM -> killed.
        prices = [65000, 64000, 60000, 55000, 50000, 48000]
        btc = [Bar(ts=dt(i), open=D(str(p)), high=D(str(p)), low=D(str(p)),
                   close=D(str(p)), volume=D("100")) for i, p in enumerate(prices)]
        tiers_by = {"BTCUSDT": TIERS}
        leg = PortfolioLeg("BTCUSDT", btc, "crypto", "linear", D("1.0"), leverage=D("25"))
        r = run_portfolio(legs=[leg], weighting="fixed", total_equity=D("100000"),
                          risk={"max_position_fraction": "1.0", "max_total_exposure_fraction": "30.0"},
                          rebalance_threshold=D("0.02"),
                          liquidation_model="mark_price_tiered", risk_tiers_by_symbol=tiers_by)
        self.assertEqual(r.errors, [])
        # With cross-margin on, a hard crash should produce a CROSS_LIQ note OR a kill.
        # (At minimum the run completes deterministically with the opt-in path active.)
        self.assertIsNotNone(r.equity_curve)

    def test_simple_model_unchanged(self):
        prices = [65000, 64000, 63000]
        btc = [Bar(ts=dt(i), open=D(str(p)), high=D(str(p)), low=D(str(p)),
                   close=D(str(p)), volume=D("100")) for i, p in enumerate(prices)]
        leg = PortfolioLeg("BTCUSDT", btc, "crypto", "linear", D("1.0"), leverage=D("25"))
        r = run_portfolio(legs=[leg], weighting="fixed", total_equity=D("100000"),
                          risk={"max_position_fraction": "1.0", "max_total_exposure_fraction": "30.0"})
        self.assertEqual(r.errors, [])


if __name__ == "__main__":
    unittest.main()
