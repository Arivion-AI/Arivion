"""Golden tests for the multi-asset / multi-token portfolio engine.

Verifies combined-ledger fills on every leg, weighting schemes, rebalancing,
venue rules (xStock spot/long-only/no-leverage), combined risk kill, and the
xStock off-hours fill-widening — all live-feasible on a Bybit UTA.
"""
from __future__ import annotations

import math
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from quant_core.orders import Bar
from quant_core.portfolio_engine import PortfolioLeg, run_portfolio, validate_legs

_RISK = {"max_position_fraction": "1.0", "max_total_exposure_fraction": "5.0",
         "max_daily_loss_fraction": "0.95", "max_drawdown_kill_fraction": "0.95"}
_WEEKDAY = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)   # Mon RTH
_SATURDAY = datetime(2026, 6, 6, 14, 0, tzinfo=timezone.utc)  # off-hours


def _bars(n, p0, seed, t0, drift=0.001):
    out, p = [], p0
    for i in range(n):
        p = p * (1 + drift) + math.sin((i + seed) / 6) * p * 0.005
        out.append(Bar(ts=t0 + timedelta(hours=i), open=Decimal(str(round(p, 2))),
                       high=Decimal(str(round(p * 1.004, 2))), low=Decimal(str(round(p * 0.996, 2))),
                       close=Decimal(str(round(p * 1.001, 2))), volume=Decimal("100")))
    return out


class MultiTokenTests(unittest.TestCase):
    def test_three_token_crypto_fills_all_legs(self):
        legs = [PortfolioLeg("BTCUSDT", _bars(50, 65000, 0, _WEEKDAY), "crypto", "linear"),
                PortfolioLeg("ETHUSDT", _bars(50, 3500, 2, _WEEKDAY), "crypto", "linear"),
                PortfolioLeg("SOLUSDT", _bars(50, 150, 4, _WEEKDAY), "crypto", "linear")]
        for scheme in ("equal", "inverse_vol", "risk_parity", "momentum"):
            r = run_portfolio(legs=legs, weighting=scheme, total_equity=Decimal("100000"),
                              risk=_RISK, rebalance_threshold=Decimal("0.03"))
            self.assertEqual(r.errors, [], scheme)
            self.assertGreaterEqual(len(set(f["symbol"] for f in r.fills)), 2, scheme)
            self.assertEqual(len(r.equity_curve), 50, scheme)


class MultiAssetTests(unittest.TestCase):
    def test_crypto_plus_equity_fills_both(self):
        legs = [PortfolioLeg("BTCUSDT", _bars(50, 65000, 0, _WEEKDAY), "crypto", "linear", Decimal("0.5")),
                PortfolioLeg("NVDAXUSDT", _bars(50, 1200, 4, _WEEKDAY), "equity", "spot", Decimal("0.25")),
                PortfolioLeg("GOOGLXUSDT", _bars(50, 600, 8, _WEEKDAY), "equity", "spot", Decimal("0.25"))]
        r = run_portfolio(legs=legs, weighting="fixed", total_equity=Decimal("100000"),
                          risk=_RISK, rebalance_threshold=Decimal("0.03"))
        self.assertEqual(r.errors, [])
        syms = set(f["symbol"] for f in r.fills)
        self.assertTrue({"BTCUSDT", "NVDAXUSDT", "GOOGLXUSDT"}.issubset(syms))


class VenueRuleTests(unittest.TestCase):
    def test_equity_leverage_short_linear_rejected(self):
        legs = [PortfolioLeg("NVDAXUSDT", _bars(10, 1200, 0, _WEEKDAY), "equity", "linear", Decimal("1"), Decimal("3"), True)]
        errs = validate_legs(legs)
        self.assertTrue(any("XSTOCK_SPOT_ONLY" in e for e in errs))
        self.assertTrue(any("XSTOCK_LEVERAGE_NOT_ALLOWED" in e for e in errs))
        self.assertTrue(any("XSTOCK_SHORT_NOT_ALLOWED" in e for e in errs))

    def test_xstock_mislabeled_crypto_still_caught(self):
        legs = [PortfolioLeg("AAPLXUSDT", _bars(10, 300, 0, _WEEKDAY), "crypto", "linear")]
        self.assertTrue(any("XSTOCK_SPOT_ONLY" in e for e in validate_legs(legs)))

    def test_run_returns_errors_for_bad_legs(self):
        legs = [PortfolioLeg("NVDAXUSDT", _bars(10, 1200, 0, _WEEKDAY), "equity", "linear", Decimal("1"), Decimal("5"))]
        r = run_portfolio(legs=legs, weighting="fixed")
        self.assertTrue(r.errors)
        self.assertEqual(r.fills, [])


