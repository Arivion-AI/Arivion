"""P1 — historical L2/trade ingestion + source-agnostic verified tier.

P1.1: the pure archive normalizer maps archive-shaped depth-500 snapshots + trades into rows
shaped exactly like the l2_snapshots/trades hypertables, tagged with distinct data_versions, with
deterministic checksums and an honest cadence.

P1.2: verify_execution_tier is source-agnostic — a fill_model whose L2 came from a historical
archive earns L2/QUEUE VERIFIED identically to a realtime-recorded one. The gate keys off whether
the engine CONSUMED the data + coverage, never the source. Also proves the new l2_source/
l2_cadence_ms fields are byte-identical-absent by default (P1.1 honesty without changing defaults).
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_INGESTOR = str(Path(__file__).resolve().parents[2] / "apps" / "data-ingestor")
if _INGESTOR not in sys.path:
    sys.path.insert(0, _INGESTOR)

from ingestor import archive  # noqa: E402

from quant_core.execution import (  # noqa: E402
    Fidelity, FillModelStats, build_fill_model, verify_execution_tier, MODE_QUEUE,
)


class ArchiveNormalizerTests(unittest.TestCase):
    def test_orderbook_snapshot_normalization(self) -> None:
        recs = [
            {"type": "snapshot", "ts": 1_700_000_000_000,
             "data": {"s": "BTCUSDT", "b": [["100.5", "2"], ["100.0", "3"], ["0", "0"]],
                      "a": [["101.0", "1"], ["101.5", "4"]], "u": 42}},
        ]
        rows = archive.normalize_archive_orderbook(recs, symbol="btcusdt", category="linear", depth=500)
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["symbol"], "BTCUSDT")
        self.assertEqual(r["sequence_id"], 42)
        self.assertEqual(r["data_version"], archive.DV_BYBIT_ARCHIVE_OB500)
        # bids sorted desc, asks asc, zero-size level dropped, best bid/ask captured.
        self.assertEqual(r["bid_levels_json"], [["100.5", "2"], ["100.0", "3"]])
        self.assertEqual(r["ask_levels_json"], [["101.0", "1"], ["101.5", "4"]])
        self.assertEqual(r["best_bid"], "100.5")
        self.assertEqual(r["best_ask"], "101.0")
        self.assertTrue(r["checksum"])  # deterministic, present for coverage accounting

    def test_checksum_is_deterministic_and_content_sensitive(self) -> None:
        rec = [{"type": "snapshot", "ts": 1, "data": {"s": "X", "b": [["1", "1"]], "a": [["2", "1"]]}}]
        a = archive.normalize_archive_orderbook(rec, symbol="X", category="linear")
        b = archive.normalize_archive_orderbook(rec, symbol="X", category="linear")
        self.assertEqual(a[0]["checksum"], b[0]["checksum"])
        rec2 = [{"type": "snapshot", "ts": 1, "data": {"s": "X", "b": [["1", "9"]], "a": [["2", "1"]]}}]
        c = archive.normalize_archive_orderbook(rec2, symbol="X", category="linear")
        self.assertNotEqual(a[0]["checksum"], c[0]["checksum"])

    def test_trade_normalization_and_dedup(self) -> None:
        recs = [
            {"T": 1_700_000_000_000, "s": "BTCUSDT", "S": "Buy", "p": "100.0", "v": "1", "i": "t1"},
            {"T": 1_700_000_000_000, "s": "BTCUSDT", "S": "Buy", "p": "100.0", "v": "1", "i": "t1"},  # dup
            {"timestamp": 1_700_000_000.5, "side": "sell", "price": "101", "size": "2", "trdMatchID": "t2"},
        ]
        rows = archive.normalize_archive_trades(recs, symbol="BTCUSDT", category="linear")
        self.assertEqual(len(rows), 2)  # dedup by trade_id
        self.assertEqual(rows[0]["trade_id"], "t1")
        self.assertEqual(rows[0]["data_version"], archive.DV_BYBIT_ARCHIVE_TRADE)
        self.assertEqual(rows[1]["side"], "Sell")
        self.assertEqual(rows[1]["trade_time_ms"], 1_700_000_000_500)  # seconds → ms

    def test_cadence_inference(self) -> None:
        rows = [{"ts_ms": 0}, {"ts_ms": 1000}, {"ts_ms": 2000}, {"ts_ms": 3000}]
        self.assertEqual(archive.infer_cadence_ms(rows), 1000)
        self.assertIsNone(archive.infer_cadence_ms(rows[:1]))


class SourceAgnosticVerifiedTierTests(unittest.TestCase):
    def _queue_stats(self, source: str | None, cadence: int | None) -> FillModelStats:
        return FillModelStats(
            maker_fills=3, l2_provider_used=True, trade_prints_used=True,
            snapshot_coverage_pct=1.0, trade_coverage_pct=1.0,
            l2_source=source, l2_cadence_ms=cadence,
        )

    def test_default_fill_model_is_byte_identical(self) -> None:
        """No l2_source set → the provenance keys are ABSENT, so the default fill_model is
        byte-identical to before P1.1 added the fields."""
        fm = build_fill_model(Fidelity.BAR_BASED, FillModelStats())
        self.assertNotIn("l2_source", fm)
        self.assertNotIn("l2_cadence_ms", fm)
        self.assertNotIn("spread_cost_modeled", fm)

    def test_historical_backfill_earns_same_tier_as_realtime(self) -> None:
        realtime = build_fill_model(Fidelity.L2_QUEUE, self._queue_stats(archive.SRC_REALTIME, None))
        archived = build_fill_model(Fidelity.L2_QUEUE, self._queue_stats(archive.SRC_BYBIT_ARCHIVE, 1000))
        # Both consumed L2+trades at full coverage → both QUEUE VERIFIED. The gate ignores source.
        self.assertEqual(realtime["mode"], MODE_QUEUE)
        self.assertEqual(archived["mode"], MODE_QUEUE)
        dr = verify_execution_tier(realtime)
        da = verify_execution_tier(archived)
        self.assertTrue(dr.l2_verified and dr.queue_verified)
        self.assertTrue(da.l2_verified and da.queue_verified, da.reasons)
        # Identical verdict regardless of source.
        self.assertEqual((dr.l2_verified, dr.queue_verified), (da.l2_verified, da.queue_verified))

    def test_provenance_recorded_when_archive(self) -> None:
        archived = build_fill_model(Fidelity.L2_QUEUE, self._queue_stats(archive.SRC_BYBIT_ARCHIVE, 1000))
        self.assertEqual(archived["l2_source"], archive.SRC_BYBIT_ARCHIVE)
        self.assertEqual(archived["l2_cadence_ms"], 1000)
        self.assertTrue(archived["spread_cost_modeled"])  # L2 fidelity charges the spread


if __name__ == "__main__":
    unittest.main()
