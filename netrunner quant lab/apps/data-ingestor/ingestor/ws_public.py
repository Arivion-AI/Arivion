from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import suppress

import asyncpg
import redis.asyncio as redis
import websockets


class PublicWsCollector:
    def __init__(self, redis_url: str, ws_url: str, pool: asyncpg.Pool) -> None:
        self.redis = redis.from_url(redis_url)
        self.ws_url = ws_url
        self.pool = pool
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self._reconnect = asyncio.Event()
        self._lock = asyncio.Lock()
        self._symbols: set[str] = set()
        self._last_seq: dict[str, int] = {}

    async def start(self, symbols: list[str]) -> None:
        await self.update_symbols(symbols)
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(symbols))

    async def update_symbols(self, symbols: list[str]) -> None:
        clean = {str(s).strip().upper() for s in symbols if str(s).strip()}
        if not clean:
            return
        async with self._lock:
            changed = not clean.issubset(self._symbols)
            self._symbols |= clean
        if changed:
            self._reconnect.set()

    async def current_symbols(self) -> list[str]:
        async with self._lock:
            return sorted(self._symbols)

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            with suppress(asyncio.CancelledError):
                self._task.cancel()
                await self._task
        await self.redis.close()

    async def _run(self, _symbols: list[str]) -> None:
        while not self._stop.is_set():
            try:
                symbols = await self.current_symbols()
                if not symbols:
                    await asyncio.sleep(1)
                    continue
                topics = [f"tickers.{symbol}" for symbol in symbols] + [f"orderbook.50.{symbol}" for symbol in symbols]
                self._reconnect.clear()
                async with websockets.connect(self.ws_url, ping_interval=20, ping_timeout=20) as ws:
                    await ws.send(json.dumps({"op": "subscribe", "args": topics}))
                    while not self._stop.is_set():
                        if self._reconnect.is_set():
                            break
                        raw = await asyncio.wait_for(ws.recv(), timeout=5)
                        payload = json.loads(raw)
                        await self._handle_message(payload)
            except Exception:
                await asyncio.sleep(2)

    async def _handle_message(self, payload: dict) -> None:
        now_ms = int(time.time() * 1000)
        topic = payload.get("topic")
        if not topic:
            return
        parts = topic.split(".")
        symbol = parts[-1] if parts else "unknown"

        await self.redis.set(f"latest:{symbol}:ts", now_ms)
        await self.redis.set(f"ws:heartbeat:{symbol}", now_ms)

        if topic.startswith("orderbook."):
            data = payload.get("data") or {}
            bids = data.get("b") or data.get("bids") or []
            asks = data.get("a") or data.get("asks") or []
            seq = data.get("seq") or payload.get("cts") or payload.get("ts")
            if seq is not None:
                seq_n = int(seq)
                prev = self._last_seq.get(symbol)
                if prev is not None and seq_n <= prev:
                    return
                self._last_seq[symbol] = seq_n
            checksum = str(data.get("checksum") or "")
            best_bid = None
            best_ask = None
            if bids:
                best_bid = bids[0][0] if isinstance(bids[0], list) and len(bids[0]) > 0 else None
            if asks:
                best_ask = asks[0][0] if isinstance(asks[0], list) and len(asks[0]) > 0 else None

            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO l2_snapshots (
                      ts, symbol, category, sequence_id, checksum, best_bid, best_ask,
                      bid_levels_json, ask_levels_json, source_fetched_at, data_version
                    ) VALUES (
                      to_timestamp($1 / 1000.0), $2, 'linear', $3, $4, $5, $6,
                      $7::jsonb, $8::jsonb, NOW(), 'v1'
                    )
                    ON CONFLICT (symbol, category, ts, sequence_id)
                    DO NOTHING
                    """,
                    int(payload.get("ts", now_ms)),
                    symbol,
                    int(seq) if seq is not None else None,
                    checksum if checksum else None,
                    str(best_bid) if best_bid is not None else None,
                    str(best_ask) if best_ask is not None else None,
                    json.dumps(bids),
                    json.dumps(asks),
                )


def build_default_collector(pool: asyncpg.Pool) -> PublicWsCollector:
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
    ws_url = os.getenv("BYBIT_WS_PUBLIC_LINEAR", "wss://stream.bybit.com/v5/public/linear")
    return PublicWsCollector(redis_url=redis_url, ws_url=ws_url, pool=pool)
