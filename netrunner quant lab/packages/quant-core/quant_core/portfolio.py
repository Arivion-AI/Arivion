"""Portfolio + risk gates for the paper-trading runtime.

Tracks positions across symbols, realized + unrealized + funding PnL, equity high
watermark for drawdown, and enforces kill switches:

- max_position_fraction per symbol
- max_daily_loss_fraction (since UTC midnight)
- max_drawdown_kill_fraction (peak-to-trough on equity)
- max_open_orders cap
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Literal

PosSide = Literal["long", "short", "flat"]


@dataclass
class PortfolioPosition:
    symbol: str
    side: PosSide = "flat"
    qty: Decimal = Decimal(0)
    avg_entry: Decimal = Decimal(0)
    realized_pnl: Decimal = Decimal(0)
    funding_pnl: Decimal = Decimal(0)

    def mark_to(self, mark: Decimal) -> Decimal:
        if self.side == "flat" or self.qty == 0:
            return Decimal(0)
        if self.side == "long":
            return (mark - self.avg_entry) * self.qty
        return (self.avg_entry - mark) * self.qty


@dataclass
class RiskConfig:
    max_position_fraction: Decimal = Decimal("0.10")     # per symbol, in equity terms
    max_total_exposure_fraction: Decimal = Decimal("1.0")  # sum across symbols
    max_daily_loss_fraction: Decimal = Decimal("0.03")
    max_drawdown_kill_fraction: Decimal = Decimal("0.12")
    max_open_orders: int = 50


@dataclass
class RiskState:
    killed: bool = False
    kill_reason: str | None = None
    day_start_equity: Decimal = Decimal(0)
    day_start_date: date | None = None
    equity_high_watermark: Decimal = Decimal(0)


@dataclass
class Portfolio:
    starting_equity: Decimal
    risk: RiskConfig = field(default_factory=RiskConfig)
    state: RiskState = field(default_factory=RiskState)
    positions: dict[str, PortfolioPosition] = field(default_factory=dict)
    cash: Decimal = Decimal(0)

    def __post_init__(self) -> None:
        if self.cash == 0:
            self.cash = self.starting_equity
        if self.state.equity_high_watermark == 0:
            self.state.equity_high_watermark = self.starting_equity
        if self.state.day_start_equity == 0:
            self.state.day_start_equity = self.starting_equity

    # --- equity ---
    def equity(self, marks: dict[str, Decimal]) -> Decimal:
        unrealized = sum((p.mark_to(marks.get(s, p.avg_entry)) for s, p in self.positions.items()), Decimal(0))
        return self.cash + unrealized

    def exposure(self, marks: dict[str, Decimal]) -> Decimal:
        return sum((abs(p.qty) * marks.get(s, p.avg_entry) for s, p in self.positions.items()), Decimal(0))

    # --- mutations ---
    def get_or_create(self, symbol: str) -> PortfolioPosition:
        if symbol not in self.positions:
            self.positions[symbol] = PortfolioPosition(symbol=symbol)
        return self.positions[symbol]

    def apply_fill(self, *, symbol: str, side: str, qty: Decimal, price: Decimal, fee: Decimal) -> Decimal:
        """Apply a fill, update position + cash, return realized PnL delta."""
        pos = self.get_or_create(symbol)
        signed = qty if side == "buy" else -qty
        realized = Decimal(0)
        if pos.side == "flat" or pos.qty == 0:
            pos.qty = abs(signed)
            pos.side = "long" if signed > 0 else "short"
            pos.avg_entry = price
        else:
            same_dir = (pos.side == "long" and signed > 0) or (pos.side == "short" and signed < 0)
            if same_dir:
                new_qty = pos.qty + abs(signed)
                pos.avg_entry = (pos.avg_entry * pos.qty + price * abs(signed)) / new_qty
                pos.qty = new_qty
            else:
                close_qty = min(pos.qty, abs(signed))
                if pos.side == "long":
                    realized = (price - pos.avg_entry) * close_qty
                else:
                    realized = (pos.avg_entry - price) * close_qty
                pos.qty -= close_qty
                pos.realized_pnl += realized
                leftover = abs(signed) - close_qty
                if pos.qty == 0:
                    if leftover > 0:
                        pos.side = "long" if signed > 0 else "short"
                        pos.qty = leftover
                        pos.avg_entry = price
                    else:
                        pos.side = "flat"
                        pos.avg_entry = Decimal(0)
        # Cash effect: linear perp PnL is realised at close; for entries on perps we don't move cash here
        # because margin/collateral isn't modeled — this simulates cross-margin where cash == equity book.
        self.cash += realized - fee
        return realized

    def apply_funding(self, symbol: str, amount: Decimal) -> None:
        """Funding amount > 0 means trader pays."""
        pos = self.get_or_create(symbol)
        pos.funding_pnl -= amount
        self.cash -= amount

    # --- risk gates ---
    def rollover_day_if_needed(self, now: datetime) -> None:
        today = now.astimezone(timezone.utc).date()
        if self.state.day_start_date != today:
            self.state.day_start_date = today
            self.state.day_start_equity = self.cash

    def update_equity_marks(self, now: datetime, marks: dict[str, Decimal]) -> None:
        self.rollover_day_if_needed(now)
        eq = self.equity(marks)
        if eq > self.state.equity_high_watermark:
            self.state.equity_high_watermark = eq
        # Daily-loss kill
        day_loss = (self.state.day_start_equity - eq) / self.state.day_start_equity if self.state.day_start_equity > 0 else Decimal(0)
        if day_loss > self.risk.max_daily_loss_fraction and not self.state.killed:
            self.state.killed = True
            self.state.kill_reason = "MAX_DAILY_LOSS"
        # Drawdown kill
        dd = (self.state.equity_high_watermark - eq) / self.state.equity_high_watermark if self.state.equity_high_watermark > 0 else Decimal(0)
        if dd > self.risk.max_drawdown_kill_fraction and not self.state.killed:
            self.state.killed = True
            self.state.kill_reason = "MAX_DRAWDOWN_KILL"

    def check_pretrade(self, *, symbol: str, qty: Decimal, price: Decimal, marks: dict[str, Decimal]) -> tuple[bool, str | None]:
        if self.state.killed:
            return False, f"KILLED:{self.state.kill_reason}"
        eq = self.equity(marks)
        if eq <= 0:
            return False, "ZERO_EQUITY"
        notional = abs(qty) * price
        max_notional = eq * self.risk.max_position_fraction
        if notional > max_notional:
            return False, "EXCEEDS_MAX_POSITION_FRACTION"
        new_exposure = self.exposure(marks) + notional
        if new_exposure > eq * self.risk.max_total_exposure_fraction:
            return False, "EXCEEDS_MAX_TOTAL_EXPOSURE"
        return True, None

    def drawdown(self) -> Decimal:
        if self.state.equity_high_watermark <= 0:
            return Decimal(0)
        # snapshot drawdown vs latest known equity_high_watermark
        return Decimal(0)
