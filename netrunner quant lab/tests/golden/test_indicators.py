from __future__ import annotations

import unittest
from decimal import Decimal

from quant_core.indicators import EMA, SMA, RSI, ATR, BollingerBands, MACD, ZScore, Donchian, VWAP, Keltner, returns


class IndicatorTests(unittest.TestCase):
    def test_sma_emits_after_window(self) -> None:
        s = SMA(3)
        self.assertIsNone(s.update(1))
        self.assertIsNone(s.update(2))
        self.assertEqual(s.update(3), Decimal(2))
        self.assertEqual(s.update(6), Decimal(11) / Decimal(3))

    def test_ema_converges(self) -> None:
        e = EMA(5)
        for _ in range(20):
            v = e.update(100)
        self.assertEqual(v.quantize(Decimal("0.0001")), Decimal("100.0000"))

    def test_rsi_extremes(self) -> None:
        r = RSI(5)
        for v in [10, 11, 12, 13, 14, 15, 16]:
            out = r.update(v)
        # Pure uptrend -> RSI saturates near 100
        self.assertGreaterEqual(out, Decimal(95))

    def test_atr_handles_no_prev_close(self) -> None:
        a = ATR(3)
        out = a.update(10, 8, 9)  # first bar
        self.assertIsNone(out)
        a.update(11, 9, 10)
        v = a.update(12, 10, 11)
        self.assertIsNotNone(v)
        self.assertGreater(v, Decimal(0))

    def test_bollinger_returns_3_bands(self) -> None:
        b = BollingerBands(5, Decimal("2"))
        for v in [10, 12, 14, 11, 13]:
            out = b.update(v)
        lower, mid, upper = out
        self.assertLess(lower, mid)
        self.assertLess(mid, upper)

    def test_macd_returns_three_components(self) -> None:
        m = MACD(3, 6, 3)
        out = None
        for v in range(1, 30):
            out = m.update(v)
        self.assertIsNotNone(out)
        macd, sig, hist = out
        self.assertGreater(macd, Decimal(0))

    def test_zscore_zero_for_constant_series(self) -> None:
        z = ZScore(5)
        for _ in range(5):
            out = z.update(100)
        self.assertEqual(out, Decimal(0))

    def test_donchian_tracks_min_max(self) -> None:
        d = Donchian(3)
        d.update(10, 5); d.update(11, 6)
        lo, hi = d.update(12, 7)
        self.assertEqual(lo, Decimal(5))
        self.assertEqual(hi, Decimal(12))

    def test_vwap_weights_by_volume(self) -> None:
        v = VWAP()
        v.update(100, 1); v.update(110, 9)
        self.assertEqual(v.update(0, 0).quantize(Decimal("0.01")), Decimal("109.00"))

    def test_keltner_bands(self) -> None:
        k = Keltner(5, Decimal("2"))
        out = None
        for i in range(10):
            out = k.update(100 + i, 100 - i, 100 + i / 2)
        self.assertIsNotNone(out)
        lo, mid, hi = out
        self.assertLess(lo, mid)
        self.assertLess(mid, hi)

    def test_returns_helper(self) -> None:
        rs = returns([100, 110, 99])
        self.assertEqual(len(rs), 2)
        self.assertEqual(rs[0], Decimal("0.1"))


if __name__ == "__main__":
    unittest.main()
