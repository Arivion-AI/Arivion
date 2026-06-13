"""Performance metrics suite — Sharpe, Sortino, Calmar, win rate, profit factor,
expectancy, max consecutive losses, equity/drawdown curves.

Inputs are sequences of equity snapshots (Decimal/float) and per-trade PnLs.
All annualizations use √N for vol, ×N for mean (§10.3).

Determinism (§21): money/fill math upstream is Decimal and byte-exact. The curve-derived
scalars here are float. To keep them provably order-independent (so the value cannot drift
under a future refactor that reorders or parallelizes a reduction, and so two runs on
different hardware agree), every float sum uses :func:`math.fsum` (exact-rounding regardless
of summation order) rather than the naive left-to-right ``sum``. These scalars are NOT part
of any run hash (``run_hash``/``event_digest`` cover events/fills only); the verifier compares
them with an absolute tolerance of :data:`METRIC_ABS_TOLERANCE`, while events/fills stay
byte-exact.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal
from typing import Sequence

from .metrics import robust_sharpe, SHARPE_MIN_OBS, SHARPE_MIN_ACTIVE_FRAC, SHARPE_CLAMP

# Absolute tolerance for comparing curve-derived float metrics across runs/hardware (§21).
# Events and fills are byte-exact; only these reduced scalars are tolerance-compared.
METRIC_ABS_TOLERANCE = 1e-9

# P3.1 — Sharpe/Sortino annualized by √(bars_per_year) assume iid returns. At sub-hourly bars the
# iid assumption is badly violated (autocorrelated returns) and the ratios are inflated + noisy.
# We do NOT silently report a misleading number: above this bars/year (i.e. finer than hourly) the
# ratios are flagged low-confidence with a machine reason code. The value is still computed and
# returned byte-identically — only annotated.
HOURLY_BARS_PER_YEAR = 24 * 365  # 8760


def _f(x) -> float:
    return float(x) if not isinstance(x, float) else x


@dataclass
class PerformanceReport:
    total_return: float
    cagr: float | None
    sharpe: float
    sortino: float
    calmar: float
    max_drawdown: float
    max_drawdown_duration_bars: int
    volatility_annualized: float
    win_rate: float
    loss_rate: float
    avg_win: float
    avg_loss: float
    profit_factor: float
    expectancy: float
    max_consecutive_losses: int
    max_consecutive_wins: int
    n_trades: int
    equity_curve: list[float]
    drawdown_curve: list[float]
    # P3.1 reliability annotation (informational; does not alter any metric value).
    metric_reliability: dict | None = None


def compute_performance(
    equity_curve: Sequence,
    trade_pnls: Sequence,
    *,
    bars_per_year: float = 35040,  # 15m default
    years: float | None = None,
) -> PerformanceReport:
    eq = [_f(x) for x in equity_curve]
    pnls = [_f(x) for x in trade_pnls]

    if not eq:
        return PerformanceReport(0, None, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [], [])

    start, end = eq[0] if eq[0] != 0 else 1.0, eq[-1]
    total_return = (end - start) / abs(start) if start != 0 else 0.0

    # Bar-over-bar returns from equity curve
    returns = []
    for i in range(1, len(eq)):
        prev = eq[i - 1] if eq[i - 1] != 0 else 1.0
        returns.append((eq[i] - eq[i - 1]) / abs(prev))

    if returns:
        mean_r = math.fsum(returns) / len(returns)
        var_r = math.fsum((r - mean_r) ** 2 for r in returns) / len(returns)
        std_r = math.sqrt(var_r)
        annualized_mean = mean_r * bars_per_year
        annualized_vol = std_r * math.sqrt(bars_per_year)
        # Clean Sharpe: robust to tiny samples / flat curves (no absurd magnitudes).
        sharpe = robust_sharpe(returns, bars_per_year)
        # Sortino uses the same robustness guards as Sharpe (sample size, active curve, clamp).
        n_ret = len(returns)
        active = sum(1 for r in returns if abs(r) > 1e-9)
        valid = n_ret >= SHARPE_MIN_OBS and active / n_ret >= SHARPE_MIN_ACTIVE_FRAC
        downside = [r for r in returns if r < 0]
        if valid and downside:
            dd_var = math.fsum(r * r for r in downside) / len(downside)
            dd_std_ann = math.sqrt(dd_var) * math.sqrt(bars_per_year)
            sortino = max(-SHARPE_CLAMP, min(SHARPE_CLAMP, annualized_mean / dd_std_ann)) if dd_std_ann > 0 else 0.0
            sortino = round(sortino, 4)
        else:
            sortino = 0.0
    else:
        sharpe = sortino = annualized_vol = 0.0

    # Drawdown
    peak = eq[0]
    max_dd = 0.0
    dd_curve = []
    cur_dd_dur = 0
    max_dd_dur = 0
    for v in eq:
        if v > peak:
            peak = v
            cur_dd_dur = 0
        else:
            cur_dd_dur += 1
        max_dd_dur = max(max_dd_dur, cur_dd_dur)
        d = (peak - v) / peak if peak > 0 else 0.0
        max_dd = max(max_dd, d)
        dd_curve.append(d)

    calmar = (total_return / max_dd) if max_dd > 0 else 0.0
    if years and years > 0 and total_return > -1.0:
        cagr = (1 + total_return) ** (1 / years) - 1
    else:
        cagr = None

    # Trade stats
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    n = len(pnls)
    win_rate = len(wins) / n if n > 0 else 0.0
    loss_rate = len(losses) / n if n > 0 else 0.0
    avg_win = math.fsum(wins) / len(wins) if wins else 0.0
    avg_loss = math.fsum(losses) / len(losses) if losses else 0.0
    sum_losses = math.fsum(losses)
    profit_factor = (math.fsum(wins) / -sum_losses) if losses and -sum_losses > 0 else 0.0
    expectancy = (win_rate * avg_win) + (loss_rate * avg_loss)

    max_w = max_l = cur_w = cur_l = 0
    for p in pnls:
        if p > 0:
            cur_w += 1; cur_l = 0
            max_w = max(max_w, cur_w)
        elif p < 0:
            cur_l += 1; cur_w = 0
            max_l = max(max_l, cur_l)
        else:
            cur_w = cur_l = 0

    subhourly = bars_per_year > HOURLY_BARS_PER_YEAR
    metric_reliability = {
        "bars_per_year": bars_per_year,
        "sharpe_confidence": "low" if subhourly else "normal",
        "sortino_confidence": "low" if subhourly else "normal",
        "reason": "SUBHOURLY_RETURNS_IID_VIOLATION" if subhourly else None,
        "note": ("Annualizing sub-hourly returns by sqrt(bars_per_year) over autocorrelated "
                 "returns violates iid; treat Sharpe/Sortino as low-confidence.") if subhourly else None,
    }

    return PerformanceReport(
        total_return=total_return, cagr=cagr,
        sharpe=sharpe, sortino=sortino, calmar=calmar,
        max_drawdown=max_dd, max_drawdown_duration_bars=max_dd_dur,
        volatility_annualized=annualized_vol if returns else 0.0,
        win_rate=win_rate, loss_rate=loss_rate,
        avg_win=avg_win, avg_loss=avg_loss,
        profit_factor=profit_factor, expectancy=expectancy,
        max_consecutive_losses=max_l, max_consecutive_wins=max_w,
        n_trades=n,
        equity_curve=eq, drawdown_curve=dd_curve,
        metric_reliability=metric_reliability,
    )
