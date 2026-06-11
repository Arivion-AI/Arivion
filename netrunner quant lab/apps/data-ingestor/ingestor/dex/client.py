from __future__ import annotations

import os
from typing import Any

from ..cache import ApiCache
from .http import RateLimitedHTTP

GECKOTERMINAL_API_BASE = os.getenv("GECKOTERMINAL_API_BASE", "https://api.geckoterminal.com/api/v2")

# Per-data-type cache TTLs (seconds). Closed OHLCV bars are immutable; only the forming bar mutates,
# so a short TTL on the OHLCV response collapses repeated live polls into one call per window.
TTL_POOL_META = 6 * 60 * 60
TTL_TOP_POOLS = 5 * 60
TTL_OHLCV = 60
TTL_TRADES = 30


class GeckoTerminalClient:
    """GeckoTerminal (CoinGecko's on-chain product) DEX data client.

    Rate-limited via the shared Redis token bucket (25/min default vs the 30/min ceiling) with
    429/Retry-After backoff, and TTL-cached in `api_cache` so we never refetch what's still fresh.
    Free tier needs no key but requires a visible "Powered by GeckoTerminal" attribution in the UI.
    """

    def __init__(self, cache: ApiCache | None = None) -> None:
        self.http = RateLimitedHTTP(
            provider="geckoterminal",
            base_url=GECKOTERMINAL_API_BASE,
            headers={"Accept": "application/json;version=20230302"},
        )
        self.cache = cache

    async def close(self) -> None:
        await self.http.close()

    async def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self.http.get_json(path, params=params or {})

    async def _cached_get(
        self, cache_key: str, data_type: str, path: str, params: dict[str, Any], *, ttl: int, priority: int = 5
    ) -> dict[str, Any]:
        if self.cache is not None:
            hit = await self.cache.get(cache_key)
            if hit is not None:
                return hit
        data = await self.get(path, params)
        if self.cache is not None:
            await self.cache.set(cache_key, "geckoterminal", data_type, data, ttl_seconds=ttl, priority=priority)
        return data

    async def top_pools(self, network: str, *, page: int = 1) -> dict[str, Any]:
        # include token/dex metadata so pools land with real symbols (not TOKEN0/TOKEN1).
        return await self._cached_get(
            f"gt:top_pools:{network}:{page}",
            "top_pools",
            f"/networks/{network}/pools",
            {"page": page, "include": "base_token,quote_token,dex"},
            ttl=TTL_TOP_POOLS,
            priority=4,
        )

    async def pool(self, network: str, address: str) -> dict[str, Any]:
        return await self._cached_get(
            f"gt:pool:{network}:{address.lower()}",
            "pool_meta",
            f"/networks/{network}/pools/{address}",
            {"include": "base_token,quote_token,dex"},
            ttl=TTL_POOL_META,
            priority=6,
        )

    async def pool_ohlcv(
        self,
        network: str,
        address: str,
        timeframe: str,
        *,
        aggregate: int = 1,
        limit: int = 200,
        before_timestamp: int | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"aggregate": aggregate, "limit": min(max(limit, 1), 1000), "currency": "usd"}
        if before_timestamp:
            params["before_timestamp"] = before_timestamp
            # historical page (no forming bar) -> immutable, cache hard
            key = f"gt:ohlcv:{network}:{address.lower()}:{timeframe}:{aggregate}:{before_timestamp}:{limit}"
            if self.cache is not None:
                hit = await self.cache.get(key)
                if hit is not None:
                    return hit
            data = await self.get(f"/networks/{network}/pools/{address}/ohlcv/{timeframe}", params)
            if self.cache is not None:
                await self.cache.set(key, "geckoterminal", "ohlcv", data, ttl_seconds=TTL_OHLCV, is_immutable=True)
            return data
        # latest page (contains the forming bar) -> short TTL
        return await self._cached_get(
            f"gt:ohlcv:{network}:{address.lower()}:{timeframe}:{aggregate}:latest:{limit}",
            "ohlcv",
            f"/networks/{network}/pools/{address}/ohlcv/{timeframe}",
            params,
            ttl=TTL_OHLCV,
            priority=3,
        )

    async def pool_trades(self, network: str, address: str, *, limit: int = 300) -> dict[str, Any]:
        # trades are a live tape; cache only very briefly to coalesce bursts.
        return await self._cached_get(
            f"gt:trades:{network}:{address.lower()}:{limit}",
            "trades",
            f"/networks/{network}/pools/{address}/trades",
            {"limit": min(max(limit, 1), 300)},
            ttl=TTL_TRADES,
            priority=3,
        )
