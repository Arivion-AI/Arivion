"""Golden tests for quant_core.lp_math — Uniswap v3 concentrated-liquidity position math."""
import unittest
from decimal import Decimal as D

from quant_core import lp_math as m

Q96 = D(2) ** 96


class TestImpermanentLoss(unittest.TestCase):
    def test_full_range_il_no_move(self):
        self.assertEqual(m.impermanent_loss_full_range(D("1")), D("0"))

    def test_full_range_il_4x(self):
        # classic result: 4x price move -> -20% vs HODL
        self.assertAlmostEqual(float(m.impermanent_loss_full_range(D("4"))), -0.2, places=6)

    def test_full_range_il_symmetric(self):
        # 0.25x and 4x give the same IL
        self.assertAlmostEqual(
            float(m.impermanent_loss_full_range(D("0.25"))),
            float(m.impermanent_loss_full_range(D("4"))),
            places=9,
        )

    def test_il_is_nonpositive(self):
        for r in ("0.5", "0.8", "1.2", "2", "10"):
            self.assertLessEqual(m.impermanent_loss_full_range(D(r)), D("0"))


class TestPrice(unittest.TestCase):
    def test_price0_in_token1_weth_usdc(self):
        # price ~3000 USDC/WETH, token0=WETH(18), token1=USDC(6)
        sqrt_p = (D("3e-9")).sqrt() * Q96
        self.assertAlmostEqual(float(m.price0_in_token1(sqrt_p, 18, 6)), 3000.0, delta=1.0)


class TestRange(unittest.TestCase):
    def test_in_range(self):
        self.assertTrue(m.is_in_range(0, -100, 100))
        self.assertFalse(m.is_in_range(200, -100, 100))
        self.assertFalse(m.is_in_range(-100, -100, 100) is False and not m.is_in_range(-100, -100, 100))
        # lower bound inclusive, upper exclusive
        self.assertTrue(m.is_in_range(-100, -100, 100))
        self.assertFalse(m.is_in_range(100, -100, 100))


class TestAmounts(unittest.TestCase):
    def test_all_token0_below_range(self):
        # price below range -> 100% token0, 0 token1
        sqrt_p = m.sqrt_ratio_x96_from_tick(-100000)
        a0, a1 = m.position_amounts(sqrt_p, -1000, 1000, D("1e15"))
        self.assertGreater(a0, 0)
        self.assertEqual(a1, D("0"))

    def test_all_token1_above_range(self):
        sqrt_p = m.sqrt_ratio_x96_from_tick(100000)
        a0, a1 = m.position_amounts(sqrt_p, -1000, 1000, D("1e15"))
        self.assertEqual(a0, D("0"))
        self.assertGreater(a1, 0)

    def test_both_in_range(self):
        sqrt_p = m.sqrt_ratio_x96_from_tick(0)
        a0, a1 = m.position_amounts(sqrt_p, -1000, 1000, D("1e15"))
        self.assertGreater(a0, 0)
        self.assertGreater(a1, 0)

    def test_value_balanced_at_mid(self):
        # wide symmetric range at price 3000 -> ~50/50 by value
        sqrt_p = (D("3e-9")).sqrt() * Q96
        pv = m.position_value_usd(
            sqrt_price_x96=sqrt_p, current_tick=0, tick_lower=-887220, tick_upper=887220,
            liquidity=D("1e15"), decimals0=18, decimals1=6, price0_usd=D("3000"), price1_usd=D("1"),
        )
        self.assertTrue(pv.in_range)
        self.assertGreater(pv.value_usd, 0)
        v0 = pv.amount0 * D("3000")
        v1 = pv.amount1 * D("1")
        # near-balanced (within 5%)
        self.assertLess(abs(v0 - v1) / pv.value_usd, D("0.05"))


if __name__ == "__main__":
    unittest.main()
