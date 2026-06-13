"""Phase 8: Bybit venue-exactness composed with bot-run execution fidelity."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from quant_core.bot_os.base import BotRuntime
from quant_core.bot_os.executor import run_bot
from quant_core.bot_os.models import BotContext, BotDecision, BotSpec, OrderIntent
from quant_core.bybit_venue import InstrumentFilter, risk_tiers_from_snapshot
from quant_core.execution import Fidelity
from quant_core.l2_replay import L2Snapshot, L2SweepProvider, snapshot_lookup_from_list
from quant_core.orders import Bar

D = Decimal


def dt(i: int) -> datetime:
    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=i)


def bars(prices: list[str]) -> list[Bar]:
    return [
        Bar(ts=dt(i), open=D(p), high=D(p) + D("1"), low=D(p) - D("1"), close=D(p), volume=D("1000"))
        for i, p in enumerate(prices)
    ]


def instr(**kw) -> InstrumentFilter:
    return InstrumentFilter(
        symbol="BTCUSDT",
        category="linear",
        tick_size=kw.get("tick_size", D("0.1")),
        qty_step=kw.get("qty_step", D("0.001")),
        min_order_qty=kw.get("min_order_qty", D("0.001")),
        min_notional=kw.get("min_notional", D("0")),
        max_leverage=D("100"),
    )


def sweep_provider() -> L2SweepProvider:
    snaps = [
        L2Snapshot.from_levels(
            int(dt(i).timestamp() * 1000),
            [(D("99"), D("100"))],
            [(D("101"), D("100"))],
            sequence_id=i,
        )
        for i in range(5)
    ]
    return L2SweepProvider(snapshot_lookup_from_list(snaps))


class _OnceBot(BotRuntime):
    bot_type = "chase_limit"

    def __init__(self, order: OrderIntent):
        self.order = order

    def on_start(self, ctx: BotContext) -> BotDecision:
        return BotDecision(place=[self.order])


class _OpenThenFundingBot(BotRuntime):
    bot_type = "chase_limit"

    def on_start(self, ctx: BotContext) -> BotDecision:
        return BotDecision(place=[OrderIntent("BTCUSDT", "buy", D("1"), "market")])


class BotRunVenueFidelityTests(unittest.TestCase):
    def _run(self, order: OrderIntent, *, venue=True, instrument=None, provider=None):
        return run_bot(
            spec=BotSpec("chase_limit", "venue", ["BTCUSDT"], {}),
            bot=_OnceBot(order),
            symbol="BTCUSDT",
            bars=bars(["100", "100", "100"]),
            funding_rows=[],
            risk={"max_position_fraction": "5", "max_total_exposure_fraction": "5"},
            execution_provider=provider or sweep_provider(),
            requested_fidelity=Fidelity.L2_SWEEP,
            instrument_filter=instrument if venue else None,
            category="linear" if venue else None,
            enforce_order_semantics=venue,
        )

    def test_venue_off_keeps_unsnapped_price_on_l2_path(self):
        order = OrderIntent("BTCUSDT", "buy", D("1"), "limit", limit_price=D("99.97"))
        report, _ = self._run(order, venue=False)
        created = [e for e in report.events if e["type"] == "ORDER_CREATED"][0]
        self.assertEqual(created["payload"]["limit"], "99.97")

    def test_venue_on_snaps_limit_to_tick_before_l2_fill(self):
        order = OrderIntent("BTCUSDT", "buy", D("1"), "limit", limit_price=D("99.97"))
        report, _ = self._run(order, instrument=instr())
        created = [e for e in report.events if e["type"] == "ORDER_CREATED"][0]
        self.assertEqual(D(created["payload"]["limit"]), D("99.9"))
        self.assertEqual(D(report.fills[0]["price"]), D("99.9"))

    def test_min_notional_rejection_fires_on_bot_l2_path(self):
        order = OrderIntent("BTCUSDT", "buy", D("0.01"), "limit", limit_price=D("99"))
        report, _ = self._run(order, instrument=instr(min_notional=D("10")))
        rejects = [e for e in report.events if e["type"] == "REJECTED"]
        self.assertEqual(rejects[0]["payload"]["reason"], "MIN_NOTIONAL")

    def test_postonly_crossing_rejected_on_bot_l2_path(self):
        order = OrderIntent("BTCUSDT", "buy", D("1"), "limit", limit_price=D("101"), post_only=True)
        report, _ = self._run(order, instrument=instr())
        rejects = [e for e in report.events if e["type"] == "REJECTED"]
        self.assertEqual(rejects[0]["payload"]["reason"], "POST_ONLY_WOULD_CROSS")

    def test_fok_unfilled_cancels_on_bot_l2_path(self):
        order = OrderIntent("BTCUSDT", "buy", D("1"), "limit", limit_price=D("50"), tif="fok")
        report, _ = self._run(order, instrument=instr())
        cancels = [e for e in report.events if e["type"] == "CANCELLED"]
        self.assertEqual(cancels[0]["payload"]["reason"], "FOK_UNFILLED")

    def test_funding_caps_apply_in_bot_run(self):
        from quant_core.engine import FundingRow

        report, _ = run_bot(
            spec=BotSpec("chase_limit", "funding", ["BTCUSDT"], {}),
            bot=_OpenThenFundingBot(),
            symbol="BTCUSDT",
            bars=bars(["100", "100", "100"]),
            funding_rows=[FundingRow(id="f1", timestamp=dt(1), funding_rate=D("0.10"))],
            risk={"max_position_fraction": "5", "max_total_exposure_fraction": "5"},
            funding_caps=(D("-0.01"), D("0.01")),
            category="linear",
        )
        settlements = [e for e in report.events if e["type"] == "FUNDING_SETTLEMENT"]
        self.assertEqual(settlements[0]["payload"]["rate"], "0.01")

    def test_mark_tiered_liquidation_can_run_from_bot_executor(self):
        tiers = risk_tiers_from_snapshot([
            {"risk_id": 1, "notional_cap": "2000000", "mmr_fraction": "0.005",
             "initial_margin_fraction": "0.01", "max_leverage": "100.00"},
        ])
        report, _ = run_bot(
            spec=BotSpec("chase_limit", "liq", ["BTCUSDT"], {}),
            bot=_OpenThenFundingBot(),
            symbol="BTCUSDT",
            bars=[
                Bar(ts=dt(0), open=D("65000"), high=D("65000"), low=D("65000"), close=D("65000"), volume=D("100")),
                Bar(ts=dt(1), open=D("64000"), high=D("64000"), low=D("64000"), close=D("64000"), volume=D("100")),
                Bar(ts=dt(2), open=D("62000"), high=D("62000"), low=D("60000"), close=D("61000"), volume=D("100")),
            ],
            funding_rows=[],
            risk={"max_position_fraction": "10", "max_total_exposure_fraction": "10"},
            risk_tiers=tiers,
            leverage=D("25"),
            category="linear",
        )
        liquidations = [e for e in report.events if e["type"] == "LIQUIDATION"]
        self.assertEqual(liquidations[0]["payload"]["liquidation_model"], "mark_price_tiered")


if __name__ == "__main__":
    unittest.main()
