"""Golden tests for the Bybit-exactness venue layer (duality_final.md WS-A..WS-F).

All values are hand-computed from the spec's exact formulas. These pin venue mechanics so a
strategy paper-traded in the lab matches Bybit live to the tick.
"""
from __future__ import annotations

import unittest
from decimal import Decimal

from quant_core.bybit_venue import (
    InstrumentFilter, conform_order, round_price_to_tick, round_qty_to_step,
    resolve_fee_bps, FEE_SCHEDULE,
    RiskTier, risk_tier_from_pct, risk_tier_from_fraction, risk_tiers_from_snapshot,
    select_tier, initial_margin, maintenance_margin,
    liquidation_price, bankruptcy_price, liq_triggered, cross_account_liquidation,
    clamp_funding_rate, post_only_would_cross, clamp_reduce_only,
)

D = Decimal


# Tier-1 BTCUSDT-like ladder (Bybit risk-limit): risk_limit 2,000,000; MMR 0.5%; IMR 1%; max lev 100x.
BTC_TIER1 = risk_tier_from_pct(1, "2000000", "0.5", "1.0", "100", "0", is_lowest_risk=True)
BTC_TIER2 = risk_tier_from_pct(2, "4000000", "1.0", "1.5", "50", "10000")

BTCUSDT = InstrumentFilter(
    symbol="BTCUSDT", category="linear",
    tick_size=D("0.10"), qty_step=D("0.001"), min_order_qty=D("0.001"),
    min_notional=D("5"), min_leverage=D("1"), max_leverage=D("100"),
    price_limit_ratio_x=D("0.05"),
)


# ----------------------------------------------------------------- WS-A filters
class FilterTests(unittest.TestCase):
    def test_buy_price_rounds_down_sell_rounds_up(self):
        self.assertEqual(round_price_to_tick(D("65000.17"), D("0.10"), "buy"), D("65000.10"))
        self.assertEqual(round_price_to_tick(D("65000.11"), D("0.10"), "sell"), D("65000.20"))

    def test_qty_floors_to_step(self):
        self.assertEqual(round_qty_to_step(D("0.0019"), D("0.001")), D("0.001"))

    def test_grid_line_off_tick_snaps(self):
        r = conform_order(side="buy", price=D("65000.17"), qty=D("0.005"), instr=BTCUSDT)
        self.assertTrue(r.ok)
        self.assertEqual(r.price, D("65000.10"))
        self.assertIn("PRICE_SNAPPED_TO_TICK", r.adjustments)

    def test_min_qty_rejected(self):
        r = conform_order(side="buy", price=D("65000"), qty=D("0.0005"), instr=BTCUSDT)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "MIN_QTY")

    def test_min_notional_rejected(self):
        instr = InstrumentFilter(symbol="X", category="spot", tick_size=D("0.01"),
                                 qty_step=D("0.001"), min_order_qty=D("0.001"), min_notional=D("10"))
        # 0.001 * 1000 = 1.0 < 10
        r = conform_order(side="buy", price=D("1000"), qty=D("0.001"), instr=instr)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "MIN_NOTIONAL")

    def test_price_band_rejects_far_limit(self):
        # mark 65000, band ±5% => [61750, 68250]; a 70000 buy limit is outside.
        r = conform_order(side="buy", price=D("70000"), qty=D("0.01"),
                          instr=BTCUSDT, mark_price=D("65000"))
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "PRICE_BAND")

    def test_price_band_inside_ok(self):
        r = conform_order(side="buy", price=D("64000"), qty=D("0.01"),
                          instr=BTCUSDT, mark_price=D("65000"))
        self.assertTrue(r.ok)

    def test_leverage_clamped(self):
        r = conform_order(side="buy", price=D("65000"), qty=D("0.01"),
                          instr=BTCUSDT, leverage=D("250"))
        self.assertTrue(r.ok)
        self.assertEqual(r.leverage, D("100"))
        self.assertIn("LEVERAGE_CLAMPED", r.adjustments)


