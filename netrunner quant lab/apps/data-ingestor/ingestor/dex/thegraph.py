"""The Graph (decentralized network) client + Uniswap v3 Arbitrum subgraph collector.

This augments the GeckoTerminal lane with *raw on-chain* pool state — sqrtPriceX96, tick, liquidity,
fee growth — and swap events carrying tick/amounts. That richer state is what makes the
`amm_quote_snapshot` / `amm_swap_replay` execution tiers honest (vs GeckoTerminal's aggregated OHLCV).

Snapshots/swaps are written under the SAME pool_id scheme as the GeckoTerminal collector
(`gt:{network}:{address}`) so the two sources augment one pool row rather than duplicating it; the
`source` column distinguishes provenance ('uniswap_v3_subgraph' vs 'geckoterminal').

Verified facts (see memory duality-onchain-reference): gateway URL is
https://gateway.thegraph.com/api/{KEY}/subgraphs/id/{ID}; Uniswap v3 Arbitrum ID is
3V7ZY6muhxaQL5qvntX1CFXJ32W7BxXZTGTwmpH5J4t3 (NOT the mainnet 5zvR82...). Ordering pools by TVL
returns spam; we filter to a reputable-token allowlist and order by volumeUSD.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import asyncpg

from ..cache import ApiCache
from .http import RateLimitedHTTP

THEGRAPH_API_KEY = os.getenv("THEGRAPH_API_KEY", "")
THEGRAPH_GATEWAY = os.getenv("THEGRAPH_GATEWAY", "https://gateway.thegraph.com")

SUBGRAPH_IDS = {
    "uniswap_v3_arbitrum": os.getenv("UNISWAP_V3_ARBITRUM_SUBGRAPH", "3V7ZY6muhxaQL5qvntX1CFXJ32W7BxXZTGTwmpH5J4t3"),
    "camelot_v3_arbitrum": os.getenv("CAMELOT_V3_ARBITRUM_SUBGRAPH", "7mPnp1UqmefcCycB8umy4uUkTkFxMoHn1Y7ncBUscePp"),
}

# Reputable Arbitrum One tokens (lowercased) — filter out spam pools that fake their TVL.
ARBITRUM_REPUTABLE_TOKENS = {
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": "WETH",
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": "USDC",
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": "USDC.e",
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": "USDT",
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": "WBTC",
    "0x912ce59144191c1204e64559fe8253a0e49e6548": "ARB",
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": "DAI",
}

_TTL_SUBGRAPH_POOLS = 5 * 60


def _pool_id(network: str, address: str) -> str:
    return f"gt:{network}:{address.lower()}"


def _dec(value: Any, default: str = "0") -> str:
    if value is None or value == "":
        return default
    try:
        return str(Decimal(str(value)))
    except Exception:
        return default


def _int(value: Any) -> Decimal | None:
    """Parse a big-integer string (uint128/uint256 from the subgraph) to an integral Decimal
    (asyncpg maps NUMERIC <-> Decimal); None if unparseable."""
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value)).to_integral_value()
    except Exception:
        return None


def _checksum(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class TheGraphClient:
    def __init__(self) -> None:
        self.http = RateLimitedHTTP(
            provider="thegraph",
            base_url=THEGRAPH_GATEWAY,
            headers={"Accept": "application/json"},
        )

    async def close(self) -> None:
        await self.http.close()

    async def query(self, subgraph_id: str, gql: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        if not THEGRAPH_API_KEY:
            raise RuntimeError("THEGRAPH_API_KEY not set")
        path = f"/api/{THEGRAPH_API_KEY}/subgraphs/id/{subgraph_id}"
        body: dict[str, Any] = {"query": gql}
        if variables:
            body["variables"] = variables
        data = await self.http.post_json(path, body)
        if "errors" in data:
            raise RuntimeError(f"subgraph errors: {data['errors']}")
        return data.get("data") or {}

    async def meta(self, subgraph_id: str) -> dict[str, Any]:
        d = await self.query(subgraph_id, "{ _meta { block { number timestamp } hasIndexingErrors } }")
        return d.get("_meta") or {}


_POOLS_QUERY = """
query Pools($first: Int!) {
  pools(first: $first, orderBy: volumeUSD, orderDirection: desc) {
    id feeTier liquidity sqrtPrice tick token0Price token1Price
    totalValueLockedUSD volumeUSD feesUSD feeGrowthGlobal0X128 feeGrowthGlobal1X128
    token0 { id symbol decimals }
    token1 { id symbol decimals }
  }
}
"""

_POSITIONS_QUERY = """
query Positions($owner: String!, $first: Int!) {
  positions(first: $first, where: { owner: $owner }) {
    id owner liquidity depositedToken0 depositedToken1 collectedFeesToken0 collectedFeesToken1
    feeGrowthInside0LastX128 feeGrowthInside1LastX128 tickLower tickUpper
    pool {
      id feeTier sqrtPrice tick liquidity feeGrowthGlobal0X128 feeGrowthGlobal1X128
      totalValueLockedUSD volumeUSD token0Price token1Price
      token0 { id symbol decimals } token1 { id symbol decimals }
    }
  }
}
"""

_SWAPS_QUERY = """
query Swaps($pool: String!, $first: Int!) {
  swaps(first: $first, orderBy: timestamp, orderDirection: desc, where: { pool: $pool }) {
    id timestamp sender recipient amount0 amount1 amountUSD tick sqrtPriceX96
    transaction { id }
  }
}
"""


class UniswapV3SubgraphCollector:
    """Ingests Uniswap v3 (or Camelot) Arbitrum pool state + swaps from The Graph."""

    def __init__(self, pool: asyncpg.Pool, *, subgraph: str = "uniswap_v3_arbitrum", venue_id: str = "uniswap-v3-arbitrum") -> None:
        self.pool = pool
        self.subgraph_id = SUBGRAPH_IDS[subgraph]
        self.venue_id = venue_id
        self.client = TheGraphClient()
        self.cache = ApiCache(pool)
        self.network = "arbitrum"
        self.chain_id = 42161

    async def close(self) -> None:
        await self.client.close()

    async def health(self) -> dict[str, Any]:
        meta = await self.client.meta(self.subgraph_id)
        return {"subgraph_id": self.subgraph_id, **meta}

    async def _upsert_pool(self, conn: asyncpg.Connection, p: dict[str, Any]) -> dict[str, Any]:
        address = str(p["id"]).lower()
        pool_id = _pool_id(self.network, address)
        t0, t1 = p.get("token0") or {}, p.get("token1") or {}
        sym0 = str(t0.get("symbol") or "TOKEN0").upper()
        sym1 = str(t1.get("symbol") or "TOKEN1").upper()
        fee_bps = None
        try:
            fee_bps = int(int(p.get("feeTier") or 0) / 100)  # 3000 (1e-6) -> 30 bps
        except (TypeError, ValueError):
            fee_bps = None
        await conn.execute(
            """
            INSERT INTO dex_pools (pool_id, chain_id, venue_id, pool_address, token0_symbol, token1_symbol,
                                   fee_bps, status, source, metadata_json)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'active','uniswap_v3_subgraph',$8::jsonb)
            ON CONFLICT (pool_id) DO UPDATE SET
              token0_symbol = EXCLUDED.token0_symbol,
              token1_symbol = EXCLUDED.token1_symbol,
              fee_bps = COALESCE(EXCLUDED.fee_bps, dex_pools.fee_bps),
              source = EXCLUDED.source,
              metadata_json = dex_pools.metadata_json || EXCLUDED.metadata_json,
              updated_at = NOW()
            """,
            pool_id, self.chain_id, self.venue_id, address, sym0, sym1, fee_bps,
            json.dumps({"subgraph": self.subgraph_id, "feeTier": p.get("feeTier"),
                        "token0": t0.get("id"), "token1": t1.get("id"),
                        "token0_decimals": int(t0.get("decimals") or 18),
                        "token1_decimals": int(t1.get("decimals") or 18),
                        "tvl_usd": p.get("totalValueLockedUSD"), "volume_usd": p.get("volumeUSD")}),
        )
        for tok in (t0, t1):
            addr = str(tok.get("id") or "").lower()
            if addr.startswith("0x"):
                await conn.execute(
                    """
                    INSERT INTO token_registry (chain_id, address, symbol, name, decimals, asset_class, source, metadata_json)
                    VALUES ($1,$2,$3,$4,$5,'crypto','uniswap_v3_subgraph','{}'::jsonb)
                    ON CONFLICT (chain_id, address) DO UPDATE SET
                      symbol = EXCLUDED.symbol, decimals = EXCLUDED.decimals,
                      source = EXCLUDED.source, updated_at = NOW()
                    """,
                    self.chain_id, addr, str(tok.get("symbol") or "?").upper(),
                    str(tok.get("symbol") or "?"), int(tok.get("decimals") or 18),
                )
        # Raw on-chain pool state snapshot — the value-add over GeckoTerminal. Raw L / feeGrowth go
        # in the wide scale-0 columns (0024); the NUMERIC(38,18) liquidity/price columns stay null here.
        await conn.execute(
            """
            INSERT INTO dex_pool_snapshots (pool_id, block_number, ts, sqrt_price_x96, tick,
                                            liquidity_raw, fee_growth_global0_x128, fee_growth_global1_x128,
                                            source, checksum, metadata_json)
            VALUES ($1,0,NOW(),$2,$3,$4,$5,$6,'uniswap_v3_subgraph',$7,$8::jsonb)
            ON CONFLICT (pool_id, block_number, ts, source) DO NOTHING
            """,
            pool_id,
            _int(p.get("sqrtPrice")),
            int(p.get("tick") or 0),
            _int(p.get("liquidity")),
            _int(p.get("feeGrowthGlobal0X128")),
            _int(p.get("feeGrowthGlobal1X128")),
            _checksum(p),
            json.dumps({"tvl_usd": p.get("totalValueLockedUSD"),
                        "token0Price": p.get("token0Price"), "token1Price": p.get("token1Price")}),
        )
        return {"pool_id": pool_id, "pool_address": address, "venue_id": self.venue_id,
                "token0_symbol": sym0, "token1_symbol": sym1, "fee_bps": fee_bps}

    async def sync_pools(self, *, first: int = 50, reputable_only: bool = True) -> dict[str, Any]:
        d = await self.client.query(self.subgraph_id, _POOLS_QUERY, {"first": min(max(first, 1), 500)})
        pools = d.get("pools") or []
        rows: list[dict[str, Any]] = []
        async with self.pool.acquire() as conn:
            for p in pools:
                t0 = str((p.get("token0") or {}).get("id") or "").lower()
                t1 = str((p.get("token1") or {}).get("id") or "").lower()
                if reputable_only and not (t0 in ARBITRUM_REPUTABLE_TOKENS and t1 in ARBITRUM_REPUTABLE_TOKENS):
                    continue
                rows.append(await self._upsert_pool(conn, p))
        return {"network": self.network, "subgraph_id": self.subgraph_id, "count": len(rows),
                "pools": rows, "source": "uniswap_v3_subgraph"}

    async def sync_swaps(self, *, pool_address: str, first: int = 200) -> dict[str, Any]:
        address = pool_address.lower()
        pool_id = _pool_id(self.network, address)
        # This Uniswap v3 Arbitrum deployment does NOT index a top-level `swaps` entity (it indexes
        # positions/mints/burns). Swaps come from the GeckoTerminal trades lane instead.
        try:
            d = await self.client.query(self.subgraph_id, _SWAPS_QUERY, {"pool": address, "first": min(max(first, 1), 1000)})
        except RuntimeError as exc:
            if "has no field `swaps`" in str(exc):
                return {"pool_id": pool_id, "network": self.network, "rows": 0,
                        "source": "uniswap_v3_subgraph", "supported": False,
                        "note": "subgraph has no swaps entity; use the GeckoTerminal trades lane (/api/dex/backfill/swaps)"}
            raise
        swaps = d.get("swaps") or []
        rows = 0
        async with self.pool.acquire() as conn:
            exists = await conn.fetchrow("SELECT 1 FROM dex_pools WHERE pool_id=$1", pool_id)
            if exists is None:
                # need pool metadata first
                await self.sync_pools(reputable_only=False)
            for s in swaps:
                tx = str((s.get("transaction") or {}).get("id") or s.get("id") or "")
                log_index = 0
                try:
                    log_index = int(str(s.get("id")).split("#")[-1])
                except (ValueError, IndexError):
                    log_index = 0
                ts = datetime.fromtimestamp(int(s.get("timestamp") or 0), tz=timezone.utc)
                await conn.execute(
                    """
                    INSERT INTO dex_swaps (tx_hash, log_index, pool_id, block_number, ts, sender, recipient,
                                           amount0, amount1, amount_usd, source, payload_json)
                    VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8,$9,'uniswap_v3_subgraph',$10::jsonb)
                    ON CONFLICT (tx_hash, log_index, pool_id, ts) DO NOTHING
                    """,
                    tx, log_index, pool_id, ts, s.get("sender"), s.get("recipient"),
                    _dec(s.get("amount0")), _dec(s.get("amount1")), _dec(s.get("amountUSD")),
                    json.dumps({"tick": s.get("tick"), "sqrtPriceX96": s.get("sqrtPriceX96"), "id": s.get("id")}),
                )
                rows += 1
        return {"pool_id": pool_id, "network": self.network, "rows": rows, "source": "uniswap_v3_subgraph"}

    async def sync_positions(self, *, wallet: str, first: int = 200) -> dict[str, Any]:
        """Sync a wallet's LP positions (raw state) into lp_positions; upserts each position's pool."""
        owner = wallet.lower()
        d = await self.client.query(self.subgraph_id, _POSITIONS_QUERY, {"owner": owner, "first": min(max(first, 1), 1000)})
        positions = d.get("positions") or []
        rows = 0
        async with self.pool.acquire() as conn:
            # link to a Duality owner if this wallet is verified (wallet_links)
            owner_id = await conn.fetchval(
                "SELECT owner_id FROM wallet_links WHERE lower(wallet_address)=$1 AND chain_id=$2 LIMIT 1",
                owner, self.chain_id,
            )
            for p in positions:
                pool = p.get("pool") or {}
                pool_meta = await self._upsert_pool(conn, pool)
                pool_id = pool_meta["pool_id"]
                nft_id = str(p.get("id"))
                liquidity = _int(p.get("liquidity")) or Decimal(0)
                status = "open" if liquidity > 0 else "closed"
                await conn.execute(
                    """
                    INSERT INTO lp_positions (position_id, owner_id, wallet_address, chain_id, pool_id, venue_id,
                        nft_id, tick_lower, tick_upper, liquidity, deposited_token0, deposited_token1,
                        collected_fees_token0, collected_fees_token1, fee_growth_inside0_last_x128,
                        fee_growth_inside1_last_x128, status, source, metadata_json)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'uniswap_v3_subgraph',$18::jsonb)
                    ON CONFLICT (position_id) DO UPDATE SET
                      owner_id = COALESCE(EXCLUDED.owner_id, lp_positions.owner_id),
                      liquidity = EXCLUDED.liquidity,
                      collected_fees_token0 = EXCLUDED.collected_fees_token0,
                      collected_fees_token1 = EXCLUDED.collected_fees_token1,
                      fee_growth_inside0_last_x128 = EXCLUDED.fee_growth_inside0_last_x128,
                      fee_growth_inside1_last_x128 = EXCLUDED.fee_growth_inside1_last_x128,
                      status = EXCLUDED.status,
                      updated_at = NOW()
                    """,
                    f"univ3:{self.network}:{nft_id}", owner_id, owner, self.chain_id, pool_id, self.venue_id,
                    nft_id, int(p.get("tickLower") or 0), int(p.get("tickUpper") or 0), liquidity,
                    _int(p.get("depositedToken0")), _int(p.get("depositedToken1")),
                    _int(p.get("collectedFeesToken0")), _int(p.get("collectedFeesToken1")),
                    _int(p.get("feeGrowthInside0LastX128")), _int(p.get("feeGrowthInside1LastX128")),
                    status, json.dumps({"feeTier": pool.get("feeTier")}),
                )
                rows += 1
        return {"wallet": owner, "chain_id": self.chain_id, "owner_id": owner_id, "count": rows,
                "source": "uniswap_v3_subgraph"}
