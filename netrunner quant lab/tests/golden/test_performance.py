from __future__ import annotations

import unittest

from quant_core.performance import compute_performance


class PerformanceTests(unittest.TestCase):
    def test_winning_curve(self) -> None:
        eq = [100, 101, 102, 105, 110]
        rep = compute_performance(eq, [1, 1, 3, 5], bars_per_year=35040)
        self.assertGreater(rep.total_return, 0.09)
        self.assertGreater(rep.sharpe, 0)
        self.assertEqual(rep.max_consecutive_wins, 4)
        self.assertEqual(rep.win_rate, 1.0)
        self.assertEqual(rep.n_trades, 4)

    def test_drawdown_detected(self) -> None:
        eq = [100, 110, 105, 90, 95]
        rep = compute_performance(eq, [], bars_per_year=35040)
        self.assertGreater(rep.max_drawdown, 0.18)

    def test_profit_factor_and_expectancy(self) -> None:
        pnls = [10, -5, 8, -2, 4]
        rep = compute_performance([100, 110, 105, 113, 111, 115], pnls, bars_per_year=35040)
        self.assertGreater(rep.profit_factor, 1.0)
        self.assertGreater(rep.expectancy, 0)

    def test_max_consecutive_losses(self) -> None:
        pnls = [-1, -2, 3, -1, -2, -3]
        rep = compute_performance([100] * 7, pnls, bars_per_year=35040)
        self.assertEqual(rep.max_consecutive_losses, 3)


if __name__ == "__main__":
    unittest.main()
