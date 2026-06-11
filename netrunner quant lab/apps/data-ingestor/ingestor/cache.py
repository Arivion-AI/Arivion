"""Durable TTL cache over the `api_cache` table (migration 0023).

The rule the whole ingestion layer follows: *never refetch what's still fresh*, and *never refetch
immutable data* (closed OHLCV bars, stable token metadata). The Redis token bucket
(`ratelimit.py`) caps the call rate; this cache cuts the number of calls we need at all.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import asyncpg


class ApiCache:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def get(self, cache_key: str) -> dict[str, Any] | None:
        """Return the cached payload if present and fresh (or immutable), else None."""
        row = await self.pool.fetchrow(
            """
            SELECT payload, expires_at, is_immutable, etag, last_modified
            FROM api_cache WHERE cache_key = $1
            """,
            cache_key,
        )
        if row is None:
            return None
        now = datetime.now(tz=timezone.utc)
        if row["is_immutable"] or row["expires_at"] > now:
            payload = row["payload"]
            return payload if isinstance(payload, dict) else json.loads(payload)
        return None

    async def get_meta(self, cache_key: str) -> dict[str, Any] | None:
        """Return {etag, last_modified} for conditional requests even if stale."""
        row = await self.pool.fetchrow(
            "SELECT etag, last_modified FROM api_cache WHERE cache_key = $1", cache_key
        )
        return dict(row) if row else None

    async def set(
        self,
        cache_key: str,
        provider: str,
        data_type: str,
        payload: dict[str, Any],
        *,
        ttl_seconds: int,
        is_immutable: bool = False,
        etag: str | None = None,
        last_modified: str | None = None,
        priority: int = 5,
    ) -> None:
        now = datetime.now(tz=timezone.utc)
        expires_at = now + timedelta(seconds=max(0, ttl_seconds))
        await self.pool.execute(
            """
            INSERT INTO api_cache (cache_key, provider, data_type, payload, etag, last_modified,
                                   fetched_at, ttl_seconds, expires_at, is_immutable, priority)
            VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (cache_key) DO UPDATE SET
              payload = EXCLUDED.payload,
              etag = EXCLUDED.etag,
              last_modified = EXCLUDED.last_modified,
              fetched_at = EXCLUDED.fetched_at,
              ttl_seconds = EXCLUDED.ttl_seconds,
              expires_at = EXCLUDED.expires_at,
              is_immutable = EXCLUDED.is_immutable,
              priority = EXCLUDED.priority
            """,
            cache_key,
            provider,
            data_type,
            json.dumps(payload),
            etag,
            last_modified,
            now,
            int(ttl_seconds),
            expires_at,
            is_immutable,
            int(priority),
        )

    async def stale_keys(self, provider: str, limit: int = 50) -> list[str]:
        """Keys due for refresh (TTL expired, not immutable), highest priority first."""
        rows = await self.pool.fetch(
            """
            SELECT cache_key FROM api_cache
            WHERE provider = $1 AND NOT is_immutable AND expires_at <= NOW()
            ORDER BY priority ASC, expires_at ASC
            LIMIT $2
            """,
            provider,
            limit,
        )
        return [r["cache_key"] for r in rows]
