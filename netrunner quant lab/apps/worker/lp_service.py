"""LP position valuation + range simulation (worker side; uses quant_core.lp_math).

Honest by construction: value is USD-anchored only when one leg is a known stablecoin (otherwise we
report a token1-denominated value and say so); uncollected fees need per-tick fee-growth we don't
index yet, so we report *collected* fees and flag the rest. Everything carries a truth note.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

import asyncpg

from quant_core import lp_math

STABLES = {"USDC", "USDC.E", "USDT", "USDG", "DAI", "USD", "USDBC", "FRAX"}


def _dec(v: Any) -> Decimal:
    if v is None:
        return Decimal(0)
    return v if isinstance(v, Decimal) else Decimal(str(v))


async def _pool_decimals(conn: asyncpg.Connection, chain_id: int, metadata_json: Any) -> tuple[int, int]:
    """Resolve token decimals: explicit metadata first (reliable), then token_registry by address."""
    import json as _json
    meta = metadata_json if isinstance(metadata_json, dict) else (_json.loads(metadata_json) if metadata_json else {})
    # 1) explicit decimals stored by the subgraph collector
    if meta.get("token0_decimals") is not None and meta.get("token1_decimals") is not None:
        return int(meta["token0_decimals"]), int(meta["token1_decimals"])
    # 2) fall back to token_registry by address
    d0 = d1 = 18
    for addr_key, idx in (("token0", 0), ("token1", 1)):
        addr = str(meta.get(addr_key) or "").lower()
        if addr.startswith("0x"):
            dec = await conn.fetchval(
                "SELECT decimals FROM token_registry WHERE chain_id=$1 AND lower(address)=$2", chain_id, addr
            )
            if dec is not None:
                if idx == 0:
                    d0 = int(dec)
                else:
                    d1 = int(dec)
    return d0, d1


async def value_position(pool: asyncpg.Pool, position_id: str) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT lp.position_id, lp.wallet_address, lp.chain_id, lp.pool_id, lp.tick_lower, lp.tick_upper,
                   lp.liquidity, lp.deposited_token0, lp.deposited_token1,
                   lp.collected_fees_token0, lp.collected_fees_token1, lp.status,
                   p.token0_symbol, p.token1_symbol, p.fee_bps, p.metadata_json,
                   s.sqrt_price_x96, s.tick AS pool_tick, s.liquidity_raw AS pool_liquidity
            FROM lp_positions lp
            JOIN dex_pools p ON p.pool_id = lp.pool_id
            LEFT JOIN LATERAL (
              SELECT sqrt_price_x96, tick, liquidity_raw FROM dex_pool_snapshots
              WHERE pool_id = lp.pool_id AND sqrt_price_x96 IS NOT NULL
              ORDER BY ts DESC LIMIT 1
            ) s ON TRUE
            WHERE lp.position_id = $1
            """,
            position_id,
        )
        if row is None:
            return {"ok": False, "error": "POSITION_NOT_FOUND"}
        if row["sqrt_price_x96"] is None:
            return {"ok": False, "error": "NO_POOL_SNAPSHOT", "hint": "sync subgraph pools first"}
        d0, d1 = await _pool_decimals(conn, int(row["chain_id"]), row["metadata_json"])

    sym0, sym1 = row["token0_symbol"], row["token1_symbol"]
    sqrt_p = _dec(row["sqrt_price_x96"])
    price0_in_t1 = lp_math.price0_in_token1(sqrt_p, d0, d1)

    # USD anchor via a stable leg.
    note = None
    if sym1 in STABLES:
        price0_usd, price1_usd = price0_in_t1, Decimal(1)
    elif sym0 in STABLES:
        price0_usd, price1_usd = Decimal(1), (Decimal(1) / price0_in_t1 if price0_in_t1 else Decimal(0))
    else:
        price0_usd, price1_usd = Decimal(0), Decimal(0)
        note = f"no stable leg ({sym0}/{sym1}); value_usd unavailable, amounts are exact"

    pv = lp_math.position_value_usd(
        sqrt_price_x96=sqrt_p, current_tick=int(row["pool_tick"] or 0),
        tick_lower=int(row["tick_lower"]), tick_upper=int(row["tick_upper"]),
        liquidity=_dec(row["liquidity"]), decimals0=d0, decimals1=d1,
        price0_usd=price0_usd, price1_usd=price1_usd,
    )
    collected0 = _dec(row["collected_fees_token0"]) / (Decimal(10) ** d0)
    collected1 = _dec(row["collected_fees_token1"]) / (Decimal(10) ** d1)
    return {
        "ok": True,
        "position_id": row["position_id"],
        "pool_id": row["pool_id"],
        "pair": f"{sym0}/{sym1}",
        "fee_bps": row["fee_bps"],
        "tick_lower": int(row["tick_lower"]),
        "tick_upper": int(row["tick_upper"]),
        "current_tick": int(row["pool_tick"] or 0),
        "in_range": pv.in_range,
        "amount0": str(pv.amount0),
        "amount1": str(pv.amount1),
        "value_usd": str(pv.value_usd) if note is None else None,
        "collected_fees": {sym0: str(collected0), sym1: str(collected1)},
        "status": row["status"],
        "truth": {
            "data_source": "uniswap_v3_subgraph",
            "value_basis": "stable_anchored" if note is None else "amounts_only",
            "uncollected_fees": "not computed (needs per-tick fee-growth indexing)",
            "note": note,
            "can_execute_real_money": False,
        },
    }


