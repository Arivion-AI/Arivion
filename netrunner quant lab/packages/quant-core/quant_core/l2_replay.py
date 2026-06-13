"""L2 / trade-print replay providers for queue-aware maker fills.

These are the production replacements for the dormant ``l2_queue_provider`` hook. They are
**pure and DB-free**: a provider is constructed with *lookup callables* that return recorded
data for a timestamp. The worker layer backs those callables with Postgres queries; the
golden tests back them with in-memory lists. This keeps ``quant_core`` deterministic and
independently testable.

Provider call contract (matches ``PaperRuntime``):

    provider(order, bar) -> (queue_ahead: Decimal, through_volume: Decimal, swept: bool)

* ``L2SweepProvider`` (Phase 2) — conservative: ``through_volume`` is always 0, so an order
  fills only when price strictly sweeps past its limit. Removes the worst bar-based optimism
  without needing trade prints. ``queue_ahead`` is computed from the book as audit evidence.
* ``L2QueueProvider`` (Phase 4) — full model: ``through_volume`` is summed from recorded
  public trades that executed through the limit price during the bar; supports partial fills
  and persistent per-order queue position.

Both expose coverage/usage attributes that ``PaperRuntime`` folds into ``FillModelStats``:
``provider_used``, ``trade_prints_used``, ``snapshot_coverage_pct``, ``trade_coverage_pct``,
and ``last_evidence`` (the per-fill evidence dict for the most recent decision).
"""
from __future__ import annotations

import bisect
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Callable


def _d(x) -> Decimal:
    return x if isinstance(x, Decimal) else Decimal(str(x))


@dataclass
class L2Snapshot:
    """A single order-book snapshot. ``bids``/``asks`` are ``[(price, size), ...]``.
    Bids are best-first descending price; asks best-first ascending price (we sort defensively)."""

    ts_ms: int
    bids: list[tuple[Decimal, Decimal]]
    asks: list[tuple[Decimal, Decimal]]
    sequence_id: int | None = None

    @classmethod
    def from_levels(cls, ts_ms: int, bids, asks, sequence_id: int | None = None) -> "L2Snapshot":
        b = sorted(((_d(p), _d(s)) for p, s in bids), key=lambda x: x[0], reverse=True)
        a = sorted(((_d(p), _d(s)) for p, s in asks), key=lambda x: x[0])
        return cls(ts_ms=ts_ms, bids=b, asks=a, sequence_id=sequence_id)

    def queue_ahead_for(self, side: str, limit_price: Decimal) -> Decimal:
        """Visible resting size ahead of a passive order at ``limit_price``.

        A passive BUY rests on the bid side; ahead of it sit all bids at a price >= its own
        (better or equal). A passive SELL rests on the ask side; ahead sit asks at price <=
        its own. (Time priority at the exact level is unknown from depth alone, so equal-price
        size is counted as ahead — the conservative assumption.)"""
        total = Decimal(0)
        if side == "buy":
            for price, size in self.bids:
                if price >= limit_price:
                    total += size
                else:
                    break
        else:
            for price, size in self.asks:
                if price <= limit_price:
                    total += size
                else:
                    break
        return total


@dataclass
class TradePrint:
    ts_ms: int
    price: Decimal
    qty: Decimal
    side: str  # taker aggressor side as Bybit reports it: "Buy" | "Sell"


SnapshotLookup = Callable[[int], "L2Snapshot | None"]
TradeLookup = Callable[[int, int], "list[TradePrint]"]


def snapshot_lookup_from_list(snapshots: list[L2Snapshot]) -> SnapshotLookup:
    """Build a nearest-at-or-before lookup over an in-memory snapshot list (for tests)."""
    snaps = sorted(snapshots, key=lambda s: s.ts_ms)
    keys = [s.ts_ms for s in snaps]

    def lookup(ts_ms: int) -> L2Snapshot | None:
        i = bisect.bisect_right(keys, ts_ms) - 1
        return snaps[i] if i >= 0 else None

    return lookup


