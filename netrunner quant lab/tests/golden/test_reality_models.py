"""P2/P3.2 — reality-model interfaces + opt-in BorrowModel. Default instances are byte-identical
(zero cost); the opt-in model charges a deterministic short-borrow cost."""
from __future__ import annotations

import unittest
from decimal import Decimal

from quant_core.reality_models import (
    BorrowModel, ConstantBorrowModel, NoBorrowModel,
)


class BorrowModelTests(unittest.TestCase):
    def test_default_no_borrow_is_zero(self) -> None:
        m = NoBorrowModel()
        self.assertIsInstance(m, BorrowModel)  # satisfies the Protocol
        self.assertEqual(m.borrow_cost(side="short", qty=Decimal("10"), price=Decimal("100"),
                                       bars_held=500, bars_per_year=525600), Decimal("0"))

    def test_constant_default_rate_zero_is_byte_identical(self) -> None:
        m = ConstantBorrowModel()  # annual_rate defaults to 0 -> no cost (opt-in OFF)
        self.assertEqual(m.borrow_cost(side="short", qty=Decimal("10"), price=Decimal("100"),
                                       bars_held=500, bars_per_year=525600), Decimal("0"))

    def test_short_borrow_accrues_per_bar(self) -> None:
        # 10% annual borrow on a $1000 short held 1/10 of a year -> $10.
        m = ConstantBorrowModel(annual_rate=Decimal("0.10"))
        cost = m.borrow_cost(side="short", qty=Decimal("10"), price=Decimal("100"),
                             bars_held=52560, bars_per_year=525600)
        self.assertEqual(cost, Decimal("1000") * Decimal("0.10") * (Decimal("52560") / Decimal("525600")))
        self.assertEqual(cost, Decimal("10.0"))

    def test_long_not_charged_by_default(self) -> None:
        m = ConstantBorrowModel(annual_rate=Decimal("0.10"))
        self.assertEqual(m.borrow_cost(side="long", qty=Decimal("10"), price=Decimal("100"),
                                       bars_held=52560, bars_per_year=525600), Decimal("0"))

    def test_both_sides_when_configured(self) -> None:
        m = ConstantBorrowModel(annual_rate=Decimal("0.10"), charge_side="both")
        self.assertGreater(m.borrow_cost(side="long", qty=Decimal("10"), price=Decimal("100"),
                                         bars_held=52560, bars_per_year=525600), 0)

    def test_determinism(self) -> None:
        m = ConstantBorrowModel(annual_rate=Decimal("0.073"))
        args = dict(side="short", qty=Decimal("3.5"), price=Decimal("123.45"),
                    bars_held=1234, bars_per_year=525600)
        self.assertEqual(m.borrow_cost(**args), m.borrow_cost(**args))  # pure, repeatable


if __name__ == "__main__":
    unittest.main()
