"""Cross-process rate limiting for external market-data APIs.

A single shared token bucket per provider, backed by Redis so every collector/process/worker draws
from the same budget (the ingestor may run multiple coroutines, and the same limits apply across
restarts). Plus a month-to-date call governor for CoinGecko, whose 10,000-calls/month cap — not the
per-minute limit — is the binding constraint.

Verified limits (2026-06): GeckoTerminal 30 req/min (no key); CoinGecko Demo ~30 req/min + 10k/month.
We budget conservatively *below* the ceiling to leave headroom for retries.
"""
from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass

import redis.asyncio as redis

# Atomic token-bucket refill+consume. Returns wait-ms (0 == a token was granted).
#   KEYS[1] = bucket hash key
#   ARGV[1] = capacity   ARGV[2] = refill_per_sec   ARGV[3] = now_ms   ARGV[4] = cost
_TOKEN_BUCKET_LUA = """
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)
local wait = 0
if tokens >= cost then
  tokens = tokens - cost
else
  wait = math.ceil(((cost - tokens) / refill) * 1000)
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, 120000)
return wait
"""


@dataclass(frozen=True)
class ProviderConfig:
    name: str
    rpm: int                 # sustained requests/min budget (kept below the real ceiling)
    monthly_cap: int = 0     # 0 == no monthly cap (GeckoTerminal); >0 enforced (CoinGecko)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# Conservative defaults (real ceilings are 30/min each); override via env.
DEFAULT_PROVIDERS = {
    "geckoterminal": ProviderConfig("geckoterminal", _env_int("GECKOTERMINAL_RPM", 25)),
    "coingecko": ProviderConfig(
        "coingecko",
        _env_int("COINGECKO_RPM", 25),
        _env_int("COINGECKO_MONTHLY_CAP", 10000),
    ),
    "thegraph": ProviderConfig("thegraph", _env_int("THEGRAPH_RPM", 30)),
}


class RateLimiter:
    """Redis-backed token bucket + monthly governor, shared across processes."""

    def __init__(self, redis_url: str | None = None, providers: dict[str, ProviderConfig] | None = None) -> None:
        self.redis = redis.from_url(redis_url or os.getenv("REDIS_URL", "redis://redis:6379"))
        self.providers = providers or DEFAULT_PROVIDERS
        self._sha: str | None = None

    async def _script(self) -> str:
        if self._sha is None:
            self._sha = await self.redis.script_load(_TOKEN_BUCKET_LUA)
        return self._sha

    async def acquire(self, provider: str, cost: int = 1, max_wait_s: float = 120.0) -> None:
        """Block until `cost` tokens are available for `provider` (capped at max_wait_s total)."""
        cfg = self.providers.get(provider)
        if cfg is None:
            return  # unknown provider -> no limit
        capacity = max(cfg.rpm, cost)
        refill_per_sec = cfg.rpm / 60.0
        key = f"ratelimit:{provider}"
        sha = await self._script()
        waited = 0.0
        while True:
            now_ms = int(time.time() * 1000)
            try:
                wait_ms = int(await self.redis.evalsha(sha, 1, key, capacity, refill_per_sec, now_ms, cost))
            except redis.ResponseError:
                # script cache flushed (e.g. Redis restart) -> reload and retry
                self._sha = None
                sha = await self._script()
                continue
            if wait_ms <= 0:
                return
            sleep_s = min(wait_ms / 1000.0, 5.0)
            waited += sleep_s
            if waited > max_wait_s:
                raise TimeoutError(f"rate-limit wait for {provider} exceeded {max_wait_s}s")
            await asyncio.sleep(sleep_s)

    # --- monthly governor (CoinGecko) ---

    def _month_key(self, provider: str) -> str:
        # UTC month bucket; pass in time so tests/replay stay deterministic-ish.
        return f"apibudget:{provider}:{time.strftime('%Y-%m', time.gmtime())}"

    async def month_count(self, provider: str) -> int:
        raw = await self.redis.get(self._month_key(provider))
        return int(raw) if raw else 0

    async def monthly_remaining(self, provider: str) -> int | None:
        cfg = self.providers.get(provider)
        if cfg is None or cfg.monthly_cap <= 0:
            return None
        return max(0, cfg.monthly_cap - await self.month_count(provider))

    async def record_call(self, provider: str, n: int = 1) -> int:
        """Increment the month-to-date counter; returns the new count."""
        cfg = self.providers.get(provider)
        if cfg is None or cfg.monthly_cap <= 0:
            return 0
        key = self._month_key(provider)
        new = int(await self.redis.incrby(key, n))
        if new == n:
            await self.redis.expire(key, 60 * 60 * 24 * 32)  # ~1 month + slack
        return new

    async def can_spend(self, provider: str, n: int = 1) -> bool:
        rem = await self.monthly_remaining(provider)
        return rem is None or rem >= n

    async def close(self) -> None:
        try:
            await self.redis.aclose()
        except Exception:
            pass


# Process-wide singleton (cheap; the real state lives in Redis).
_LIMITER: RateLimiter | None = None


def get_limiter() -> RateLimiter:
    global _LIMITER
    if _LIMITER is None:
        _LIMITER = RateLimiter()
    return _LIMITER
