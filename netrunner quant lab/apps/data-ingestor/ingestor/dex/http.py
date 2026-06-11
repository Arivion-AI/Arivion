"""Rate-limited HTTP client shared by the external-API collectors.

Every outbound call to GeckoTerminal / CoinGecko / The Graph goes through here so it (1) draws a
token from the shared Redis bucket, (2) records CoinGecko's monthly spend, and (3) backs off on 429
honoring Retry-After. This is the single choke point the audit found missing.
"""
from __future__ import annotations

import asyncio
import random
from typing import Any

import httpx

from ..ratelimit import RateLimiter, get_limiter


class RateLimitedHTTP:
    def __init__(
        self,
        *,
        provider: str,
        base_url: str = "",
        limiter: RateLimiter | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 30.0,
        max_retries: int = 4,
    ) -> None:
        self.provider = provider
        self.limiter = limiter or get_limiter()
        self.client = httpx.AsyncClient(base_url=base_url, timeout=timeout, headers=headers or {})
        self.max_retries = max_retries

    async def close(self) -> None:
        await self.client.aclose()

    async def request_json(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        cost: int = 1,
    ) -> dict[str, Any]:
        last_exc: Exception | None = None
        for attempt in range(self.max_retries):
            # Respect the monthly cap (CoinGecko) before spending a token.
            if not await self.limiter.can_spend(self.provider, cost):
                raise RuntimeError(f"{self.provider} monthly budget exhausted")
            await self.limiter.acquire(self.provider, cost=cost)
            try:
                resp = await self.client.request(method, url, params=params, json=json_body)
            except httpx.HTTPError as exc:
                last_exc = exc
                await asyncio.sleep(min(2 ** attempt, 30) + random.random())
                continue
            await self.limiter.record_call(self.provider, cost)
            if resp.status_code == 429:
                retry_after = resp.headers.get("Retry-After")
                delay = float(retry_after) if (retry_after and retry_after.isdigit()) else min(2 ** attempt, 30)
                await asyncio.sleep(delay + random.random())
                last_exc = httpx.HTTPStatusError("429 rate limited", request=resp.request, response=resp)
                continue
            resp.raise_for_status()
            return resp.json()
        raise last_exc or RuntimeError(f"{self.provider} request failed after {self.max_retries} attempts")

    async def request_any(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        cost: int = 1,
    ) -> Any:
        """Like request_json but tolerates a top-level JSON array (e.g. /coins/markets)."""
        last_exc: Exception | None = None
        for attempt in range(self.max_retries):
            if not await self.limiter.can_spend(self.provider, cost):
                raise RuntimeError(f"{self.provider} monthly budget exhausted")
            await self.limiter.acquire(self.provider, cost=cost)
            try:
                resp = await self.client.request(method, url, params=params)
            except httpx.HTTPError as exc:
                last_exc = exc
                await asyncio.sleep(min(2 ** attempt, 30) + random.random())
                continue
            await self.limiter.record_call(self.provider, cost)
            if resp.status_code == 429:
                retry_after = resp.headers.get("Retry-After")
                delay = float(retry_after) if (retry_after and retry_after.isdigit()) else min(2 ** attempt, 30)
                await asyncio.sleep(delay + random.random())
                last_exc = httpx.HTTPStatusError("429 rate limited", request=resp.request, response=resp)
                continue
            resp.raise_for_status()
            return resp.json()
        raise last_exc or RuntimeError(f"{self.provider} request failed after {self.max_retries} attempts")

    async def get_json(self, url: str, params: dict[str, Any] | None = None, *, cost: int = 1) -> dict[str, Any]:
        return await self.request_json("GET", url, params=params, cost=cost)

    async def post_json(self, url: str, json_body: dict[str, Any], *, cost: int = 1) -> dict[str, Any]:
        return await self.request_json("POST", url, json_body=json_body, cost=cost)
