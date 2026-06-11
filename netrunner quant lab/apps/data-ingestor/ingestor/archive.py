"""Historical L2 / trade ingestion adapter (P1.1).

Corrects the reference doc's claim that historical L2 is impossible because "Bybit has no
historical order-book REST". That is true only of the live v5 REST API. Historical L2 IS
available:

  * Bybit's own free archive (depth-500 snapshots for spot+contracts, trades), no registration,
    back to ~2023 — files served from quote-saver.bycsi.com / public.bybit.com.
  * Tardis.dev — paid tick-level incremental L2 + snapshots + trades, back to ~2019-2021.
  * Amberdata — Bybit tick trades from 2021-09-01.

This module is the PURE normalizer (no DB, no network): it maps archive-shaped depth-500
snapshots and trade prints into rows shaped EXACTLY like the existing ``l2_snapshots`` /
``trades`` hypertables, tagged with distinct ``data_version``s, with deterministic checksums so a
historically-backfilled range reports coverage exactly like a forward-recorded one. The HTTP
download + the durable backfill job/endpoint wrap these functions (see main.py); the network fetch
itself is a documented follow-up — the normalize+persist path is delivered and tested here.

Fidelity honesty: depth-500 archive snapshots have a SNAPSHOT CADENCE (not tick-by-tick deltas),
which limits queue-position precision vs Tardis incremental L2. ``infer_cadence_ms`` measures the
observed cadence; the run records ``l2_source`` + ``l2_cadence_ms`` in fill_model
(quant_core.execution) so a queue-aware result honestly states how it was produced.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

# Distinct data_version tags per source (P1.1) — coverage accounting keys off data_version, so a
# backfilled range is attributable and reproducible exactly like a realtime-recorded one.
DV_BYBIT_ARCHIVE_OB500 = "bybit-archive-ob500-v1"
DV_BYBIT_ARCHIVE_TRADE = "bybit-archive-trade-v1"
DV_TARDIS_OB_L2 = "tardis-ob-l2-v1"  # paid, higher-fidelity (tick incremental L2)

# fill_model l2_source labels.
SRC_BYBIT_ARCHIVE = "bybit-archive-ob500"
SRC_TARDIS = "tardis-incr"
SRC_REALTIME = "realtime-ws"


def _levels(rows: Any, *, reverse: bool, depth: int) -> list[list[str]]:
    """Normalize a side's levels to sorted [[price, size], ...] strings, top-`depth`."""
    out: list[tuple[float, str, str]] = []
    for r in rows or []:
        if isinstance(r, (list, tuple)) and len(r) >= 2:
            price, size = str(r[0]), str(r[1])
        elif isinstance(r, dict):
            price, size = str(r.get("price")), str(r.get("size") or r.get("qty"))
        else:
            continue
        try:
            if float(size) == 0.0:
                continue
        except ValueError:
            continue
        out.append((float(price), price, size))
    out.sort(key=lambda x: x[0], reverse=reverse)
    return [[p, s] for _, p, s in out[:depth]]


def _book_checksum(symbol: str, ts_ms: int, bids: list[list[str]], asks: list[list[str]]) -> str:
    """Deterministic snapshot checksum. Prefers nothing external — a stable hash over the book so
    duplicate/coverage accounting matches regardless of source."""
    payload = json.dumps({"s": symbol, "ts": ts_ms, "b": bids, "a": asks},
                         sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def normalize_archive_orderbook(
    records: list[dict], *, symbol: str, category: str,
    data_version: str = DV_BYBIT_ARCHIVE_OB500, depth: int = 500,
) -> list[dict]:
    """Map archive ``snapshot`` order-book records to l2_snapshots row dicts.

    Accepts the Bybit-archive line shape ``{"type":"snapshot","ts":<ms>,"data":{"s","b","a","u"|"seq"}}``
    (delta lines, which require book reconstruction identical to the realtime collector, are
    skipped here and noted — full snapshots are sufficient for depth-500 cadence replay)."""
    sym = symbol.upper()
    out: list[dict] = []
    for rec in records:
        if str(rec.get("type", "snapshot")).lower() != "snapshot":
            continue  # delta reconstruction is the realtime collector's job; see module docstring
        data = rec.get("data") or rec
        ts_ms = int(rec.get("ts") or data.get("ts") or 0)
        bids = _levels(data.get("b") or data.get("bids"), reverse=True, depth=depth)
        asks = _levels(data.get("a") or data.get("asks"), reverse=False, depth=depth)
        if not bids and not asks:
            continue
        seq = data.get("u")
        if seq is None:
            seq = data.get("seq")
        checksum = str(data.get("checksum") or "") or _book_checksum(sym, ts_ms, bids, asks)
        out.append({
            "ts_ms": ts_ms, "symbol": sym, "category": category,
            "sequence_id": int(seq) if seq is not None else None,
            "checksum": checksum,
            "best_bid": bids[0][0] if bids else None,
            "best_ask": asks[0][0] if asks else None,
            "bid_levels_json": bids, "ask_levels_json": asks,
            "data_version": data_version,
        })
    out.sort(key=lambda r: (r["ts_ms"], r["sequence_id"] if r["sequence_id"] is not None else 0))
    return out


def normalize_archive_trades(
    records: list[dict], *, symbol: str, category: str,
    data_version: str = DV_BYBIT_ARCHIVE_TRADE,
) -> list[dict]:
    """Map archive trade records to trades row dicts (Bybit archive uses ``T,s,S,p,v,i`` keys; the
    public CSV uses ``timestamp,side,price,size,trdMatchID``)."""
    sym = symbol.upper()
    out: list[dict] = []
    seen: set[str] = set()
    for r in records:
        ts_raw = float(r.get("T") or r.get("timestamp") or r.get("ts") or 0)
        # Public CSV stamps seconds (with fraction); WS/JSON stamps ms. Scale BEFORE truncating.
        ts_ms = int(round(ts_raw * 1000)) if 0 < ts_raw < 1_000_000_000_000 else int(ts_raw)
        price = str(r.get("p") or r.get("price") or "")
        qty = str(r.get("v") or r.get("size") or r.get("qty") or "")
        side = str(r.get("S") or r.get("side") or "").capitalize()
        trade_id = str(r.get("i") or r.get("trdMatchID") or r.get("trade_id")
                       or f"{ts_ms}-{price}-{qty}-{side}")
        if not price or not qty or side not in ("Buy", "Sell"):
            continue
        if trade_id in seen:
            continue
        seen.add(trade_id)
        out.append({
            "ts_ms": ts_ms, "trade_time_ms": ts_ms, "symbol": sym, "category": category,
            "trade_id": trade_id, "side": side, "price": price, "qty": qty,
            "data_version": data_version,
        })
    out.sort(key=lambda r: (r["ts_ms"], r["trade_id"]))
    return out


def infer_cadence_ms(snapshot_rows: list[dict]) -> int | None:
    """Median inter-snapshot interval (ms) — the honest cadence of depth-500 archive snapshots.
    None when fewer than two snapshots (cadence unknown)."""
    ts = sorted({int(r["ts_ms"]) for r in snapshot_rows if r.get("ts_ms")})
    if len(ts) < 2:
        return None
    deltas = sorted(b - a for a, b in zip(ts, ts[1:]) if b > a)
    if not deltas:
        return None
    return int(deltas[len(deltas) // 2])
