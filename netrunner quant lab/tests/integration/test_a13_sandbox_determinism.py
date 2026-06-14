from __future__ import annotations

from pathlib import Path
import unittest


class SandboxDeterminismConfigTests(unittest.TestCase):
    def test_sandbox_subprocess_pins_blas_threads(self) -> None:
        src = Path(__file__).resolve().parents[2] / "apps" / "sandbox-runner" / "main.py"
        text = src.read_text(encoding="utf-8")
        self.assertIn("OMP_NUM_THREADS", text)
        self.assertIn("OPENBLAS_NUM_THREADS", text)
        self.assertIn("MKL_NUM_THREADS", text)
        self.assertIn("VECLIB_MAXIMUM_THREADS", text)
        self.assertIn("NUMEXPR_NUM_THREADS", text)


if __name__ == "__main__":
    unittest.main()

