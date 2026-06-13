"""Reality-model interfaces (P2) — the LEAN/Nautilus pluggable-model spine.

Today fill/fee/slippage/impact/latency behavior is engine constants + scattered flags. LEAN injects
swappable Reality Models per security; Nautilus uses L1/L2/L3 book types + a queue heuristic. This
module defines the small set of explicit, pure, Decimal, deterministic interfaces the engine should
consume so future fidelity work is additive and testable. **Every default instance must reproduce
current byte-identical output** — these are interfaces + safe defaults, NOT a behavior change.

STATUS (scoped — see FINDINGS.md P2): the interfaces + the new opt-in ``BorrowModel`` (P3.2) land
here with tests. Wiring ``PaperRuntime``/``EventBacktestEngine`` to consume them (replacing the
inline fee/slippage/latency code) is the follow-up PR; it must be proven byte-identical (default
models vs inline code → identical events+metrics) before it ships.

P2.2 (queue-position upgrade vs Nautilus): ``orders.queue_aware_fill_qty`` depletes ``queue_ahead``
by cumulative through-volume. Documented fidelity gaps to close behind the L2 gate, only where data
supports them: order-modification resetting queue priority, partial-fill priority, and
cancellations ahead in queue (Nautilus models these via per-order queue state + trade-consumption
seeding). Not implemented here — TODO.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol, runtime_checkable


@runtime_checkable
class FeeModel(Protocol):
    def fee(self, *, notional: Decimal, is_maker: bool) -> Decimal: ...


@runtime_checkable
class SlippageModel(Protocol):
    def slippage_bps(self, *, qty: Decimal, bar_volume: Decimal | None) -> Decimal: ...


@runtime_checkable
class BorrowModel(Protocol):
    def borrow_cost(self, *, side: str, qty: Decimal, price: Decimal, bars_held: int,
                    bars_per_year: float) -> Decimal: ...


@dataclass(frozen=True)
class NoBorrowModel:
    """Default BorrowModel: charges nothing — preserves byte-identical output (P3.2 OFF)."""

    def borrow_cost(self, *, side, qty, price, bars_held, bars_per_year) -> Decimal:  # noqa: ANN001
        return Decimal("0")


@dataclass(frozen=True)
class ConstantBorrowModel:
    """Opt-in short-borrow / financing cost (P3.2).

    A short position on a linear perp / xStock carries a configurable annualized borrow rate,
    accrued per bar held: ``cost = notional * annual_rate * (bars_held / bars_per_year)``. Default
    rate 0 ⇒ byte-identical to the current engine. Longs are not charged borrow (set
    ``charge_side='both'`` to also model long financing). Pure & deterministic.
    """

    annual_rate: Decimal = Decimal("0")
    charge_side: str = "short"  # "short" | "both"

    def borrow_cost(self, *, side: str, qty: Decimal, price: Decimal, bars_held: int,
                    bars_per_year: float) -> Decimal:
        if self.annual_rate == 0 or bars_held <= 0 or qty <= 0:
            return Decimal("0")
        s = str(side).lower()
        if self.charge_side == "short" and s not in ("short", "sell"):
            return Decimal("0")
        notional = abs(qty * price)
        frac = Decimal(str(bars_held)) / Decimal(str(bars_per_year))
        return notional * self.annual_rate * frac
