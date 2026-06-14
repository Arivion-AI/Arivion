"""P0.3 — float-stats / Decimal-money determinism seam.

Confirms the curve-derived scalar metrics are:
  1. reproducible run-to-run (same inputs -> identical metrics), and
  2. order-independent — ``math.fsum`` reductions give the same result regardless of the
     summation order, where a naive left-to-right ``sum`` could drift in the last ULP.

These scalars are NOT byte-hashed (events/fills are); they are tolerance-compared by the
verifier. ``METRIC_ABS_TOLERANCE`` is the documented absolute tolerance (§21).
"""
from __future__ import annotations

import math
import random
import unittest
from decimal import Decimal

from quant_core.orders import Bar
from quant_core.performance import METRIC_ABS_TOLERANCE, compute_performance
from quant_core.paper_runtime import PaperRuntime
from quant_core.portfolio import Portfolio
from quant_core.strategies import REGISTRY as STRATEGY_REGISTRY


def _bars(n: int, seed: int = 7) -> list[Bar]:
    from datetime import datetime, timedelta, timezone

    rng = random.Random(seed)
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    px = 100.0
    out: list[Bar] = []
    for i in range(n):
        px = max(1.0, px * (1.0 + rng.uniform(-0.01, 0.012)))
        p = Decimal(str(round(px, 2)))
        out.append(Bar(ts=t0 + timedelta(minutes=i), open=p, high=p + Decimal("0.5"),
                       low=p - Decimal("0.5"), close=p, volume=Decimal("10")))
    return out


class DeterminismStatsTests(unittest.TestCase):
    def test_metric_tolerance_constant_documented(self) -> None:
        # The seam is a named, importable constant — not a magic literal scattered in code.
        self.assertEqual(METRIC_ABS_TOLERANCE, 1e-9)

    def test_same_backtest_twice_identical_metrics(self) -> None:
        """Run the same bot backtest twice; every curve-derived metric matches within tolerance
        (in fact byte-identical, since the pipeline is deterministic)."""
        bars = _bars(300)
        strat_name = next(iter(STRATEGY_REGISTRY))

        def run_once():
            pf = Portfolio(starting_equity=Decimal("10000"))
            rt = PaperRuntime(symbol="BTCUSDT", portfolio=pf, strategy=STRATEGY_REGISTRY[strat_name]({}))
            res = rt.run(bars=bars, funding_rows=[])
            return compute_performance(res.equity_curve, res.trade_pnls, bars_per_year=525600)

        a, b = run_once(), run_once()
        for field in ("total_return", "sharpe", "sortino", "calmar", "max_drawdown",
                      "volatility_annualized", "win_rate", "profit_factor", "expectancy"):
            va, vb = getattr(a, field), getattr(b, field)
            self.assertLessEqual(abs(va - vb), METRIC_ABS_TOLERANCE, f"{field} drifted: {va} vs {vb}")
            self.assertEqual(va, vb, f"{field} not byte-identical: {va} vs {vb}")

    def test_trade_stat_reductions_are_order_independent(self) -> None:
        """The trade-PnL reductions (avg_win, avg_loss, profit_factor, expectancy) are sums over
        fixed multisets — permuting the PnL order must not change them. fsum guarantees this even
        for adversarially mixed magnitudes where a naive float ``sum`` would drift in the last ULP.
        Equity is held flat so only the trade-stat reductions are exercised."""
        rng = random.Random(123)
        # Mixed-magnitude wins and losses: the classic summation-order-sensitive set.
        pnls = [1e8, -1e8, 1.0, -1.0, 1e-7, -1e-7, 3.14159, -2.71828, 5e6, -4.9e6] * 10
        flat_eq = [10000.0] * (len(pnls) + 1)  # flat curve isolates trade-stat reductions

        def stats_for(order):
            rep = compute_performance(flat_eq, order, bars_per_year=525600)
            return (rep.avg_win, rep.avg_loss, rep.profit_factor, rep.expectancy)

        base = stats_for(pnls)
        for _ in range(25):
            shuffled = pnls[:]
            rng.shuffle(shuffled)
            got = stats_for(shuffled)
            for name, b, g in zip(("avg_win", "avg_loss", "profit_factor", "expectancy"), base, got):
                self.assertEqual(b, g, f"{name} not order-stable under permutation: {b} vs {g}")

    def test_fsum_is_order_invariant(self) -> None:
        """The property the code relies on: math.fsum is exact-rounding and therefore order-
        invariant for any permutation, independent of the interpreter's ``sum`` implementation.
        (CPython 3.12+ compensates ``sum`` too, but fsum is the version-independent guarantee we
        pin to so the byte-stability of curve scalars does not depend on the runtime.)"""
        rng = random.Random(99)
        vals = [1.0, 1e100, 1.0, -1e100, 1e-100, 7.0, -3.5, 2e50, -2e50]
        base = math.fsum(vals)
        for _ in range(50):
            shuffled = vals[:]
            rng.shuffle(shuffled)
            self.assertEqual(math.fsum(shuffled), base)


if __name__ == "__main__":
    unittest.main()
