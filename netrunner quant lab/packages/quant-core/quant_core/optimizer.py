from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ParityThresholds:
    allowed_return_drift: float = 0.005
    allowed_drawdown_drift: float = 0.01
    allowed_trade_count_drift: int = 2


@dataclass(frozen=True)
class CandidateMetrics:
    total_return: float
    max_drawdown: float
    trade_count: int


@dataclass(frozen=True)
class ParityResult:
    return_drift: float
    drawdown_drift: float
    trade_count_drift: int
    within_threshold: bool


def compute_parity(vector_metrics: CandidateMetrics, event_metrics: CandidateMetrics, thresholds: ParityThresholds) -> ParityResult:
    return_drift = abs(event_metrics.total_return - vector_metrics.total_return)
    drawdown_drift = abs(event_metrics.max_drawdown - vector_metrics.max_drawdown)
    trade_count_drift = abs(event_metrics.trade_count - vector_metrics.trade_count)

    within_threshold = (
        return_drift <= thresholds.allowed_return_drift
        and drawdown_drift <= thresholds.allowed_drawdown_drift
        and trade_count_drift <= thresholds.allowed_trade_count_drift
    )

    return ParityResult(
        return_drift=return_drift,
        drawdown_drift=drawdown_drift,
        trade_count_drift=trade_count_drift,
        within_threshold=within_threshold,
    )