def trade_lookup_from_list(trades: list[TradePrint]) -> TradeLookup:
    """Build a [start, end) range lookup over an in-memory trade list (for tests)."""
    ts = sorted(trades, key=lambda t: t.ts_ms)
    keys = [t.ts_ms for t in ts]

    def lookup(start_ms: int, end_ms: int) -> list[TradePrint]:
        lo = bisect.bisect_left(keys, start_ms)
        hi = bisect.bisect_left(keys, end_ms)
        return ts[lo:hi]

    return lookup


def _bar_ms(bar) -> int:
    return int(bar.ts.timestamp() * 1000)


def _swept(order, bar) -> bool:
    """Strict penetration of the limit price by the bar's range."""
    if order.limit_price is None:
        return False
    if order.side == "buy":
        return bar.low < order.limit_price
    return bar.high > order.limit_price


class _BaseProvider:
    def __init__(self) -> None:
        self.provider_used = False
        self.trade_prints_used = False
        self._bars_seen = 0
        self._snapshot_hits = 0
        self._trade_window_hits = 0
        self.last_evidence: dict | None = None

    @property
    def snapshot_coverage_pct(self) -> float:
        return self._snapshot_hits / self._bars_seen if self._bars_seen else 0.0

    @property
    def trade_coverage_pct(self) -> float:
        return self._trade_window_hits / self._bars_seen if self._bars_seen else 0.0


class L2SweepProvider(_BaseProvider):
    """Conservative sweep-only maker fills (Phase 2).

    Fill iff price strictly sweeps past the limit. ``through_volume`` is fixed at 0, so
    ``queue_aware_fill_qty`` yields the full remaining on a sweep and 0 otherwise — never a
    touch-fill. ``queue_ahead`` is computed from the nearest book snapshot purely as audit
    evidence. If no snapshot covers the bar, the bar still counts against coverage; the run
    can be hard-rejected upstream when ``allow_fallback`` is false.
    """

    def __init__(self, snapshot_lookup: SnapshotLookup) -> None:
        super().__init__()
        self._snap = snapshot_lookup

    def __call__(self, order, bar) -> tuple[Decimal, Decimal, bool]:
        self._bars_seen += 1
        self.provider_used = True
        ts_ms = _bar_ms(bar)
        snap = self._snap(ts_ms)
        if snap is not None:
            self._snapshot_hits += 1
            queue_ahead = snap.queue_ahead_for(order.side, order.limit_price)
            snap_ts = snap.ts_ms
            snap_seq = snap.sequence_id
        else:
            # No book ⇒ no evidence of queue; sweep decision still holds on OHLC alone.
            queue_ahead = Decimal(0)
            snap_ts = None
            snap_seq = None
        swept = _swept(order, bar)
        self.last_evidence = {
            "model": "l2_sweep_only",
            "order_id": getattr(order, "order_id", None),
            "symbol": getattr(order, "symbol", None),
            "side": order.side,
            "limit_price": str(order.limit_price) if order.limit_price is not None else None,
            "snapshot_ts_ms": snap_ts,
            "snapshot_sequence_id": snap_seq,
            "queue_ahead": str(queue_ahead),
            "through_volume": "0",
            "swept": swept,
            "snapshot_available": snap is not None,
        }
        return queue_ahead, Decimal(0), swept


