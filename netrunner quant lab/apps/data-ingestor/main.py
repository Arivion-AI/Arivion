from __future__ import annotations

import os
import asyncio
from typing import Any

import asyncpg
import redis.asyncio as redis
from fastapi import FastAPI
from fastapi.responses import Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, generate_latest

from ingestor import archive
from ingestor.bybit import BybitCollector
from ingestor.models import BackfillRequest
from ingestor.ws_public import build_default_collector
from ingestor.live import LivePoller
from ingestor.realtime import RealtimeCollector
from ingestor.dex import DexCollector
from ingestor.dex.live import DexLivePoller
from ingestor.dex.robinhood_testnet import RH_TEST_TOKENS

DATABASE_URL = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
# Default empty: the legacy orderbook(L2) collector is superseded by the realtime
# kline/ticker collector (realtime.py). Set WS_PUBLIC_SYMBOLS only if you actually
# need recorded L2 — it is the main storage hog. Idle by default stops the growth.
WS_PUBLIC_SYMBOLS = os.getenv("WS_PUBLIC_SYMBOLS", "")

app = FastAPI(title="Duality Data Ingestor")
collector_counter = Counter("duality_ingestor_collect_total", "Ingestor collection calls", ["endpoint", "status"])


async def wait_for_database(max_attempts: int = 30) -> None:
    for attempt in range(1, max_attempts + 1):
        try:
            conn = await asyncpg.connect(DATABASE_URL)
            await conn.close()
            return
        except Exception:
            if attempt == max_attempts:
                raise
            await asyncio.sleep(2)


@app.on_event("startup")
async def startup() -> None:
    await wait_for_database()
    app.state.pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
    app.state.ws_collector = build_default_collector(app.state.pool)
    bootstrap_symbols = [s.strip().upper() for s in WS_PUBLIC_SYMBOLS.split(",") if s.strip()]
    await app.state.ws_collector.start(symbols=bootstrap_symbols)
    # Demand-driven realtime REST poller for paper trading (spot + linear).
    app.state.live = LivePoller(app.state.pool)
    await app.state.live.start()
    # Realtime Bybit WebSocket collector (Phase 3): sub-second prices + confirmed 1m bars.
    app.state.realtime = RealtimeCollector(app.state.pool, REDIS_URL)
    await app.state.realtime.start()
    # API-backed DEX data lane. WebSocket/RPC log replay can be added behind this same surface.
    app.state.dex_live = DexLivePoller(app.state.pool, REDIS_URL)


@app.on_event("shutdown")
async def shutdown() -> None:
    await app.state.ws_collector.stop()
    await app.state.live.stop()
    try:
        await app.state.realtime.stop()
    except Exception:
        pass
    await app.state.pool.close()


@app.post("/collect/live/subscribe")
async def live_subscribe(payload: dict) -> dict:
    items = payload.get("items") or payload.get("symbols") or []
    if items and isinstance(items[0], str):
        items = [{"symbol": s} for s in items]
    subs = await app.state.live.subscribe(items)
    app.state.realtime.set_demand(items)   # feed the realtime WS collector too
    return {"ok": True, "subscriptions": subs, "status": app.state.live.status()}


@app.post("/collect/live/unsubscribe")
async def live_unsubscribe(payload: dict) -> dict:
    items = payload.get("items") or []
    if items and isinstance(items[0], str):
        items = [{"symbol": s} for s in items]
    await app.state.live.unsubscribe(items)
    return {"ok": True, "subscriptions": await app.state.live.current_subscriptions()}


@app.get("/collect/live/prices")
async def live_prices(max_age_ms: int = 60000) -> dict:
    prices, refreshed = await app.state.live.prices_fresh(max_age_ms=max_age_ms)
    return {"ok": True, "prices": prices, "refreshed": refreshed, "status": app.state.live.status()}


@app.post("/collect/live/poll")
async def live_poll_now() -> dict:
    n = await app.state.live.poll_once()
    return {"ok": True, "polled": n, "status": app.state.live.status()}


@app.get("/collect/realtime/status")
async def realtime_status() -> dict:
    return {"ok": True, **app.state.realtime.status()}


