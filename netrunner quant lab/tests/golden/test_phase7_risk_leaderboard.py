from __future__ import annotations

import unittest

from quant_core.risk import RiskGateConfig, RiskMetrics, evaluate_risk


class Phase7RiskTests(unittest.TestCase):
    def test_high_return_high_drawdown_is_gated_out(self) -> None:
        target = RiskMetrics(
            total_return_after_fees_funding=0.90,
            sharpe=2.0,
            calmar=1.4,
            max_drawdown=0.45,
            consistency=0.7,
            robustness=0.65,
            live_paper_score=0.0,
            liquidation_events=0,
            data_coverage_complete=True,
            overfit_penalty=0.05,
            approximate_fills=False,
        )
        cohort = [
            target,
            RiskMetrics(
                total_return_after_fees_funding=0.25,
                sharpe=1.3,
                calmar=0.9,
                max_drawdown=0.12,
                consistency=0.62,
                robustness=0.58,
                live_paper_score=0.0,
                liquidation_events=0,
                data_coverage_complete=True,
                overfit_penalty=0.07,
                approximate_fills=False,
            ),
        ]
        result = evaluate_risk(target, cohort, RiskGateConfig(drawdown_cap=0.30, overfit_penalty_threshold=0.20))
        self.assertFalse(result.hard_gates_passed)
        self.assertIn("MAX_DRAWDOWN_CAP", result.gate_failures)

    def test_approximate_fills_blocked_for_official(self) -> None:
        target = RiskMetrics(
            total_return_after_fees_funding=0.10,
            sharpe=1.0,
            calmar=0.6,
            max_drawdown=0.15,
            consistency=0.55,
            robustness=0.50,
            live_paper_score=0.0,
            liquidation_events=0,
            data_coverage_complete=True,
            overfit_penalty=0.03,
            approximate_fills=True,
        )
        result = evaluate_risk(target, [target], RiskGateConfig())
        self.assertFalse(result.hard_gates_passed)
        self.assertIn("APPROXIMATE_FILLS_BLOCKED", result.gate_failures)


if __name__ == "__main__":
    unittest.main()
