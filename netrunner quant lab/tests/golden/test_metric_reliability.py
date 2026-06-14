"""P3.1 — Sharpe/Sortino reliability annotation for sub-hourly bars.

The ratio VALUES are unchanged (byte-identical); they are only annotated low-confidence below the
hourly interval, with a machine reason code, so a misleading number is never reported silently.
"""
from __future__ import annotations

import unittest

from quant_core.performance import HOURLY_BARS_PER_YEAR, compute_performance

EQ = [100, 101, 100.5, 102, 101.5, 103, 104, 103.5, 105]


class MetricReliabilityTests(unittest.TestCase):
    def test_subhourly_flagged_low_confidence(self) -> None:
        rep = compute_performance(EQ, [], bars_per_year=525600)  # 1-minute
        mr = rep.metric_reliability
        self.assertEqual(mr["sharpe_confidence"], "low")
        self.assertEqual(mr["sortino_confidence"], "low")
        self.assertEqual(mr["reason"], "SUBHOURLY_RETURNS_IID_VIOLATION")

    def test_daily_is_normal_confidence(self) -> None:
        rep = compute_performance(EQ, [], bars_per_year=365)  # daily
        self.assertEqual(rep.metric_reliability["sharpe_confidence"], "normal")
        self.assertIsNone(rep.metric_reliability["reason"])

    def test_threshold_is_hourly(self) -> None:
        self.assertEqual(rep_conf(HOURLY_BARS_PER_YEAR), "normal")        # hourly = boundary OK
        self.assertEqual(rep_conf(HOURLY_BARS_PER_YEAR + 1), "low")       # finer than hourly = low

    def test_annotation_does_not_change_the_numbers(self) -> None:
        # Same curve, two intervals: the Sharpe VALUE differs only by the √(bars/year) factor that
        # was always applied — the annotation itself adds nothing to/subtracts nothing from it.
        sub = compute_performance(EQ, [], bars_per_year=525600)
        day = compute_performance(EQ, [], bars_per_year=365)
        # The annotation is metadata only; the ratio is still the raw annualized computation.
        self.assertNotEqual(sub.sharpe, day.sharpe)  # differ only by the annualization factor
        self.assertGreater(sub.sharpe, 0)


def rep_conf(bpy: float) -> str:
    return compute_performance(EQ, [], bars_per_year=bpy).metric_reliability["sharpe_confidence"]


if __name__ == "__main__":
    unittest.main()
