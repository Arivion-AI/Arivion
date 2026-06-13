"""Golden tests for quant_core.amm_execution — constant-product AMM quote/fill model."""
import unittest
from decimal import Decimal as D

from quant_core.amm_execution import quote_constant_product, quote_mid_only


class TestConstantProduct(unittest.TestCase):
    def test_weth_usdc_quote(self):
        # 1 WETH into a 1000 WETH / 3,000,000 USDC pool (mid 3000), 0.3% fee
        q = quote_constant_product(amount_in=D("1"), reserve_in=D("1000"), reserve_out=D("3000000"), fee_bps=D("30"))
        # ~2988 USDC out (3000 - 0.3% fee - ~40bps impact)
        self.assertTrue(D("2985") < q.expected_out < D("2992"))
        self.assertEqual(q.result_tier, "DEX MODELED")
        self.assertFalse(q.truth()["can_execute_real_money"])

    def test_min_out_below_expected(self):
        q = quote_constant_product(amount_in=D("1"), reserve_in=D("1000"), reserve_out=D("3000000"), slippage_bps=D("50"))
        self.assertLess(q.min_out, q.expected_out)

    def test_large_trade_warns(self):
        # 50 WETH = 5% of reserve -> reserve warning + high impact
        q = quote_constant_product(amount_in=D("50"), reserve_in=D("1000"), reserve_out=D("3000000"))
        self.assertIn("TRADE_EXCEEDS_1_PERCENT_POOL_RESERVE", q.warnings)
        self.assertGreater(q.price_impact_bps, D("100"))

    def test_rejects_bad_inputs(self):
        with self.assertRaises(ValueError):
            quote_constant_product(amount_in=D("0"), reserve_in=D("1000"), reserve_out=D("3000000"))
        with self.assertRaises(ValueError):
            quote_constant_product(amount_in=D("1"), reserve_in=D("0"), reserve_out=D("3000000"))


class TestMidOnly(unittest.TestCase):
    def test_mid_only_optimistic(self):
        q = quote_mid_only(amount_in=D("1"), mid_price=D("3000"))
        self.assertEqual(q.result_tier, "LOCAL ONLY")
        self.assertEqual(q.price_impact_bps, D("0"))
        self.assertIn("NO_POOL_SNAPSHOT", q.warnings)
        # 3000 - 0.3% fee = 2991
        self.assertAlmostEqual(float(q.expected_out), 2991.0, delta=0.5)


if __name__ == "__main__":
    unittest.main()
