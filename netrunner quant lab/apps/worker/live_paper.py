"""Persistent server-side live paper-trading sessions.

A session is created once; a single background loop then advances ALL running
sessions every ``LIVE_PAPER_TICK_SECONDS`` by reading the freshest 1-minute candles
(kept current by the data-ingestor's demand-driven poller) and re-running the
deterministic PaperRuntime on the growing real series. No client driver loop — the
server trades forward on its own until the session is stopped.

State is persisted to ``live_paper_sessions`` so the UI (Paper War Room / Strategy
Desk) and restarts can read current equity / fills / positions.
"""
from __future__ import annotations

import asyncio
import bisect
import json
import os
from datetime import datetime, timezone
from decimal import Decimal

import asyncpg
import redis.asyncio as _redis

from quant_core.strategies import REGISTRY as STRATEGY_REGISTRY
from quant_core.orders import Bar as RuntimeBar
from quant_core.portfolio import Portfolio, RiskConfig
from quant_core.paper_runtime import PaperRuntime
from quant_core.performance import compute_performance
from quant_core.execution import Fidelity
from l2_data import load_l2_snapshots, load_trades
from quant_core.l2_replay import L2QueueProvider, L2SweepProvider

TICK_SECONDS = int(os.getenv("LIVE_PAPER_TICK_SECONDS", "30"))
WARMUP_LIMIT = int(os.getenv("LIVE_PAPER_BARS", "400"))
# Recovery (Phase 6): max consecutive missing forward bars tolerated before a restart is
# blocked instead of silently resumed over a data gap.
RECOVERY_MAX_GAP_BARS = int(os.getenv("RECOVERY_MAX_GAP_BARS", "2"))
# Hard cap on bars paged during recovery replay (prevents unbounded memory on very old sessions).
RECOVERY_MAX_BARS = int(os.getenv("RECOVERY_MAX_BARS", "200000"))


