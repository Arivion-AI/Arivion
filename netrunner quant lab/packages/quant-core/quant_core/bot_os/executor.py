"""Bot executor — drives a BotRuntime through a sequence of bars and converts the
BotDecision stream into v3.1-style ledger events on the existing PaperRuntime.

This intentionally reuses ``PaperRuntime`` to enforce the §10 fill rules:
strict-penetration limits, next-open market fills, stop-first intrabar,
timestamp-driven funding (§9). One ledger, not two (correction #8).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Callable

from ..engine import FundingRow
from ..orders import Bar, Order, OrderType, TimeInForce
from ..paper_runtime import PaperRunResult, PaperRuntime
from ..portfolio import Portfolio, RiskConfig
from ..strategies.base import Strategy, StrategyContext, StrategyDecision
from .base import BotRuntime
from .models import BotContext, BotDecision, BotSpec, OrderIntent

_ORDER_TYPE_MAP = {
    "market": OrderType.MARKET,
    "limit": OrderType.LIMIT,
    "stop_market": OrderType.STOP_MARKET,
    "stop_limit": OrderType.STOP_LIMIT,
    "trailing_stop": OrderType.TRAILING_STOP,
}


@dataclass
class BotRunReport:
    spec_hash: str
    compiler_version: str
    engine_version: str
    final_equity: Decimal
    fills: list[dict] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    equity_curve: list[Decimal] = field(default_factory=list)
    trade_pnls: list[Decimal] = field(default_factory=list)
    risk_notes: list[str] = field(default_factory=list)
    positions: dict = field(default_factory=dict)
    risk_state: dict = field(default_factory=dict)
    # Normalized execution fill_model (Phases 1-2) + per-maker-fill audit evidence.
    fill_model: dict = field(default_factory=dict)
    fill_evidence: list[dict] = field(default_factory=list)


class _BotStrategyShim(Strategy):
    """Adapt a BotRuntime to the Strategy interface used by PaperRuntime."""

    name = "bot_shim"

    def __init__(self, bot: BotRuntime, symbol: str, on_event=None, side_marks=None):
        super().__init__({})
        self.bot = bot
        self.symbol = symbol
        self._started = False
        self._funding_last: dict[str, Decimal] = {}
        self._risk_notes: list[str] = []
        self._on_event = on_event or (lambda *_a, **_kw: None)
        # side_marks: {symbol: {ts: Decimal close}} so multi-symbol bots
        # (combo, rebalancer, funding_arb) see marks for every leg they need.
        self._side_marks: dict[str, dict] = side_marks or {}

    def update_funding(self, symbol: str, rate: Decimal) -> None:
        self._funding_last[symbol] = rate

    @property
    def risk_notes(self) -> list[str]:
        return self._risk_notes

    def on_bar(self, ctx: StrategyContext) -> StrategyDecision:
        prices = {self.symbol: ctx.bar_close}
        marks = {self.symbol: ctx.bar_close}
        # Layer in side marks for multi-symbol bots — use the bar with the
        # closest timestamp not exceeding current bar's ts.
        for sym, series in self._side_marks.items():
            if not series:
                continue
            closest_ts = None
            for t in series:
                if t <= ctx.ts and (closest_ts is None or t > closest_ts):
                    closest_ts = t
            if closest_ts is not None:
                prices[sym] = series[closest_ts]
                marks[sym] = series[closest_ts]
        bot_ctx = BotContext(
            ts=ctx.ts,
            prices=prices,
            marks=marks,
            prior_bar_volume={self.symbol: ctx.bar_volume},
            funding_rates=dict(self._funding_last),
            positions={self.symbol: ctx.position_qty if ctx.position_side == "long" else -ctx.position_qty if ctx.position_side == "short" else Decimal(0)},
            equity=ctx.equity,
            cash=ctx.cash,
        )

        decisions: list[BotDecision] = []
        if not self._started:
            decisions.append(self.bot.on_start(bot_ctx))
            self._started = True
        decisions.append(self.bot.on_bar(bot_ctx))

        place: list[Order] = []
        cancel_all = False
        for d in decisions:
            if not isinstance(d, BotDecision):
                continue
            cancel_all = cancel_all or d.cancel_all
            for intent in d.place:
                place.append(self._intent_to_order(intent))
            self._risk_notes.extend(d.risk_notes)
            for note in d.risk_notes:
                self._on_event("RISK_NOTE", ctx.ts, {"note": note})
            for log in d.logs:
                self._on_event("BOT_LOG", ctx.ts, {"msg": log})
        return StrategyDecision(place=place, cancel_all=cancel_all)

    def _intent_to_order(self, intent: OrderIntent) -> Order:
        try:
            tif = TimeInForce(str(getattr(intent, "tif", "gtc")).lower())
        except ValueError:
            tif = TimeInForce.GTC
        return Order(
            symbol=intent.symbol,
            side=intent.side,
            qty=intent.qty,
            order_type=_ORDER_TYPE_MAP.get(intent.order_type, OrderType.MARKET),
            limit_price=intent.limit_price,
            stop_price=intent.stop_price,
            tif=tif,
            post_only=intent.post_only,
            reduce_only=intent.reduce_only,
            trigger_by=getattr(intent, "trigger_by", "LastPrice"),
            client_tag=intent.tag,
        )

    def on_fill(self, order: Order, fill_price: Decimal, fill_qty: Decimal) -> None:
        # Convert to a BotContext-like dict and let the bot react.
        ctx = BotContext(
            ts=datetime.utcnow(),
            prices={self.symbol: fill_price},
            marks={self.symbol: fill_price},
        )
        fill = {"side": order.side, "qty": str(fill_qty), "price": str(fill_price), "tag": order.client_tag}
        decision = self.bot.on_fill(fill, ctx)
        self._risk_notes.extend(decision.risk_notes)


def run_bot(
    *,
    spec: BotSpec,
    bot: BotRuntime,
    symbol: str,
    bars: list[Bar],
    funding_rows: list[FundingRow],
    starting_equity: Decimal = Decimal("10000"),
    risk: dict[str, Any] | None = None,
    fee_bps_taker: Decimal = Decimal("5.5"),
    fee_bps_maker: Decimal = Decimal("1.0"),
    slippage_bps_one_way: Decimal = Decimal("2.0"),
    spec_hash_value: str = "",
    compiler_version: str = "",
    engine_version: str = "bot-os-v4.1",
    side_bars: dict[str, list[Bar]] | None = None,
    event_sink: Callable[[dict], None] | None = None,
    execution_provider: object | None = None,
    requested_fidelity: object | None = None,
    fallback_reason: str | None = None,
    latency: object | None = None,
    instrument_filter: object | None = None,
    vip_tier: str | None = None,
    category: str | None = None,
    enforce_order_semantics: bool = False,
    funding_caps: tuple[Decimal | None, Decimal | None] | None = None,
    risk_tiers: list | None = None,
    leverage: Decimal | None = None,
) -> tuple[BotRunReport, PaperRunResult]:
    risk_kwargs = {}
    for k in ("max_position_fraction", "max_total_exposure_fraction", "max_daily_loss_fraction", "max_drawdown_kill_fraction"):
        if risk and k in risk:
            risk_kwargs[k] = Decimal(str(risk[k]))
    portfolio = Portfolio(starting_equity=starting_equity, risk=RiskConfig(**risk_kwargs))

    extra_events: list[dict] = []

    def on_event(type_: str, ts, payload):
        extra_events.append({"ts": ts.isoformat() if hasattr(ts, "isoformat") else ts, "type": type_, "payload": payload})

    side_marks: dict[str, dict] = {}
    if side_bars:
        for sym, series in side_bars.items():
            side_marks[sym] = {b.ts: b.close for b in series}
    shim = _BotStrategyShim(bot, symbol, on_event=on_event, side_marks=side_marks)

    # forward funding-rate updates so the bot can read funding_rates on each bar
    funding_lookup: dict[datetime, Decimal] = {f.timestamp: f.funding_rate for f in funding_rows}
    bars_sorted = sorted(bars, key=lambda b: b.ts)

    runtime = PaperRuntime(
        symbol=symbol, portfolio=portfolio, strategy=shim,
        fee_bps_taker=fee_bps_taker, fee_bps_maker=fee_bps_maker,
        slippage_bps_one_way=slippage_bps_one_way,
        vip_tier=vip_tier,
        category=category,
        instrument_filter=instrument_filter,
    )
    runtime.enforce_order_semantics = bool(enforce_order_semantics)
    if funding_caps is not None:
        runtime.funding_cap_lower, runtime.funding_cap_upper = funding_caps
    if risk_tiers:
        runtime.risk_tiers = risk_tiers
        runtime.liquidation_model = "mark_price_tiered"
    if leverage is not None:
        runtime.leverage = leverage
    # Phases 1-2: install the L2 execution provider when one was resolved (else bar-based).
    if requested_fidelity is not None:
        from ..execution import Fidelity
        runtime.requested_fidelity = Fidelity.parse(requested_fidelity, Fidelity.BAR_BASED)
    if execution_provider is not None:
        runtime.l2_queue_provider = execution_provider
    if fallback_reason:
        runtime.fill_stats.fallback_reason = fallback_reason
    if latency is not None:
        runtime.latency = latency

    # Prime funding_last for any rows older than the first bar so the bot sees the latest seen rate.
    for f in funding_rows:
        if bars_sorted and f.timestamp <= bars_sorted[0].ts:
            shim.update_funding(symbol, f.funding_rate)
    # During the run, the PaperRuntime applies funding per bar; we also propagate the rate
    # into the shim so on_bar sees an up-to-date funding_rate.
    for b in bars_sorted:
        if b.ts in funding_lookup:
            shim.update_funding(symbol, funding_lookup[b.ts])

    result = runtime.run(bars=bars_sorted, funding_rows=funding_rows)

    events_combined = [
        {"ts": e.ts.isoformat(), "type": e.type, "payload": e.payload}
        for e in result.events
    ] + extra_events
    events_combined.sort(key=lambda e: e["ts"])
    if event_sink:
        for event in events_combined:
            event_sink(event)

    report = BotRunReport(
        spec_hash=spec_hash_value,
        compiler_version=compiler_version,
        engine_version=engine_version,
        final_equity=result.final_equity,
        fills=[
            {"order_id": f.order_id, "symbol": f.symbol, "side": f.side, "qty": str(f.qty),
             "price": str(f.price), "fee": str(f.fee), "ts": f.ts.isoformat(), "is_maker": f.is_maker}
            for f in result.fills
        ],
        events=events_combined[:1000],
        equity_curve=result.equity_curve,
        trade_pnls=result.trade_pnls,
        risk_notes=list(set(shim.risk_notes)),
        positions={
            sym: {"side": p.side, "qty": str(p.qty), "avg_entry": str(p.avg_entry),
                  "realized_pnl": str(p.realized_pnl), "funding_pnl": str(p.funding_pnl)}
            for sym, p in portfolio.positions.items()
        },
        risk_state={
            "killed": portfolio.state.killed,
            "kill_reason": portfolio.state.kill_reason,
            "equity_high_watermark": str(portfolio.state.equity_high_watermark),
        },
        fill_model=runtime.fill_model(),
        fill_evidence=runtime.fill_evidence[:200],
    )
    return report, result