@app.post("/collect/realtime/record-l2")
async def realtime_record_l2(payload: dict) -> dict:
    items = payload.get("items") or payload.get("symbols") or []
    if items and isinstance(items[0], str):
        items = [{"symbol": s} for s in items]
    enable = bool(payload.get("enable", True))
    manual = bool(payload.get("manual", True))
    l2 = app.state.realtime.set_l2_demand(items, enable=enable, manual=manual)
    return {"ok": True, "l2_recording": l2}


@app.post("/collect/realtime/record-trades")
async def realtime_record_trades(payload: dict) -> dict:
    items = payload.get("items") or payload.get("symbols") or []
    if items and isinstance(items[0], str):
        items = [{"symbol": s} for s in items]
    enable = bool(payload.get("enable", True))
    manual = bool(payload.get("manual", True))
    trades = app.state.realtime.set_trade_demand(items, enable=enable, manual=manual)
    # Seed recent trades from REST so a freshly-enabled symbol has immediate (non-historical)
    # coverage rather than waiting for the WS feed to accumulate prints.
    seeded = 0
    if enable:
        for it in items:
            sym = str(it.get("symbol", "")).strip().upper()
            if not sym:
                continue
            cat = str(it.get("category") or ("spot" if sym.endswith("XUSDT") else "linear"))
            seeded += await app.state.realtime.seed_recent_trades(sym, cat)
    return {"ok": True, "trade_recording": trades, "seeded_recent_trades": seeded}


@app.get("/collect/xstocks/instruments")
async def xstocks_instruments() -> dict:
    try:
        items = await app.state.live.fetch_xstock_instruments()
        return {"ok": True, "count": len(items), "instruments": items}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/collect/dex/backfill/pools")
async def dex_backfill_pools(payload: dict) -> dict:
    collector = DexCollector(app.state.pool)
    try:
        network = str(payload.get("network") or "arbitrum")
        raw_addresses = payload.get("addresses") or payload.get("poolAddresses") or []
        addresses = [str(a) for a in raw_addresses] if isinstance(raw_addresses, list) else []
        limit = int(payload.get("limit") or 20)
        result = await collector.backfill_pools(network=network, addresses=addresses, limit=limit)
        collector_counter.labels("dex-pools", "ok").inc()
        return {"ok": True, **result}
    except Exception as e:
        collector_counter.labels("dex-pools", "error").inc()
        return {"ok": False, "error": str(e)}
    finally:
        await collector.close()


@app.post("/collect/dex/backfill/swaps")
async def dex_backfill_swaps(payload: dict) -> dict:
    collector = DexCollector(app.state.pool)
    try:
        network = str(payload.get("network") or "arbitrum")
        pool_address = str(payload.get("poolAddress") or payload.get("pool_address") or "")
        if not pool_address:
            return {"ok": False, "error": "POOL_ADDRESS_REQUIRED"}
        interval = str(payload.get("interval") or "hour")
        limit = int(payload.get("limit") or 200)
        candles = await collector.backfill_candles(network=network, pool_address=pool_address, interval=interval, limit=limit)
        swaps = await collector.backfill_swaps(network=network, pool_address=pool_address, limit=min(limit, 300))
        collector_counter.labels("dex-swaps", "ok").inc()
        return {"ok": True, "candles": candles, "swaps": swaps}
    except Exception as e:
        collector_counter.labels("dex-swaps", "error").inc()
        return {"ok": False, "error": str(e)}
    finally:
        await collector.close()


@app.post("/collect/dex/subgraph/pools")
async def dex_subgraph_pools(payload: dict) -> dict:
    from ingestor.dex.thegraph import UniswapV3SubgraphCollector

    collector = UniswapV3SubgraphCollector(app.state.pool)
    try:
        result = await collector.sync_pools(
            first=int(payload.get("first") or 50),
            reputable_only=bool(payload.get("reputable_only", True)),
        )
        collector_counter.labels("dex-subgraph-pools", "ok").inc()
        return {"ok": True, **result}
    except Exception as e:
        collector_counter.labels("dex-subgraph-pools", "error").inc()
        return {"ok": False, "error": str(e)}
    finally:
        await collector.close()


