"""Golden tests for xStocks (tokenized equity) integration + Cross-Asset Allocator."""
from __future__ import annotations

import math
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from quant_core import xstocks as xs
from quant_core.bot_os import build_bot, compute_cockpit, run_bot, validate_bot_spec
from quant_core.bot_os.models import BotSpec
from quant_core.orders import Bar


def _bars(n, p0, drift, seed, t0):
    out = []
    p = p0
    for i in range(n):
        p = p * (1 + drift) + math.sin((i + seed) / 6) * p * 0.004
        out.append(Bar(
            ts=t0 + timedelta(hours=i),
            open=Decimal(str(round(p, 2))), high=Decimal(str(round(p * 1.003, 2))),
            low=Decimal(str(round(p * 0.997, 2))), close=Decimal(str(round(p * 1.001, 2))),
            volume=Decimal("100"),
        ))
    return out


_RISK = {"max_position_fraction": "1.0", "max_total_exposure_fraction": "5.0",
         "max_daily_loss_fraction": "0.9", "max_drawdown_kill_fraction": "0.9"}
_WEEKDAY = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)   # Monday, 10:00 ET (RTH)
_SATURDAY = datetime(2026, 6, 6, 14, 0, tzinfo=timezone.utc)  # Saturday (off-hours)


class CatalogTests(unittest.TestCase):
    def test_catalog_nonempty_and_symbols(self):
        self.assertGreaterEqual(len(xs.all_xstocks()), 8)
        self.assertTrue(xs.is_xstock("AAPLXUSDT"))
        self.assertTrue(xs.is_xstock("NVDAX"))
        self.assertFalse(xs.is_xstock("BTCUSDT"))

    def test_asset_class(self):
        self.assertEqual(xs.asset_class_of("NVDAXUSDT"), "equity")
        self.assertEqual(xs.asset_class_of("BTCUSDT"), "crypto")

    def test_multiplier_conversion(self):
        x = xs.xstock_by_symbol("AAPLXUSDT")
        # default multiplier 1 -> token price == share price
        self.assertEqual(x.stock_price("312.21"), Decimal("312.21"))
        self.assertEqual(x.token_qty("2"), Decimal("2"))

    def test_payload_shape(self):
        p = xs.catalog_payload()
        self.assertIn("xstocks", p)
        self.assertEqual(p["quote"], "USDT")
        self.assertFalse(p["constraints"]["short_selling"])


class MarketHoursTests(unittest.TestCase):
    def test_rth_weekday(self):
        self.assertTrue(xs.is_regular_trading_hours(_WEEKDAY))

    def test_off_hours_weekend(self):
        self.assertFalse(xs.is_regular_trading_hours(_SATURDAY))

    def test_spread_multiplier(self):
        self.assertEqual(xs.off_hours_spread_multiplier(_WEEKDAY), Decimal("1"))
        self.assertGreater(xs.off_hours_spread_multiplier(_SATURDAY), Decimal("1"))

    def test_position_cap(self):
        self.assertTrue(xs.position_cap_breached("400000"))
        self.assertFalse(xs.position_cap_breached("100000"))


class AllocatorValidationTests(unittest.TestCase):
    def test_static_valid(self):
        params = {"mode": "static", "total_investment": "100000", "symbols": [
            {"symbol": "BTCUSDT", "asset_class": "crypto", "side": "long", "target_weight_fraction": "0.5"},
            {"symbol": "NVDAXUSDT", "asset_class": "equity", "side": "long", "target_weight_fraction": "0.5"},
        ]}
        spec = BotSpec("cross_asset_allocator", "x", ["BTCUSDT", "NVDAXUSDT"], params)
        rep = validate_bot_spec(spec)
        self.assertTrue(rep["valid"], rep["errors"])
        self.assertIn("XSTOCK_SPOT_24_7", rep["eligibility_labels"])

    def test_short_equity_blocked(self):
        params = {"mode": "static", "symbols": [
            {"symbol": "NVDAXUSDT", "asset_class": "equity", "side": "short", "target_weight_fraction": "1.0", "leverage": 3},
        ]}
        spec = BotSpec("cross_asset_allocator", "bad", ["NVDAXUSDT"], params)
        rep = validate_bot_spec(spec)
        self.assertFalse(rep["valid"])
        self.assertTrue(any("XSTOCK_SHORT_NOT_ALLOWED" in e for e in rep["errors"]))
        self.assertTrue(any("XSTOCK_LEVERAGE_NOT_ALLOWED" in e for e in rep["errors"]))

    def test_cockpit_hard_blocks_short_leverage(self):
        params = {"mode": "static", "total_investment": "100000", "symbols": [
            {"symbol": "NVDAXUSDT", "asset_class": "equity", "side": "short", "target_weight_fraction": "1.0", "leverage": 5},
        ]}
        spec = BotSpec("cross_asset_allocator", "bad", ["NVDAXUSDT"], params)
        ck = compute_cockpit(spec)
        self.assertTrue(ck.modules["xstock_constraints"]["applicable"])
        self.assertTrue(any("XSTOCK_SHORT_NOT_ALLOWED" in b for b in ck.hard_blocks))

    def test_cockpit_position_cap_warning(self):
        params = {"mode": "static", "total_investment": "1000000", "symbols": [
            {"symbol": "NVDAXUSDT", "asset_class": "equity", "side": "long", "target_weight_fraction": "1.0"},
        ]}
        spec = BotSpec("cross_asset_allocator", "big", ["NVDAXUSDT"], params)
        ck = compute_cockpit(spec)
        self.assertTrue(ck.modules["xstock_constraints"]["position_cap_warnings"])