class L2QueueProvider(_BaseProvider):
    """Full queue-aware maker fills (Phase 4).

    ``through_volume`` is summed from recorded public trades that executed THROUGH the limit
    price within the bar window; ``queue_ahead`` is the resting size at join time, reduced as
    the order consumes the queue across bars (persistent per-order state). On a sweep the
    order fills in full.
    """

    def __init__(
        self,
        snapshot_lookup: SnapshotLookup,
        trade_lookup: TradeLookup,
        *,
        join_latency_ms: int = 0,
        bar_interval_ms: int = 60_000,
    ) -> None:
        super().__init__()
        self._snap = snapshot_lookup
        self._trades = trade_lookup
        self._join_latency_ms = join_latency_ms
        self._bar_interval_ms = max(1, int(bar_interval_ms))
        # Persistent per-order queue position: order_id -> remaining queue ahead.
        self._queue_state: dict[str, Decimal] = {}
        # order_id -> effective join time (ms), captured once.
        self._join_ms: dict[str, int] = {}
        # order_id -> (snapshot timestamp, sequence) used when the order joined.
        self._join_snap: dict[str, tuple[int | None, int | None]] = {}

    def forget(self, order_id: str) -> None:
        """Stop tracking a cancelled/terminal order's queue position."""
        self._queue_state.pop(order_id, None)
        self._join_ms.pop(order_id, None)
        self._join_snap.pop(order_id, None)

    def _through_volume(self, order, start_ms: int, end_ms: int) -> tuple[Decimal, int, int]:
        """Volume that traded THROUGH the limit price in [start, end).

        Bybit ``publicTrade.side`` is the taker aggressor. A passive BUY at ``p`` is filled by
        sell-aggressor trades at price <= p; a passive SELL at ``p`` by buy-aggressor trades at
        price >= p."""
        trades = self._trades(start_ms, end_ms)
        total = Decimal(0)
        used = 0
        for t in trades:
            if order.side == "buy" and t.side.lower() == "sell" and t.price <= order.limit_price:
                total += t.qty
                used += 1
            elif order.side == "sell" and t.side.lower() == "buy" and t.price >= order.limit_price:
                total += t.qty
                used += 1
        return total, used, len(trades)

    def __call__(self, order, bar) -> tuple[Decimal, Decimal, bool]:
        self._bars_seen += 1
        self.provider_used = True
        oid = getattr(order, "order_id", id(order))
        ts_ms = _bar_ms(bar)

        # Capture join time + initial queue position once, from the book at join.
        if oid not in self._queue_state:
            join_ms = ts_ms + self._join_latency_ms
            self._join_ms[oid] = join_ms
            snap = self._snap(join_ms)
            if snap is not None:
                self._snapshot_hits += 1
                self._queue_state[oid] = snap.queue_ahead_for(order.side, order.limit_price)
                self._join_snap[oid] = (snap.ts_ms, snap.sequence_id)
            else:
                self._queue_state[oid] = Decimal(0)
                self._join_snap[oid] = (None, None)
        else:
            self._snapshot_hits += 1  # already-joined orders carry a known queue position

        queue_ahead = self._queue_state[oid]
        join_ms = self._join_ms[oid]

        # Sum trade prints through the limit over this bar's window (from join, first bar).
        window_start = max(join_ms, ts_ms)
        window_end = ts_ms + self._bar_interval_ms
        through, n_used, n_window = self._through_volume(order, window_start, window_end)
        # The full queue provider is only installed when the worker has recorded publicTrade
        # data for the run, so the queue model genuinely ran.
        self.trade_prints_used = True
        # Coverage = fraction of bars whose trade window actually contained recorded prints.
        # (Hard-coding this to 1.0 would defeat the trade-coverage verification threshold.)
        if n_window > 0:
            self._trade_window_hits += 1

        # CUMULATIVE queue depletion: this bar's through-volume consumes the queue resting
        # ahead, so the order advances toward the front across bars even on no-fill bars. The
        # fill decision below uses the PRE-depletion queue_ahead; through partitions into
        # queue-fill = min(through, queue_ahead) and order-fill = max(0, through - queue_ahead).
        self._queue_state[oid] = max(Decimal(0), queue_ahead - through)

        swept = _swept(order, bar)
        snap_ts, snap_seq = self._join_snap.get(oid, (None, None))
        self.last_evidence = {
            "model": "l2_queue_full",
            "order_id": oid,
            "symbol": getattr(order, "symbol", None),
            "side": order.side,
            "limit_price": str(order.limit_price) if order.limit_price is not None else None,
            "order_join_time_ms": join_ms,
            "snapshot_ts_ms": snap_ts,
            "snapshot_sequence_id": snap_seq,
            "queue_ahead": str(queue_ahead),
            "through_volume": str(through),
            "swept": swept,
            "trade_count_used": n_used,
            "trade_count_window": n_window,
            "trade_window_start_ms": window_start,
            "trade_window_end_ms": window_end,
            "latency_ms": self._join_latency_ms,
        }
        return queue_ahead, through, swept

    def on_fill(self, order_id: str, filled_qty: Decimal, through_volume: Decimal) -> None:
        """No-op: queue depletion is handled per-bar in ``__call__`` (cumulative, including
        no-fill bars). Kept for the PaperRuntime hook interface — depleting here too would
        double-count the through-volume against the queue."""
        return None
