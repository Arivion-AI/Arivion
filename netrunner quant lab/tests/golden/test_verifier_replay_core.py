"""P0.2 — the verifier must re-run the SAME engine that produced the result.

Exercises the pure verifier replay core (no DB): a representative bot is run via the worker's
exact PaperRuntime path, persisted-shaped into a run record, and replayed through
``replay_bot_run``. The recomputed events/``event_digest`` and metrics must match the original
**byte-for-byte** (events) / within tolerance (metrics). Also asserts engine selection routes bots
to PaperRuntime and simple runs to EventBacktestEngine, and that runs needing DB-backed inputs
(L2 / venue-exact / latency) are honestly deferred with a machine reason code rather than
silently replayed on a different path.
"""
from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

_VERIFIER = str(Path(__file__).resolve().parents[2] / "apps" / "verifier")
if _VERIFIER not in sys.path:
    sys.path.insert(0, _VERIFIER)

import replay_core as rc  # noqa: E402

from quant_core.bot_os import BotSpec, build_bot, run_bot, spec_hash as v4_spec_hash  # noqa: E402
from quant_core.engine import FundingRow  # noqa: E402
from quant_core.orders import Bar  # noqa: E402

BASE_MS = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
INTERVAL_MIN = 15


def _bar_rows(n: int = 120) -> list[dict]:
    rows = []
    px = 100.0
    for i in range(n):
        px += 0.7 if (i // 8) % 2 == 0 else -0.5
        p = round(px, 2)
        rows.append({
            "ts": BASE_MS + i * INTERVAL_MIN * 60_000,
            "open": str(p), "high": str(p + 0.8), "low": str(p - 0.8),
            "close": str(p), "volume": "40",
        })
    return rows


TWAP_PARAMS = {"symbol": "BTCUSDT", "side": "buy", "total_qty": "1.0",
               "slice_count": 10, "order_style": "market"}


def _bot_config(bot_type: str = "twap", params: dict | None = None) -> dict:
    """A run record's config_json (= the persisted BotRunPayload.model_dump()) for a bar_based bot."""
    return {
        "spec": {"bot_type": bot_type, "name": "t", "symbols": ["BTCUSDT"],
                 "params": params if params is not None else dict(TWAP_PARAMS), "risk": {}, "accounting": {}},
        "symbol": "BTCUSDT",
        "bars": _bar_rows(),
        "funding_rows": [],
        "side_bars": {},
        "starting_equity": "10000",
        "risk": {},
        "fee_bps_taker": "5.5", "fee_bps_maker": "1.0", "slippage_bps_one_way": "2.0",
        "interval_minutes": INTERVAL_MIN,
        "execution_fidelity": "bar_based",
        "venue_exact": False,
        "enable_latency_model": False,
    }


def _produce_run(config: dict):
    """Reproduce the worker's bots_run engine path to get the ORIGINAL events + event_digest,
    exactly as bots_run/_stable_json_hash would have persisted them."""
    spec = BotSpec(bot_type=config["spec"]["bot_type"], name="t", symbols=["BTCUSDT"],
                   params=config["spec"]["params"], risk={}, accounting={})
    bot = build_bot(spec.bot_type, spec.params)
    bars = [Bar(ts=datetime.fromtimestamp(b["ts"] / 1000, tz=timezone.utc),
                open=Decimal(b["open"]), high=Decimal(b["high"]), low=Decimal(b["low"]),
                close=Decimal(b["close"]), volume=Decimal(b["volume"])) for b in config["bars"]]
    report, _ = run_bot(spec=spec, bot=bot, symbol="BTCUSDT", bars=bars, funding_rows=[],
                        starting_equity=Decimal("10000"), risk={},
                        spec_hash_value=v4_spec_hash(spec), compiler_version=rc._compiler_version())
    return report


class VerifierReplayCoreTests(unittest.TestCase):
    def test_engine_selection(self) -> None:
        self.assertEqual(rc.select_engine({"run_kind": "bot_backtest"}, None), rc.ENGINE_PAPER_RUNTIME_BOT)
        self.assertEqual(rc.select_engine({"run_kind": "bot_paper"}, None), rc.ENGINE_PAPER_RUNTIME_BOT)
        self.assertEqual(rc.select_engine({"replay_mode": "paper_runtime_event_replay"}, None),
                         rc.ENGINE_PAPER_RUNTIME_BOT)
        self.assertEqual(rc.select_engine(None, "spec-123"), rc.ENGINE_PAPER_RUNTIME_BOT)
        # Simple single-signal run -> EventBacktestEngine (the original, byte-identical path).
        self.assertEqual(rc.select_engine({}, None), rc.ENGINE_EVENT_BACKTEST)
        self.assertEqual(rc.select_engine(None, None), rc.ENGINE_EVENT_BACKTEST)

    def test_bot_replay_reproduces_events_byte_for_byte(self) -> None:
        config = _bot_config("twap")
        # _produce_run consumes the process-global order-ID counter; replay_bot_run consumes more.
        # This is exactly the worker-vs-verifier cross-process situation.
        original = _produce_run(config)
        original_canon = rc.canonical_events_digest(original.events)

        replay = rc.replay_bot_run(config)
        self.assertTrue(replay.ok, f"bar_based bot must replay in the pure core; got {replay.reason}")

        # The CANONICAL digest reproduces byte-for-byte across processes (the robust verification).
        self.assertEqual(replay.canonical_event_digest, original_canon)
        self.assertEqual(rc._canonicalize_order_ids(replay.events),
                         rc._canonicalize_order_ids(original.events))
        self.assertEqual(replay.final_equity, str(original.final_equity))
        # And the events are semantically identical modulo the (process-global) raw order IDs:
        self.assertEqual(len(replay.events), len(original.events))
        self.assertEqual([e["type"] for e in replay.events], [e["type"] for e in original.events])

    def test_raw_digest_is_process_local_canonical_is_stable(self) -> None:
        """Documents the pitfall the canonical digest fixes: raw event_digest depends on the
        global order-ID counter (so worker and verifier disagree), but the canonical digest does
        not. Both runs here are the identical bot; only the counter state differs between them."""
        config = _bot_config("twap")
        r1 = rc.replay_bot_run(config)   # consumes counter
        r2 = rc.replay_bot_run(config)   # consumes more counter -> different raw IDs
        self.assertNotEqual(r1.event_digest, r2.event_digest)            # raw drifts (process-local)
        self.assertEqual(r1.canonical_event_digest, r2.canonical_event_digest)  # canonical is stable

    def test_compare_replay_accepts_match_rejects_tamper(self) -> None:
        config = _bot_config("twap")
        replay = rc.replay_bot_run(config)
        stored_metrics = {"total_return_after_fees_funding": replay.metrics["total_return_after_fees_funding"]}
        ok = rc.compare_replay(stored_event_digest=replay.event_digest,
                               recomputed_event_digest=replay.event_digest,
                               stored_metrics=stored_metrics, recomputed_metrics=replay.metrics)
        self.assertTrue(ok.events_match and ok.metrics_match, ok.reasons)
        # A tampered stored digest must be rejected (events compared byte-exact).
        bad = rc.compare_replay(stored_event_digest="deadbeef",
                                recomputed_event_digest=replay.event_digest,
                                stored_metrics=stored_metrics, recomputed_metrics=replay.metrics)
        self.assertFalse(bad.events_match)
        self.assertIn("EVENT_DIGEST_MISMATCH", bad.reasons)
        # A metric drift beyond tolerance must be rejected.
        drift = rc.compare_replay(stored_event_digest=replay.event_digest,
                                  recomputed_event_digest=replay.event_digest,
                                  stored_metrics={"total_return_after_fees_funding": 999.0},
                                  recomputed_metrics=replay.metrics)
        self.assertFalse(drift.metrics_match)

    def test_db_backed_runs_are_deferred_not_silently_bar_based(self) -> None:
        # L2 fidelity -> needs recorded provider (DB).
        l2 = _bot_config("twap"); l2["execution_fidelity"] = "l2_queue"
        r = rc.replay_bot_run(l2)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, rc.REASON_NEEDS_DB_PROVIDER)
        # venue_exact -> needs instrument/risk snapshots (DB).
        ve = _bot_config("twap"); ve["venue_exact"] = True
        self.assertEqual(rc.replay_bot_run(ve).reason, rc.REASON_NEEDS_DB_PROVIDER)
        # latency enabled -> config not captured in run record.
        lat = _bot_config("twap"); lat["enable_latency_model"] = True
        self.assertEqual(rc.replay_bot_run(lat).reason, rc.REASON_LATENCY_NOT_CAPTURED)
        # unknown bot type -> machine reason code, not a crash or false pass.
        bad = _bot_config("not_a_real_bot")
        self.assertEqual(rc.replay_bot_run(bad).reason, rc.REASON_UNKNOWN_BOT_TYPE)


if __name__ == "__main__":
    unittest.main()