class AllocatorRunTests(unittest.TestCase):
    def test_crypto_leg_fills(self):
        btc = _bars(48, 65000, 0.001, 0, _WEEKDAY)
        params = {"mode": "static", "total_investment": "100000", "symbols": [
            {"symbol": "BTCUSDT", "asset_class": "crypto", "side": "long", "target_weight_fraction": "1.0"},
        ]}
        bot = build_bot("cross_asset_allocator", params)
        rep, _ = run_bot(spec=BotSpec("cross_asset_allocator", "x", ["BTCUSDT"], params), bot=bot,
                         symbol="BTCUSDT", bars=btc, funding_rows=[], starting_equity=Decimal("100000"), risk=_RISK)
        self.assertGreaterEqual(len(rep.fills), 1)

    def test_equity_paused_off_hours(self):
        nvda = _bars(24, 1200, 0.0, 4, _SATURDAY)
        params = {"mode": "static", "total_investment": "100000", "pause_equity_off_hours": True, "symbols": [
            {"symbol": "NVDAXUSDT", "asset_class": "equity", "side": "long", "target_weight_fraction": "1.0"},
        ]}
        bot = build_bot("cross_asset_allocator", params)
        rep, _ = run_bot(spec=BotSpec("cross_asset_allocator", "x", ["NVDAXUSDT"], params), bot=bot,
                         symbol="NVDAXUSDT", bars=nvda, funding_rows=[], starting_equity=Decimal("100000"), risk=_RISK)
        self.assertEqual(len(rep.fills), 0)
        self.assertTrue(any("XSTOCK_SKIPPED_OFF_HOURS" in n for n in rep.risk_notes))

    def test_equity_fills_during_rth(self):
        nvda = _bars(24, 1200, 0.0, 4, _WEEKDAY)
        params = {"mode": "static", "total_investment": "100000", "pause_equity_off_hours": True, "symbols": [
            {"symbol": "NVDAXUSDT", "asset_class": "equity", "side": "long", "target_weight_fraction": "1.0"},
        ]}
        bot = build_bot("cross_asset_allocator", params)
        rep, _ = run_bot(spec=BotSpec("cross_asset_allocator", "x", ["NVDAXUSDT"], params), bot=bot,
                         symbol="NVDAXUSDT", bars=nvda, funding_rows=[], starting_equity=Decimal("100000"), risk=_RISK)
        self.assertGreaterEqual(len(rep.fills), 1)

    def test_momentum_mode_runs(self):
        btc = _bars(60, 65000, 0.002, 0, _WEEKDAY)
        params = {"mode": "momentum", "total_investment": "100000", "lookback_bars": 10, "top_n": 1, "symbols": [
            {"symbol": "BTCUSDT", "asset_class": "crypto", "side": "long", "target_weight_fraction": "1.0"},
        ]}
        bot = build_bot("cross_asset_allocator", params)
        rep, _ = run_bot(spec=BotSpec("cross_asset_allocator", "x", ["BTCUSDT"], params), bot=bot,
                         symbol="BTCUSDT", bars=btc, funding_rows=[], starting_equity=Decimal("100000"), risk=_RISK)
        self.assertGreaterEqual(len(rep.fills), 1)


if __name__ == "__main__":
    unittest.main()
