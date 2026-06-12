"""Worker-side loaders that back the pure ``quant_core`` L2/trade providers with Postgres.

``quant_core`` stays database-free: it consumes *lookup callables*. This module turns
recorded ``l2_snapshots`` / ``trades`` rows into those callables and decides, per the
requested fidelity + recorded coverage, which provider (if any) to install — or whether the
run must be rejected for insufficient coverage.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal

from quant_core.execution import Fidelity
from quant_core.bybit_venue import InstrumentFilter, risk_tiers_from_snapshot
from quant_core.l2_replay import (
    L2QueueProvider,
    L2Snapshot,
    L2SweepProvider,
    TradePrint,
    snapshot_lookup_from_list,
    trade_lookup_from_list,
)


def _levels(v) -> list[tuple]:
    """Parse a JSONB level array (``[[price, size], ...]``) from asyncpg (str or list)."""
    if v is None:
        return []
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except Exception:
            return []
    out: list[tuple] = []
    for lvl in v or []:
        try:
            out.append((lvl[0], lvl[1]))
        except Exception:
            continue
    return out


async def load_l2_snapshots(conn, symbol, category, start_ms, end_ms) -> list[L2Snapshot]:
    rows = await conn.fetch(
        """SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms, sequence_id,
                  bid_levels_json, ask_levels_json
             FROM l2_snapshots
            WHERE symbol = $1 AND category = $2
              AND ts >= to_timestamp($3 / 1000.0) AND ts <= to_timestamp($4 / 1000.0)
            ORDER BY ts ASC""",
        symbol, category, int(start_ms), int(end_ms),
    )
    return [
        L2Snapshot.from_levels(
            int(r["ts_ms"]), _levels(r["bid_levels_json"]), _levels(r["ask_levels_json"]),
            sequence_id=r["sequence_id"],
        )
        for r in rows
    ]


async def load_trades(conn, symbol, category, start_ms, end_ms) -> list[TradePrint]:
    """Load public trade prints. Returns [] if the trades table does not exist yet
    (Phase 3 migration), so callers degrade gracefully rather than 500."""
    try:
        rows = await conn.fetch(
            """SELECT trade_time_ms, price, qty, side
                 FROM trades
                WHERE symbol = $1 AND category = $2
                  AND trade_time_ms >= $3 AND trade_time_ms < $4
                ORDER BY trade_time_ms ASC""",
            symbol, category, int(start_ms), int(end_ms),
        )
    except Exception:
        return []
    return [
        TradePrint(int(r["trade_time_ms"]), Decimal(str(r["price"])), Decimal(str(r["qty"])), str(r["side"]))
        for r in rows
    ]


def bars_range_ms(bars, interval_ms: int = 60_000) -> tuple[int, int]:
    """[start, end) covering the bar series, padded one bar at the end for trade windows."""
    start_ms = int(bars[0].ts.timestamp() * 1000)
    end_ms = int(bars[-1].ts.timestamp() * 1000) + int(interval_ms)
    return start_ms, end_ms


@dataclass
class ProviderBuild:
    provider: object | None          # the installed provider (or None ⇒ bar-based)
    error: str | None = None         # coverage error code; caller should reject the run
    fallback_reason: str | None = None  # set when a requested fidelity fell back to a lower one
    snapshots_loaded: int = 0
    trades_loaded: int = 0


@dataclass
class VenueBuild:
    instrument_filter: InstrumentFilter | None
    risk_tiers: list | None = None
    funding_caps: tuple[Decimal | None, Decimal | None] | None = None
    extra_filters: dict | None = None
    data_version: str | None = None


def _json_obj(v) -> dict:
    if v is None:
        return {}
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return v if isinstance(v, dict) else {}


def _json_list(v) -> list:
    if v is None:
        return []
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
        except Exception:
            return []
        return parsed if isinstance(parsed, list) else []
    return v if isinstance(v, list) else []


def _dec(v, default: str = "0") -> Decimal:
    if v is None or v == "":
        return Decimal(default)
    return Decimal(str(v))


def _opt_dec(v) -> Decimal | None:
    if v is None or v == "":
        return None
    return Decimal(str(v))


async def load_instrument_filter(conn, symbol: str, category: str) -> VenueBuild:
    """Build Bybit venue-exactness inputs from the latest recorded instrument snapshot."""
    row = await conn.fetchrow(
        """
        SELECT tick_size, qty_step, max_leverage, extra_filters_json,
               maintenance_margin_tiers_json, data_version
        FROM instrument_snapshots
        WHERE symbol = $1
        ORDER BY source_fetched_at DESC NULLS LAST, valid_from DESC NULLS LAST
        LIMIT 1
        """,
        symbol,
    )
    if not row:
        return VenueBuild(instrument_filter=None)
    extra = _json_obj(row["extra_filters_json"])
    tiers_raw = _json_list(row["maintenance_margin_tiers_json"])
    try:
        risk_tiers = risk_tiers_from_snapshot(tiers_raw) if tiers_raw else []
    except Exception:
        risk_tiers = []

    instr = InstrumentFilter(
        symbol=symbol,
        category=category,
        tick_size=_dec(row["tick_size"], "0.01"),
        min_price=_dec(extra.get("minPrice"), "0"),
        max_price=_dec(extra.get("maxPrice"), "0"),
        qty_step=_dec(row["qty_step"], "0.000001"),
        min_order_qty=_dec(extra.get("minOrderQty"), "0"),
        max_order_qty=_dec(extra.get("maxOrderQty"), "0"),
        max_mkt_order_qty=_dec(extra.get("maxMktOrderQty"), "0"),
        min_notional=_dec(extra.get("minNotionalValue"), "0"),
        min_leverage=_dec(extra.get("minLeverage"), "1"),
        max_leverage=_dec(row["max_leverage"], "100"),
        leverage_step=_dec(extra.get("leverageStep"), "0.01"),
        price_limit_ratio_x=_opt_dec(extra.get("priceLimitRatioX")),
        price_limit_ratio_y=_opt_dec(extra.get("priceLimitRatioY")),
        data_version=str(row["data_version"] or "snapshot"),
    )
    return VenueBuild(
        instrument_filter=instr,
        risk_tiers=risk_tiers,
        funding_caps=(_opt_dec(extra.get("lowerFundingRate")), _opt_dec(extra.get("upperFundingRate"))),
        extra_filters=extra,
        data_version=str(row["data_version"] or "snapshot"),
    )


async def build_provider(conn, *, fidelity: Fidelity, symbol: str, category: str, bars,
                         allow_fallback: bool, join_latency_ms: int = 0,
                         interval_ms: int = 60_000) -> ProviderBuild:
    """Resolve the execution provider for a one-shot run over ``bars``.

    * bar_based ⇒ no provider.
    * l2_sweep / l2_queue with zero recorded L2 in range ⇒ reject (``L2_COVERAGE_INSUFFICIENT``)
      unless ``allow_fallback`` (then bar-based with a fallback_reason).
    * l2_queue with zero recorded trades ⇒ reject (``TRADE_COVERAGE_INSUFFICIENT``) unless
      ``allow_fallback`` (then degrade to sweep with a fallback_reason).
    """
    if fidelity == Fidelity.BAR_BASED or not bars:
        return ProviderBuild(provider=None)

    interval_ms = max(1, int(interval_ms))
    start_ms, end_ms = bars_range_ms(bars, interval_ms)
    # Include a small pre-window so nearest-at-or-before lookups can see the book that
    # existed when the order joined at the first replay bar.
    snaps = await load_l2_snapshots(conn, symbol, category, start_ms - interval_ms, end_ms)
    if not snaps:
        if allow_fallback:
            return ProviderBuild(provider=None, fallback_reason="NO_L2_SNAPSHOTS_IN_RANGE_FELL_BACK_TO_BAR")
        return ProviderBuild(provider=None, error="L2_COVERAGE_INSUFFICIENT")

    snap_lookup = snapshot_lookup_from_list(snaps)

    if fidelity == Fidelity.L2_SWEEP:
        return ProviderBuild(provider=L2SweepProvider(snap_lookup), snapshots_loaded=len(snaps))

    # l2_queue
    trades = await load_trades(conn, symbol, category, start_ms, end_ms)
    if not trades:
        if allow_fallback:
            return ProviderBuild(
                provider=L2SweepProvider(snap_lookup), snapshots_loaded=len(snaps),
                fallback_reason="NO_TRADES_IN_RANGE_DEGRADED_TO_SWEEP",
            )
        return ProviderBuild(provider=None, error="TRADE_COVERAGE_INSUFFICIENT")

    return ProviderBuild(
        provider=L2QueueProvider(
            snap_lookup,
            trade_lookup_from_list(trades),
            join_latency_ms=join_latency_ms,
            bar_interval_ms=interval_ms,
        ),
        snapshots_loaded=len(snaps), trades_loaded=len(trades),
    )