@app.post("/collect/dex/subgraph/swaps")
async def dex_subgraph_swaps(payload: dict) -> dict:
    from ingestor.dex.thegraph import UniswapV3SubgraphCollector

    pool_address = str(payload.get("poolAddress") or payload.get("pool_address") or "")
    if not pool_address:
        return {"ok": False, "error": "POOL_ADDRESS_REQUIRED"}
    collector = UniswapV3SubgraphCollector(app.state.pool)
    try:
        result = await collector.sync_swaps(pool_address=pool_address, first=int(payload.get("first") or 200))
        collector_counter.labels("dex-subgraph-swaps", "ok").inc()
        return {"ok": True, **result}
    except Exception as e:
        collector_counter.labels("dex-subgraph-swaps", "error").inc()
        return {"ok": False, "error": str(e)}
    finally:
        await collector.close()


@app.post("/collect/dex/lp/sync")
async def dex_lp_sync(payload: dict) -> dict:
    from ingestor.dex.thegraph import UniswapV3SubgraphCollector

    wallet = str(payload.get("wallet") or payload.get("wallet_address") or "")
    if not wallet:
        return {"ok": False, "error": "WALLET_REQUIRED"}
    collector = UniswapV3SubgraphCollector(app.state.pool)
    try:
        result = await collector.sync_positions(wallet=wallet, first=int(payload.get("first") or 200))
        collector_counter.labels("dex-lp-sync", "ok").inc()
        return {"ok": True, **result}
    except Exception as e:
        collector_counter.labels("dex-lp-sync", "error").inc()
        return {"ok": False, "error": str(e)}
    finally:
        await collector.close()


@app.get("/collect/dex/subgraph/health")
async def dex_subgraph_health() -> dict:
    from ingestor.dex.thegraph import UniswapV3SubgraphCollector

    collector = UniswapV3SubgraphCollector(app.state.pool)
    try:
        return {"ok": True, **await collector.health()}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        await collector.close()


@app.post("/live/dex/subscribe")
async def dex_live_subscribe(payload: dict) -> dict:
    items = payload.get("items") or []
    if items and isinstance(items[0], str):
        items = [{"poolAddress": p} for p in items]
    subs = await app.state.dex_live.subscribe(items)
    return {"ok": True, "subscriptions": subs, "status": app.state.dex_live.status()}


@app.post("/live/dex/poll")
async def dex_live_poll() -> dict:
    return await app.state.dex_live.poll_once()


@app.get("/collect/dex/robinhood-testnet/tokens")
async def rh_testnet_tokens() -> dict:
    return {
        "ok": True,
        "chain_id": 46630,
        "tokens": RH_TEST_TOKENS,
        "truth": {
            "data_source": "robinhood_docs",
            "testnet_disclaimer": "These are Robinhood Chain testnet tokens only; they have no production stock rights here.",
            "can_execute_real_money": False,
        },
    }


@app.get("/collect/dex/budget")
async def dex_budget() -> dict:
    """Rate-limiter + monthly-budget visibility for the external-API ingestion layer."""
    from ingestor.ratelimit import get_limiter

    limiter = get_limiter()
    providers: dict[str, Any] = {}
    for name, cfg in limiter.providers.items():
        providers[name] = {
            "rpm_budget": cfg.rpm,
            "monthly_cap": cfg.monthly_cap or None,
            "month_to_date": await limiter.month_count(name),
            "monthly_remaining": await limiter.monthly_remaining(name),
        }
    cache_rows = await app.state.pool.fetch(
        "SELECT provider, count(*) AS n, count(*) FILTER (WHERE is_immutable) AS immutable FROM api_cache GROUP BY provider"
    )
    return {
        "ok": True,
        "providers": providers,
        "cache": {r["provider"]: {"rows": r["n"], "immutable": r["immutable"]} for r in cache_rows},
        "attribution": "Powered by GeckoTerminal",
    }


