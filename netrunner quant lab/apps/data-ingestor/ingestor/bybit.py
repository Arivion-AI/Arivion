from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import asyncpg
import httpx

BYBIT_BASE_URL = os.getenv("BYBIT_BASE_URL", "https://api.bybit.com")


def _step_ms_for_interval(interval: str) -> int:
    interval_map = {
        "1": 60_000,
        "3": 180_000,
        "5": 300_000,
        "15": 900_000,
        "30": 1_800_000,
        "60": 3_600_000,
        "120": 7_200_000,
        "240": 14_400_000,
        "360": 21_600_000,
        "720": 43_200_000,
        "D": 86_400_000,
        "W": 604_800_000,
        "M": 2_592_000_000,
        "5min": 300_000,
        "15min": 900_000,
        "30min": 1_800_000,
        "1h": 3_600_000,
        "4h": 14_400_000,
        "1d": 86_400_000,
    }
    if interval not in interval_map:
        raise ValueError(f"unsupported interval: {interval}")
    return interval_map[interval]


def _align_range(start_ms: int, end_ms: int, step_ms: int) -> tuple[int, int]:
    aligned_start = (start_ms // step_ms) * step_ms
    aligned_end = (end_ms // step_ms) * step_ms
    return aligned_start, aligned_end


def _normalize_oi_ls_interval(interval: str) -> str:
    raw = str(interval).strip()
    mapping = {
        "5": "5min",
        "15": "15min",
        "30": "30min",
        "60": "1h",
        "240": "4h",
        "D": "1d",
        "5m": "5min",
        "15m": "15min",
        "30m": "30min",
        "1h": "1h",
        "4h": "4h",
        "1d": "1d",
    }
    return mapping.get(raw, raw)


def _normalize_kline_interval(interval: str) -> str:
    raw = str(interval).strip()
    mapping = {
        "1m": "1",
        "3m": "3",
        "5m": "5",
        "15m": "15",
        "30m": "30",
        "1h": "60",
        "2h": "120",
        "4h": "240",
        "6h": "360",
        "12h": "720",
        "1d": "D",
        "1w": "W",
        "1M": "M",
    }
    return mapping.get(raw, raw)


class BybitCollector:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.client = httpx.AsyncClient(base_url=BYBIT_BASE_URL, timeout=30.0)

    async def close(self) -> None:
        await self.client.aclose()

    async def fetch_kline_page(
        self,
        *,
        category: str,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        limit: int = 1000,
    ) -> list[list[str]]:
        interval_value = _normalize_kline_interval(interval)
        response = await self.client.get(
            "/v5/market/kline",
            params={
                "category": category,
                "symbol": symbol,
                "interval": interval_value,
                "start": start_ms,
                "end": end_ms,
                "limit": min(limit, 1000),
            },
        )
        response.raise_for_status()
        payload = response.json()
        return payload.get("result", {}).get("list", [])

    async def backfill_kline_paginated(
        self,
        *,
        category: str,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        data_version: str,
        endpoint_sleep_seconds: float = 0.3,
    ) -> dict[str, Any]:
        import asyncio

        interval = _normalize_kline_interval(interval)
        step_ms = _step_ms_for_interval(interval)
        aligned_start_ms, aligned_end_ms = _align_range(start_ms, end_ms, step_ms)
        cursor_start = aligned_start_ms
        pages = 0
        rows_inserted = 0

        async with self.pool.acquire() as conn:
            while cursor_start <= aligned_end_ms:
                page = await self.fetch_kline_page(
                    category=category,
                    symbol=symbol,
                    interval=interval,
                    start_ms=cursor_start,
                    end_ms=aligned_end_ms,
                    limit=1000,
                )
                pages += 1
                if not page:
                    break

                # Bybit returns reverse order; store ascending by open_time.
                parsed = sorted(page, key=lambda row: int(row[0]))

                for row in parsed:
                    open_ms = int(row[0])
                    checksum = hashlib.sha256("|".join(row).encode("utf-8")).hexdigest()
                    await conn.execute(
                        """
                        INSERT INTO candles (
                          symbol, category, interval, open_time,
                          open, high, low, close, volume, turnover,
                          data_version, checksum
                        )
                        VALUES (
                          $1, $2, $3, to_timestamp($4 / 1000.0),
                          $5, $6, $7, $8, $9, $10,
                          $11, $12
                        )
                        ON CONFLICT (symbol, category, interval, open_time)
                        DO UPDATE SET
                          open = EXCLUDED.open,
                          high = EXCLUDED.high,
                          low = EXCLUDED.low,
                          close = EXCLUDED.close,
                          volume = EXCLUDED.volume,
                          turnover = EXCLUDED.turnover,
                          data_version = EXCLUDED.data_version,
                          checksum = EXCLUDED.checksum,
                          source_fetched_at = NOW()
                        """,
                        symbol,
                        category,
                        interval,
                        open_ms,
                        row[1],
                        row[2],
                        row[3],
                        row[4],
                        row[5],
                        row[6],
                        data_version,
                        checksum,
                    )
                    rows_inserted += 1

                last_ms = int(parsed[-1][0])
                if last_ms < cursor_start:
                    break
                cursor_start = last_ms + step_ms
                await asyncio.sleep(endpoint_sleep_seconds)

            await self._write_coverage(conn, symbol, category, interval, aligned_start_ms, aligned_end_ms, data_version)

            await conn.execute(
                """
                INSERT INTO backfill_jobs (
                  endpoint, category, symbol, interval, start_ts, end_ts,
                  status, pages_requested, rows_inserted, gaps_found, created_at
                ) VALUES (
                  'kline', $1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0),
                  'completed', $6, $7,
                  (SELECT missing_bars FROM data_coverage
                   WHERE symbol=$2 AND category=$1 AND interval=$3
                   ORDER BY updated_at DESC LIMIT 1),
                  NOW()
                )
                """,
                category,
                symbol,
                interval,
                aligned_start_ms,
                aligned_end_ms,
                pages,
                rows_inserted,
            )

        return {"pages": pages, "rows_inserted": rows_inserted, "checkpoint": {"last_open_ms": max(aligned_start_ms, cursor_start - step_ms)}}

    async def _backfill_priced_kline(
        self, *, endpoint: str, table: str, symbol: str, interval: str,
        start_ms: int, end_ms: int, data_version: str, category: str,
        endpoint_sleep_seconds: float,
    ) -> dict[str, Any]:
        """Shared backfill for the [start,open,high,low,close] OHLC endpoints
        (mark-price-kline / index-price-kline). Public market endpoints only."""
        import asyncio

        interval = _normalize_kline_interval(interval)
        step_ms = _step_ms_for_interval(interval)
        aligned_start_ms, aligned_end_ms = _align_range(start_ms, end_ms, step_ms)
        cursor_start = aligned_start_ms
        pages = 0
        rows_inserted = 0
        insert_sql = (
            f"INSERT INTO {table} (symbol, interval, open_time, open, high, low, close, data_version) "
            "VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7, $8) "
            "ON CONFLICT (symbol, interval, open_time) DO UPDATE SET "
            "open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, "
            "data_version = EXCLUDED.data_version, source_fetched_at = NOW()"
        )
        async with self.pool.acquire() as conn:
            while cursor_start <= aligned_end_ms:
                response = await self.client.get(
                    endpoint,
                    params={"category": category, "symbol": symbol, "interval": interval,
                            "start": cursor_start, "end": aligned_end_ms, "limit": 1000},
                )
                response.raise_for_status()
                page = response.json().get("result", {}).get("list", [])
                pages += 1
                if not page:
                    break
                parsed = sorted(page, key=lambda row: int(row[0]))
                for row in parsed:
                    await conn.execute(insert_sql, symbol, interval, int(row[0]),
                                       row[1], row[2], row[3], row[4], data_version)
                    rows_inserted += 1
                last_ms = int(parsed[-1][0])
                if last_ms < cursor_start:
                    break
                cursor_start = last_ms + step_ms
                await asyncio.sleep(endpoint_sleep_seconds)
        return {"pages": pages, "rows_inserted": rows_inserted, "endpoint": endpoint}

    async def backfill_mark_kline_paginated(
        self, *, symbol: str, interval: str, start_ms: int, end_ms: int,
        data_version: str, category: str = "linear", endpoint_sleep_seconds: float = 0.3,
    ) -> dict[str, Any]:
        """WS-0: REAL mark-price series (public /v5/market/mark-price-kline) -> mark_candles.
        The price WS-C liquidation triggers on (not last-trade)."""
        return await self._backfill_priced_kline(
            endpoint="/v5/market/mark-price-kline", table="mark_candles", symbol=symbol,
            interval=interval, start_ms=start_ms, end_ms=end_ms, data_version=data_version,
            category=category, endpoint_sleep_seconds=endpoint_sleep_seconds)

    async def backfill_index_kline_paginated(
        self, *, symbol: str, interval: str, start_ms: int, end_ms: int,
        data_version: str, category: str = "linear", endpoint_sleep_seconds: float = 0.3,
    ) -> dict[str, Any]:
        """WS-0: REAL index-price series (public /v5/market/index-price-kline) -> index_candles.
        Used for basis / funding sanity."""
        return await self._backfill_priced_kline(
            endpoint="/v5/market/index-price-kline", table="index_candles", symbol=symbol,
            interval=interval, start_ms=start_ms, end_ms=end_ms, data_version=data_version,
            category=category, endpoint_sleep_seconds=endpoint_sleep_seconds)

    async def _write_coverage(
        self,
        conn: asyncpg.Connection,
        symbol: str,
        category: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        data_version: str,
    ) -> None:
        step = _step_ms_for_interval(interval)
        aligned_start_ms, aligned_end_ms = _align_range(start_ms, end_ms, step)

        rows = await conn.fetch(
            """
            SELECT EXTRACT(EPOCH FROM open_time) * 1000 AS open_ms
            FROM candles
            WHERE symbol = $1
              AND category = $2
              AND interval = $3
              AND open_time BETWEEN to_timestamp($4 / 1000.0) AND to_timestamp($5 / 1000.0)
            ORDER BY open_time ASC
            """,
            symbol,
            category,
            interval,
            aligned_start_ms,
            aligned_end_ms,
        )

        expected = max(0, ((aligned_end_ms - aligned_start_ms) // step) + 1)
        seen: dict[int, int] = {}
        for row in rows:
            ts = int(row["open_ms"])
            seen[ts] = seen.get(ts, 0) + 1

        actual = len(seen)
        duplicates = sum(count - 1 for count in seen.values() if count > 1)
        missing = expected - actual

        await conn.execute(
            """
            INSERT INTO data_coverage (
              symbol, category, interval, range_start, range_end,
              expected_bars, actual_bars, missing_bars, duplicate_bars,
              data_version, subject_to_retention, updated_at
            ) VALUES (
              $1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0),
              $6, $7, $8, $9, $10, FALSE, NOW()
            )
            ON CONFLICT (symbol, category, interval, range_start, range_end, data_version)
            DO UPDATE SET
              expected_bars = EXCLUDED.expected_bars,
              actual_bars = EXCLUDED.actual_bars,
              missing_bars = EXCLUDED.missing_bars,
              duplicate_bars = EXCLUDED.duplicate_bars,
              updated_at = NOW()
            """,
            symbol,
            category,
            interval,
            aligned_start_ms,
            aligned_end_ms,
            expected,
            actual,
            max(0, missing),
            duplicates,
            data_version,
        )

    async def collect_funding_history(
        self,
        *,
        category: str,
        symbol: str,
        start_ms: int,
        end_ms: int,
        data_version: str,
    ) -> int:
        items: list[dict[str, Any]] = []
        cursor_end = end_ms
        while True:
            response = await self.client.get(
                "/v5/market/funding/history",
                params={"category": category, "symbol": symbol, "startTime": start_ms, "endTime": cursor_end, "limit": 200},
            )
            response.raise_for_status()
            page = response.json().get("result", {}).get("list", [])
            if not page:
                break
            items.extend(page)
            oldest = min(int(item["fundingRateTimestamp"]) for item in page)
            if oldest <= start_ms or len(page) < 200:
                break
            cursor_end = oldest - 1

        unique_items = {int(item["fundingRateTimestamp"]): item for item in items}
        async with self.pool.acquire() as conn:
            for item in unique_items.values():
                # Use exact fundingRateTimestamp. Never synthesize schedule times.
                await conn.execute(
                    """
                    INSERT INTO funding_rates (
                      symbol, category, funding_rate, funding_rate_timestamp,
                      source_fetched_at, data_version
                    ) VALUES (
                      $1, $2, $3, to_timestamp($4 / 1000.0), NOW(), $5
                    )
                    ON CONFLICT (symbol, category, funding_rate_timestamp)
                    DO UPDATE SET
                      funding_rate = EXCLUDED.funding_rate,
                      source_fetched_at = NOW(),
                      data_version = EXCLUDED.data_version
                    """,
                    symbol,
                    category,
                    item["fundingRate"],
                    int(item["fundingRateTimestamp"]),
                    data_version,
                )
            await self._write_retention_coverage(
                conn=conn,
                symbol=symbol,
                category=category,
                interval="8h",
                start_ms=start_ms,
                end_ms=end_ms,
                data_version=data_version,
                table_name="funding_rates",
                ts_column="funding_rate_timestamp",
            )
        return len(unique_items)

    async def collect_open_interest(
        self,
        *,
        category: str,
        symbol: str,
        interval_time: str,
        start_ms: int,
        end_ms: int,
        data_version: str,
    ) -> int:
        normalized_interval = _normalize_oi_ls_interval(interval_time)
        items: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {
                "category": category,
                "symbol": symbol,
                "intervalTime": normalized_interval,
                "startTime": start_ms,
                "endTime": end_ms,
                "limit": 200,
            }
            if cursor:
                params["cursor"] = cursor
            response = await self.client.get("/v5/market/open-interest", params=params)
            response.raise_for_status()
            result = response.json().get("result", {})
            page = result.get("list", [])
            items.extend(page)
            cursor = result.get("nextPageCursor") or None
            if not cursor:
                break
        unique_items = {int(item["timestamp"]): item for item in items}
        async with self.pool.acquire() as conn:
            for item in unique_items.values():
                await conn.execute(
                    """
                    INSERT INTO open_interest (
                      symbol, interval_time, ts, open_interest, data_version
                    ) VALUES (
                      $1, $2, to_timestamp($3 / 1000.0), $4, $5
                    )
                    ON CONFLICT (symbol, interval_time, ts)
                    DO UPDATE SET
                      open_interest = EXCLUDED.open_interest,
                      data_version = EXCLUDED.data_version,
                      source_fetched_at = NOW()
                    """,
                    symbol,
                    normalized_interval,
                    int(item["timestamp"]),
                    item["openInterest"],
                    data_version,
                )
            await self._write_retention_coverage(
                conn=conn,
                symbol=symbol,
                category=category,
                interval=normalized_interval,
                start_ms=start_ms,
                end_ms=end_ms,
                data_version=data_version,
                table_name="open_interest",
                ts_column="ts",
            )
        return len(unique_items)

    async def collect_long_short_ratio(
        self,
        *,
        category: str,
        symbol: str,
        period: str,
        start_ms: int,
        end_ms: int,
        data_version: str,
    ) -> int:
        normalized_period = _normalize_oi_ls_interval(period)
        items: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {
                "category": category,
                "symbol": symbol,
                "period": normalized_period,
                "startTime": start_ms,
                "endTime": end_ms,
                "limit": 500,
            }
            if cursor:
                params["cursor"] = cursor
            response = await self.client.get("/v5/market/account-ratio", params=params)
            response.raise_for_status()
            result = response.json().get("result", {})
            page = result.get("list", [])
            items.extend(page)
            cursor = result.get("nextPageCursor") or None
            if not cursor:
                break
        unique_items = {int(item["timestamp"]): item for item in items}

        async with self.pool.acquire() as conn:
            for item in unique_items.values():
                await conn.execute(
                    """
                    INSERT INTO long_short_ratio (
                      symbol, period, ts, buy_ratio, sell_ratio, data_version
                    ) VALUES (
                      $1, $2, to_timestamp($3 / 1000.0), $4, $5, $6
                    )
                    ON CONFLICT (symbol, period, ts)
                    DO UPDATE SET
                      buy_ratio = EXCLUDED.buy_ratio,
                      sell_ratio = EXCLUDED.sell_ratio,
                      data_version = EXCLUDED.data_version,
                      source_fetched_at = NOW()
                    """,
                    symbol,
                    normalized_period,
                    int(item["timestamp"]),
                    item["buyRatio"],
                    item["sellRatio"],
                    data_version,
                )
            await self._write_retention_coverage(
                conn=conn,
                symbol=symbol,
                category=category,
                interval=normalized_period,
                start_ms=start_ms,
                end_ms=end_ms,
                data_version=data_version,
                table_name="long_short_ratio",
                ts_column="ts",
            )
        return len(unique_items)

    async def collect_instruments_info(self, *, category: str, data_version: str) -> int:
        risk_limit_map = await self._fetch_risk_limits(category=category)
        items: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {"category": category, "limit": 1000}
            if cursor:
                params["cursor"] = cursor
            response = await self.client.get("/v5/market/instruments-info", params=params)
            response.raise_for_status()
            result = response.json().get("result", {})
            items.extend(result.get("list", []))
            cursor = result.get("nextPageCursor") or None
            if not cursor:
                break

        now = datetime.now(timezone.utc)
        async with self.pool.acquire() as conn:
            for item in items:
                price_filter = item.get("priceFilter", {})
                lot_filter = item.get("lotSizeFilter", {})
                lev_filter = item.get("leverageFilter", {})
                tick_size = price_filter.get("tickSize", "0")
                qty_step = lot_filter.get("qtyStep", "0")
                max_leverage = lev_filter.get("maxLeverage")
                funding_interval = item.get("fundingInterval")
                # WS-A extra filters / WS-D funding caps (all from the public instrument snapshot)
                extra_filters = {
                    "minPrice": price_filter.get("minPrice"),
                    "maxPrice": price_filter.get("maxPrice"),
                    "minOrderQty": lot_filter.get("minOrderQty"),
                    "maxOrderQty": lot_filter.get("maxOrderQty"),
                    "maxMktOrderQty": lot_filter.get("maxMktOrderQty"),
                    "minNotionalValue": lot_filter.get("minNotionalValue"),
                    "minLeverage": lev_filter.get("minLeverage"),
                    "leverageStep": lev_filter.get("leverageStep"),
                    "upperFundingRate": item.get("upperFundingRate"),
                    "lowerFundingRate": item.get("lowerFundingRate"),
                    "priceLimitRatioX": price_filter.get("priceLimitRatioX"),
                    "priceLimitRatioY": price_filter.get("priceLimitRatioY"),
                    # WS-E: settle-coin ledgers / UTA collateral
                    "settleCoin": item.get("settleCoin"),
                    "unifiedMarginTrade": item.get("unifiedMarginTrade"),
                    "contractType": item.get("contractType"),
                }
                raw_tiers = risk_limit_map.get(item.get("symbol", ""), [])
                mm_tiers = sorted(
                    [
                        {
                            "risk_id": t.get("id"),
                            "notional_cap": t.get("riskLimitValue"),
                            "mmr_fraction": t.get("maintenanceMargin"),
                            "initial_margin_fraction": t.get("initialMargin"),
                            "max_leverage": t.get("maxLeverage"),
                            # WS-0/WS-C: mmDeduction (makes the ladder continuous) and isLowestRisk
                            # ARE returned by /v5/market/risk-limit (verified live 2026-05).
                            "mm_deduction": t.get("mmDeduction"),
                            "is_lowest_risk": bool(t.get("isLowestRisk")),
                        }
                        for t in raw_tiers
                    ],
                    key=lambda t: Decimal(str(t.get("notional_cap") or "0")),
                )

                await conn.execute(
                    """
                    INSERT INTO instrument_snapshots (
                      symbol, tick_size, qty_step, funding_interval_minutes,
                      max_leverage, maintenance_margin_tiers_json, extra_filters_json, status,
                      valid_from, data_version
                    ) VALUES (
                      $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10
                    )
                    ON CONFLICT (symbol, valid_from)
                    DO NOTHING
                    """,
                    item.get("symbol"),
                    tick_size,
                    qty_step,
                    int(funding_interval) if funding_interval else None,
                    max_leverage,
                    json.dumps(mm_tiers),
                    json.dumps(extra_filters),
                    item.get("status", "Unknown"),
                    now,
                    data_version,
                )
        return len(items)

    async def _fetch_risk_limits(self, *, category: str) -> dict[str, list[dict[str, Any]]]:
        rows: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {"category": category, "limit": 1000}
            if cursor:
                params["cursor"] = cursor
            response = await self.client.get("/v5/market/risk-limit", params=params)
            response.raise_for_status()
            result = response.json().get("result", {})
            rows.extend(result.get("list", []))
            cursor = result.get("nextPageCursor") or None
            if not cursor:
                break
        grouped: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            grouped.setdefault(row.get("symbol", ""), []).append(row)
        return grouped

    async def _write_retention_coverage(
        self,
        *,
        conn: asyncpg.Connection,
        symbol: str,
        category: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        data_version: str,
        table_name: str,
        ts_column: str,
    ) -> None:
        interval_map = {
            "5min": 300_000,
            "15min": 900_000,
            "30min": 1_800_000,
            "1h": 3_600_000,
            "4h": 14_400_000,
            "1d": 86_400_000,
            "8h": 28_800_000,
            "5m": 300_000,
            "15m": 900_000,
            "30m": 1_800_000,
        }
        step = interval_map.get(interval, 900_000)
        aligned_start_ms, aligned_end_ms = _align_range(start_ms, end_ms, step)

        rows = await conn.fetch(
            f"""
            SELECT EXTRACT(EPOCH FROM {ts_column}) * 1000 AS open_ms
            FROM {table_name}
            WHERE symbol = $1
              AND {ts_column} BETWEEN to_timestamp($2 / 1000.0) AND to_timestamp($3 / 1000.0)
            ORDER BY {ts_column} ASC
            """,
            symbol,
            aligned_start_ms,
            aligned_end_ms,
        )

        expected = max(0, ((aligned_end_ms - aligned_start_ms) // step) + 1)
        seen: dict[int, int] = {}
        for row in rows:
            ts = int(row["open_ms"])
            seen[ts] = seen.get(ts, 0) + 1

        actual = len(seen)
        duplicates = sum(count - 1 for count in seen.values() if count > 1)
        missing = expected - actual

        await conn.execute(
            """
            INSERT INTO data_coverage (
              symbol, category, interval, range_start, range_end,
              expected_bars, actual_bars, missing_bars, duplicate_bars,
              data_version, subject_to_retention, updated_at
            ) VALUES (
              $1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0),
              $6, $7, $8, $9, $10, TRUE, NOW()
            )
            ON CONFLICT (symbol, category, interval, range_start, range_end, data_version)
            DO UPDATE SET
              expected_bars = EXCLUDED.expected_bars,
              actual_bars = EXCLUDED.actual_bars,
              missing_bars = EXCLUDED.missing_bars,
              duplicate_bars = EXCLUDED.duplicate_bars,
              subject_to_retention = TRUE,
              updated_at = NOW()
            """,
            symbol,
            category,
            interval,
            aligned_start_ms,
            aligned_end_ms,
            expected,
            actual,
            max(0, missing),
            duplicates,
            data_version,
        )
