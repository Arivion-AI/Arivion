from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, getcontext
from typing import Callable, Literal

getcontext().prec = 28

Side = Literal["long", "short"]
Category = Literal["linear", "inverse"]

EPOCH_MIN = datetime.min.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class BacktestBar:
    ts: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal


@dataclass(frozen=True)
class FundingRow:
    id: str
    timestamp: datetime
    funding_rate: Decimal


@dataclass(frozen=True)
class MarginTier:
    """Maintenance-margin tier (Bybit risk-limit endpoint).

    A position with notional <= ``notional_cap`` uses ``mmr_fraction`` as its
    maintenance-margin ratio. Tiers must be supplied in ascending ``notional_cap``.
    """

    notional_cap: Decimal
    mmr_fraction: Decimal


@dataclass
class Position:
    symbol: str
    side: Side
    category: Category
    qty: Decimal = Decimal("0")
    contract_qty: Decimal = Decimal("0")
    opened_at: datetime | None = None
    closed_at: datetime | None = None
    entry_price: Decimal = Decimal("0")
    cash_quote: Decimal = Decimal("0")
    cash_base: Decimal = Decimal("0")
    funding_pnl_quote: Decimal = Decimal("0")
    funding_pnl_base: Decimal = Decimal("0")

    def is_open_at(self, timestamp: datetime) -> bool:
        if self.opened_at is None:
            return False
        if self.closed_at is not None and timestamp >= self.closed_at:
            return False
        return timestamp >= self.opened_at

    def is_open(self) -> bool:
        return self.opened_at is not None and self.closed_at is None


@dataclass(frozen=True)
class BacktestEvent:
    event_type: str
    event_ts: datetime
    payload: dict


@dataclass(frozen=True)
class PendingOrder:
    side: Side
    qty: Decimal
    created_bar_index: int


@dataclass
class EventRunResult:
    fills: list[BacktestEvent]
    funding_events: list[BacktestEvent]
    exits: list[BacktestEvent] = field(default_factory=list)
    liquidations: list[BacktestEvent] = field(default_factory=list)
    events: list[BacktestEvent] = field(default_factory=list)
    final_position: Position | None = None


MarkPriceLookup = Callable[[str, datetime], Decimal]


def apply_funding_events(
    position: Position,
    bar_start: datetime,
    bar_end: datetime,
    funding_rows: list[FundingRow],
    mark_price_lookup: MarkPriceLookup,
    funding_cap_lower: Decimal | None = None,
    funding_cap_upper: Decimal | None = None,
) -> list[BacktestEvent]:
    """WS-D: funding still settles ONLY at real fundingRateTimestamp rows (no synthetic
    cadence — preserves no-lookahead). When the symbol's per-symbol caps are supplied
    (`lowerFundingRate`/`upperFundingRate` from the instrument snapshot), each rate is clamped
    to `[lower, upper]` exactly as the venue would. Default None ⇒ unchanged behaviour."""
    events: list[BacktestEvent] = []
    eligible_rows = [row for row in funding_rows if bar_start < row.timestamp <= bar_end]

    for row in eligible_rows:
        if not position.is_open_at(row.timestamp):
            continue

        mark = mark_price_lookup(position.symbol, row.timestamp)
        rate = row.funding_rate
        if funding_cap_lower is not None or funding_cap_upper is not None:
            from .bybit_venue import clamp_funding_rate
            rate = clamp_funding_rate(rate, funding_cap_lower, funding_cap_upper)
        side_sign = Decimal("1") if position.side == "long" else Decimal("-1")

        if position.category == "linear":
            notional = abs(position.qty) * mark
            fee = notional * rate * side_sign
            position.cash_quote -= fee
            position.funding_pnl_quote -= fee
            amount = fee
            currency = "quote"

        elif position.category == "inverse":
            value_base = abs(position.contract_qty) / mark
            fee_base = value_base * rate * side_sign
            position.cash_base -= fee_base
            position.funding_pnl_base -= fee_base
            amount = fee_base
            currency = "base"

        else:
            raise ValueError(f"Unsupported category: {position.category}")

        events.append(
            BacktestEvent(
                event_type="FUNDING_SETTLEMENT",
                event_ts=row.timestamp,
                payload={
                    "funding_row_id": row.id,
                    "rate": str(rate),
                    "amount": str(amount),
                    "currency": currency,
                    "mark": str(mark),
                },
            )
        )

    return events