@app.get("/health")
async def health() -> dict:
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        await conn.fetchval("SELECT 1")
    finally:
        await conn.close()

    client = redis.from_url(REDIS_URL)
    try:
        await client.ping()
    finally:
        await client.close()

    return {"ok": True, "service": "data-ingestor", "db": "up", "redis": "up"}


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/collect/backfill/kline")
async def collect_kline(payload: BackfillRequest) -> dict:
    collector = BybitCollector(app.state.pool)
    try:
        result = await collector.backfill_kline_paginated(
            category=payload.category,
            symbol=payload.symbol,
            interval=payload.interval,
            start_ms=payload.start_ms,
            end_ms=payload.end_ms,
            data_version=payload.data_version,
        )
        collector_counter.labels("kline", "ok").inc()
        return {"ok": True, **result}
    finally:
        await collector.close()


@app.post("/collect/backfill/mark-kline")
async def collect_mark_kline(payload: BackfillRequest) -> dict:
    """WS-0: backfill the real mark-price series (public /v5/market/mark-price-kline)
    into mark_candles for WS-C mark-based liquidation."""
    collector = BybitCollector(app.state.pool)
    try:
        result = await collector.backfill_mark_kline_paginated(
            category=payload.category,
            symbol=payload.symbol,
            interval=payload.interval,
            start_ms=payload.start_ms,
            end_ms=payload.end_ms,
            data_version=payload.data_version,
        )
        collector_counter.labels("mark-kline", "ok").inc()
        return {"ok": True, **result}
    finally:
        await collector.close()


@app.post("/collect/backfill/index-kline")
async def collect_index_kline(payload: BackfillRequest) -> dict:
    """WS-0: backfill the real index-price series (public /v5/market/index-price-kline)."""
    collector = BybitCollector(app.state.pool)
    try:
        result = await collector.backfill_index_kline_paginated(
            category=payload.category, symbol=payload.symbol, interval=payload.interval,
            start_ms=payload.start_ms, end_ms=payload.end_ms, data_version=payload.data_version,
        )
        collector_counter.labels("index-kline", "ok").inc()
        return {"ok": True, **result}
    finally:
        await collector.close()


@app.post("/collect/backfill/l2-archive")
async def collect_l2_archive(payload: dict) -> dict:
    """P1.1 — historical L2 + trade backfill. Normalizes archive-shaped depth-500 snapshots and
    trade prints into the SAME l2_snapshots/trades hypertables + coverage accounting a forward
    recording uses, tagged with a historical ``data_version``. A backfilled range then reports
    coverage exactly like a forward-recorded one, and (P1.2) earns the verified tier under the same
    source-agnostic gate.

    Records may be supplied inline (``orderbook``/``trades`` lists) — the actual download from the
    Bybit free archive (quote-saver.bycsi.com) / Tardis.dev is a documented follow-up; this
    normalize+persist path is the tested core. ``source`` selects the data_version tag + fill_model
    ``l2_source`` provenance ("bybit-archive" | "tardis").
    """
    symbol = str(payload.get("symbol", "")).upper()
    category = str(payload.get("category") or ("spot" if symbol.endswith("XUSDT") else "linear"))
    source = str(payload.get("source", "bybit-archive"))
    depth = int(payload.get("depth", 500))
    if not symbol:
        return {"ok": False, "error": "MISSING_SYMBOL"}
    ob_dv = archive.DV_TARDIS_OB_L2 if source == "tardis" else archive.DV_BYBIT_ARCHIVE_OB500
    tr_dv = archive.DV_BYBIT_ARCHIVE_TRADE
    snap_rows = archive.normalize_archive_orderbook(
        payload.get("orderbook") or [], symbol=symbol, category=category,
        data_version=ob_dv, depth=depth)
    trade_rows = archive.normalize_archive_trades(
        payload.get("trades") or [], symbol=symbol, category=category, data_version=tr_dv)
    cadence_ms = archive.infer_cadence_ms(snap_rows)
    inserted_snaps = inserted_trades = 0
    async with app.state.pool.acquire() as conn:
        for r in snap_rows:
            await conn.execute(
                """INSERT INTO l2_snapshots (ts, symbol, category, sequence_id, checksum,
                       best_bid, best_ask, bid_levels_json, ask_levels_json, source_fetched_at, data_version)
                   VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, NOW(), $10)
                   ON CONFLICT (symbol, category, ts, sequence_id) DO NOTHING""",
                r["ts_ms"], r["symbol"], r["category"], r["sequence_id"], r["checksum"],
                r["best_bid"], r["best_ask"], json.dumps(r["bid_levels_json"]),
                json.dumps(r["ask_levels_json"]), r["data_version"])
            inserted_snaps += 1
        for r in trade_rows:
            await conn.execute(
                """INSERT INTO trades (ts, trade_time_ms, symbol, category, trade_id, side, price, qty,
                       source_fetched_at, data_version)
                   VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
                   ON CONFLICT (symbol, category, trade_id, ts) DO NOTHING""",
                r["ts_ms"], r["trade_time_ms"], r["symbol"], r["category"], r["trade_id"],
                r["side"], r["price"], r["qty"], r["data_version"])
            inserted_trades += 1
    collector_counter.labels("l2-archive", "ok").inc()
    return {
        "ok": True, "symbol": symbol, "category": category, "source": source,
        "snapshots": inserted_snaps, "trades": inserted_trades,
        "l2_cadence_ms": cadence_ms,
        "data_version": {"orderbook": ob_dv, "trades": tr_dv},
        "fill_model_provenance": {
            "l2_source": archive.SRC_TARDIS if source == "tardis" else archive.SRC_BYBIT_ARCHIVE,
            "l2_cadence_ms": cadence_ms,
        },
        "note": "Forward-only applies to symbols/ranges not yet backfilled; this range is now historically replayable.",
    }


