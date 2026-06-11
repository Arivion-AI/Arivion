"""Demand-driven realtime price poller for paper trading.

Polls Bybit's PUBLIC REST kline endpoint every ``LIVE_POLL_SECONDS`` (default 60s)
for ONLY the symbols that currently have an active subscription (i.e. a running
paper session). This keeps us far under Bybit's 600-req/5s IP limit — even 50 live
symbols once a minute is < 1 req/s — while giving paper trading fresh 1-minute bars.

Covers BOTH categories:
  * crypto perps  -> category="linear"
  * crypto spot / tokenized equities (xStocks) -> category="spot"

Each poll upserts the latest closed klines into ``candles`` (so backtests/charts see
them) and updates a ``live_prices`` table with the freshest mark + age, which the API
and UI read to drive realtime paper trading.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import time

import asyncpg
import httpx

BYBIT_BASE_URL = os.getenv("BYBIT_BASE_URL", "https://api.bybit.com")
LIVE_POLL_SECONDS = int(os.getenv("LIVE_POLL_SECONDS", "60"))


def _norm_interval(interval: str) -> str:
    return "D" if str(interval).upper() in ("D", "1D", "DAY") else str(interval)


class LivePoller:
    """Polls only the subscribed (symbol, category, interval) tuples on an interval."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.client = httpx.AsyncClient(base_url=BYBIT_BASE_URL, timeout=20.0)
        self._subs: dict[tuple[str, str, str], float] = {}   # (symbol,category,interval) -> subscribed_at
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self.last_cycle_ts: int | None = None
        self.last_cycle_polled: int = 0

    async def ensure_table(self) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS live_prices (
                  symbol TEXT NOT NULL,
                  category TEXT NOT NULL,
                  interval TEXT NOT NULL,
                  last_close NUMERIC,
                  last_open_ms BIGINT,
                  updated_at TIMESTAMPTZ DEFAULT NOW(),
                  PRIMARY KEY (symbol, category, interval)
                )
                """
            )

    async def start(self) -> None:
        await self.ensure_table()
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
        await self.client.aclose()

    async def subscribe(self, items: list[dict]) -> list[dict]:
        async with self._lock:
            for it in items:
                sym = str(it.get("symbol", "")).strip().upper()
                if not sym:
                    continue
                cat = str(it.get("category") or ("spot" if sym.endswith("XUSDT") else "linear"))
                interval = _norm_interval(it.get("interval") or "1")
                self._subs[(sym, cat, interval)] = time.time()
        # Poll immediately so the UI gets data without waiting a full cycle.
        await self.poll_once()
        return await self.current_subscriptions()

    async def unsubscribe(self, items: list[dict]) -> None:
        async with self._lock:
            for it in items:
                sym = str(it.get("symbol", "")).strip().upper()
                cat = str(it.get("category") or ("spot" if sym.endswith("XUSDT") else "linear"))
                interval = _norm_interval(it.get("interval") or "1")
                self._subs.pop((sym, cat, interval), None)

    async def current_subscriptions(self) -> list[dict]:
        async with self._lock:
            return [{"symbol": s, "category": c, "interval": i} for (s, c, i) in self._subs]

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await self.poll_once()
            except Exception:
                pass
            for _ in range(LIVE_POLL_SECONDS):
                if self._stop.is_set():
                    break
                await asyncio.sleep(1)

    async def poll_once(self) -> int:
        async with self._lock:
            subs = list(self._subs.keys())
        polled = 0
        for (symbol, category, interval) in subs:
            try:
                await self._poll_symbol(symbol, category, interval)
                polled += 1
            except Exception:
                pass
            await asyncio.sleep(0.15)  # gentle pacing; well under rate limit
        self.last_cycle_ts = int(time.time() * 1000)
        self.last_cycle_polled = polled
        return polled

    async def _poll_symbol(self, symbol: str, category: str, interval: str) -> None:
        # Fetch the most recent few klines (no start/end => latest).
        resp = await self.client.get(
            "/v5/market/kline",
            params={"category": category, "symbol": symbol, "interval": interval, "limit": 3},
        )
        resp.raise_for_status()
        rows = resp.json().get("result", {}).get("list", [])
        if not rows:
            return
        # Bybit returns newest-first; store ascending.
        rows = sorted(rows, key=lambda r: int(r[0]))
        async with self.pool.acquire() as conn:
            for row in rows:
                open_ms = int(row[0])
                checksum = hashlib.sha256("|".join(row).encode("utf-8")).hexdigest()
                await conn.execute(
                    """
                    INSERT INTO candles (symbol, category, interval, open_time, open, high, low, close, volume, turnover, data_version, checksum)
                    VALUES ($1,$2,$3, to_timestamp($4/1000.0), $5,$6,$7,$8,$9,$10,'live-v1',$11)
                    ON CONFLICT (symbol, category, interval, open_time) DO UPDATE SET
                      open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close,
                      volume=EXCLUDED.volume, turnover=EXCLUDED.turnover, source_fetched_at=NOW()
                    """,
                    symbol, category, interval, open_ms,
                    row[1], row[2], row[3], row[4],
                    row[5] if len(row) > 5 else "0", row[6] if len(row) > 6 else "0", checksum,
                )
            last = rows[-1]
            await conn.execute(
                """
                INSERT INTO live_prices (symbol, category, interval, last_close, last_open_ms, updated_at)
                VALUES ($1,$2,$3,$4,$5,NOW())
                ON CONFLICT (symbol, category, interval) DO UPDATE SET
                  last_close=EXCLUDED.last_close, last_open_ms=EXCLUDED.last_open_ms, updated_at=NOW()
                """,
                symbol, category, interval, last[4], int(last[0]),
            )

    async def prices_fresh(self, max_age_ms: int = 60000) -> tuple[list[dict], bool]:
        """Return live prices, auto-pulling fresh data first if anything exceeds
        ``max_age_ms`` (default 60s) — the ‘>1 min gap => pull live’ guarantee."""
        rows = await self.prices()
        # Subscribed but never priced, or any row stale -> repoll once, then re-read.
        async with self._lock:
            subbed = len(self._subs)
        stale = any(r["age_ms"] > max_age_ms for r in rows) or (subbed > len(rows))
        if stale and subbed > 0:
            await self.poll_once()
            return await self.prices(), True
        return rows, False

    async def prices(self) -> list[dict]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT symbol, category, interval, last_close,
                          EXTRACT(EPOCH FROM (NOW()-updated_at))*1000 AS age_ms, last_open_ms
                   FROM live_prices ORDER BY symbol"""
            )
        return [{"symbol": r["symbol"], "category": r["category"], "interval": r["interval"],
                 "last_close": str(r["last_close"]), "age_ms": int(r["age_ms"]),
                 "last_open_ms": int(r["last_open_ms"]) if r["last_open_ms"] else None,
                 "fresh": int(r["age_ms"]) < (LIVE_POLL_SECONDS * 1000 * 2)} for r in rows]

    async def fetch_xstock_instruments(self) -> list[dict]:
        """Live truth from Bybit: spot pairs with symbolType=='xstocks' + xstockMultiplier.
        Used to verify the catalog never drifts to unlisted/phantom symbols."""
        resp = await self.client.get("/v5/market/instruments-info", params={"category": "spot"})
        resp.raise_for_status()
        items = resp.json().get("result", {}).get("list", [])
        out = []
        for it in items:
            if str(it.get("symbolType", "")).lower() == "xstocks":   # strict: real tokenized equities only
                out.append({
                    "symbol": it.get("symbol"),
                    "base_coin": it.get("baseCoin"),
                    "quote_coin": it.get("quoteCoin"),
                    "xstock_multiplier": str(it.get("xstockMultiplier", "1")),
                    "status": it.get("status"),
                    "symbol_type": it.get("symbolType"),
                })
        return out

    def status(self) -> dict:
        return {"poll_seconds": LIVE_POLL_SECONDS, "last_cycle_ts": self.last_cycle_ts,
                "last_cycle_polled": self.last_cycle_polled, "n_subscriptions": len(self._subs)}
