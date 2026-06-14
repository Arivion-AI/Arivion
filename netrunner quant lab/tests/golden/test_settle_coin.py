"""WS-E: settle-coin ledgers + cross-margin equity. Per the plan's DoD."""
from __future__ import annotations

import unittest
from decimal import Decimal

from quant_core.settle_coin import SettleCoinLedger, IsolatedLeg, DEFAULT_COLLATERAL_RATIO

D = Decimal


class SettleCoinTests(unittest.TestCase):
    def test_usdc_loss_hits_usdc_not_usdt(self):
        led = SettleCoinLedger()
        led.deposit("USDT", D("10000"))
        led.deposit("USDC", D("5000"))
        led.settle("USDC", D("-800"))         # a USDC-perp loss
        self.assertEqual(led.balance("USDT"), D("10000"))   # untouched
        self.assertEqual(led.balance("USDC"), D("4200"))

    def test_cross_equity_reflects_both_coins(self):
        led = SettleCoinLedger()
        led.deposit("USDT", D("10000"))
        led.deposit("USDC", D("5000"))
        # +200 unrealized on the USDT book, -100 on the USDC book; stables at 1.0
        eq = led.cross_equity_usd(unrealized_by_coin={"USDT": D("200"), "USDC": D("-100")})
        self.assertEqual(eq, D("15100"))      # 15000 wallet + 200 - 100

    def test_collateral_haircut_default_usdt_par(self):
        self.assertEqual(DEFAULT_COLLATERAL_RATIO["USDT"], D("1.0"))
        led = SettleCoinLedger()
        led.deposit("USDT", D("1000"))
        self.assertEqual(led.wallet_usd(), D("1000"))       # no-op haircut

    def test_collateral_haircut_applied_when_set(self):
        led = SettleCoinLedger(collateral_ratio={"USDT": D("1.0"), "BTC": D("0.9")})
        led.deposit("BTC", D("1"))
        # 1 BTC * 0.9 ratio * 65000 price = 58500
        self.assertEqual(led.wallet_usd({"BTC": D("65000")}), D("58500"))

    def test_isolated_leg_liquidation_does_not_touch_shared(self):
        led = SettleCoinLedger()
        led.deposit("USDT", D("10000"))
        iso = IsolatedLeg(settle_coin="USDT", posted_margin=D("500"))
        loss = iso.liquidation_loss(D("3000"))   # blow-up larger than posted margin
        self.assertEqual(loss, D("500"))         # capped at posted margin
        self.assertEqual(led.balance("USDT"), D("10000"))   # shared balance untouched


if __name__ == "__main__":
    unittest.main()
