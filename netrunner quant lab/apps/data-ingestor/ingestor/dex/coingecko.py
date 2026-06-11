"""CoinGecko client for token + tokenized-stock spot prices.

The whole point of using CoinGecko here is the batch lever: `/simple/price` accepts up to 515 ids in
ONE call, so pricing hundreds of tokens costs a single credit. The binding constraint is the Demo
plan's 10,000-calls/MONTH cap (not the per-minute rate), enforced by the shared limiter's monthly
governor. Spot prices are cached ~30-60s; metadata for days.
"""
from __future__ import annotations

import os
from typing import Any

from .http import RateLimitedHTTP

COINGECKO_API_BASE = os.getenv("COINGECKO_API_BASE", "https://api.coingecko.com/api/v3")
COINGECKO_API_KEY = os.getenv("COINGECKO_API_KEY", "")
MAX_IDS_PER_CALL = 500  # under the documented 515 ceiling


def _key_headers() -> dict[str, str]:
    # Demo keys ride in a header; Pro uses x-cg-pro-api-key (+ pro base url).
    if COINGECKO_API_KEY:
        header = "x-cg-pro-api-key" if "pro-api" in COINGECKO_API_BASE else "x-cg-demo-api-key"
        return {header: COINGECKO_API_KEY}
    return {}


class CoinGeckoClient:
    def __init__(self) -> None:
        self.http = RateLimitedHTTP(
            provider="coingecko",
            base_url=COINGECKO_API_BASE,
            headers={"Accept": "application/json", **_key_headers()},
        )

    async def close(self) -> None:
        await self.http.close()

    async def simple_price(
        self,
        ids: list[str],
        *,
        vs_currencies: str = "usd",
        include_24hr_change: bool = True,
        include_last_updated_at: bool = True,
    ) -> dict[str, Any]:
        """Batch price lookup. Splits >500 ids across the minimum number of calls."""
        out: dict[str, Any] = {}
        uniq = sorted({i.strip().lower() for i in ids if i and i.strip()})
        for start in range(0, len(uniq), MAX_IDS_PER_CALL):
            chunk = uniq[start : start + MAX_IDS_PER_CALL]
            params = {
                "ids": ",".join(chunk),
                "vs_currencies": vs_currencies,
                "include_24hr_change": str(include_24hr_change).lower(),
                "include_last_updated_at": str(include_last_updated_at).lower(),
            }
            out.update(await self.http.get_json("/simple/price", params=params))
        return out

    async def coins_markets(self, ids: list[str], *, vs_currency: str = "usd", per_page: int = 250) -> list[dict[str, Any]]:
        uniq = sorted({i.strip().lower() for i in ids if i and i.strip()})
        if not uniq:
            return []
        params = {
            "vs_currency": vs_currency,
            "ids": ",".join(uniq[:per_page]),
            "per_page": min(per_page, 250),
            "page": 1,
        }
        data = await self.http.request_any("GET", "/coins/markets", params=params)
        return data if isinstance(data, list) else []