# ----------------------------------------------------------------- WS-B fees
class FeeTests(unittest.TestCase):
    def test_nonvip_linear(self):
        self.assertEqual(resolve_fee_bps("linear", is_maker=True), D("2.0"))
        self.assertEqual(resolve_fee_bps("linear", is_maker=False), D("5.5"))

    def test_pro_maker_rebate_negative(self):
        self.assertLess(resolve_fee_bps("linear", is_maker=True, vip_tier="PRO3"), D(0))

    def test_unknown_tier_falls_back_nonvip(self):
        self.assertEqual(resolve_fee_bps("linear", is_maker=True, vip_tier="DOES_NOT_EXIST"),
                         FEE_SCHEDULE["linear"]["NONVIP"]["maker"])

    def test_spot_higher_than_linear(self):
        self.assertGreater(resolve_fee_bps("spot", is_maker=False),
                           resolve_fee_bps("linear", is_maker=False))


# ----------------------------------------------------------- WS-C liquidation
class LiquidationTests(unittest.TestCase):
    """25x BTCUSDT long, entry 65000, qty 0.1 BTC (PV_entry = 6500 USDT, tier-1).
       IM = PV_entry / lev = 6500/25 = 260.
       MM = PV_mark·MMR − ded + fee_to_close. At mark=entry, PV_mark=6500;
            MMR=0.005 => 32.5 ; ded=0 ; fee_to_close = 6500 * 5.5/10000 = 3.575
            => MM = 32.5 + 3.575 = 36.075
       LP_long = entry − (IM − MM)/|qty|         (extra=0)
               = 65000 − (260 − 36.075)/0.1
               = 65000 − 223.925/0.1 = 65000 − 2239.25 = 62760.75
       bankruptcy = entry − IM/|qty| = 65000 − 260/0.1 = 65000 − 2600 = 62400
    """
    qty = D("0.1"); entry = D("65000"); lev = D("25")

    def test_tier_selection(self):
        # PV_entry 6500 <= 2,000,000 -> tier 1
        self.assertEqual(select_tier([BTC_TIER1, BTC_TIER2], D("6500")).tier_id, 1)
        # huge position bumps to tier 2
        self.assertEqual(select_tier([BTC_TIER1, BTC_TIER2], D("3000000")).tier_id, 2)

    def test_initial_margin(self):
        im = initial_margin(self.qty, self.entry, BTC_TIER1, leverage=self.lev)
        self.assertEqual(im, D("260"))

    def test_maintenance_margin(self):
        mm = maintenance_margin(self.qty, self.entry, BTC_TIER1, entry=self.entry,
                                taker_fee_bps=D("5.5"))
        self.assertEqual(mm, D("36.075"))

    def test_liquidation_price_long(self):
        im = initial_margin(self.qty, self.entry, BTC_TIER1, leverage=self.lev)
        mm = maintenance_margin(self.qty, self.entry, BTC_TIER1, entry=self.entry, taker_fee_bps=D("5.5"))
        lp = liquidation_price("long", self.entry, self.qty, im, mm)
        self.assertEqual(lp, D("62760.75"))

    def test_bankruptcy_price_long(self):
        im = initial_margin(self.qty, self.entry, BTC_TIER1, leverage=self.lev)
        self.assertEqual(bankruptcy_price("long", self.entry, im, self.qty), D("62400"))

    def test_lp_above_bankruptcy_for_long(self):
        im = initial_margin(self.qty, self.entry, BTC_TIER1, leverage=self.lev)
        mm = maintenance_margin(self.qty, self.entry, BTC_TIER1, entry=self.entry, taker_fee_bps=D("5.5"))
        lp = liquidation_price("long", self.entry, self.qty, im, mm)
        bp = bankruptcy_price("long", self.entry, im, self.qty)
        self.assertGreater(lp, bp)   # you liquidate before going bankrupt

    def test_short_liq_above_entry(self):
        im = initial_margin(self.qty, self.entry, BTC_TIER1, leverage=self.lev)
        mm = maintenance_margin(self.qty, self.entry, BTC_TIER1, entry=self.entry, taker_fee_bps=D("5.5"))
        lp = liquidation_price("short", self.entry, self.qty, im, mm)
        self.assertEqual(lp, D("67239.25"))   # 65000 + 2239.25

    def test_liq_trigger_on_mark_series(self):
        lp = D("62760.75")
        self.assertTrue(liq_triggered("long", lp, mark_high=D("64000"), mark_low=D("62000")))
        self.assertFalse(liq_triggered("long", lp, mark_high=D("65500"), mark_low=D("63000")))

    def test_cross_account_liquidation(self):
        self.assertTrue(cross_account_liquidation(D("100"), D("100")))
        self.assertTrue(cross_account_liquidation(D("99"), D("100")))
        self.assertFalse(cross_account_liquidation(D("101"), D("100")))

    def test_mmr_unit_trap_is_fraction(self):
        # 0.5 percent must be stored as 0.005, NOT 0.5
        self.assertEqual(BTC_TIER1.mmr, D("0.005"))

    def test_real_bybit_market_units_are_fractions(self):
        # Cross-validated against live /v5/market/risk-limit (2026-05): the public market
        # endpoint returns maintenanceMargin/initialMargin as FRACTIONS already. The snapshot
        # mapper must NOT divide by 100 — the resulting mmr must equal the raw 0.005.
        snapshot = [
            {"risk_id": 1, "notional_cap": "2000000", "mmr_fraction": "0.005",
             "initial_margin_fraction": "0.01", "max_leverage": "100.00"},
            {"risk_id": 2, "notional_cap": "2600000", "mmr_fraction": "0.0056",
             "initial_margin_fraction": "0.0111", "max_leverage": "90.00"},
        ]
        tiers = risk_tiers_from_snapshot(snapshot)
        self.assertEqual(tiers[0].mmr, D("0.005"))      # NOT 0.00005
        self.assertEqual(tiers[0].imr, D("0.01"))
        self.assertTrue(tiers[0].is_lowest_risk)
        self.assertEqual(tiers[1].mmr, D("0.0056"))
        # And the from_fraction constructor must agree with the hand-built tier-1.
        t1 = risk_tier_from_fraction(1, "2000000", "0.005", "0.01", "100")
        self.assertEqual(t1.mmr, BTC_TIER1.mmr)
        self.assertEqual(t1.imr, BTC_TIER1.imr)

    def test_mm_deduction_recurrence_matches_live(self):
        # When mmDeduction is absent, compute it: MM_ded(2) = cap1*(MMR2-MMR1)+0
        #   = 2,000,000*(0.0056-0.005) = 1200 -> EXACTLY Bybit's published tier-2 mmDeduction.
        snap_no_ded = [
            {"risk_id": 1, "notional_cap": "2000000", "mmr_fraction": "0.005",
             "initial_margin_fraction": "0.01", "max_leverage": "100.00"},
            {"risk_id": 2, "notional_cap": "2600000", "mmr_fraction": "0.0056",
             "initial_margin_fraction": "0.0111", "max_leverage": "90.00"},
        ]
        tiers = risk_tiers_from_snapshot(snap_no_ded)
        self.assertEqual(tiers[0].mm_deduction, D("0"))
        self.assertEqual(tiers[1].mm_deduction, D("1200"))
        # When the API DOES supply mmDeduction, it is trusted verbatim.
        snap_ded = [dict(snap_no_ded[0], mm_deduction="0"),
                    dict(snap_no_ded[1], mm_deduction="1200")]
        self.assertEqual(risk_tiers_from_snapshot(snap_ded)[1].mm_deduction, D("1200"))