async def value_wallet(pool: asyncpg.Pool, wallet: str) -> dict[str, Any]:
    async with pool.acquire() as conn:
        ids = [r["position_id"] for r in await conn.fetch(
            "SELECT position_id FROM lp_positions WHERE lower(wallet_address)=$1 AND status='open'", wallet.lower()
        )]
    positions = [await value_position(pool, pid) for pid in ids]
    total = sum(Decimal(p["value_usd"]) for p in positions if p.get("ok") and p.get("value_usd"))
    return {"ok": True, "wallet": wallet.lower(), "count": len(positions), "total_value_usd": str(total), "positions": positions}


async def simulate_range(
    pool: asyncpg.Pool,
    *,
    pool_id: str,
    capital_usd: Decimal,
    range_pct: Decimal = Decimal("10"),
) -> dict[str, Any]:
    """Simulate opening a position of `capital_usd` in a +/-range_pct band around the current price.

    Returns the token split, in-range status, and a rough fee-APR estimate. Estimate, not a promise.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT p.token0_symbol, p.token1_symbol, p.fee_bps, p.chain_id, p.metadata_json,
                   s.sqrt_price_x96, s.tick, s.liquidity_raw AS pool_liquidity,
                   (s.metadata_json->>'tvl_usd') AS tvl_usd,
                   (s.metadata_json->>'volume_usd') gv
            FROM dex_pools p
            LEFT JOIN LATERAL (
              SELECT sqrt_price_x96, tick, liquidity_raw, metadata_json FROM dex_pool_snapshots
              WHERE pool_id = p.pool_id AND sqrt_price_x96 IS NOT NULL ORDER BY ts DESC LIMIT 1
            ) s ON TRUE
            WHERE p.pool_id = $1
            """,
            pool_id,
        )
        if row is None or row["sqrt_price_x96"] is None:
            return {"ok": False, "error": "NO_POOL_SNAPSHOT", "hint": "sync subgraph pools first"}
        d0, d1 = await _pool_decimals(conn, int(row["chain_id"]), row["metadata_json"])
        pool_meta = await conn.fetchval("SELECT metadata_json FROM dex_pools WHERE pool_id=$1", pool_id)

    sym0, sym1 = row["token0_symbol"], row["token1_symbol"]
    sqrt_p = _dec(row["sqrt_price_x96"])
    current_tick = int(row["tick"] or 0)
    price0_in_t1 = lp_math.price0_in_token1(sqrt_p, d0, d1)

    # Derive a tick band from +/- range_pct. tick spacing ~ ln(1+pct)/ln(1.0001).
    from decimal import Decimal as D
    import math
    frac = float(range_pct) / 100.0
    width_ticks = int(math.log(1 + frac) / math.log(1.0001))
    tick_lower, tick_upper = current_tick - width_ticks, current_tick + width_ticks

    # Solve liquidity L so the position's value == capital_usd, anchored on a stable leg.
    if sym1 in STABLES:
        price0_usd, price1_usd = price0_in_t1, D(1)
    elif sym0 in STABLES:
        price0_usd, price1_usd = D(1), (D(1) / price0_in_t1 if price0_in_t1 else D(0))
    else:
        return {"ok": False, "error": "NO_STABLE_LEG", "pair": f"{sym0}/{sym1}",
                "hint": "USD sizing needs a stablecoin leg"}

    # value is linear in L -> compute value at L=1e18 then scale.
    probe = D(10) ** 18
    pv = lp_math.position_value_usd(
        sqrt_price_x96=sqrt_p, current_tick=current_tick, tick_lower=tick_lower, tick_upper=tick_upper,
        liquidity=probe, decimals0=d0, decimals1=d1, price0_usd=price0_usd, price1_usd=price1_usd,
    )
    if pv.value_usd <= 0:
        return {"ok": False, "error": "DEGENERATE_RANGE"}
    L = probe * capital_usd / pv.value_usd
    final = lp_math.position_value_usd(
        sqrt_price_x96=sqrt_p, current_tick=current_tick, tick_lower=tick_lower, tick_upper=tick_upper,
        liquidity=L, decimals0=d0, decimals1=d1, price0_usd=price0_usd, price1_usd=price1_usd,
    )

    # Rough fee APR: position share of in-range liquidity * pool fee revenue, annualized.
    fee_bps = D(row["fee_bps"] or 30)
    vol_usd = _dec(row["gv"])  # cumulative volume from subgraph (lifetime) — use as a crude proxy only
    pool_L = _dec(row["pool_liquidity"]) or D(1)
    share = L / (pool_L + L)
    fee_apr_note = "fee APR omitted (need 24h volume; subgraph gives lifetime volume only)"
    return {
        "ok": True,
        "pool_id": pool_id,
        "pair": f"{sym0}/{sym1}",
        "fee_bps": int(fee_bps),
        "capital_usd": str(capital_usd),
        "range_pct": str(range_pct),
        "tick_lower": tick_lower,
        "tick_upper": tick_upper,
        "in_range": final.in_range,
        "split": {sym0: str(final.amount0), sym1: str(final.amount1)},
        "value_usd": str(final.value_usd),
        "liquidity": str(L.to_integral_value()),
        "pool_liquidity_share": str(share),
        "truth": {
            "data_source": "uniswap_v3_subgraph",
            "result_tier": "DEX MODELED",
            "fee_apr": fee_apr_note,
            "note": "Concentrated-liquidity simulation; not a quote or a promise of fills.",
            "can_execute_real_money": False,
        },
    }
