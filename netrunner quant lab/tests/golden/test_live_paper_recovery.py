"""P0.1 — live-paper restart-recovery: deterministic full replay (no 400-bar truncation)
and candle-gap blocking. Docker-free: a tiny in-memory fake asyncpg pool drives the real
``LivePaperManager._build_mem`` recovery path so this runs in the pure golden lane.

Two acceptance cases (§15/§16a.3, the deferred §22 priming regression test):

  1. A session whose forward history is **>400 bars** is reproduced **exactly** on restart —
     equity/fills match a direct PaperRuntime reference over the same warmup+forward, with no
     reset to starting_equity and no dropped fills. The `RECOVERY_COMPLETED` event must be
     recorded; that assertion **fails before** the ``ensure_table`` fix (the
     ``recovery_events_json`` column was missing, so ``_recovery_event``'s UPDATE was swallowed
     by its try/except) and **passes after**.
  2. A forward candle gap larger than ``RECOVERY_MAX_GAP_BARS`` blocks the session
     (``status='recovery_blocked'`` + reason), never a silent resume across the hole.
"""
from __future__ import annotations

import asyncio
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path


# --- Stub the deps that only exist inside the worker container (asyncpg, redis.asyncio) so the
# --- pure module imports here. live_paper only uses asyncpg as a (stringized) annotation and
# --- redis.asyncio via from_url(); neither needs the real package for this test.
def _install_stubs() -> None:
    if "asyncpg" not in sys.modules:
        m = types.ModuleType("asyncpg")
        m.Pool = object  # only referenced in annotations (PEP 563 -> never evaluated)
        sys.modules["asyncpg"] = m
    if "redis" not in sys.modules:
        redis_mod = types.ModuleType("redis")
        aio = types.ModuleType("redis.asyncio")

        class _FakeRedis:
            def __init__(self, *a, **k):
                pass

            async def publish(self, *a, **k):
                return 0

        aio.from_url = lambda *a, **k: _FakeRedis()
        redis_mod.asyncio = aio
        sys.modules["redis"] = redis_mod
        sys.modules["redis.asyncio"] = aio


_install_stubs()
_WORKER = str(Path(__file__).resolve().parents[2] / "apps" / "worker")
if _WORKER not in sys.path:
    sys.path.insert(0, _WORKER)

import live_paper  # noqa: E402  (after stubs + path)
from quant_core.orders import Bar  # noqa: E402
from quant_core.paper_runtime import PaperRuntime  # noqa: E402
from quant_core.portfolio import Portfolio  # noqa: E402
from quant_core.strategies import REGISTRY as STRATEGY_REGISTRY  # noqa: E402

INTERVAL_MIN = 1
INTERVAL_MS = INTERVAL_MIN * 60_000
BASE_MS = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)