def _env_int(name: str, default: int) -> int:
    try:
        return int(float(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _j(v):
    """asyncpg returns JSONB as a str — decode to dict safely."""
    if v is None:
        return {}
    if isinstance(v, (dict, list)):
        return v
    try:
        return json.loads(v)
    except Exception:
        return {}


class LivePaperManager:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self.last_cycle_ts: int | None = None
        self.last_cycle_count: int = 0
        # In-memory per-session live state (incremental, stateful forward paper).
        # session_id -> {runtime, portfolio, last_ts, fills:[], equity_curve:[], trade_pnls:[]}
        self._mem: dict[str, dict] = {}
        self.redis = _redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))

    async def ensure_table(self) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS live_paper_sessions (
                  session_id TEXT PRIMARY KEY,
                  owner_id BIGINT,
                  strategy_id TEXT NOT NULL,
                  symbol TEXT NOT NULL,
                  category TEXT NOT NULL DEFAULT 'linear',
                  params_json JSONB NOT NULL DEFAULT '{}',
                  starting_equity NUMERIC NOT NULL DEFAULT 10000,
                  interval_minutes INT NOT NULL DEFAULT 1,
                  risk_json JSONB NOT NULL DEFAULT '{}',
                  status TEXT NOT NULL DEFAULT 'running',
                  created_at TIMESTAMPTZ DEFAULT NOW(),
                  last_tick_at TIMESTAMPTZ,
                  last_bar_ms BIGINT,
                  bars_seen INT DEFAULT 0,
                  final_equity NUMERIC,
                  fills_count INT DEFAULT 0,
                  performance_json JSONB DEFAULT '{}',
                  positions_json JSONB DEFAULT '{}',
                  risk_state_json JSONB DEFAULT '{}',
                  last_price NUMERIC
                )
                """
            )
            # Forward-P&L baseline + warmup-context backtest return (context only).
            for col, typ in (("start_equity", "NUMERIC"), ("start_fills", "INT"),
                             ("start_bar_ms", "BIGINT"), ("warmup_return", "NUMERIC"),
                             ("execution_fidelity", "TEXT DEFAULT 'bar_based'"),
                             ("fill_model_json", "JSONB DEFAULT '{}'"),
                             ("allow_fallback", "BOOLEAN DEFAULT TRUE"),
                             ("l2_depth", "INT DEFAULT 50"),
                             ("latency_json", "JSONB DEFAULT '{}'"),
                             ("runtime_checkpoint_json", "JSONB DEFAULT '{}'"),
                             ("recovery_blocked_reason", "TEXT"),
                             # Recovery event ledger (RECOVERY_* events). Also created by
                             # migration 0009, but mirrored here so the column exists wherever
                             # the worker runs ensure_table — otherwise _recovery_event's UPDATE
                             # fails silently (try/except) and recovery becomes unauditable.
                             ("recovery_events_json", "JSONB DEFAULT '[]'::jsonb"),
                             ("recording_json", "JSONB DEFAULT '{}'")):
                await conn.execute(f"ALTER TABLE live_paper_sessions ADD COLUMN IF NOT EXISTS {col} {typ}")

    async def start(self) -> None:
        await self.ensure_table()
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run())

    async def stop_loop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()

    async def create_session(self, *, session_id, owner_id, strategy_id, symbol, category,
                             params, starting_equity, interval_minutes, risk,
                             execution_fidelity: str = "bar_based",
                             allow_fallback: bool = True) -> dict:
        if strategy_id not in STRATEGY_REGISTRY:
            return {"error": "UNKNOWN_STRATEGY", "available": list(STRATEGY_REGISTRY.keys())}
        # §25 A.2 — fail loud on a missing/non-numeric owner rather than persisting an unowned row.
        from security import parse_owner_id, OwnerIdError
        try:
            owner_id = parse_owner_id(owner_id)
        except OwnerIdError as e:
            return {"error": "INVALID_OWNER_ID", "detail": str(e)}
        fidelity = Fidelity.parse(execution_fidelity, Fidelity.BAR_BASED).value
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO live_paper_sessions
                  (session_id, owner_id, strategy_id, symbol, category, params_json,
                   starting_equity, interval_minutes, risk_json, status, created_at,
                   execution_fidelity, allow_fallback, l2_depth, latency_json, recording_json)
                VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,'running',NOW(),
                        $10,$11,$12,$13::jsonb,$14::jsonb)
                ON CONFLICT (session_id) DO UPDATE SET
                  status='running', params_json=EXCLUDED.params_json, risk_json=EXCLUDED.risk_json,
                  execution_fidelity=EXCLUDED.execution_fidelity,
                  allow_fallback=EXCLUDED.allow_fallback,
                  l2_depth=EXCLUDED.l2_depth,
                  latency_json=EXCLUDED.latency_json,
                  recording_json=EXCLUDED.recording_json
                """,
                session_id, owner_id, strategy_id, symbol.upper(), category,
                json.dumps(params), str(starting_equity), int(interval_minutes), json.dumps(risk),
                fidelity, bool(allow_fallback), _env_int("L2_DEPTH", 50),
                json.dumps({
                    "enabled": _env_bool("ENABLE_LATENCY_MODEL", False),
                    "feed_latency_ms": _env_int("DEFAULT_FEED_LATENCY_MS", 0),
                    "order_latency_ms": _env_int("DEFAULT_ORDER_LATENCY_MS", 0),
                    "cancel_latency_ms": _env_int("DEFAULT_CANCEL_LATENCY_MS", 0),
                }),
                json.dumps({
                    "ticker": True,
                    "kline": True,
                    "l2": fidelity in (Fidelity.L2_SWEEP.value, Fidelity.L2_QUEUE.value),
                    "trades": fidelity == Fidelity.L2_QUEUE.value,
                }),
            )
        await self._build_mem(session_id, persist=True)   # prime indicators on warmup, fresh live book
        return await self.get_session(session_id)

    async def stop_session(self, session_id: str) -> dict:
        async with self.pool.acquire() as conn:
            await conn.execute("UPDATE live_paper_sessions SET status='stopped' WHERE session_id=$1", session_id)
        return await self.get_session(session_id)

    async def _fetch_bars(self, conn, symbol, category, interval_minutes) -> list[RuntimeBar]:
        interval = "1" if interval_minutes == 1 else ("D" if interval_minutes == 1440 else str(interval_minutes))
        rows = await conn.fetch(
            """SELECT EXTRACT(EPOCH FROM open_time)*1000 AS ts, open, high, low, close, volume
               FROM candles WHERE symbol=$1 AND category=$2 AND interval=$3
               ORDER BY open_time DESC LIMIT $4""",
            symbol, category, interval, WARMUP_LIMIT,
        )
        rows = list(reversed(rows))
        return [RuntimeBar(ts=datetime.fromtimestamp(int(r["ts"]) / 1000, tz=timezone.utc),
                           open=Decimal(str(r["open"])), high=Decimal(str(r["high"])),
                           low=Decimal(str(r["low"])), close=Decimal(str(r["close"])),
                           volume=Decimal(str(r["volume"] or "0"))) for r in rows]

    async def _fetch_bars_since(self, conn, symbol, category, interval_minutes, since_ms) -> list[RuntimeBar]:
        """Recovery fetch: ALL bars from since_ms forward (ascending, no 400-bar truncation).
        This is what lets a restart replay the full session deterministically instead of a
        truncated tail (the old bug)."""
        interval = "1" if interval_minutes == 1 else ("D" if interval_minutes == 1440 else str(interval_minutes))
        rows = await conn.fetch(
            """SELECT EXTRACT(EPOCH FROM open_time)*1000 AS ts, open, high, low, close, volume
               FROM candles WHERE symbol=$1 AND category=$2 AND interval=$3
                 AND open_time >= to_timestamp($4/1000.0)
               ORDER BY open_time ASC LIMIT $5""",
            symbol, category, interval, int(since_ms), RECOVERY_MAX_BARS,
        )
        return [RuntimeBar(ts=datetime.fromtimestamp(int(r["ts"]) / 1000, tz=timezone.utc),
                           open=Decimal(str(r["open"])), high=Decimal(str(r["high"])),
                           low=Decimal(str(r["low"])), close=Decimal(str(r["close"])),
                           volume=Decimal(str(r["volume"] or "0"))) for r in rows]

    @staticmethod
    def _max_consecutive_gap(forward: list[RuntimeBar], interval_ms: int) -> tuple[int, int | None]:
        """Largest run of MISSING bars in the forward series. Returns (missing_bars, gap_start_ms)."""
        worst = 0
        worst_at = None
        for a, b in zip(forward, forward[1:]):
            ams = int(a.ts.timestamp() * 1000); bms = int(b.ts.timestamp() * 1000)
            missing = (bms - ams) // interval_ms - 1
            if missing > worst:
                worst = int(missing); worst_at = ams + interval_ms
        return worst, worst_at

    async def _recovery_event(self, session_id: str, owner_id: str, etype: str, **payload) -> None:
        """Append a RECOVERY_* event to the session ledger (capped) and publish to Redis."""
        evt = {"type": etype, "ts_ms": None, **payload}
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """UPDATE live_paper_sessions
                         SET recovery_events_json = (
                           COALESCE(recovery_events_json,'[]'::jsonb) || $2::jsonb
                         )
                       WHERE session_id=$1""",
                    session_id, json.dumps([evt]))
            await self.redis.publish(f"rt:session:{owner_id}", json.dumps({"session_id": session_id, "recovery_event": evt}, default=str))
        except Exception:
            pass

    def _risk_kwargs(self, rk: dict) -> dict:
        return {k: Decimal(str(rk[k])) for k in
                ("max_position_fraction", "max_total_exposure_fraction",
                 "max_daily_loss_fraction", "max_drawdown_kill_fraction") if k in rk}

    async def _build_mem(self, session_id: str, persist: bool = False) -> dict | None:
        """Prime the strategy on warmup history WITHOUT booking P&L (throwaway book),
        then create a FRESH live book; replay any forward bars since start. Stores the
        persistent runtime in memory so subsequent ticks only feed genuinely-new bars."""
        interval_ms = 0
        async with self.pool.acquire() as conn:
            s = await conn.fetchrow("SELECT * FROM live_paper_sessions WHERE session_id=$1", session_id)
            if not s:
                return None
            interval_ms = max(1, int(s["interval_minutes"])) * 60_000
            recovering = s["start_bar_ms"] is not None
            if recovering:
                # RECOVERY: page the FULL session forward from start (no 400-bar truncation),
                # with a warmup window before start for indicator priming.
                since_ms = int(s["start_bar_ms"]) - WARMUP_LIMIT * interval_ms
                bars = await self._fetch_bars_since(conn, s["symbol"], s["category"], s["interval_minutes"], since_ms)
            else:
                bars = await self._fetch_bars(conn, s["symbol"], s["category"], s["interval_minutes"])
        if len(bars) < 2:
            return None
        params = _j(s["params_json"]); rk = _j(s["risk_json"])
        start_bar_ms = s["start_bar_ms"]
        if start_bar_ms is None:
            # First build: warmup = all but the last bar; live starts at the last bar.
            start_bar_ms = int(bars[-1].ts.timestamp() * 1000)
        warmup = [b for b in bars if int(b.ts.timestamp() * 1000) <= start_bar_ms]
        forward = [b for b in bars if int(b.ts.timestamp() * 1000) > start_bar_ms]

        # RECOVERY gap-blocking: never silently resume over a candle gap in the forward range.
        if recovering:
            await self._recovery_event(session_id, str(s["owner_id"]), "RECOVERY_STARTED",
                                       start_bar_ms=start_bar_ms, forward_bars=len(forward))
            gap_bars, gap_at = self._max_consecutive_gap(forward, interval_ms)
            if gap_bars > 0:
                await self._recovery_event(session_id, str(s["owner_id"]), "RECOVERY_GAP_DETECTED",
                                           missing_bars=gap_bars, gap_start_ms=gap_at)
                await self._recovery_event(session_id, str(s["owner_id"]), "RECOVERY_BACKFILL_REQUESTED",
                                           from_ms=gap_at, interval_minutes=s["interval_minutes"])
            if gap_bars > RECOVERY_MAX_GAP_BARS:
                reason = f"CANDLE_GAP_{gap_bars}_BARS_AT_{gap_at}"
                async with self.pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE live_paper_sessions SET status='recovery_blocked', recovery_blocked_reason=$2 WHERE session_id=$1",
                        session_id, reason)
                await self._recovery_event(session_id, str(s["owner_id"]), "RECOVERY_BLOCKED", reason=reason)
                return None

        # Prime strategy indicators on warmup with a THROWAWAY portfolio (no live P&L).
        strategy = STRATEGY_REGISTRY[s["strategy_id"]](params)
        warm_return = 0.0
        if len(warmup) >= 2:
            throwaway = Portfolio(starting_equity=Decimal(str(s["starting_equity"])), risk=RiskConfig(**self._risk_kwargs(rk)))
            warm_rt = PaperRuntime(symbol=s["symbol"], portfolio=throwaway, strategy=strategy)
            wres = warm_rt.run(bars=warmup, funding_rows=[])
            try:
                warm_return = float(wres.final_equity) / float(s["starting_equity"]) - 1.0
            except Exception:
                warm_return = 0.0

        # Fresh LIVE book using the now-warm strategy instance.
        live_pf = Portfolio(starting_equity=Decimal(str(s["starting_equity"])), risk=RiskConfig(**self._risk_kwargs(rk)))
        live_rt = PaperRuntime(symbol=s["symbol"], portfolio=live_pf, strategy=strategy)
        fidelity = Fidelity.parse(s["execution_fidelity"], Fidelity.BAR_BASED)
        live_rt.requested_fidelity = fidelity
        latency = _j(s["latency_json"]) if "latency_json" in s else {}
        join_latency_ms = int(latency.get("order_latency_ms", 0)) if latency.get("enabled") else 0
        if latency.get("enabled"):
            from quant_core.execution import LatencyConfig
            live_rt.latency = LatencyConfig(
                enabled=True,
                feed_latency_ms=int(latency.get("feed_latency_ms", 0)),
                order_entry_latency_ms=int(latency.get("order_latency_ms", 0)),
                cancel_latency_ms=int(latency.get("cancel_latency_ms", 0)),
                exchange_ack_latency_ms=int(latency.get("ack_latency_ms", 0)),
                jitter_ms=int(latency.get("jitter_ms", 0)),
                seed=int(latency.get("seed", 42)),
            )
        mem = {"runtime": live_rt, "portfolio": live_pf, "last_ts": start_bar_ms,
               "fills": [], "equity_curve": [float(s["starting_equity"])], "trade_pnls": [],
               "interval_minutes": s["interval_minutes"], "symbol": s["symbol"],
               "category": s["category"], "fidelity": fidelity,
               "warm_return": warm_return, "starting_equity": float(s["starting_equity"]),
               "allow_fallback": bool(s["allow_fallback"]) if "allow_fallback" in s else True,
               "join_latency_ms": join_latency_ms,
               "replay_snapshots": [], "replay_trades": [],
               "provider_kind": None, "recovery_blocked_reason": None}
        self._mem[session_id] = mem
        if forward:
            await self._advance_with_l2(mem, forward)
        if persist:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """UPDATE live_paper_sessions SET start_bar_ms=$2, start_equity=$3, start_fills=0, warmup_return=$4
                       WHERE session_id=$1""",
                    session_id, start_bar_ms, str(s["starting_equity"]), str(warm_return))
            await self._persist(session_id, mem)
        if recovering:
            # Full deterministic replay reproduced equity/fills/positions; clear any prior
            # block and record completion. (No silent reset — state is the replayed truth.)
            async with self.pool.acquire() as conn:
                await conn.execute(
                    "UPDATE live_paper_sessions SET status='running', recovery_blocked_reason=NULL WHERE session_id=$1",
                    session_id)
            await self._recovery_event(session_id, str(s["owner_id"]), "RECOVERY_COMPLETED",
                                       replayed_bars=len(forward), equity=mem["equity_curve"][-1],
                                       fills=len(mem["fills"]))
        return mem

    def _live_snapshot_lookup(self, mem: dict):
        def lookup(ts_ms: int):
            snaps = mem.get("replay_snapshots", [])
            keys = [s.ts_ms for s in snaps]
            i = bisect.bisect_right(keys, ts_ms) - 1
            return snaps[i] if i >= 0 else None
        return lookup

    def _live_trade_lookup(self, mem: dict):
        def lookup(start_ms: int, end_ms: int):
            trades = mem.get("replay_trades", [])
            keys = [t.ts_ms for t in trades]
            lo = bisect.bisect_left(keys, start_ms)
            hi = bisect.bisect_left(keys, end_ms)
            return trades[lo:hi]
        return lookup

    def _merge_replay_rows(self, mem: dict, *, snapshots=None, trades=None) -> None:
        if snapshots:
            by_key = {(s.ts_ms, s.sequence_id): s for s in mem.get("replay_snapshots", [])}
            by_key.update({(s.ts_ms, s.sequence_id): s for s in snapshots})
            mem["replay_snapshots"] = sorted(by_key.values(), key=lambda s: s.ts_ms)
        if trades:
            by_key = {(t.ts_ms, t.price, t.qty, t.side): t for t in mem.get("replay_trades", [])}
            by_key.update({(t.ts_ms, t.price, t.qty, t.side): t for t in trades})
            mem["replay_trades"] = sorted(by_key.values(), key=lambda t: t.ts_ms)

    def _install_live_provider(self, mem: dict) -> None:
        rt = mem["runtime"]
        fid = mem.get("fidelity", Fidelity.BAR_BASED)
        interval_ms = max(1, int(mem.get("interval_minutes", 1)) * 60_000)
        if fid == Fidelity.BAR_BASED:
            rt.l2_queue_provider = None
            mem["provider_kind"] = None
            return
        if not mem.get("replay_snapshots"):
            rt.l2_queue_provider = None
            rt.fill_stats.fallback_reason = "NO_L2_SNAPSHOTS_IN_RANGE_FELL_BACK_TO_BAR"
            mem["provider_kind"] = None
            return
        if fid == Fidelity.L2_QUEUE and mem.get("replay_trades"):
            if mem.get("provider_kind") != "queue":
                rt.l2_queue_provider = L2QueueProvider(
                    self._live_snapshot_lookup(mem),
                    self._live_trade_lookup(mem),
                    join_latency_ms=int(mem.get("join_latency_ms", 0)),
                    bar_interval_ms=interval_ms,
                )
                rt.fill_stats.latency_model_used = int(mem.get("join_latency_ms", 0)) > 0
                mem["provider_kind"] = "queue"
            rt.fill_stats.fallback_reason = None
            return
        if fid == Fidelity.L2_QUEUE:
            rt.fill_stats.fallback_reason = "NO_TRADES_IN_RANGE_DEGRADED_TO_SWEEP"
        else:
            rt.fill_stats.fallback_reason = None
        if mem.get("provider_kind") != "sweep":
            rt.l2_queue_provider = L2SweepProvider(self._live_snapshot_lookup(mem))
            mem["provider_kind"] = "sweep"

    async def _advance_with_l2(self, mem: dict, new_bars: list) -> None:
        """Install/update a stateful L2 provider over the bars about to be replayed.

        The provider object survives across ticks, so queue position does too. Its lookup
        callables read mutable replay buffers that are extended from Postgres each cycle.
        """
        rt = mem["runtime"]
        fid = mem.get("fidelity", Fidelity.BAR_BASED)
        if fid != Fidelity.BAR_BASED and new_bars:
            interval_ms = max(1, int(mem.get("interval_minutes", 1)) * 60_000)
            lo = int(new_bars[0].ts.timestamp() * 1000)
            hi = int(new_bars[-1].ts.timestamp() * 1000) + interval_ms
            async with self.pool.acquire() as conn:
                snaps = await load_l2_snapshots(conn, mem["symbol"], mem.get("category", "linear"), lo - interval_ms, hi)
                trades = await load_trades(conn, mem["symbol"], mem.get("category", "linear"), lo, hi) if fid == Fidelity.L2_QUEUE else []
            self._merge_replay_rows(mem, snapshots=snaps, trades=trades)
            if not snaps and not mem.get("allow_fallback", True):
                mem["recovery_blocked_reason"] = "L2_COVERAGE_INSUFFICIENT"
                rt.fill_stats.fallback_reason = mem["recovery_blocked_reason"]
                return
            if fid == Fidelity.L2_QUEUE and not trades and not mem.get("replay_trades") and not mem.get("allow_fallback", True):
                mem["recovery_blocked_reason"] = "TRADE_COVERAGE_INSUFFICIENT"
                rt.fill_stats.fallback_reason = mem["recovery_blocked_reason"]
                return
            mem["recovery_blocked_reason"] = None
            self._install_live_provider(mem)
        self._advance(mem, new_bars)

    def _advance(self, mem: dict, new_bars: list) -> None:
        res = mem["runtime"].run(bars=new_bars, funding_rows=[])
        mem["fills"].extend(res.fills)
        mem["equity_curve"].extend(float(x) for x in res.equity_curve)
        mem["trade_pnls"].extend(float(x) for x in res.trade_pnls)
        mem["last_ts"] = int(new_bars[-1].ts.timestamp() * 1000)
        mem["last_close"] = float(new_bars[-1].close)

    async def _persist(self, session_id: str, mem: dict) -> None:
        pf = mem["portfolio"]
        marks = {mem["symbol"]: Decimal(str(mem.get("last_close", mem["equity_curve"][-1])))}
        try:
            equity = float(pf.equity(marks))
        except Exception:
            equity = mem["equity_curve"][-1]
        bpy = 365 * 24 * 60 / max(1, mem["interval_minutes"])
        perf = compute_performance([Decimal(str(x)) for x in mem["equity_curve"]],
                                   [Decimal(str(x)) for x in mem["trade_pnls"]], bars_per_year=bpy)
        positions = {sym: {"side": p.side, "qty": str(p.qty), "avg_entry": str(p.avg_entry),
                           "realized_pnl": str(p.realized_pnl)} for sym, p in pf.positions.items()}
        try:
            fill_model = mem["runtime"].fill_model()
        except Exception:
            fill_model = {}
        checkpoint = {
            "last_bar_ms": mem.get("last_ts"),
            "equity": str(equity),
            "fills_count": len(mem["fills"]),
            "provider_kind": mem.get("provider_kind"),
            "snapshot_rows_loaded": len(mem.get("replay_snapshots", [])),
            "trade_rows_loaded": len(mem.get("replay_trades", [])),
            "queue_state_preserved_by": "deterministic_replay_from_start_bar_ms",
        }
        async with self.pool.acquire() as conn:
            await conn.execute(
                """UPDATE live_paper_sessions SET
                     last_tick_at=NOW(), last_bar_ms=$2, bars_seen=$3, final_equity=$4,
                     fills_count=$5, performance_json=$6::jsonb, positions_json=$7::jsonb,
                     risk_state_json=$8::jsonb, last_price=$9, fill_model_json=$10::jsonb,
                     runtime_checkpoint_json=$11::jsonb, recovery_blocked_reason=$12
                   WHERE session_id=$1""",
                session_id, mem["last_ts"], max(0, len(mem["equity_curve"]) - 1), str(equity),
                len(mem["fills"]),
                json.dumps({"total_return": perf.total_return, "sharpe": perf.sharpe,
                            "max_drawdown": perf.max_drawdown, "win_rate": perf.win_rate,
                            "n_trades": perf.n_trades}),
                json.dumps(positions),
                json.dumps({"killed": pf.state.killed, "kill_reason": pf.state.kill_reason}),
                str(mem.get("last_close", equity)),
                json.dumps(fill_model),
                json.dumps(checkpoint),
                mem.get("recovery_blocked_reason"),
            )
            row = await conn.fetchrow("SELECT * FROM live_paper_sessions WHERE session_id=$1", session_id)
            # Phase 6: write a checkpoint row (dedicated table) capturing the live book state.
            # Recovery itself is deterministic replay from start_bar_ms; this row is the
            # expected post-recovery state for verification + the audit trail.
            try:
                prov = mem["runtime"].l2_queue_provider
                qstate = None
                if prov is not None and hasattr(prov, "_queue_state"):
                    qstate = json.dumps({str(k): str(v) for k, v in prov._queue_state.items()})
                open_orders = [
                    {"order_id": o.order_id, "side": o.side, "qty": str(o.qty), "type": o.order_type.value,
                     "limit_price": str(o.limit_price) if o.limit_price is not None else None,
                     "status": o.status.value, "filled_qty": str(o.filled_qty)}
                    for o in mem["runtime"].open_orders if not o.is_terminal()
                ]
                await conn.execute(
                    """INSERT INTO live_paper_checkpoints
                         (session_id, owner_id, symbol, category, checkpoint_bar_ms, strategy_id, start_bar_ms,
                          portfolio_state_json, open_orders_json, queue_state_json, positions_json,
                          equity, fills_count, performance_json, fill_model_json)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14::jsonb,$15::jsonb)""",
                    session_id, int(row["owner_id"]), mem["symbol"], mem.get("category", "linear"),
                    mem["last_ts"], row["strategy_id"], row["start_bar_ms"],
                    json.dumps({"cash": str(pf.cash)}), json.dumps(open_orders), qstate,
                    json.dumps(positions), str(equity), len(mem["fills"]),
                    json.dumps({"total_return": perf.total_return, "sharpe": perf.sharpe}),
                    json.dumps(fill_model),
                )
            except Exception:
                pass
        # Publish session snapshot to Redis for SSE fan-out (rt:session:{owner_id}).
        try:
            snap = self._row(row)
            await self.redis.publish(f"rt:session:{row['owner_id']}", json.dumps(snap, default=str))
        except Exception:
            pass

    async def _tick_session(self, session_id: str) -> None:
        async with self.pool.acquire() as conn:
            s = await conn.fetchrow("SELECT status, symbol, category, interval_minutes FROM live_paper_sessions WHERE session_id=$1", session_id)
            if not s or s["status"] != "running":
                return
            bars = await self._fetch_bars(conn, s["symbol"], s["category"], s["interval_minutes"])
        mem = self._mem.get(session_id)
        if mem is None:
            mem = await self._build_mem(session_id, persist=True)   # rebuild after restart
            if mem is None:
                return
        new = [b for b in bars if int(b.ts.timestamp() * 1000) > mem["last_ts"]]
        if new:
            await self._advance_with_l2(mem, new)
        await self._persist(session_id, mem)

    async def _run(self) -> None:
        import time as _t
        while not self._stop.is_set():
            try:
                async with self.pool.acquire() as conn:
                    ids = [r["session_id"] for r in await conn.fetch(
                        "SELECT session_id FROM live_paper_sessions WHERE status='running'")]
                for sid in ids:
                    try:
                        await self._tick_session(sid)
                    except Exception:
                        pass
                self.last_cycle_ts = int(_t.time() * 1000)
                self.last_cycle_count = len(ids)
            except Exception:
                pass
            for _ in range(TICK_SECONDS):
                if self._stop.is_set():
                    break
                await asyncio.sleep(1)

    async def list_sessions(self, owner_id: str | None = None) -> list[dict]:
        async with self.pool.acquire() as conn:
            if owner_id is not None:
                rows = await conn.fetch("SELECT * FROM live_paper_sessions WHERE owner_id=$1 ORDER BY created_at DESC", int(owner_id))
            else:
                rows = await conn.fetch("SELECT * FROM live_paper_sessions ORDER BY created_at DESC")
        return [self._row(r) for r in rows]

    async def get_session(self, session_id: str) -> dict:
        async with self.pool.acquire() as conn:
            r = await conn.fetchrow("SELECT * FROM live_paper_sessions WHERE session_id=$1", session_id)
        return self._row(r) if r else {"error": "SESSION_NOT_FOUND"}

    def _row(self, r) -> dict:
        # The live book is forward-only by construction, so its metrics ARE the live
        # numbers (warmup primed indicators on a throwaway book and is stored separately).
        fe = float(r["final_equity"]) if r["final_equity"] is not None else None
        se = float(r["starting_equity"]) if r["starting_equity"] is not None else None
        perf = _j(r["performance_json"])
        live_return = perf.get("total_return", 0.0)
        live_pnl = (fe - se) if (fe is not None and se is not None) else 0.0
        live_fills = r["fills_count"] or 0
        warmup_ret = float(r["warmup_return"]) if r["warmup_return"] is not None else 0.0
        return {
            "session_id": r["session_id"], "owner_id": r["owner_id"], "strategy_id": r["strategy_id"],
            "symbol": r["symbol"], "category": r["category"], "status": r["status"],
            "starting_equity": str(r["starting_equity"]),
            "final_equity": str(r["final_equity"]) if r["final_equity"] is not None else None,
            # Forward (since-start) metrics — the honest "live" numbers:
            "live_return": live_return, "live_pnl": live_pnl, "live_fills": live_fills,
            "warmup_return": warmup_ret,   # context only (backtest over warmup history)
            "start_equity": str(r["start_equity"]) if r["start_equity"] is not None else None,
            "start_bar_ms": r["start_bar_ms"],
            "last_price": str(r["last_price"]) if r["last_price"] is not None else None,
            "fills_count": r["fills_count"], "bars_seen": r["bars_seen"],
            "last_bar_ms": r["last_bar_ms"],
            "last_tick_at": r["last_tick_at"].isoformat() if r["last_tick_at"] else None,
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "performance": _j(r["performance_json"]),
            "positions": _j(r["positions_json"]),
            "risk_state": _j(r["risk_state_json"]),
            "execution_fidelity": r["execution_fidelity"] if "execution_fidelity" in r else "bar_based",
            "fill_model": _j(r["fill_model_json"]) if "fill_model_json" in r else {},
            "checkpoint": _j(r["runtime_checkpoint_json"]) if "runtime_checkpoint_json" in r else {},
            "recovery_blocked_reason": r["recovery_blocked_reason"] if "recovery_blocked_reason" in r else None,
            "recovery_events": _j(r["recovery_events_json"]) if "recovery_events_json" in r else [],
            "recording": _j(r["recording_json"]) if "recording_json" in r else {},
        }

    def status(self) -> dict:
        return {"tick_seconds": TICK_SECONDS, "last_cycle_ts": self.last_cycle_ts,
                "last_cycle_count": self.last_cycle_count}
