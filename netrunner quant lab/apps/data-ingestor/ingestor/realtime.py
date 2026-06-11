"""Realtime Bybit public-WebSocket collector (Phase 3).

Holds one WS connection per category (spot + linear), subscribes to
``kline.1.{symbol}`` + ``tickers.{symbol}`` for the demand set (symbols of active
live-paper sessions / live subscriptions), and on each message:

  * upserts the 1-minute candle (provisional while forming, finalized on confirm)
  * updates ``live_prices``
  * publishes to Redis pub/sub for SSE fan-out and bar-synchronous paper trading:
      rt:price:{symbol}     - sub-second last price (ticker)
      rt:bar:{symbol}       - forming/confirmed 1m candle
      rt:barclose:{symbol}  - emitted only when confirm=true (authoritative close)

Demand is the UNION of explicit live subscriptions and every running live-paper
session — so starting a session auto-subscribes its symbol within ~10s. The REST
poller remains as a gap-fill backstop. Forming bars are display-only; the paper
engine must act on confirmed (closed) bars to preserve no-lookahead.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time

import asyncpg
import httpx
import redis.asyncio as redis
import websockets

BYBIT_BASE_URL = os.getenv("BYBIT_BASE_URL", "https://api.bybit.com")
WS_URLS = {
    "linear": os.getenv("BYBIT_WS_PUBLIC_LINEAR", "wss://stream.bybit.com/v5/public/linear"),
    "spot": os.getenv("BYBIT_WS_PUBLIC_SPOT", "wss://stream.bybit.com/v5/public/spot"),
}
WRITE_THROTTLE_S = float(os.getenv("RT_WRITE_THROTTLE_S", "1.5"))
SESSION_RECORDING_GRACE_SECONDS = float(os.getenv("SESSION_RECORDING_GRACE_SECONDS", "60"))


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _l2_depth() -> int:
    try:
        depth = int(float(os.getenv("L2_DEPTH", "50")))
    except (TypeError, ValueError):
        depth = 50
    return depth if depth in (50, 200, 1000) else 50


class RealtimeCollector:
    def __init__(self, pool: asyncpg.Pool, redis_url: str) -> None:
        self.pool = pool
        self.redis = redis.from_url(redis_url)
        self._http = httpx.AsyncClient(base_url=BYBIT_BASE_URL, timeout=15.0)
        self._desired: dict[str, set[str]] = {"linear": set(), "spot": set()}
        # Opt-in L2 (orderbook depth) recording — demand-driven, only for symbols a
        # user is verifying (so execution bots can earn a VERIFIED tier) WITHOUT the
        # firehose storage cost of recording L2 for everything.
        self._l2_desired: dict[str, set[str]] = {"linear": set(), "spot": set()}
        self._trade_desired: dict[str, set[str]] = {"linear": set(), "spot": set()}
        self._manual_l2: dict[str, set[str]] = {"linear": set(), "spot": set()}
        self._manual_trades: dict[str, set[str]] = {"linear": set(), "spot": set()}
        self._session_l2: dict[str, set[str]] = {"linear": set(), "spot": set()}
        self._session_trades: dict[str, set[str]] = {"linear": set(), "spot": set()}
        self._session_recording_seen: dict[tuple[str, str, str], float] = {}
        self._l2_seq: dict[str, int] = {}
        self._books: dict[str, dict[str, dict[str, str]]] = {}
        self._trade_ids: dict[str, set[str]] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._stop = asyncio.Event()
        self._last_write: dict[str, float] = {}
        self.stats = {c: {"connected": False, "klines": 0, "tickers": 0, "barcloses": 0,
                          "l2_snapshots": 0, "trades": 0, "last_msg_ms": None,
                          "symbols": 0, "l2_symbols": 0, "trade_symbols": 0}
                      for c in ("linear", "spot")}

    def set_demand(self, items: list[dict]) -> None:
        for it in items:
            sym = str(it.get("symbol", "")).strip().upper()
            if not sym:
                continue
            cat = str(it.get("category") or ("spot" if sym.endswith("XUSDT") else "linear"))
            if cat in self._desired:
                self._desired[cat].add(sym)

    def _recording_target(self, manual: bool, feed: str) -> dict[str, set[str]]:
        if feed == "l2":
            return self._manual_l2 if manual else self._session_l2
        return self._manual_trades if manual else self._session_trades

    def _recompute_recording_demand(self) -> None:
        for cat in ("linear", "spot"):
            self._l2_desired[cat] = set(self._manual_l2[cat]) | set(self._session_l2[cat])
            self._trade_desired[cat] = set(self._manual_trades[cat]) | set(self._session_trades[cat])
            for sym in self._l2_desired[cat] | self._trade_desired[cat]:
                self._desired[cat].add(sym)

    def set_l2_demand(self, items: list[dict], enable: bool = True, manual: bool = True) -> dict:
        target = self._recording_target(manual, "l2")
        for it in items:
            sym = str(it.get("symbol", "")).strip().upper()
            if not sym:
                continue
            cat = str(it.get("category") or ("spot" if sym.endswith("XUSDT") else "linear"))
            if cat not in target:
                continue
            if enable:
                target[cat].add(sym)
                self._desired[cat].add(sym)   # also stream its price/bars
            else:
                target[cat].discard(sym)
        self._recompute_recording_demand()
        return {k: sorted(v) for k, v in self._l2_desired.items()}

    def set_trade_demand(self, items: list[dict], enable: bool = True, manual: bool = True) -> dict:
        target = self._recording_target(manual, "trades")
        for it in items:
            sym = str(it.get("symbol", "")).strip().upper()
            if not sym:
                continue
            cat = str(it.get("category") or ("spot" if sym.endswith("XUSDT") else "linear"))
            if cat not in target:
                continue
            if enable:
                target[cat].add(sym)
                self._desired[cat].add(sym)
            else:
                target[cat].discard(sym)
        self._recompute_recording_demand()
        return {k: sorted(v) for k, v in self._trade_desired.items()}

    async def _refresh_from_db(self) -> None:
        async with self.pool.acquire() as conn:
            try:
                rows = await conn.fetch(
                    "SELECT DISTINCT symbol, category, execution_fidelity FROM live_paper_sessions WHERE status='running'")
            except Exception:
                rows = await conn.fetch(
                    "SELECT DISTINCT symbol, category, 'bar_based' AS execution_fidelity FROM live_paper_sessions WHERE status='running'")
        now = time.time()
        active_keys: set[tuple[str, str, str]] = set()
        for r in rows:
            cat = r["category"] if r["category"] in self._desired else "linear"
            sym = str(r["symbol"]).upper()
            self._desired[cat].add(sym)
            try:
                raw_fid = r["execution_fidelity"]
            except Exception:
                raw_fid = "bar_based"
            fid = str(raw_fid or "bar_based").lower()
            if fid in ("l2_sweep", "l2_queue"):
                active_keys.add((cat, sym, "l2"))
                self._session_recording_seen[(cat, sym, "l2")] = now
            if fid == "l2_queue":
                active_keys.add((cat, sym, "trades"))
                self._session_recording_seen[(cat, sym, "trades")] = now
        for cat in ("linear", "spot"):
            self._session_l2[cat].clear()
            self._session_trades[cat].clear()
        for key, last_seen in list(self._session_recording_seen.items()):
            cat, sym, feed = key
            if key not in active_keys and now - last_seen > SESSION_RECORDING_GRACE_SECONDS:
                self._session_recording_seen.pop(key, None)
                continue
            if feed == "l2":
                self._session_l2[cat].add(sym)
            else:
                self._session_trades[cat].add(sym)
        self._recompute_recording_demand()

    async def start(self) -> None:
        self._stop.clear()
        for cat in ("linear", "spot"):
            self._tasks[cat] = asyncio.create_task(self._run_category(cat))
        self._tasks["demand"] = asyncio.create_task(self._demand_loop())

    async def stop(self) -> None:
        self._stop.set()
        for t in self._tasks.values():
            t.cancel()
        await self.redis.close()

    async def _demand_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self._refresh_from_db()
            except Exception:
                pass
            await asyncio.sleep(10)

    async def _run_category(self, cat: str) -> None:
        while not self._stop.is_set():
            symbols = sorted(self._desired[cat])
            l2syms = sorted(self._l2_desired[cat])
            tradesyms = sorted(self._trade_desired[cat])
            self.stats[cat]["symbols"] = len(symbols)
            self.stats[cat]["l2_symbols"] = len(l2syms)
            self.stats[cat]["trade_symbols"] = len(tradesyms)
            if not symbols and not l2syms:
                await asyncio.sleep(2)
                continue
            current = (frozenset(symbols), frozenset(l2syms), frozenset(tradesyms))
            depth = _l2_depth()
            topics = ([f"kline.1.{s}" for s in symbols] + [f"tickers.{s}" for s in symbols]
                      + [f"orderbook.{depth}.{s}" for s in l2syms]
                      + [f"publicTrade.{s}" for s in tradesyms])
            try:
                async with websockets.connect(WS_URLS[cat], ping_interval=20, ping_timeout=20) as ws:
                    for i in range(0, len(topics), 10):   # Bybit caps args per subscribe message
                        await ws.send(json.dumps({"op": "subscribe", "args": topics[i:i + 10]}))
                    self.stats[cat]["connected"] = True
                    while not self._stop.is_set():
                        if (frozenset(self._desired[cat]), frozenset(self._l2_desired[cat]),
                                frozenset(self._trade_desired[cat])) != current:
                            break  # demand changed -> reconnect & resubscribe
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=5)
                        except asyncio.TimeoutError:
                            continue
                        await self._handle(cat, json.loads(raw))
            except Exception:
                pass
            self.stats[cat]["connected"] = False
            await asyncio.sleep(2)

    async def _handle(self, cat: str, m: dict) -> None:
        topic = m.get("topic", "")
        if topic.startswith("kline."):
            sym = topic.split(".")[-1]
            for d in (m.get("data") or []):
                await self._on_kline(sym, cat, d)
        elif topic.startswith("tickers."):
            sym = topic.split(".")[-1]
            d = m.get("data") or {}
            lp = d.get("lastPrice")
            if lp:
                self.stats[cat]["tickers"] += 1
                self.stats[cat]["last_msg_ms"] = int(time.time() * 1000)
                await self.redis.publish(f"rt:price:{sym}", json.dumps(
                    {"symbol": sym, "price": str(lp), "ts": int(time.time() * 1000)}))
        elif topic.startswith("orderbook."):
            await self._on_orderbook(cat, m)
        elif topic.startswith("publicTrade."):
            await self._on_public_trade(cat, m)

    async def _on_orderbook(self, cat: str, m: dict) -> None:
        d = m.get("data") or {}
        sym = d.get("s") or m.get("topic", "").split(".")[-1]
        key = f"{cat}:{sym}"
        book = self._books.setdefault(key, {"b": {}, "a": {}})
        bids_delta = d.get("b") or []
        asks_delta = d.get("a") or []
        seq = d.get("seq") or m.get("cts") or m.get("ts")
        if seq is not None:
            seq_n = int(seq)
            if self._l2_seq.get(key) is not None and seq_n <= self._l2_seq[key]:
                return
            self._l2_seq[key] = seq_n
        if str(m.get("type", "")).lower() == "snapshot":
            book["b"] = {}
            book["a"] = {}

        def apply(side: str, rows: list) -> None:
            for row in rows:
                if not isinstance(row, list) or len(row) < 2:
                    continue
                price, size = str(row[0]), str(row[1])
                try:
                    is_zero = float(size) == 0.0
                except ValueError:
                    is_zero = size == "0"
                if is_zero:
                    book[side].pop(price, None)
                else:
                    book[side][price] = size

        apply("b", bids_delta)
        apply("a", asks_delta)
        depth = _l2_depth()
        bids = [[p, s] for p, s in sorted(book["b"].items(), key=lambda x: float(x[0]), reverse=True)[:depth]]
        asks = [[p, s] for p, s in sorted(book["a"].items(), key=lambda x: float(x[0]))[:depth]]
        best_bid = bids[0][0] if bids and isinstance(bids[0], list) else None
        best_ask = asks[0][0] if asks and isinstance(asks[0], list) else None
        ts_ms = int(m.get("ts", time.time() * 1000))
        async with self.pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO l2_snapshots (ts, symbol, category, sequence_id, checksum,
                       best_bid, best_ask, bid_levels_json, ask_levels_json, source_fetched_at, data_version)
                   VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, NOW(), 'rt-l2-v1')
                   ON CONFLICT (symbol, category, ts, sequence_id) DO NOTHING""",
                ts_ms, sym, cat, int(seq) if seq is not None else None,
                str(d.get("checksum") or d.get("u") or ""), str(best_bid) if best_bid else None,
                str(best_ask) if best_ask else None, json.dumps(bids), json.dumps(asks))
        self.stats[cat]["l2_snapshots"] += 1
        self.stats[cat]["last_msg_ms"] = int(time.time() * 1000)

    async def _on_public_trade(self, cat: str, m: dict) -> None:
        topic = m.get("topic", "")
        sym_from_topic = topic.split(".")[-1] if topic else ""
        rows = m.get("data") or []
        if isinstance(rows, dict):
            rows = [rows]
        if not rows:
            return
        values = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            sym = str(row.get("s") or sym_from_topic).upper()
            trade_id = str(row.get("i") or row.get("tradeId") or f"{row.get('T')}-{row.get('p')}-{row.get('v')}-{row.get('S')}")
            key = f"{cat}:{sym}"
            seen = self._trade_ids.setdefault(key, set())
            if trade_id in seen:
                continue
            seen.add(trade_id)
            if len(seen) > 50_000:
                self._trade_ids[key] = set(list(seen)[-25_000:])
            try:
                ts_ms = int(row.get("T") or m.get("ts") or time.time() * 1000)
                price = str(row.get("p"))
                qty = str(row.get("v") or row.get("qty"))
                side = str(row.get("S") or row.get("side"))
            except Exception:
                continue
            if not price or not qty or side not in ("Buy", "Sell", "buy", "sell"):
                continue
            values.append((ts_ms, sym, trade_id, side.capitalize(), price, qty))
        if not values:
            return
        async with self.pool.acquire() as conn:
            await conn.executemany(
                """INSERT INTO trades (
                     ts, trade_time_ms, symbol, category, trade_id, side, price, qty,
                     source_fetched_at, data_version
                   ) VALUES (
                     to_timestamp($1/1000.0), $1, $2, $3, $4, $5, $6, $7, NOW(), 'rt-trade-v1'
                   )
                   ON CONFLICT (symbol, category, trade_id, ts) DO NOTHING""",
                [(ts, sym, cat, tid, side, price, qty) for ts, sym, tid, side, price, qty in values],
            )
        self.stats[cat]["trades"] += len(values)
        self.stats[cat]["last_msg_ms"] = int(time.time() * 1000)
        # Publish to Redis for SSE fan-out / bar-synchronous consumers (Phase 3).
        # Per-symbol batches keep ordering; individual prints support fine-grained listeners.
        by_sym: dict[str, list] = {}
        for ts, sym, tid, side, price, qty in values:
            by_sym.setdefault(sym, []).append(
                {"trade_id": tid, "ts": ts, "price": price, "qty": qty, "side": side, "category": cat})
        for sym, prints in by_sym.items():
            try:
                await self.redis.publish(f"rt:trade_batch:{sym}", json.dumps({"symbol": sym, "category": cat, "trades": prints}))
                for p in prints:
                    await self.redis.publish(f"rt:trade:{sym}", json.dumps({"symbol": sym, **p}))
            except Exception:
                pass

    async def seed_recent_trades(self, symbol: str, category: str, limit: int = 1000) -> int:
        """Seed the latest recent trades from Bybit REST (/v5/market/recent-trade) when a
        symbol is first enabled. This is NOT historical backfill — only what Bybit returns
        (≤1000 most-recent prints). Marked data_version='rest-recent-trade-v1' to distinguish
        from the realtime WS feed."""
        sym = symbol.upper()
        cat = category if category in ("linear", "spot") else "linear"
        try:
            resp = await self._http.get(
                "/v5/market/recent-trade",
                params={"category": cat, "symbol": sym, "limit": min(int(limit), 1000)},
            )
            data = (resp.json().get("result") or {}).get("list") or []
        except Exception:
            return 0
        rows = []
        seen = self._trade_ids.setdefault(f"{cat}:{sym}", set())
        for t in data:
            try:
                tid = str(t.get("execId") or t.get("i") or f"{t.get('time')}-{t.get('price')}-{t.get('size')}-{t.get('side')}")
                if tid in seen:
                    continue
                seen.add(tid)
                ts_ms = int(t.get("time") or t.get("T") or 0)
                price = str(t.get("price") or t.get("p"))
                qty = str(t.get("size") or t.get("v"))
                side = str(t.get("side") or t.get("S"))
                if not ts_ms or not price or not qty or side.capitalize() not in ("Buy", "Sell"):
                    continue
                rows.append((ts_ms, sym, cat, tid, side.capitalize(), price, qty))
            except Exception:
                continue
        if not rows:
            return 0
        async with self.pool.acquire() as conn:
            await conn.executemany(
                """INSERT INTO trades (ts, trade_time_ms, symbol, category, trade_id, side, price, qty,
                       source_fetched_at, data_version)
                   VALUES (to_timestamp($1/1000.0), $1, $2, $3, $4, $5, $6, $7, NOW(), 'rest-recent-trade-v1')
                   ON CONFLICT (symbol, category, trade_id, ts) DO NOTHING""",
                rows,
            )
        return len(rows)

    async def _on_kline(self, sym: str, cat: str, d: dict) -> None:
        try:
            start = int(d["start"]); confirm = bool(d.get("confirm"))
            o, h, l, c = str(d["open"]), str(d["high"]), str(d["low"]), str(d["close"])
            vol = str(d.get("volume", "0")); to = str(d.get("turnover", "0"))
        except Exception:
            return
        self.stats[cat]["klines"] += 1
        self.stats[cat]["last_msg_ms"] = int(time.time() * 1000)
        await self.redis.publish(f"rt:bar:{sym}", json.dumps(
            {"symbol": sym, "category": cat, "open_time": start, "open": o, "high": h,
             "low": l, "close": c, "confirm": confirm, "ts": int(time.time() * 1000)}))
        # Throttle DB writes for the forming bar; always write on confirm.
        now = time.time()
        if not confirm and (now - self._last_write.get(sym, 0) < WRITE_THROTTLE_S):
            return
        self._last_write[sym] = now
        checksum = hashlib.sha256(f"{sym}|{start}|{o}|{h}|{l}|{c}|{vol}".encode()).hexdigest()
        async with self.pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO candles (symbol, category, interval, open_time, open, high, low, close, volume, turnover, data_version, checksum)
                   VALUES ($1,$2,'1', to_timestamp($3/1000.0), $4,$5,$6,$7,$8,$9,'rt-ws-v1',$10)
                   ON CONFLICT (symbol, category, interval, open_time) DO UPDATE SET
                     open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close,
                     volume=EXCLUDED.volume, turnover=EXCLUDED.turnover, source_fetched_at=NOW()""",
                sym, cat, start, o, h, l, c, vol, to, checksum)
            await conn.execute(
                """INSERT INTO live_prices (symbol, category, interval, last_close, last_open_ms, updated_at)
                   VALUES ($1,$2,'1',$3,$4,NOW())
                   ON CONFLICT (symbol, category, interval) DO UPDATE SET
                     last_close=EXCLUDED.last_close, last_open_ms=EXCLUDED.last_open_ms, updated_at=NOW()""",
                sym, cat, c, start)
        if confirm:
            self.stats[cat]["barcloses"] += 1
            await self.redis.publish(f"rt:barclose:{sym}", json.dumps(
                {"symbol": sym, "category": cat, "open_time": start, "close": c}))

    def status(self) -> dict:
        return {"write_throttle_s": WRITE_THROTTLE_S,
                "l2_depth": _l2_depth(),
                "public_trades_enabled": _env_bool("ENABLE_PUBLIC_TRADES", False),
                "desired": {k: sorted(v) for k, v in self._desired.items()},
                "l2_desired": {k: sorted(v) for k, v in self._l2_desired.items()},
                "trade_desired": {k: sorted(v) for k, v in self._trade_desired.items()},
                "stats": self.stats}