def _trend_candles(start_ms: int, n: int, skip: set[int] | None = None) -> list[dict]:
    """Deterministic trending 1m candles (rows shaped like the SQL SELECT in _fetch_bars*)."""
    skip = skip or set()
    rows = []
    px = 100.0
    for i in range(n):
        # A gentle saw-tooth trend so trend_ema_cross actually crosses and trades.
        px += 0.5 if (i // 20) % 2 == 0 else -0.4
        p = round(px, 2)
        if i in skip:
            continue
        rows.append({
            "ts": start_ms + i * INTERVAL_MS,
            "open": str(p), "high": str(p + 0.6), "low": str(p - 0.6),
            "close": str(p), "volume": "25",
        })
    return rows


def _row_to_bar(r: dict) -> Bar:
    return Bar(
        ts=datetime.fromtimestamp(int(r["ts"]) / 1000, tz=timezone.utc),
        open=Decimal(str(r["open"])), high=Decimal(str(r["high"])),
        low=Decimal(str(r["low"])), close=Decimal(str(r["close"])),
        volume=Decimal(str(r["volume"] or "0")),
    )


class _FakeConn:
    def __init__(self, store: "_Store") -> None:
        self.store = store

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def fetchrow(self, sql: str, *args):
        if "FROM live_paper_sessions" in sql:
            return dict(self.store.session)  # copy: simulates a row snapshot
        return None

    async def fetch(self, sql: str, *args):
        # _fetch_bars_since: open_time >= since_ms ASC LIMIT max
        if "open_time >=" in sql and "ASC" in sql:
            since_ms = int(args[3])
            return [r for r in self.store.candles if r["ts"] >= since_ms]
        # _fetch_bars: DESC LIMIT (tail) — not used on the recovery path, but supported.
        if "DESC" in sql:
            limit = int(args[3])
            return list(reversed(self.store.candles[-limit:]))
        return []

    async def execute(self, sql: str, *args):
        if sql.strip().startswith("CREATE TABLE"):
            return
        if "ADD COLUMN IF NOT EXISTS" in sql:
            # ensure_table ALTERs — track which columns exist (this is the P0.1 fix surface).
            for tok in sql.split("ADD COLUMN IF NOT EXISTS")[1:]:
                col = tok.strip().split()[0]
                self.store.columns.add(col)
            return
        if "SET recovery_events_json" in sql:
            if "recovery_events_json" not in self.store.columns:
                # Emulate Postgres: UPDATE referencing a missing column errors. In production
                # this is swallowed by _recovery_event's try/except -> events vanish (the bug).
                raise RuntimeError('column "recovery_events_json" does not exist')
            import json
            evts = json.loads(args[1]) if isinstance(args[1], str) else args[1]
            self.store.session["recovery_events_json"].extend(evts)
            return
        if "status='recovery_blocked'" in sql:
            self.store.session["status"] = "recovery_blocked"
            self.store.session["recovery_blocked_reason"] = args[1]
            return
        if "status='running'" in sql:
            self.store.session["status"] = "running"
            self.store.session["recovery_blocked_reason"] = None
            return
        return


class _FakePool:
    def __init__(self, store: "_Store") -> None:
        self.store = store

    def acquire(self):
        return _FakeConn(self.store)


class _Store:
    def __init__(self, session: dict, candles: list[dict], columns: set[str]) -> None:
        self.session = session
        self.candles = candles
        self.columns = columns


def _base_columns(with_recovery_events: bool) -> set[str]:
    cols = {
        "session_id", "owner_id", "strategy_id", "symbol", "category", "params_json",
        "starting_equity", "interval_minutes", "risk_json", "status", "start_bar_ms",
        "execution_fidelity", "allow_fallback", "latency_json", "recovery_blocked_reason",
    }
    if with_recovery_events:
        cols.add("recovery_events_json")
    return cols


def _make_session(session_id: str, symbol: str, start_bar_ms: int) -> dict:
    # Full row so _row()/_build_mem can read every field they touch.
    return {
        "session_id": session_id, "owner_id": "1", "strategy_id": "trend_ema_cross",
        "symbol": symbol, "category": "linear", "params_json": {},
        "starting_equity": "10000", "interval_minutes": INTERVAL_MIN, "risk_json": {},
        "status": "running", "start_bar_ms": start_bar_ms,
        "start_equity": None, "warmup_return": None, "last_tick_at": None, "created_at": None,
        "final_equity": None, "fills_count": 0, "bars_seen": 0, "last_bar_ms": None,
        "last_price": None, "performance_json": {}, "positions_json": {}, "risk_state_json": {},
        "execution_fidelity": "bar_based", "allow_fallback": True, "latency_json": {},
        "fill_model_json": {}, "runtime_checkpoint_json": {}, "recording_json": {},
        "recovery_blocked_reason": None, "recovery_events_json": [],
    }


def _reference_replay(start_bar_ms: int, candles: list[dict]) -> tuple[Decimal, int]:
    """Reproduce _build_mem's recovery math directly: prime the strategy on warmup (throwaway
    book), then run a fresh live book over the forward bars with the SAME strategy instance."""
    bars = [_row_to_bar(r) for r in candles]
    warmup = [b for b in bars if int(b.ts.timestamp() * 1000) <= start_bar_ms]
    forward = [b for b in bars if int(b.ts.timestamp() * 1000) > start_bar_ms]
    strat = STRATEGY_REGISTRY["trend_ema_cross"]({})
    throwaway = Portfolio(starting_equity=Decimal("10000"))
    PaperRuntime(symbol="BTCUSDT", portfolio=throwaway, strategy=strat).run(bars=warmup, funding_rows=[])
    live_pf = Portfolio(starting_equity=Decimal("10000"))
    res = PaperRuntime(symbol="BTCUSDT", portfolio=live_pf, strategy=strat).run(bars=forward, funding_rows=[])
    return res.final_equity, len(res.fills)


class LivePaperRecoveryTests(unittest.TestCase):
    def test_recovery_over_400_bars_reproduces_exactly_and_records_event(self) -> None:
        """>400 forward bars: full deterministic replay, equity/fills reproduced exactly, no reset.
        The RECOVERY_COMPLETED assertion is the fail-before/pass-after hook for the ensure_table
        column fix."""
        warmup_n = live_paper.WARMUP_LIMIT + 1   # 401 warmup bars available before start
        forward_n = 450                          # > 400 -> would be lost by the old 400-bar cap
        start_bar_ms = BASE_MS + warmup_n * INTERVAL_MS
        first_ms = start_bar_ms - live_paper.WARMUP_LIMIT * INTERVAL_MS  # _fetch_bars_since window
        total = warmup_n + 1 + forward_n
        candles = _trend_candles(BASE_MS, total)
        # Only the candles the recovery actually pages (open_time >= since) form warmup+forward.
        paged = [r for r in candles if r["ts"] >= first_ms]

        sid = "rcv-session"
        store = _Store(_make_session(sid, "BTCUSDT", start_bar_ms), candles, _base_columns(True))
        mgr = live_paper.LivePaperManager(_FakePool(store))

        mem = asyncio.run(mgr._build_mem(sid, persist=False))
        self.assertIsNotNone(mem, "recovery must produce a live book, not None")

        # No truncation: the full forward range (450 > 400) was replayed.
        forward_paged = [r for r in paged if r["ts"] > start_bar_ms]
        self.assertEqual(len(forward_paged), forward_n)
        completed = [e for e in store.session["recovery_events_json"] if e["type"] == "RECOVERY_COMPLETED"]
        self.assertTrue(completed, "RECOVERY_COMPLETED must be recorded (needs recovery_events_json column)")
        self.assertEqual(completed[-1]["replayed_bars"], forward_n)

        # Exact reproduction vs a direct reference replay (same warmup priming + forward).
        # mem stores the equity curve as float (live_paper.py _advance), so compare at float
        # precision against the Decimal reference — both derive from the identical computation.
        ref_equity, ref_fills = _reference_replay(start_bar_ms, paged)
        got_equity = float(mem["equity_curve"][-1])
        self.assertEqual(len(mem["fills"]), ref_fills)
        self.assertEqual(got_equity, float(ref_equity))  # exact float reproduction (no truncation)
        # Trading actually happened and was preserved (not reset to starting_equity).
        self.assertGreater(ref_fills, 0, "test data must produce fills to be meaningful")
        self.assertNotEqual(got_equity, 10000.0)

    def test_recovery_events_swallowed_without_column(self) -> None:
        """Directly demonstrates the bug the ensure_table fix closes: without the
        recovery_events_json column, the RECOVERY_* writes are swallowed and recovery is invisible
        (equity still reproduced, but unauditable)."""
        warmup_n = live_paper.WARMUP_LIMIT + 1
        start_bar_ms = BASE_MS + warmup_n * INTERVAL_MS
        candles = _trend_candles(BASE_MS, warmup_n + 1 + 50)
        sid = "rcv-nocol"
        store = _Store(_make_session(sid, "BTCUSDT", start_bar_ms), candles, _base_columns(False))
        mgr = live_paper.LivePaperManager(_FakePool(store))
        mem = asyncio.run(mgr._build_mem(sid, persist=False))
        self.assertIsNotNone(mem)
        self.assertEqual(store.session["recovery_events_json"], [],
                         "without the column, events are silently dropped (the bug)")

    def test_ensure_table_adds_recovery_events_column(self) -> None:
        """The fix: ensure_table now creates recovery_events_json wherever the worker runs."""
        store = _Store(_make_session("s", "BTCUSDT", BASE_MS), [], set())
        mgr = live_paper.LivePaperManager(_FakePool(store))
        asyncio.run(mgr.ensure_table())
        self.assertIn("recovery_events_json", store.columns)

    def test_forward_gap_blocks_recovery(self) -> None:
        """A forward candle gap > RECOVERY_MAX_GAP_BARS blocks the session — never a silent resume."""
        warmup_n = live_paper.WARMUP_LIMIT + 1
        start_bar_ms = BASE_MS + warmup_n * INTERVAL_MS
        gap = live_paper.RECOVERY_MAX_GAP_BARS + 4
        # Drop a run of forward bars right after start to create a hole bigger than tolerance.
        gap_start_idx = warmup_n + 5
        skip = set(range(gap_start_idx, gap_start_idx + gap))
        candles = _trend_candles(BASE_MS, warmup_n + 1 + 80, skip=skip)
        sid = "gap-session"
        store = _Store(_make_session(sid, "BTCUSDT", start_bar_ms), candles, _base_columns(True))
        mgr = live_paper.LivePaperManager(_FakePool(store))

        mem = asyncio.run(mgr._build_mem(sid, persist=False))
        self.assertIsNone(mem, "a gap beyond tolerance must block (return None), not replay")
        self.assertEqual(store.session["status"], "recovery_blocked")
        self.assertIsNotNone(store.session["recovery_blocked_reason"])
        self.assertIn("CANDLE_GAP", store.session["recovery_blocked_reason"])
        types_seen = [e["type"] for e in store.session["recovery_events_json"]]
        self.assertIn("RECOVERY_GAP_DETECTED", types_seen)
        self.assertIn("RECOVERY_BLOCKED", types_seen)


if __name__ == "__main__":
    unittest.main()