def market_fill_from_signal(
    bars: list[BacktestBar],
    signal_bar_index: int,
    side: Side,
    slippage_bps_one_way: Decimal,
    symbol: str | None = None,
) -> tuple[datetime, Decimal]:
    if signal_bar_index + 1 >= len(bars):
        raise ValueError("Missing next bar for fill; cannot fill at signal bar close")

    next_bar = bars[signal_bar_index + 1]
    from .xstocks import effective_slippage_bps  # xStock off-hours widening (no-op for crypto)
    eff = effective_slippage_bps(symbol, next_bar.ts, slippage_bps_one_way)
    slippage_factor = eff / Decimal("10000")

    if side == "long":
        price = next_bar.open * (Decimal("1") + slippage_factor)
    else:
        price = next_bar.open * (Decimal("1") - slippage_factor)

    return next_bar.ts, price


def resolve_intrabar_exit(
    side: Side,
    entry_price: Decimal,
    stop_loss: Decimal,
    take_profit: Decimal,
    bar: BacktestBar,
) -> tuple[str, Decimal]:
    """Resolve same-bar TP/SL with the adverse stop-first rule.

    Returns ``("stop_loss", sl)``, ``("take_profit", tp)`` or ``("none", entry_price)``.
    Supports both long and short sides.
    """

    if side == "long":
        stop_hit = bar.low <= stop_loss
        take_hit = bar.high >= take_profit
    elif side == "short":
        stop_hit = bar.high >= stop_loss
        take_hit = bar.low <= take_profit
    else:
        raise ValueError(f"Unsupported side: {side}")

    # Gap-through realism (QuantConnect EquityFillModel convention): if the bar opens
    # beyond the stop, the realistic fill is the open, not the stop price.
    if side == "long":
        stop_fill = min(stop_loss, bar.open)   # protective sell: gap-down fills at open
    else:
        stop_fill = max(stop_loss, bar.open)   # protective buy on short: gap-up fills at open

    if stop_hit and take_hit:
        return "stop_loss", stop_fill          # stop-first (adverse) rule
    if stop_hit:
        return "stop_loss", stop_fill
    if take_hit:
        return "take_profit", take_profit
    return "none", entry_price


def strict_limit_penetration(
    side: Side,
    limit_price: Decimal,
    tick_buffer: Decimal,
    bar: BacktestBar,
) -> bool:
    if side == "long":
        return bar.low < (limit_price - tick_buffer)
    if side == "short":
        return bar.high > (limit_price + tick_buffer)
    raise ValueError(f"Unsupported side: {side}")


def _maintenance_margin_fraction(notional: Decimal, tiers: list[MarginTier]) -> Decimal:
    """Pick the maintenance-margin fraction for the given notional (tiered)."""
    if not tiers:
        raise ValueError("maintenance_margin_tiers required for leverage > 1")
    for tier in tiers:
        if notional <= tier.notional_cap:
            return tier.mmr_fraction
    return tiers[-1].mmr_fraction


def check_liquidation(
    position: Position,
    mark: Decimal,
    leverage: Decimal,
    tiers: list[MarginTier],
) -> bool:
    """Tiered liquidation check for leveraged linear positions.

    Equity = initial_margin + unrealized_pnl + funding_pnl. Liquidation triggers when
    equity falls below maintenance_margin = notional * mmr_fraction for the tier.
    """
    if leverage <= Decimal("1") or position.category != "linear" or not position.is_open():
        return False

    qty = abs(position.qty)
    if qty == 0:
        return False

    notional = qty * mark
    side_sign = Decimal("1") if position.side == "long" else Decimal("-1")
    unrealized = (mark - position.entry_price) * qty * side_sign
    initial_margin = (position.entry_price * qty) / leverage
    equity = initial_margin + unrealized + position.funding_pnl_quote
    mmr = _maintenance_margin_fraction(notional, tiers)
    maintenance_margin = notional * mmr
    return equity <= maintenance_margin