# ----------------------------------------------------------------- WS-D funding
class FundingTests(unittest.TestCase):
    def test_clamp_within(self):
        self.assertEqual(clamp_funding_rate(D("0.0001"), D("-0.005"), D("0.005")), D("0.0001"))

    def test_clamp_upper(self):
        self.assertEqual(clamp_funding_rate(D("0.01"), D("-0.005"), D("0.005")), D("0.005"))

    def test_clamp_lower(self):
        self.assertEqual(clamp_funding_rate(D("-0.01"), D("-0.005"), D("0.005")), D("-0.005"))


# ----------------------------------------------------------------- WS-F semantics
class OrderSemanticsTests(unittest.TestCase):
    def test_postonly_buy_crossing_rejected(self):
        # best ask 65000; a PostOnly buy at 65001 would take -> reject
        self.assertTrue(post_only_would_cross("buy", D("65001"), best_bid=D("64999"), best_ask=D("65000")))

    def test_postonly_buy_passive_ok(self):
        self.assertFalse(post_only_would_cross("buy", D("64998"), best_bid=D("64999"), best_ask=D("65000")))

    def test_postonly_sell_crossing_rejected(self):
        self.assertTrue(post_only_would_cross("sell", D("64999"), best_bid=D("64999"), best_ask=D("65000")))

    def test_reduce_only_clamps_to_position(self):
        # long 0.1; a reduceOnly sell of 0.3 can only close 0.1
        self.assertEqual(clamp_reduce_only("sell", D("0.3"), "long", D("0.1")), D("0.1"))

    def test_reduce_only_cannot_increase(self):
        # long 0.1; a reduceOnly BUY would increase -> 0 allowed
        self.assertEqual(clamp_reduce_only("buy", D("0.3"), "long", D("0.1")), D("0"))

    def test_reduce_only_flat_position_noop(self):
        self.assertEqual(clamp_reduce_only("sell", D("0.3"), "flat", D("0")), D("0"))


