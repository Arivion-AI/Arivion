"""WS-D: funding-cap clamping wired into the engine funding path. Funding still settles only
at real fundingRateTimestamp rows; extreme rates clamp to the symbol's per-symbol caps."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from quant_core.engine import apply_funding_events, FundingRow, Position

D = Decimal


def dt(i):
    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(hours=i)


class FundingCapTests(unittest.TestCase):
    def _pos(self):
        p = Position(symbol="BTCUSDT", side="long", category="linear")
        p.qty = D("1")
        p.opened_at = dt(0)
        p.closed_at = None
        return p

    def _apply(self, rate, lo=None, up=None):
        pos = self._pos()
        rows = [FundingRow(id="f1", timestamp=dt(1), funding_rate=D(str(rate)))]
        ev = apply_funding_events(pos, dt(0), dt(2), rows,
                                  mark_price_lookup=lambda s, t: D("65000"),
                                  funding_cap_lower=lo, funding_cap_upper=up)
        return pos, ev[0]

    def test_extreme_rate_clamped_to_upper(self):
        # raw 0.01 but cap 0.005 -> applied rate is 0.005 -> fee = 1*65000*0.005 = 325
        pos, ev = self._apply("0.01", lo=D("-0.005"), up=D("0.005"))
        self.assertEqual(ev.payload["rate"], "0.005")
        self.assertEqual(pos.funding_pnl_quote, D("-325"))

    def test_negative_extreme_clamped_to_lower(self):
        pos, ev = self._apply("-0.02", lo=D("-0.005"), up=D("0.005"))
        self.assertEqual(ev.payload["rate"], "-0.005")

    def test_no_caps_is_unchanged(self):
        pos, ev = self._apply("0.01")
        self.assertEqual(ev.payload["rate"], "0.01")
        self.assertEqual(pos.funding_pnl_quote, D("-650"))   # 65000*0.01

    def test_within_caps_unchanged(self):
        pos, ev = self._apply("0.0001", lo=D("-0.005"), up=D("0.005"))
        self.assertEqual(ev.payload["rate"], "0.0001")


if __name__ == "__main__":
    unittest.main()