class EventBacktestEngine:
    """Deterministic event loop implementing §10.1 rules.

    - funding applied at actual ``fundingRateTimestamp`` rows
    - features causal: signal at ``close[t]`` fills no earlier than ``open[t+1]``
    - intrabar stop-first when same bar hits both TP and SL
    - tiered liquidation check when ``leverage > 1`` (requires ``margin_tiers``)
    - emits FILL / FUNDING_SETTLEMENT / EXIT / LIQUIDATION events
    """

    def __init__(self, engine_version: str = "quant-core-phase3-v2") -> None:
        self.engine_version = engine_version

    def run(
        self,
        *,
        symbol: str,
        bars: list[BacktestBar],
        funding_rows: list[FundingRow],
        mark_price_lookup: MarkPriceLookup,
        signals: dict[int, Side],
        slippage_bps_one_way: Decimal,
        qty: Decimal,
        category: Category,
        seed: int,
        stop_loss_pct: Decimal | None = None,
        take_profit_pct: Decimal | None = None,
        max_holding_bars: int | None = None,
        leverage: Decimal = Decimal("1"),
        margin_tiers: list[MarginTier] | None = None,
        liquidation_model: str = "simple",
        risk_tiers: "list | None" = None,
        taker_fee_bps: Decimal = Decimal("5.5"),
        funding_cap_lower: Decimal | None = None,
        funding_cap_upper: Decimal | None = None,
    ) -> EventRunResult:
        if not bars:
            raise ValueError("bars cannot be empty")
        # WS-C: opt-in mark-price tiered liquidation. Default "simple" keeps the existing path
        # byte-identical. "mark_price_tiered" uses the full Bybit formula (IM/MM with mm_deduction
        # + fee_to_close, LP trigger, settle at bankruptcy price) from `risk_tiers` (bybit_venue
        # RiskTier list, e.g. risk_tiers_from_snapshot(instrument_snapshots row)).
        use_mark_tiered = liquidation_model == "mark_price_tiered" and leverage > Decimal("1")
        if use_mark_tiered and not risk_tiers:
            raise ValueError("risk_tiers required for liquidation_model='mark_price_tiered'")
        if leverage > Decimal("1") and not margin_tiers and not use_mark_tiered:
            raise ValueError(
                "margin_tiers (maintenance_margin_tiers_json) required for leverage > 1; "
                "otherwise run is APPROXIMATE_LIQUIDATION and not verifiable"
            )

        events: list[BacktestEvent] = []
        fills: list[BacktestEvent] = []
        funding_events: list[BacktestEvent] = []
        exits: list[BacktestEvent] = []
        liquidations: list[BacktestEvent] = []

        pending_orders: list[PendingOrder] = []
        position = Position(symbol=symbol, side="long", category=category)
        entry_bar_index: int | None = None

        for bar_index, bar in enumerate(bars):
            # Bar 0: use a sentinel min datetime so a funding row exactly at bars[0].ts is included.
            bar_start = bars[bar_index - 1].ts if bar_index > 0 else EPOCH_MIN
            bar_end = bar.ts

            funding_applied = apply_funding_events(
                position=position,
                bar_start=bar_start,
                bar_end=bar_end,
                funding_rows=funding_rows,
                mark_price_lookup=mark_price_lookup,
                funding_cap_lower=funding_cap_lower,
                funding_cap_upper=funding_cap_upper,
            )
            funding_events.extend(funding_applied)
            events.extend(funding_applied)

            executable = [o for o in pending_orders if o.created_bar_index < bar_index]
            for order in executable:
                fill_ts, fill_price = market_fill_from_signal(
                    bars=bars,
                    signal_bar_index=order.created_bar_index,
                    side=order.side,
                    slippage_bps_one_way=slippage_bps_one_way,
                    symbol=symbol,
                )
                if not position.is_open():
                    position.opened_at = fill_ts
                    position.closed_at = None
                    position.side = order.side
                    position.entry_price = fill_price
                    entry_bar_index = bar_index
                    if category == "linear":
                        position.qty = order.qty
                    else:
                        position.contract_qty = order.qty

                fill_event = BacktestEvent(
                    event_type="FILL",
                    event_ts=fill_ts,
                    payload={
                        "side": order.side,
                        "qty": str(order.qty),
                        "fill_price": str(fill_price),
                        "seed": seed,
                    },
                )
                fills.append(fill_event)
                events.append(fill_event)

            pending_orders = [o for o in pending_orders if o.created_bar_index >= bar_index]

            # Intrabar exit resolution (TP/SL/max_holding) for any open position
            if position.is_open() and entry_bar_index is not None and bar_index > entry_bar_index:
                exit_reason: str | None = None
                exit_price: Decimal | None = None

                if stop_loss_pct is not None and take_profit_pct is not None:
                    if position.side == "long":
                        sl = position.entry_price * (Decimal("1") - stop_loss_pct)
                        tp = position.entry_price * (Decimal("1") + take_profit_pct)
                    else:
                        sl = position.entry_price * (Decimal("1") + stop_loss_pct)
                        tp = position.entry_price * (Decimal("1") - take_profit_pct)
                    reason, price = resolve_intrabar_exit(
                        side=position.side,
                        entry_price=position.entry_price,
                        stop_loss=sl,
                        take_profit=tp,
                        bar=bar,
                    )
                    if reason != "none":
                        exit_reason, exit_price = reason, price

                if exit_reason is None and max_holding_bars is not None:
                    if (bar_index - entry_bar_index) >= max_holding_bars:
                        exit_reason, exit_price = "max_holding", bar.close

                if exit_reason is not None and exit_price is not None:
                    position.closed_at = bar.ts
                    exit_event = BacktestEvent(
                        event_type="EXIT",
                        event_ts=bar.ts,
                        payload={
                            "reason": exit_reason,
                            "exit_price": str(exit_price),
                            "side": position.side,
                        },
                    )
                    exits.append(exit_event)
                    events.append(exit_event)
                    entry_bar_index = None

            # Tiered liquidation check (leverage > 1 only)
            if position.is_open() and leverage > Decimal("1"):
                mark = mark_price_lookup(position.symbol, bar.ts)
                if use_mark_tiered:
                    # WS-C full Bybit math; settle at the bankruptcy price, not LP.
                    from . import bybit_venue as _bv
                    pl = _bv.position_liquidation(
                        side=position.side, qty=position.qty, entry=position.entry_price,
                        mark_high=mark, mark_low=mark, mark_close=mark,
                        tiers=risk_tiers, leverage=leverage, taker_fee_bps=taker_fee_bps,
                    )
                    if pl.triggered:
                        liq_event = BacktestEvent(
                            event_type="LIQUIDATION", event_ts=bar.ts,
                            payload={"mark": str(mark), "side": position.side,
                                     "liquidation_model": "mark_price_tiered",
                                     "tier_id": pl.tier_id, "lp": str(pl.lp),
                                     "bankruptcy_price": str(pl.bankruptcy),
                                     "settle_price": str(pl.bankruptcy)},
                        )
                        liquidations.append(liq_event)
                        events.append(liq_event)
                        position.closed_at = bar.ts
                        entry_bar_index = None
                elif check_liquidation(position, mark, leverage, margin_tiers or []):
                    liq_event = BacktestEvent(
                        event_type="LIQUIDATION",
                        event_ts=bar.ts,
                        payload={"mark": str(mark), "side": position.side,
                                 "liquidation_model": "simple"},
                    )
                    liquidations.append(liq_event)
                    events.append(liq_event)
                    position.closed_at = bar.ts
                    entry_bar_index = None

            if bar_index in signals and not position.is_open():
                signal_side = signals[bar_index]
                events.append(
                    BacktestEvent(
                        event_type="SIGNAL",
                        event_ts=bar.ts,
                        payload={"side": signal_side, "bar_index": bar_index},
                    )
                )
                pending_orders.append(PendingOrder(side=signal_side, qty=qty, created_bar_index=bar_index))

        events.sort(key=lambda evt: (evt.event_ts, evt.event_type))

        return EventRunResult(
            fills=fills,
            funding_events=funding_events,
            exits=exits,
            liquidations=liquidations,
            events=events,
            final_position=position,
        )