class RiskAndFillTests(unittest.TestCase):
    def test_combined_drawdown_kill_flattens(self):
        legs = [PortfolioLeg("BTCUSDT", _bars(50, 65000, 0, _WEEKDAY), "crypto", "linear", Decimal("1.0"))]
        r = run_portfolio(legs=legs, weighting="fixed", total_equity=Decimal("100000"),
                          risk={"max_drawdown_kill_fraction": "0.01", "max_position_fraction": "1.0",
                                "max_total_exposure_fraction": "5.0", "max_daily_loss_fraction": "0.95"})
        self.assertTrue(r.risk_state["killed"])
        self.assertEqual(r.risk_state["kill_reason"], "MAX_DRAWDOWN_KILL")

    def test_equity_held_flat_off_hours(self):
        # Best-practice mixed-calendar rule: equity legs DO NOT trade outside US RTH —
        # they are held flat (crypto keeps trading 24/7). So a Saturday equity-only book
        # produces zero fills (with an off-hours-hold note); a weekday RTH book trades.
        def run(t0):
            legs = [PortfolioLeg("NVDAXUSDT", _bars(8, 1000, 0, t0, drift=0.0), "equity", "spot", Decimal("1.0"))]
            return run_portfolio(legs=legs, weighting="fixed", total_equity=Decimal("100000"),
                                 risk=_RISK, rebalance_threshold=Decimal("0.01"))
        sat = run(_SATURDAY)
        self.assertEqual(len(sat.fills), 0)
        self.assertTrue(any("XSTOCK_OFFHOURS_HOLD" in n for n in sat.risk_notes))
        self.assertGreaterEqual(len(run(_WEEKDAY).fills), 1)

    def test_rebalance_threshold_limits_churn(self):
        legs = [PortfolioLeg("BTCUSDT", _bars(40, 65000, 0, _WEEKDAY, drift=0.0), "crypto", "linear", Decimal("0.5")),
                PortfolioLeg("ETHUSDT", _bars(40, 3500, 0, _WEEKDAY, drift=0.0), "crypto", "linear", Decimal("0.5"))]
        tight = run_portfolio(legs=legs, weighting="fixed", total_equity=Decimal("100000"), risk=_RISK, rebalance_threshold=Decimal("0.005"))
        loose = run_portfolio(legs=legs, weighting="fixed", total_equity=Decimal("100000"), risk=_RISK, rebalance_threshold=Decimal("0.50"))
        self.assertLessEqual(loose.rebalances, tight.rebalances)

    def test_ruin_floor_kills_at_zero_equity(self):
        # Leveraged crypto leg into a steep decline -> equity should hit the ruin floor
        # and the run stops (killed), not drift to absurd negative equity.
        decline = []
        p = 1000.0
        for i in range(30):
            p *= 0.90  # -10%/bar
            decline.append(Bar(ts=_WEEKDAY + timedelta(hours=i), open=Decimal(str(round(p, 2))),
                               high=Decimal(str(round(p * 1.001, 2))), low=Decimal(str(round(p * 0.95, 2))),
                               close=Decimal(str(round(p * 0.97, 2))), volume=Decimal("100")))
        legs = [PortfolioLeg("BTCUSDT", decline, "crypto", "linear", Decimal("1.0"), Decimal("5"))]
        r = run_portfolio(legs=legs, weighting="fixed", total_equity=Decimal("100"),
                          risk={"max_position_fraction": "1.0", "max_total_exposure_fraction": "10.0",
                                "max_daily_loss_fraction": "0.99", "max_drawdown_kill_fraction": "0.99"})
        self.assertTrue(r.risk_state["killed"])
        self.assertGreaterEqual(float(r.final_equity), -float(r.equity_curve[0]))  # not catastrophically negative

    def test_metrics_present(self):
        legs = [PortfolioLeg("BTCUSDT", _bars(40, 65000, 0, _WEEKDAY), "crypto", "linear", Decimal("1.0"))]
        r = run_portfolio(legs=legs, weighting="fixed", total_equity=Decimal("100000"), risk=_RISK)
        for k in ("total_return", "sharpe", "max_drawdown"):
            self.assertIn(k, r.metrics)


if __name__ == "__main__":
    unittest.main()
