from __future__ import annotations

import math
from collections.abc import Sequence
from decimal import Decimal, getcontext

getcontext().prec = 28

# Clean-Sharpe guards. A mostly-flat / sparsely-traded equity curve has a near-zero return stdev, so
# the raw annualized Sharpe (mean/std × √bars_per_year) explodes to absurd magnitudes (e.g. -876).
# robust_sharpe keeps it honest: enough observations, the curve actually moves, and a hard clamp.
SHARPE_MIN_OBS = 10        # need at least this many bar returns to annualize
SHARPE_MIN_ACTIVE_FRAC = 0.1  # at least 10% of bars must actually move (else the curve is idle/flat)
SHARPE_CLAMP = 20.0        # real Sharpes live well inside this; beyond it is a small-sample artifact


def robust_sharpe(returns: Sequence[float], bars_per_year: float,
                  *, min_obs: int = SHARPE_MIN_OBS, clamp: float = SHARPE_CLAMP) -> float:
    """Annualized Sharpe that never returns a degenerate value.

    Returns 0.0 when the sample is too small or the equity curve is essentially flat (a near-zero
    denominator would otherwise inflate the ratio); clamps the result to ±clamp; rounds for display.
    Use this everywhere a Sharpe is surfaced so the number is always interpretable.
    """
    rets = [float(r) for r in returns if r is not None]
    n = len(rets)
    if n < min_obs or bars_per_year <= 0:
        return 0.0
    active = sum(1 for r in rets if abs(r) > 1e-9)
    if active < min_obs or active / n < SHARPE_MIN_ACTIVE_FRAC:
        return 0.0
    mean = math.fsum(rets) / n
    var = math.fsum((r - mean) ** 2 for r in rets) / (n - 1)
    sd = math.sqrt(var)
    if sd <= 1e-9:
        return 0.0
    s = (mean / sd) * math.sqrt(bars_per_year)
    if not math.isfinite(s):
        return 0.0
    return round(max(-clamp, min(clamp, s)), 4)


def sharpe_annualized(mean_bar_excess: Decimal, std_bar: Decimal, interval_minutes: int) -> Decimal:
    if std_bar == 0:
        raise ValueError("std_bar cannot be zero for Sharpe calculation")

    bars_per_year = (Decimal(365) * Decimal(24) * Decimal(60)) / Decimal(interval_minutes)
    annualized_mean_excess = mean_bar_excess * bars_per_year
    annualized_vol = std_bar * bars_per_year.sqrt()
    return annualized_mean_excess / annualized_vol
