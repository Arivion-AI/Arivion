from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

PaperStatus = Literal["active", "paused", "waiting_fresh_ticks", "stopped"]


@dataclass
class PaperSessionState:
    session_id: str
    status: PaperStatus
    reconnecting: bool
    required_fresh_ticks: int
    fresh_ticks_seen: int
    max_data_age_ms: int
    last_price: Decimal | None


@dataclass
class Tick:
    symbol: str
    price: Decimal
    ts_ms: int
    now_ms: int


@dataclass
class PaperDecision:
    status: PaperStatus
    reconnecting: bool
    fresh_ticks_seen: int
    events: list[dict]
    create_fill: bool


def evaluate_tick(state: PaperSessionState, tick: Tick) -> PaperDecision:
    events: list[dict] = []
    age_ms = tick.now_ms - tick.ts_ms

    if age_ms > state.max_data_age_ms:
        events.append(
            {
                "event_type": "DATA_STALE_PAUSE",
                "payload": {
                    "symbol": tick.symbol,
                    "price": str(tick.price),
                    "data_age_ms": age_ms,
                    "max_data_age_ms": state.max_data_age_ms,
                },
            }
        )
        return PaperDecision(
            status="paused",
            reconnecting=True,
            fresh_ticks_seen=0,
            events=events,
            create_fill=False,
        )

    if state.reconnecting:
        fresh = state.fresh_ticks_seen + 1
        if fresh < state.required_fresh_ticks:
            events.append(
                {
                    "event_type": "WAITING_FRESH_TICKS",
                    "payload": {
                        "symbol": tick.symbol,
                        "fresh_ticks_seen": fresh,
                        "required_fresh_ticks": state.required_fresh_ticks,
                    },
                }
            )
            return PaperDecision(
                status="waiting_fresh_ticks",
                reconnecting=True,
                fresh_ticks_seen=fresh,
                events=events,
                create_fill=False,
            )

        events.append(
            {
                "event_type": "RESUMED_AFTER_FRESH_TICKS",
                "payload": {
                    "symbol": tick.symbol,
                    "fresh_ticks_seen": fresh,
                    "required_fresh_ticks": state.required_fresh_ticks,
                },
            }
        )
        state.reconnecting = False
        state.status = "active"
        state.fresh_ticks_seen = fresh

    create_fill = False
    if state.last_price is not None and tick.price > state.last_price:
        create_fill = True

    events.append(
        {
            "event_type": "TICK_INGESTED",
            "payload": {
                "symbol": tick.symbol,
                "price": str(tick.price),
                "last_price": str(state.last_price) if state.last_price is not None else None,
            },
        }
    )

    return PaperDecision(
        status="active",
        reconnecting=False,
        fresh_ticks_seen=state.fresh_ticks_seen,
        events=events,
        create_fill=create_fill,
    )
