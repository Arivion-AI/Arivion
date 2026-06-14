from __future__ import annotations

import math
import unittest

from quant_core.optimizer_grid import (
    cartesian_grid, generate_candidates, merge_with_base, random_samples, sobol_samples,
)
from quant_core.regime_library import REGIMES, regime_by_id, regimes_by_expected, regimes_by_symbol


class CartesianGridTests(unittest.TestCase):
    def test_basic_cross_product(self) -> None:
        space = {"a": {"values": [1, 2]}, "b": {"values": ["x", "y", "z"]}}
        cands = cartesian_grid(space)
        self.assertEqual(len(cands), 6)
        self.assertEqual({(c["a"], c["b"]) for c in cands},
                         {(1, "x"), (1, "y"), (1, "z"), (2, "x"), (2, "y"), (2, "z")})

    def test_numeric_step_range(self) -> None:
        cands = cartesian_grid({"qty": {"min": 0.01, "max": 0.05, "step": 0.01}})
        self.assertEqual(len(cands), 5)
        self.assertAlmostEqual(cands[0]["qty"], 0.01)
        self.assertAlmostEqual(cands[-1]["qty"], 0.05)

    def test_log_spaced_n(self) -> None:
        cands = cartesian_grid({"gamma": {"min": 1e-6, "max": 1e-3, "n": 4, "log": True}})
        values = [c["gamma"] for c in cands]
        self.assertEqual(len(values), 4)
        self.assertAlmostEqual(values[0], 1e-6)
        self.assertAlmostEqual(values[-1], 1e-3)
        # Log spacing means each value is the same ratio above the previous.
        ratios = [values[i + 1] / values[i] for i in range(len(values) - 1)]
        for r in ratios[1:]:
            self.assertAlmostEqual(r, ratios[0], places=4)


class RandomSamplesTests(unittest.TestCase):
    def test_seeded_random_reproducible(self) -> None:
        space = {"x": {"min": 0, "max": 1}}
        a = random_samples(space, n_samples=20, seed=42)
        b = random_samples(space, n_samples=20, seed=42)
        self.assertEqual(a, b)

    def test_random_respects_bounds(self) -> None:
        space = {"x": {"min": 10, "max": 20}}
        samples = random_samples(space, n_samples=200, seed=1)
        xs = [s["x"] for s in samples]
        self.assertGreaterEqual(min(xs), 10)
        self.assertLessEqual(max(xs), 20)


class SobolSamplesTests(unittest.TestCase):
    def test_better_coverage_than_random(self) -> None:
        # Sobol should produce better-distributed samples than uniform random for small N.
        space = {"x": {"min": 0, "max": 1}, "y": {"min": 0, "max": 1}}
        s_samples = [(s["x"], s["y"]) for s in sobol_samples(space, n_samples=16)]
        # Just sanity-check: not all the same, and stays within bounds.
        self.assertEqual(len(set(s_samples)), 16)
        for x, y in s_samples:
            self.assertTrue(0 <= x <= 1 and 0 <= y <= 1)


class GenerateCandidatesTests(unittest.TestCase):
    def test_max_candidates_cap(self) -> None:
        space = {"a": {"min": 0, "max": 100, "step": 1}}  # would be 101 candidates
        cands = generate_candidates(space, method="grid", max_candidates=50)
        self.assertEqual(len(cands), 50)

    def test_merge_with_base(self) -> None:
        base = {"order_qty": "0.01", "leverage": 1, "fee_bps": 5.5}
        override = {"leverage": 3}
        merged = merge_with_base(base, override)
        self.assertEqual(merged, {"order_qty": "0.01", "leverage": 3, "fee_bps": 5.5})


class RegimeLibraryTests(unittest.TestCase):
    def test_at_least_5_btc_regimes(self) -> None:
        btc = regimes_by_symbol("BTCUSDT")
        self.assertGreaterEqual(len(btc), 5)

    def test_lookup_by_id(self) -> None:
        r = regime_by_id("btc_2021_bull")
        self.assertIsNotNone(r)
        self.assertEqual(r.symbol, "BTCUSDT")
        self.assertEqual(r.expected_regime, "bull")

    def test_regime_id_collisions(self) -> None:
        ids = [r.regime_id for r in REGIMES]
        self.assertEqual(len(ids), len(set(ids)), "regime_ids must be unique")

    def test_range_is_positive(self) -> None:
        for r in REGIMES:
            self.assertGreater(r.end_ms, r.start_ms, f"{r.regime_id} has start >= end")

    def test_filter_by_expected(self) -> None:
        bears = regimes_by_expected("bear")
        self.assertGreaterEqual(len(bears), 2)
        for r in bears:
            self.assertEqual(r.expected_regime, "bear")


if __name__ == "__main__":
    unittest.main()
