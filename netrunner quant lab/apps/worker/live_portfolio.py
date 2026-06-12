"""Persistent server-side MULTI-ASSET (portfolio) paper-trading sessions.

The single-bot analog (live_paper.py) advances a stateful PaperRuntime per tick. A
multi-asset basket is rebalanced as ONE book, and the portfolio engine
(quant_core.portfolio_engine.run_portfolio) is a deterministic one-shot batch — so a
portfolio paper session simply RE-RUNS run_portfolio over the freshly-fetched candle
window on each tick. A single background loop advances ALL running portfolio sessions
every LIVE_PORTFOLIO_TICK_SECONDS by reading the freshest candles (kept current by the
data-ingestor) per leg. No client driver loop.

State is persisted to ``live_portfolio_sessions`` and published to ``rt:session:{owner}``
so the UI/agent monitor see live equity / weights / rebalances / risk state.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from decimal import Decimal

import asyncpg
import redis.asyncio as _redis

from quant_core.orders import Bar as RuntimeBar
from quant_core.portfolio_engine import PortfolioLeg as _PortfolioLeg, run_portfolio as _run_portfolio

TICK_SECONDS = int(os.getenv("LIVE_PORTFOLIO_TICK_SECONDS", os.getenv("LIVE_PAPER_TICK_SECONDS", "30")))
WARMUP_LIMIT = int(os.getenv("LIVE_PORTFOLIO_BARS", "1000"))


def _j(v):
    if v is None:
        return {}
    if isinstance(v, (dict, list)):
        return v
    try:
        return json.loads(v)
    except Exception:
        return {}


class LivePortfolioManager:
    """Runs persistent multi-asset paper sessions by re-running the deterministic
    portfolio engine over the growing real candle series each tick."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self.last_cycle_ts: int | None = None
        self.last_cycle_count: int = 0
        self.redis = _redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))

    async def ensure_table(self) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS live_portfolio_sessions (
                  session_id        TEXT PRIMARY KEY,
                  owner_id          BIGINT,
                  weighting         TEXT NOT NULL DEFAULT 'fixed',
                  legs_json         JSONB NOT NULL DEFAULT '[]'::jsonb,
                  total_equity      NUMERIC NOT NULL DEFAULT 10000,
                  interval_minutes  INT NOT NULL DEFAULT 60,
                  risk_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
                  rebalance_threshold NUMERIC NOT NULL DEFAULT 0.05,
                  lookback_bars     INT NOT NULL DEFAULT 20,
                  top_n             INT NOT NULL DEFAULT 3,
                  status            TEXT NOT NULL DEFAULT 'running',
                  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
                  last_tick_at      TIMESTAMPTZ,
                  last_bar_ms       BIGINT,
                  start_bar_ms      BIGINT,
                  rebalances        INT NOT NULL DEFAULT 0,
                  final_equity      NUMERIC,
                  fills_count       INT NOT NULL DEFAULT 0,
                  performance_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
                  positions_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
                  risk_state_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
                  weights_history_json JSONB NOT NULL DEFAULT '[]'::jsonb
                );
                CREATE INDEX IF NOT EXISTS live_portfolio_sessions_owner_idx
                  ON live_portfolio_sessions (owner_id, status, created_at DESC);
                """
            )

    async def start(self) -> None:
        await self.ensure_table()
        if self._task is None:
            self._stop.clear()
            self._task = asyncio.create_task(self._run())

    async def stop_loop(self) -> None:
        self._stop.set()
        if self._task:
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    def status(self) -> dict:
        return {"loop": self._task is not None and not self._task.done(),
                "tick_seconds": TICK_SECONDS, "last_cycle_ts": self.last_cycle_ts,
                "last_cycle_count": self.last_cycle_count}

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                async with self.pool.acquire() as conn:
                    ids = [r["session_id"] for r in await conn.fetch(
                        "SELECT session_id FROM live_portfolio_sessions WHERE status='running'")]
                for sid in ids:
                    try:
                        await self._tick_session(sid)
                    except Exception:
                        pass
                self.last_cycle_ts = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
                self.last_cycle_count = len(ids)
            except Exception:
                pass
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=TICK_SECONDS)
            except asyncio.TimeoutError:
                pass

    async def _fetch_bars(self, conn, symbol: str, category: str, interval_minutes: int) -> list[RuntimeBar]:
        interval = "1" if interval_minutes == 1 else ("D" if interval_minutes == 1440 else str(interval_minutes))
        rows = await conn.fetch(
            """SELECT EXTRACT(EPOCH FROM open_time)*1000 AS ts, open, high, low, close, volume
               FROM candles WHERE symbol=$1 AND category=$2 AND interval=$3
               ORDER BY open_time DESC LIMIT $4""",
            symbol, category, interval, WARMUP_LIMIT,
        )
        rows = list(reversed(rows))
        return [RuntimeBar(
            ts=datetime.fromtimestamp(int(r["ts"]) / 1000, tz=timezone.utc),
            open=Decimal(str(r["open"])), high=Decimal(str(r["high"])),
            low=Decimal(str(r["low"])), close=Decimal(str(r["close"])),
            volume=Decimal(str(r["volume"] or 0)),
        ) for r in rows]

    async def create_session(self, *, session_id: str, owner_id: str, legs: list[dict],
                             weighting: str = "fixed", total_equity: str = "10000",
                             interval_minutes: int = 60, risk: dict | None = None,
                             rebalance_threshold: str = "0.05", lookback_bars: int = 20,
                             top_n: int = 3) -> dict:
        risk = risk or {}
        async with self.pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO live_portfolio_sessions
                     (session_id, owner_id, weighting, legs_json, total_equity, interval_minutes,
                      risk_json, rebalance_threshold, lookback_bars, top_n, status, created_at)
                   VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10,'running',now())
                   ON CONFLICT (session_id) DO UPDATE SET
                     legs_json=EXCLUDED.legs_json, weighting=EXCLUDED.weighting, status='running'""",
                session_id, int(owner_id), weighting, json.dumps(legs), str(total_equity),
                int(interval_minutes), json.dumps(risk), str(rebalance_threshold), int(lookback_bars), int(top_n),
            )
        # Prime it immediately so the caller gets a populated session back.
        await self._tick_session(session_id, first=True)
        return await self.get_session(session_id)

    async def _tick_session(self, session_id: str, first: bool = False) -> None:
        async with self.pool.acquire() as conn:
            s = await conn.fetchrow("SELECT * FROM live_portfolio_sessions WHERE session_id=$1", session_id)
            if not s or s["status"] != "running":
                return
            legs_cfg = _j(s["legs_json"])
            built: list[_PortfolioLeg] = []
            first_ts: int | None = None
            for lc in legs_cfg:
                bars = await self._fetch_bars(conn, lc["symbol"].upper(), lc.get("category", "linear"), int(s["interval_minutes"]))
                if bars:
                    ft = int(bars[0].ts.timestamp() * 1000)
                    first_ts = ft if first_ts is None else min(first_ts, ft)
                built.append(_PortfolioLeg(
                    symbol=lc["symbol"].upper(), bars=bars, asset_class=lc.get("asset_class", "crypto"),
                    category=lc.get("category", "linear"), target_weight=Decimal(str(lc.get("target_weight", 0))),
                    leverage=Decimal(str(lc.get("leverage", 1))), allow_short=bool(lc.get("allow_short", False)),
                ))
        if not any(l.bars for l in built):
            return

        res = _run_portfolio(
            legs=built, weighting=s["weighting"], total_equity=Decimal(str(s["total_equity"])),
            rebalance_threshold=Decimal(str(s["rebalance_threshold"])), lookback_bars=int(s["lookback_bars"]),
            top_n=int(s["top_n"]), interval_minutes=int(s["interval_minutes"]), risk=_j(s["risk_json"]),
        )
        last_bar_ms = res.timestamps[-1] if res.timestamps else None
        start_bar_ms = s["start_bar_ms"] or (res.timestamps[0] if res.timestamps else first_ts)
        async with self.pool.acquire() as conn:
            await conn.execute(
                """UPDATE live_portfolio_sessions SET
                     last_tick_at=now(), last_bar_ms=$2, start_bar_ms=COALESCE(start_bar_ms,$3),
                     rebalances=$4, final_equity=$5, fills_count=$6, performance_json=$7::jsonb,
                     positions_json=$8::jsonb, risk_state_json=$9::jsonb, weights_history_json=$10::jsonb
                   WHERE session_id=$1""",
                session_id, last_bar_ms, start_bar_ms, res.rebalances, str(res.final_equity), len(res.fills),
                json.dumps(res.metrics), json.dumps(res.positions), json.dumps(res.risk_state),
                json.dumps(res.weights_history[-50:]),
            )
            owner = int(s["owner_id"]) if s["owner_id"] is not None else 0
        # Publish a snapshot so the agent monitor / UI can react (same channel single-bot uses).
        snap = {"kind": "portfolio", "session_id": session_id, "owner_id": owner,
                "final_equity": str(res.final_equity), "metrics": res.metrics,
                "rebalances": res.rebalances, "risk_state": res.risk_state}
        try:
            await self.redis.publish(f"rt:session:{owner}", json.dumps(snap, default=str))
        except Exception:
            pass

    async def stop_session(self, session_id: str) -> dict:
        async with self.pool.acquire() as conn:
            await conn.execute("UPDATE live_portfolio_sessions SET status='stopped' WHERE session_id=$1", session_id)
        return await self.get_session(session_id)

    async def get_session(self, session_id: str) -> dict:
        async with self.pool.acquire() as conn:
            r = await conn.fetchrow("SELECT * FROM live_portfolio_sessions WHERE session_id=$1", session_id)
        return self._row(r) if r else {"error": "SESSION_NOT_FOUND", "session_id": session_id}

    async def list_sessions(self, owner_id: str | None = None) -> list[dict]:
        async with self.pool.acquire() as conn:
            if owner_id is not None:
                rows = await conn.fetch(
                    "SELECT * FROM live_portfolio_sessions WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100", int(owner_id))
            else:
                rows = await conn.fetch("SELECT * FROM live_portfolio_sessions ORDER BY created_at DESC LIMIT 100")
        return [self._row(r) for r in rows]

    def _row(self, r) -> dict:
        return {
            "session_id": r["session_id"], "owner_id": r["owner_id"], "weighting": r["weighting"],
            "legs": _j(r["legs_json"]), "total_equity": str(r["total_equity"]),
            "interval_minutes": r["interval_minutes"], "status": r["status"],
            "final_equity": str(r["final_equity"]) if r["final_equity"] is not None else None,
            "rebalances": r["rebalances"], "fills_count": r["fills_count"],
            "performance": _j(r["performance_json"]), "positions": _j(r["positions_json"]),
            "risk_state": _j(r["risk_state_json"]), "weights_history": _j(r["weights_history_json"]),
            "last_bar_ms": r["last_bar_ms"], "start_bar_ms": r["start_bar_ms"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        }
