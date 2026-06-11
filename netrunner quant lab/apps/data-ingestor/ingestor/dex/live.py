from __future__ import annotations

import json
from typing import Any

import asyncpg
import redis.asyncio as redis

from .uniswap_v3 import DexCollector


class DexLivePoller:
    def __init__(self, pool: asyncpg.Pool, redis_url: str) -> None:
        self.pool = pool
        self.redis_url = redis_url
        self.watch: dict[str, dict[str, Any]] = {}

    async def subscribe(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        for item in items:
            network = str(item.get("network") or "arbitrum")
            pool_address = str(item.get("poolAddress") or item.get("pool_address") or "").lower()
            interval = str(item.get("interval") or "hour")
            if not pool_address:
                continue
            self.watch[f"{network}:{pool_address}:{interval}"] = {
                "network": network,
                "pool_address": pool_address,
                "interval": interval,
            }
        return list(self.watch.values())

    def status(self) -> dict[str, Any]:
        return {"dex_watch_count": len(self.watch), "dex_watch": list(self.watch.values())}

    async def poll_once(self) -> dict[str, Any]:
        collector = DexCollector(self.pool)
        client = redis.from_url(self.redis_url)
        try:
            published = 0
            for item in self.watch.values():
                result = await collector.backfill_candles(
                    network=item["network"],
                    pool_address=item["pool_address"],
                    interval=item["interval"],
                    limit=3,
                )
                await collector.backfill_swaps(network=item["network"], pool_address=item["pool_address"], limit=25)
                pool_id = result["pool_id"]
                rows = await self.pool.fetch(
                    """
                    SELECT close::text AS close, volume_usd::text AS volume_usd, open_time, source
                    FROM dex_candles
                    WHERE pool_id=$1 AND interval=$2
                    ORDER BY open_time DESC
                    LIMIT 1
                    """,
                    pool_id,
                    item["interval"],
                )
                if rows:
                    payload = {
                        "pool_id": pool_id,
                        "network": item["network"],
                        "pool_address": item["pool_address"],
                        "interval": item["interval"],
                        "close": rows[0]["close"],
                        "volume_usd": rows[0]["volume_usd"],
                        "open_time": rows[0]["open_time"].isoformat(),
                        "source": rows[0]["source"],
                    }
                    await client.publish(f"rt:dex:candle:{pool_id}", json.dumps(payload))
                    await client.publish(f"rt:dex:pool:{pool_id}", json.dumps(payload))
                    published += 2
            return {"ok": True, "watched": len(self.watch), "published": published}
        finally:
            await client.close()
            await collector.close()