@app.post("/collect/funding")
async def collect_funding(payload: BackfillRequest) -> dict:
    collector = BybitCollector(app.state.pool)
    try:
        rows = await collector.collect_funding_history(
            category=payload.category,
            symbol=payload.symbol,
            start_ms=payload.start_ms,
            end_ms=payload.end_ms,
            data_version=payload.data_version,
        )
        collector_counter.labels("funding", "ok").inc()
        return {"ok": True, "rows": rows, "checkpoint": {"end_ms": payload.end_ms}}
    finally:
        await collector.close()


@app.post("/collect/oi")
async def collect_open_interest(payload: BackfillRequest) -> dict:
    collector = BybitCollector(app.state.pool)
    try:
        rows = await collector.collect_open_interest(
            category=payload.category,
            symbol=payload.symbol,
            interval_time=payload.interval,
            start_ms=payload.start_ms,
            end_ms=payload.end_ms,
            data_version=payload.data_version,
        )
        collector_counter.labels("oi", "ok").inc()
        return {"ok": True, "rows": rows, "subject_to_retention": True, "checkpoint": {"end_ms": payload.end_ms}}
    finally:
        await collector.close()


@app.post("/collect/long-short")
async def collect_long_short(payload: BackfillRequest) -> dict:
    collector = BybitCollector(app.state.pool)
    try:
        rows = await collector.collect_long_short_ratio(
            category=payload.category,
            symbol=payload.symbol,
            period=payload.interval,
            start_ms=payload.start_ms,
            end_ms=payload.end_ms,
            data_version=payload.data_version,
        )
        collector_counter.labels("long-short", "ok").inc()
        return {"ok": True, "rows": rows, "subject_to_retention": True, "checkpoint": {"end_ms": payload.end_ms}}
    finally:
        await collector.close()


@app.post("/collect/instruments/{category}")
async def collect_instruments(category: str) -> dict:
    collector = BybitCollector(app.state.pool)
    try:
        rows = await collector.collect_instruments_info(category=category, data_version="v1")
        collector_counter.labels("instruments", "ok").inc()
        return {"ok": True, "rows": rows}
    finally:
        await collector.close()


@app.post("/collect/ws/subscribe")
async def ws_subscribe(payload: dict) -> dict:
    symbols = payload.get("symbols") or []
    if not isinstance(symbols, list):
        return {"ok": False, "error": "INVALID_SYMBOLS"}
    await app.state.ws_collector.update_symbols([str(s) for s in symbols])
    return {"ok": True, "symbols": await app.state.ws_collector.current_symbols()}


@app.get("/collect/ws/symbols")
async def ws_symbols() -> dict:
    return {"ok": True, "symbols": await app.state.ws_collector.current_symbols()}
