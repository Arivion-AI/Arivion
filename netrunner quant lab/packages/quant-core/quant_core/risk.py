from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RiskMetrics:
    total_return_after_fees_funding: float
    sharpe: float
    calmar: float
    max_drawdown: float
    consistency: float
    robustness: float
    live_paper_score: float
    liquidation_events: int
    data_coverage_complete: bool
    overfit_penalty: float
    approximate_fills: bool


@dataclass(frozen=True)
class RiskGateConfig:
    drawdown_cap: float = 0.30
    overfit_penalty_threshold: float = 0.20


@dataclass(frozen=True)
class RiskEvaluation:
    base_score: float
    hard_gates_passed: bool
    gate_failures: list[str]


def _percentile(values: list[float], value: float) -> float:
    if not values:
        return 50.0
    less_equal = sum(1 for v in values if v <= value)
    return 100.0 * (less_equal / len(values))


def evaluate_risk(
    target: RiskMetrics,
    cohort: list[RiskMetrics],
    gate_config: RiskGateConfig | None = None,
) -> RiskEvaluation:
    config = gate_config or RiskGateConfig()

    if not cohort:
        cohort = [target]

    returns = [row.total_return_after_fees_funding for row in cohort]
    sharpes = [row.sharpe for row in cohort]
    calmars = [row.calmar for row in cohort]
    drawdown_inverse = [max(0.0, 1.0 - row.max_drawdown) for row in cohort]
    consistency = [row.consistency for row in cohort]
    robustness = [row.robustness for row in cohort]
    live_scores = [row.live_paper_score for row in cohort]

    base_score = (
        0.20 * _percentile(returns, target.total_return_after_fees_funding)
        + 0.15 * _percentile(sharpes, target.sharpe)
        + 0.15 * _percentile(calmars, target.calmar)
        + 0.15 * _percentile(drawdown_inverse, max(0.0, 1.0 - target.max_drawdown))
        + 0.10 * _percentile(consistency, target.consistency)
        + 0.10 * _percentile(robustness, target.robustness)
        + 0.15 * _percentile(live_scores, target.live_paper_score)
    )

    gate_failures: list[str] = []
    if target.max_drawdown > config.drawdown_cap:
        gate_failures.append("MAX_DRAWDOWN_CAP")
    if target.liquidation_events != 0:
        gate_failures.append("LIQUIDATION_EVENTS_NONZERO")
    if not target.data_coverage_complete:
        gate_failures.append("DATA_COVERAGE_INCOMPLETE")
    if target.overfit_penalty > config.overfit_penalty_threshold:
        gate_failures.append("OVERFIT_THRESHOLD_EXCEEDED")
    if target.approximate_fills:
        gate_failures.append("APPROXIMATE_FILLS_BLOCKED")

    return RiskEvaluation(
        base_score=round(base_score, 6),
        hard_gates_passed=len(gate_failures) == 0,
        gate_failures=gate_failures,
    )
