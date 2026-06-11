from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import asyncpg

from ..cache import ApiCache
from .client import GeckoTerminalClient


CHAIN_BY_NETWORK = {"arbitrum": 42161}
DEFAULT_VENUE_ID = "uniswap-v3-arbitrum"


def _pool_id(network: str, address: str) -> str:
    return f"gt:{network}:{address.lower()}"


def _checksum(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _dec(value: Any, default: str = "0") -> str:
    if value is None or value == "":
        return default
    try:
        return str(Decimal(str(value)))
    except Exception:
        return default


def _ts_from_any(value: Any) -> datetime:
    if isinstance(value, (int, float)):
        raw = float(value)
        if raw > 10_000_000_000:
            raw /= 1000
        return datetime.fromtimestamp(raw, tz=timezone.utc)
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.now(tz=timezone.utc)


def _included_lookup(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for item in payload.get("included") or []:
        if isinstance(item, dict) and item.get("id"):
            out[str(item["id"])] = item
    return out


class DexCollector:
    """API-backed DEX market-data collector.

    The current MVP uses GeckoTerminal as an external real-market data source and stores source
    provenance as ``geckoterminal``. Raw RPC/subgraph replay can replace or augment this later while
    preserving the same tables.
    """

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.client = GeckoTerminalClient(cache=ApiCache(pool))

    async def close(self) -> None:
        await self.client.close()

    async def _upsert_pool_from_gt(self, conn: asyncpg.Connection, network: str, item: dict[str, Any], included: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
        attrs = item.get("attributes") or {}
        rel = item.get("relationships") or {}
        included = included or {}
        address = str(attrs.get("address") or item.get("id", "").split("_")[-1]).lower()
        chain_id = CHAIN_BY_NETWORK.get(network, 42161)
        dex_id = str(((rel.get("dex") or {}).get("data") or {}).get("id") or "")
        venue_id = DEFAULT_VENUE_ID
        if "camelot" in dex_id.lower() or "camelot" in str(attrs.get("name", "")).lower():
            venue_id = "camelot-arbitrum"
        base_id = str(((rel.get("base_token") or {}).get("data") or {}).get("id") or "")
        quote_id = str(((rel.get("quote_token") or {}).get("data") or {}).get("id") or "")
        base = (included.get(base_id) or {}).get("attributes") or {}
        quote = (included.get(quote_id) or {}).get("attributes") or {}
        token0_symbol = str(base.get("symbol") or attrs.get("base_token_symbol") or "TOKEN0").upper()
        token1_symbol = str(quote.get("symbol") or attrs.get("quote_token_symbol") or "TOKEN1").upper()
        pool_id = _pool_id(network, address)

        await conn.execute(
            """
            INSERT INTO dex_pools (
              pool_id, chain_id, venue_id, pool_address, token0_symbol, token1_symbol,
              fee_bps, status, source, metadata_json
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active','geckoterminal',$8::jsonb)
            ON CONFLICT (pool_id) DO UPDATE SET
              venue_id = EXCLUDED.venue_id,
              token0_symbol = EXCLUDED.token0_symbol,
              token1_symbol = EXCLUDED.token1_symbol,
              status = EXCLUDED.status,
              source = EXCLUDED.source,
              metadata_json = EXCLUDED.metadata_json,
              updated_at = NOW()
            """,
            pool_id,
            chain_id,
            venue_id,
            address,
            token0_symbol,
            token1_symbol,
            None,
            json.dumps({"geckoterminal_id": item.get("id"), "name": attrs.get("name"), "raw": attrs}),
        )

        for token, symbol, rel_id in ((base, token0_symbol, base_id), (quote, token1_symbol, quote_id)):
            token_address = str(token.get("address") or rel_id.split("_")[-1] or "").lower()
            if token_address.startswith("0x"):
                await conn.execute(
                    """
                    INSERT INTO token_registry (chain_id, address, symbol, name, decimals, asset_class, source, metadata_json)
                    VALUES ($1,$2,$3,$4,$5,'crypto','geckoterminal',$6::jsonb)
                    ON CONFLICT (chain_id, address) DO UPDATE SET
                      symbol = EXCLUDED.symbol,
                      name = EXCLUDED.name,
                      decimals = EXCLUDED.decimals,
                      source = EXCLUDED.source,
                      metadata_json = EXCLUDED.metadata_json,
                      updated_at = NOW()
                    """,
                    chain_id,
                    token_address,
                    symbol,
                    str(token.get("name") or symbol),
                    int(token.get("decimals") or 18),
                    json.dumps({"geckoterminal_id": rel_id}),
                )

        await conn.execute(
            """
            INSERT INTO dex_pool_snapshots (
              pool_id, block_number, ts, liquidity, reserve0, reserve1,
              price_usd, source, checksum, metadata_json
            ) VALUES ($1,0,NOW(),$2,NULL,NULL,$3,'geckoterminal',$4,$5::jsonb)
            ON CONFLICT (pool_id, block_number, ts, source) DO NOTHING
            """,
            pool_id,
            _dec(attrs.get("reserve_in_usd")),
            _dec(attrs.get("base_token_price_usd") or attrs.get("quote_token_price_usd")),
            _checksum(attrs),
            json.dumps({"raw": attrs}),
        )
        return {"pool_id": pool_id, "pool_address": address, "venue_id": venue_id, "token0_symbol": token0_symbol, "token1_symbol": token1_symbol}

    async def backfill_pools(self, *, network: str = "arbitrum", addresses: list[str] | None = None, limit: int = 20) -> dict[str, Any]:
        rows: list[dict[str, Any]] = []
        async with self.pool.acquire() as conn:
            if addresses:
                for address in addresses[: max(1, min(limit, 100))]:
                    payload = await self.client.pool(network, address)
                    rows.append(await self._upsert_pool_from_gt(conn, network, payload.get("data") or {}, _included_lookup(payload)))
            else:
                payload = await self.client.top_pools(network)
                included = _included_lookup(payload)
                for item in (payload.get("data") or [])[: max(1, min(limit, 100))]:
                    rows.append(await self._upsert_pool_from_gt(conn, network, item, included))
        return {"network": network, "count": len(rows), "pools": rows, "source": "geckoterminal"}

    async def backfill_candles(self, *, network: str, pool_address: str, interval: str = "hour", limit: int = 200) -> dict[str, Any]:
        payload = await self.client.pool_ohlcv(network, pool_address, interval, limit=limit)
        values = (((payload.get("data") or {}).get("attributes") or {}).get("ohlcv_list") or [])
        pool_id = _pool_id(network, pool_address)
        rows = 0
        async with self.pool.acquire() as conn:
            pool_row = await conn.fetchrow("SELECT pool_id FROM dex_pools WHERE pool_id=$1", pool_id)
            if pool_row is None:
                pool_payload = await self.client.pool(network, pool_address)
                await self._upsert_pool_from_gt(conn, network, pool_payload.get("data") or {}, _included_lookup(pool_payload))
            for row in values:
                if not isinstance(row, list) or len(row) < 6:
                    continue
                ts, open_, high, low, close, volume = row[:6]
                await conn.execute(
                    """
                    INSERT INTO dex_candles (
                      pool_id, interval, open_time, open, high, low, close,
                      volume_usd, source, coverage_score, checksum
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'geckoterminal',0.70,$9)
                    ON CONFLICT (pool_id, interval, open_time, source)
                    DO UPDATE SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
                                  close=EXCLUDED.close, volume_usd=EXCLUDED.volume_usd,
                                  coverage_score=EXCLUDED.coverage_score, checksum=EXCLUDED.checksum
                    """,
                    pool_id,
                    interval,
                    _ts_from_any(ts),
                    _dec(open_),
                    _dec(high),
                    _dec(low),
                    _dec(close),
                    _dec(volume),
                    _checksum(row),
                )
                rows += 1
            if values:
                start = _ts_from_any(values[-1][0])
                end = _ts_from_any(values[0][0])
                await conn.execute(
                    """
                    INSERT INTO dex_data_coverage (
                      pool_id, interval, range_start, range_end, source,
                      expected_bars, actual_bars, swap_rows, snapshot_rows, coverage_score
                    ) VALUES ($1,$2,$3,$4,'geckoterminal',$5,$5,0,0,0.70)
                    ON CONFLICT (pool_id, interval, range_start, range_end, source)
                    DO UPDATE SET actual_bars=EXCLUDED.actual_bars, coverage_score=EXCLUDED.coverage_score, updated_at=NOW()
                    """,
                    pool_id,
                    interval,
                    start,
                    end,
                    rows,
                )
        return {"pool_id": pool_id, "network": network, "interval": interval, "rows": rows, "source": "geckoterminal"}

    async def backfill_swaps(self, *, network: str, pool_address: str, limit: int = 200) -> dict[str, Any]:
        payload = await self.client.pool_trades(network, pool_address, limit=limit)
        pool_id = _pool_id(network, pool_address)
        rows = 0
        async with self.pool.acquire() as conn:
            pool_row = await conn.fetchrow("SELECT pool_id FROM dex_pools WHERE pool_id=$1", pool_id)
            if pool_row is None:
                pool_payload = await self.client.pool(network, pool_address)
                await self._upsert_pool_from_gt(conn, network, pool_payload.get("data") or {}, _included_lookup(pool_payload))
            for item in payload.get("data") or []:
                attrs = item.get("attributes") or {}
                tx_hash = str(attrs.get("tx_hash") or attrs.get("transaction_hash") or item.get("id") or _checksum(item))
                log_index = int(attrs.get("log_index") or attrs.get("tx_from_address") is not None)
                ts = _ts_from_any(attrs.get("block_timestamp") or attrs.get("timestamp") or attrs.get("created_at"))
                await conn.execute(
                    """
                    INSERT INTO dex_swaps (
                      tx_hash, log_index, pool_id, block_number, ts, sender, recipient,
                      amount0, amount1, amount_usd, price_usd, source, payload_json
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,$8,$9,'geckoterminal',$10::jsonb)
                    ON CONFLICT (tx_hash, log_index, pool_id, ts) DO NOTHING
                    """,
                    tx_hash,
                    log_index,
                    pool_id,
                    int(attrs.get("block_number") or 0),
                    ts,
                    attrs.get("tx_from_address"),
                    attrs.get("tx_to_address"),
                    _dec(attrs.get("volume_in_usd") or attrs.get("amount_usd")),
                    _dec(attrs.get("price_from_in_usd") or attrs.get("price_to_in_usd")),
                    json.dumps({"id": item.get("id"), "raw": attrs}),
                )
                rows += 1
        return {"pool_id": pool_id, "network": network, "rows": rows, "source": "geckoterminal"}