# --------------------------------------------- WS-A/WS-B integration via PaperRuntime
class PaperRuntimeVenueTests(unittest.TestCase):
    """The venue layer must be a true no-op unless opted in, and must actually conform /
    re-fee when opted in. Drives it through the real PaperRuntime."""

    def _setup(self, instrument_filter=None, vip_tier=None, category=None):
        from datetime import datetime, timezone, timedelta
        from quant_core.orders import Bar
        from quant_core.portfolio import Portfolio, RiskConfig
        from quant_core.paper_runtime import PaperRuntime
        from quant_core.strategies import GridTrader

        def dt(i):
            return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=15 * i)
        bars = [Bar(ts=dt(i), open=D("100"), high=D("100.5"), low=D("99.5"),
                    close=D("100"), volume=D("1000")) for i in range(8)]
        port = Portfolio(starting_equity=D("100000"),
                         risk=RiskConfig(max_position_fraction=D("1.0"), max_total_exposure_fraction=D("1.0")))
        strat = GridTrader({"grid_levels": 3, "grid_spacing_bps": 50, "order_qty": "0.01"})
        rt = PaperRuntime(symbol="BTCUSDT", portfolio=port, strategy=strat,
                          fee_bps_taker=D("5.5"), fee_bps_maker=D("1.0"),
                          instrument_filter=instrument_filter, vip_tier=vip_tier, category=category)
        return rt, bars

    def test_vip_tier_overrides_fees(self):
        rt, _ = self._setup(vip_tier="PRO3", category="linear")
        self.assertEqual(rt.fee_bps_maker, FEE_SCHEDULE["linear"]["PRO3"]["maker"])  # rebate
        self.assertLess(rt.fee_bps_maker, D(0))

    def test_no_vip_tier_keeps_explicit_fees(self):
        rt, _ = self._setup()
        self.assertEqual(rt.fee_bps_maker, D("1.0"))
        self.assertEqual(rt.fee_bps_taker, D("5.5"))

    def test_filter_rejects_subminimum_qty(self):
        # min_order_qty 1.0 forces every 0.01 grid order to be REJECTED with MIN_QTY
        strict = InstrumentFilter(symbol="BTCUSDT", category="linear", tick_size=D("0.1"),
                                  qty_step=D("0.001"), min_order_qty=D("1.0"))
        rt, bars = self._setup(instrument_filter=strict)
        result = rt.run(bars=bars)
        rejects = [e for e in result.events if e.type == "REJECTED"]
        self.assertTrue(rejects)
        self.assertTrue(all(e.payload.get("reason") == "MIN_QTY" for e in rejects))
        self.assertEqual(len(result.fills), 0)

    def test_no_filter_is_noop(self):
        rt, bars = self._setup()
        result = rt.run(bars=bars)
        self.assertEqual([e for e in result.events if e.type == "REJECTED"], [])


if __name__ == "__main__":
    unittest.main()
