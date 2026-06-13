"""Paper-trading runtime.

Bar-driven loop that drives a Strategy through a sequence of Bars + funding rows
against a Portfolio with risk gates. Handles market / limit / stop / trailing
order processing with strict-penetration limit fills (§10.1) and stop-first
intrabar ordering. Emits an event log identical in shape to the live backtest.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from .engine import FundingRow, apply_funding_events, Position as EnginePosition
from .orders import (
    Bar,
    Fill,
    Order,
    OrderStatus,
    OrderType,
    TimeInForce,
    can_fill_limit,
    can_fill_market,
    can_fill_stop,
    maker_fill_qty,
)
from .portfolio import Portfolio
from .strategies.base import Strategy, StrategyContext, StrategyDecision
from .execution import Fidelity, FillModelStats, build_fill_model
from . import orders as _orders_mod


@dataclass
class PaperEvent:
    ts: datetime
    type: str
    payload: dict


@dataclass
class PaperRunResult:
    events: list[PaperEvent] = field(default_factory=list)
    fills: list[Fill] = field(default_factory=list)
    equity_curve: list[Decimal] = field(default_factory=list)
    trade_pnls: list[Decimal] = field(default_factory=list)
    final_equity: Decimal = Decimal(0)


class PaperRuntime:
    def __init__(
        self,
        *,
        symbol: str,
        portfolio: Portfolio,
        strategy: Strategy,
        fee_bps_taker: Decimal = Decimal("5.5"),
        fee_bps_maker: Decimal = Decimal("1.0"),
        slippage_bps_one_way: Decimal = Decimal("2.0"),
        tick_buffer: Decimal = Decimal("0.01"),
        vip_tier: str | None = None,
        category: str | None = None,
        instrument_filter: "object | None" = None,
    ) -> None:
        self.symbol = symbol
        self.portfolio = portfolio
        self.strategy = strategy
        # WS-B: if a vip_tier is declared, resolve maker/taker fees from the pinned Bybit
        # fee schedule (default OFF -> keep the explicit fee_bps_* args, byte-identical).
        if vip_tier is not None:
            from .bybit_venue import resolve_fee_bps
            cat = category or "linear"
            fee_bps_maker = resolve_fee_bps(cat, is_maker=True, vip_tier=vip_tier)
            fee_bps_taker = resolve_fee_bps(cat, is_maker=False, vip_tier=vip_tier)
        self.fee_bps_taker = fee_bps_taker
        self.fee_bps_maker = fee_bps_maker
        self.slippage_bps_one_way = slippage_bps_one_way
        self.tick_buffer = tick_buffer
        self.vip_tier = vip_tier
        self.category = category
        self.instrument_filter = instrument_filter  # WS-A: InstrumentFilter or None
        # WS-D: per-symbol funding caps (clamp rate to [lower, upper]); None ⇒ unclamped.
        self.funding_cap_lower: Decimal | None = None
        self.funding_cap_upper: Decimal | None = None
        # WS-F: enforce PostOnly-reject / reduceOnly-clamp at intake (opt-in; default OFF).
        self.enforce_order_semantics: bool = False
        # WS-G: queue-aware maker fills. If set, a callable (order, this_bar) ->
        # (queue_ahead, through_volume, swept) from recorded L2 + trade prints; the limit branch
        # then fills via queue_aware_fill_qty and flips l2_aware. Default None ⇒ bar-based.
        self.l2_queue_provider = None
        self.l2_aware_used: bool = False
        # The fidelity the CALLER requested (used to label the achieved fill_model.mode).
        # Defaults to bar_based so behaviour is byte-identical unless a caller opts in.
        self.requested_fidelity: Fidelity = Fidelity.BAR_BASED
        # Accumulated counters/flags for the normalized fill_model block.
        self.fill_stats = FillModelStats()
        # Per-maker-fill audit evidence (Phase 4); appended whenever a provider runs.
        self.fill_evidence: list[dict] = []
        # Phase 5: deterministic latency model. None/disabled ⇒ 0ms, byte-identical behaviour.
        self.latency = None  # quant_core.execution.LatencyConfig | None
        self._join_eff: dict[str, int] = {}     # order_id -> effective exchange (join) time ms
        self._cancel_eff: dict[str, int] = {}    # order_id -> effective cancel time ms (pending)
        self.open_orders: list[Order] = []
        # WS-C: opt-in mark-price tiered liquidation for venue-exact linear runs.
        self.liquidation_model: str = "none"
        self.risk_tiers: list | None = None
        self.leverage: Decimal = Decimal("1")

    # ---- Phase 5 latency helpers ----
    def _lat_on(self) -> bool:
        return self.latency is not None and getattr(self.latency, "enabled", False)

    def _lat_jitter_ms(self, order_id: str) -> int:
        """Deterministic per-order jitter in [0, jitter_ms] (seeded; no wall-clock/RNG)."""
        j = int(getattr(self.latency, "jitter_ms", 0) or 0)
        if j <= 0:
            return 0
        seed = int(getattr(self.latency, "seed", 42) or 42)
        h = hashlib.sha256(f"{seed}:{order_id}".encode()).hexdigest()
        return int(h, 16) % (j + 1)

    @staticmethod
    def _ms(ts: datetime) -> int:
        return int(ts.timestamp() * 1000)

    def _emit(self, result: PaperRunResult, ts: datetime, type_: str, **payload) -> None:
        result.events.append(PaperEvent(ts=ts, type=type_, payload=payload))
        if type_ in ("REJECTED", "RISK_REJECT"):
            self.fill_stats.rejected_orders += 1

    def _close_oco_siblings(self, order: Order) -> None:
        if not order.oco_group:
            return
        for o in self.open_orders:
            if o.oco_group == order.oco_group and o.order_id != order.order_id and not o.is_terminal():
                o.status = OrderStatus.CANCELLED

    def _apply_fill(self, result: PaperRunResult, order: Order, price: Decimal, qty: Decimal, ts: datetime, is_maker: bool) -> None:
        fee_bps = self.fee_bps_maker if is_maker else self.fee_bps_taker
        notional = qty * price
        fee = notional * fee_bps / Decimal(10000)
        realized = self.portfolio.apply_fill(symbol=order.symbol, side=order.side, qty=qty, price=price, fee=fee)
        order.filled_qty += qty
        # rolling avg fill price
        if order.filled_qty > 0:
            order.avg_fill_price = (order.avg_fill_price * (order.filled_qty - qty) + price * qty) / order.filled_qty
        if order.filled_qty >= order.qty:
            order.status = OrderStatus.FILLED
        else:
            order.status = OrderStatus.PARTIAL
        order.updated_at = ts
        fill = Fill(order_id=order.order_id, symbol=order.symbol, side=order.side, qty=qty, price=price, fee=fee, slippage_bps=Decimal(0) if is_maker else self.slippage_bps_one_way, ts=ts, is_maker=is_maker)
        result.fills.append(fill)
        if is_maker:
            self.fill_stats.maker_fills += 1
        else:
            self.fill_stats.taker_fills += 1
        self._emit(result, ts, "FILL", order_id=order.order_id, side=order.side, qty=str(qty), price=str(price), fee=str(fee), is_maker=is_maker)
        if realized != 0:
            result.trade_pnls.append(realized)
            self._emit(result, ts, "REALIZED_PNL", amount=str(realized), order_id=order.order_id)
        self.strategy.on_fill(order, price, qty)
        if order.status == OrderStatus.FILLED:
            self._close_oco_siblings(order)

    def _l2_limit_fill(self, result: PaperRunResult, order: Order, this_bar: Bar):
        """Consult the installed L2 provider for a resting limit order on this bar.

        Returns ``(fill_price, fill_qty, had_opportunity)``. ``had_opportunity`` is True
        whenever the provider was consulted (so IOC/FOK no-fill logic can fire), matching the
        bar-based path's contract. Folds provider usage/coverage/evidence into fill stats and
        stashes the through-volume so the caller can advance the queue after the fill applies.
        """
        qa, thru, swept = self.l2_queue_provider(order, this_bar)
        fq = _orders_mod.queue_aware_fill_qty(order.remaining, qa, thru, swept)
        self.l2_aware_used = True
        self._pending_through = thru
        prov = self.l2_queue_provider
        self.fill_stats.l2_provider_used = (
            self.fill_stats.l2_provider_used or bool(getattr(prov, "provider_used", True)))
        if getattr(prov, "trade_prints_used", False):
            self.fill_stats.trade_prints_used = True
        ev = getattr(prov, "last_evidence", None)
        if ev is not None:
            self.fill_evidence.append(ev)
        return order.limit_price, fq, True

    def _maybe_liquidate_mark_tiered(self, result: PaperRunResult, bar: Bar) -> None:
        if self.liquidation_model != "mark_price_tiered" or not self.risk_tiers or self.leverage <= 1:
            return
        if self.category and self.category != "linear":
            return
        net = self.portfolio.get_or_create(self.symbol)
        if net.side == "flat" or net.qty <= 0:
            return
        from .bybit_venue import position_liquidation
        pl = position_liquidation(
            side=net.side,
            qty=net.qty,
            entry=net.avg_entry,
            mark_high=bar.high,
            mark_low=bar.low,
            mark_close=bar.close,
            tiers=self.risk_tiers,
            leverage=self.leverage,
            taker_fee_bps=self.fee_bps_taker,
        )
        if not pl.triggered:
            return
        self._emit(
            result,
            bar.ts,
            "LIQUIDATION",
            liquidation_model="mark_price_tiered",
            tier_id=pl.tier_id,
            liquidation_price=str(pl.lp),
            bankruptcy_price=str(pl.bankruptcy),
            mark_high=str(bar.high),
            mark_low=str(bar.low),
            mark_close=str(bar.close),
        )
        close_side = "sell" if net.side == "long" else "buy"
        liq = Order(
            symbol=self.symbol,
            side=close_side,
            qty=net.qty,
            order_type=OrderType.MARKET,
            reduce_only=True,
            client_tag="mark_tiered_liquidation",
        )
        self._apply_fill(result, liq, pl.bankruptcy, net.qty, bar.ts, is_maker=False)

    def _process_pending_orders(self, result: PaperRunResult, next_bar: Bar | None, this_bar: Bar) -> None:
        if next_bar is None:
            return
        lat_on = self._lat_on()
        bar_ms = self._ms(this_bar.ts)
        for order in self.open_orders:
            if order.is_terminal():
                continue
            if lat_on:
                # A pending cancel only takes effect once cancel_request_time + cancel_latency
                # has elapsed. A fill on an earlier bar therefore stands (cancel can't reach
                # back). Applied at bar start, before any fill is attempted this bar.
                ceff = self._cancel_eff.get(order.order_id)
                if ceff is not None and bar_ms >= ceff:
                    order.status = OrderStatus.CANCELLED
                    self._emit(result, this_bar.ts, "CANCELLED", reason="CANCEL_LATENCY_EFFECTIVE",
                               order_id=order.order_id)
                    continue
                # The order has not joined the book until decision_time + order_entry_latency.
                jeff = self._join_eff.get(order.order_id)
                if jeff is not None and bar_ms < jeff:
                    continue
            if order.order_type == OrderType.MARKET:
                fill_price, _ = can_fill_market(next_bar, order, self.slippage_bps_one_way)
                self._apply_fill(result, order, fill_price, order.remaining, next_bar.ts, is_maker=False)
            elif order.order_type == OrderType.LIMIT:
                if self.l2_queue_provider is not None:
                    # L2 path (sweep/queue): the provider is the fill authority. It is
                    # consulted on EVERY bar the order rests — no strict-penetration pre-gate,
                    # because a queue order can fill from through-volume on a mere touch and a
                    # sweep order fills on strict penetration (provider's own `swept`).
                    fp, fq, had_opportunity = self._l2_limit_fill(result, order, this_bar)
                else:
                    # Bar-based path (default; byte-identical to pre-upgrade behaviour):
                    # strict penetration vs THIS bar's range + a volume-participation cap.
                    fp = can_fill_limit(this_bar, order, self.tick_buffer)
                    had_opportunity = fp is not None
                    fq = maker_fill_qty(order.remaining, this_bar.volume) if had_opportunity else Decimal(0)

                if had_opportunity:
                    # WS-F: FOK must fill in full or not at all (opt-in).
                    if (self.enforce_order_semantics and order.tif == TimeInForce.FOK
                            and fq < order.remaining):
                        order.status = OrderStatus.CANCELLED
                        self._emit(result, this_bar.ts, "CANCELLED", reason="FOK_UNFILLED",
                                   order_id=order.order_id)
                        continue
                    if fq > 0:
                        self._apply_fill(result, order, fp, fq, this_bar.ts, is_maker=True)
                        # Phase 4: advance the order's queue position by the through-volume it
                        # just consumed, so it converges to the front across bars.
                        if self.l2_queue_provider is not None:
                            _adv = getattr(self.l2_queue_provider, "on_fill", None)
                            if _adv is not None:
                                _adv(order.order_id, fq, getattr(self, "_pending_through", Decimal(0)))
                    # WS-F: IOC keeps the immediate partial, cancels the remainder.
                    if (self.enforce_order_semantics and order.tif == TimeInForce.IOC
                            and not order.is_terminal()):
                        order.status = OrderStatus.CANCELLED
                        self._emit(result, this_bar.ts, "CANCELLED", reason="IOC_REMAINDER",
                                   order_id=order.order_id)
                elif self.enforce_order_semantics and order.tif in (TimeInForce.IOC, TimeInForce.FOK):
                    # No immediate fill possible this bar -> IOC/FOK cancel right away.
                    order.status = OrderStatus.CANCELLED
                    self._emit(result, this_bar.ts, "CANCELLED", reason="IOC_FOK_NO_FILL",
                               order_id=order.order_id)
            elif order.order_type in (OrderType.STOP_MARKET, OrderType.STOP_LIMIT, OrderType.TRAILING_STOP):
                order.update_trailing(this_bar.close)
                trigger_bar = this_bar
                if order.trigger_by and order.trigger_by != "LastPrice":
                    from .bybit_venue import resolve_trigger_price
                    ref = resolve_trigger_price(
                        order.trigger_by,
                        this_bar.close,
                        mark=getattr(self, "_mark_ref", None),
                        index=getattr(self, "_index_ref", None),
                    )
                    trigger_bar = Bar(ts=this_bar.ts, open=ref, high=ref, low=ref, close=ref, volume=this_bar.volume)
                if can_fill_stop(trigger_bar, order):
                    if order.order_type == OrderType.STOP_MARKET or order.order_type == OrderType.TRAILING_STOP:
                        sp = order.stop_price if order.stop_price is not None else this_bar.close
                        # Gap-through realism: a bar opening beyond the stop fills at the
                        # (worse) open, not the stop price.
                        fill_price = min(sp, trigger_bar.open) if order.side == "sell" else max(sp, trigger_bar.open)
                        self._apply_fill(result, order, fill_price, order.remaining, this_bar.ts, is_maker=False)
                    else:
                        # Stop-limit: convert to a resting limit at the stop's limit_price.
                        order.order_type = OrderType.LIMIT
                        order.stop_price = None

    def _gc_orders(self) -> None:
        # Stop tracking queue position for any order that has gone terminal
        # (filled/cancelled/rejected) so a cancellation halts queue advancement.
        _forget = getattr(self.l2_queue_provider, "forget", None)
        if _forget is not None:
            for o in self.open_orders:
                if o.is_terminal():
                    _forget(o.order_id)
        self.open_orders = [o for o in self.open_orders if not o.is_terminal()]

    def fill_model(self) -> dict:
        """Build the normalized fill_model block for this run (Phase 1).

        Folds the provider's observed coverage into the accumulated stats, then delegates to
        ``build_fill_model`` which resolves the *achieved* mode from the request + what the
        engine actually did. Safe to call after ``run``."""
        prov = self.l2_queue_provider
        if prov is not None:
            sc = getattr(prov, "snapshot_coverage_pct", None)
            tc = getattr(prov, "trade_coverage_pct", None)
            if sc is not None:
                self.fill_stats.snapshot_coverage_pct = float(sc)
            if tc is not None:
                self.fill_stats.trade_coverage_pct = float(tc)
        return build_fill_model(
            self.requested_fidelity,
            self.fill_stats,
            market_impact_coef=_orders_mod.MARKET_IMPACT_COEF,
            maker_participation_rate=_orders_mod.MAKER_PARTICIPATION_RATE,
        )

    def run(
        self,
        *,
        bars: list[Bar],
        funding_rows: list[FundingRow] | None = None,
        mark_lookup=None,
    ) -> PaperRunResult:
        result = PaperRunResult()
        funding_rows = funding_rows or []
        mark_lookup = mark_lookup or (lambda _s, _t, fallback: fallback)
        last_funding_rate: Decimal | None = None

        # Phase 5: latency model setup. When enabled, the strategy sees data delayed by
        # feed_latency (rounded to whole bars), orders join late, and cancels are deferred.
        lat_on = self._lat_on()
        if lat_on:
            self.fill_stats.latency_model_used = True
        interval_ms = self._ms(bars[1].ts) - self._ms(bars[0].ts) if len(bars) > 1 else 60_000
        feed_shift = 0
        if lat_on and interval_ms > 0:
            feed_shift = int(getattr(self.latency, "feed_latency_ms", 0) or 0) // interval_ms

        # Engine-position shim so we can reuse apply_funding_events.
        engine_pos = EnginePosition(symbol=self.symbol, side="long", category="linear")

        for i, bar in enumerate(bars):
            self._mark_ref = mark_lookup(self.symbol, bar.ts, bar.close)
            self._index_ref = None
            # 1) Funding settlement on rows in (prev_bar.ts, bar.ts]
            bar_start = bars[i - 1].ts if i > 0 else bar.ts
            net = self.portfolio.get_or_create(self.symbol)
            if net.side != "flat" and net.qty > 0:
                engine_pos.side = "long" if net.side == "long" else "short"
                engine_pos.qty = net.qty
                engine_pos.opened_at = bar_start
                engine_pos.closed_at = None
                funding_events = apply_funding_events(
                    position=engine_pos,
                    bar_start=bar_start,
                    bar_end=bar.ts,
                    funding_rows=funding_rows,
                    mark_price_lookup=lambda s, t: mark_lookup(s, t, bar.close),
                    funding_cap_lower=self.funding_cap_lower,
                    funding_cap_upper=self.funding_cap_upper,
                )
                for fe in funding_events:
                    amount = Decimal(fe.payload["amount"])
                    self.portfolio.apply_funding(self.symbol, amount)
                    self._emit(result, fe.event_ts, "FUNDING_SETTLEMENT", amount=str(amount), rate=fe.payload["rate"], mark=fe.payload["mark"])
            for fr in funding_rows:
                if bar_start < fr.timestamp <= bar.ts:
                    last_funding_rate = fr.funding_rate

            # 2) Strategy decision (uses signal at close[t], orders effective from this bar onward).
            # Feed latency: the strategy reacts to prices delayed by whole bars (data it could
            # actually have seen by decision time); the order book still advances on the real bar.
            seen = bars[i - feed_shift] if feed_shift and i - feed_shift >= 0 else bar
            ctx = StrategyContext(
                ts=bar.ts, symbol=self.symbol,
                bar_open=seen.open, bar_high=seen.high, bar_low=seen.low, bar_close=seen.close, bar_volume=seen.volume,
                position_qty=net.qty, position_side=net.side, avg_entry=net.avg_entry,
                cash=self.portfolio.cash,
                equity=self.portfolio.equity({self.symbol: bar.close}),
                open_orders=[o for o in self.open_orders if not o.is_terminal()],
                funding_rate_last=last_funding_rate,
            )
            decision = self.strategy.on_bar(ctx)
            # Cancels: immediate when latency is off; deferred to cancel_request + cancel_latency
            # (+ jitter) when on, so a cancel can't retroactively undo an earlier fill.
            cancel_ms = self._ms(bar.ts)
            def _request_cancel(o: Order) -> None:
                if lat_on:
                    self._cancel_eff[o.order_id] = (
                        cancel_ms + int(getattr(self.latency, "cancel_latency_ms", 0) or 0)
                        + self._lat_jitter_ms(o.order_id))
                else:
                    o.status = OrderStatus.CANCELLED
            if decision.cancel_all:
                for o in self.open_orders:
                    if not o.is_terminal():
                        _request_cancel(o)
            for oid in decision.cancel_order_ids:
                for o in self.open_orders:
                    if o.order_id == oid and not o.is_terminal():
                        _request_cancel(o)

            for new_order in decision.place:
                ok, reason = self.portfolio.check_pretrade(symbol=self.symbol, qty=new_order.qty, price=bar.close, marks={self.symbol: bar.close})
                if not ok:
                    new_order.status = OrderStatus.REJECTED
                    new_order.created_at = bar.ts
                    self._emit(result, bar.ts, "RISK_REJECT", reason=reason, order_id=new_order.order_id, side=new_order.side, qty=str(new_order.qty))
                    continue
                # WS-A: instrument-filter conformance (opt-in; only when a snapshot is supplied).
                # Snaps price to tick / qty to step, or REJECTS with a typed Bybit reason.
                if self.instrument_filter is not None:
                    from .bybit_venue import conform_order
                    is_mkt = new_order.order_type == OrderType.MARKET
                    cr = conform_order(
                        side=new_order.side,
                        price=new_order.limit_price if not is_mkt else None,
                        qty=new_order.qty, instr=self.instrument_filter,
                        is_market=is_mkt, mark_price=bar.close,
                    )
                    if not cr.ok:
                        new_order.status = OrderStatus.REJECTED
                        new_order.created_at = bar.ts
                        self._emit(result, bar.ts, "REJECTED", reason=cr.reason,
                                   order_id=new_order.order_id, side=new_order.side, qty=str(new_order.qty))
                        continue
                    if cr.price is not None and not is_mkt:
                        new_order.limit_price = cr.price
                    if cr.qty is not None:
                        new_order.qty = cr.qty
                # WS-F: order-type semantics (opt-in; default OFF preserves the internal
                # kill/liquidate reduceOnly path and existing behaviour byte-for-byte).
                if self.enforce_order_semantics:
                    from .bybit_venue import post_only_would_cross, clamp_reduce_only
                    # PostOnly that would cross the book at submit -> rejected (never a taker).
                    if (new_order.post_only and new_order.limit_price is not None
                            and post_only_would_cross(new_order.side, new_order.limit_price,
                                                      best_bid=bar.close, best_ask=bar.close)):
                        new_order.status = OrderStatus.REJECTED
                        new_order.created_at = bar.ts
                        self._emit(result, bar.ts, "REJECTED", reason="POST_ONLY_WOULD_CROSS",
                                   order_id=new_order.order_id, side=new_order.side, qty=str(new_order.qty))
                        continue
                    # reduceOnly can only reduce, never flip/increase.
                    if new_order.reduce_only:
                        allowed = clamp_reduce_only(new_order.side, new_order.qty, net.side, net.qty)
                        if allowed <= 0:
                            new_order.status = OrderStatus.REJECTED
                            new_order.created_at = bar.ts
                            self._emit(result, bar.ts, "REJECTED", reason="REDUCE_ONLY_NO_POSITION",
                                       order_id=new_order.order_id, side=new_order.side, qty=str(new_order.qty))
                            continue
                        new_order.qty = allowed
                new_order.created_at = bar.ts
                new_order.status = OrderStatus.OPEN
                self.open_orders.append(new_order)
                # Phase 5: order lifecycle timestamps. decision -> send -> effective (joins the
                # book) -> ack. With latency off, all equal the decision time (no behaviour change).
                lat_evt: dict = {}
                if lat_on:
                    decision_ms = self._ms(bar.ts)
                    jit = self._lat_jitter_ms(new_order.order_id)
                    entry = int(getattr(self.latency, "order_entry_latency_ms", 0) or 0)
                    ack = int(getattr(self.latency, "exchange_ack_latency_ms", 0) or 0)
                    eff = decision_ms + entry + jit
                    self._join_eff[new_order.order_id] = eff
                    lat_evt = {"decision_time_ms": decision_ms, "send_time_ms": decision_ms,
                               "effective_exchange_time_ms": eff, "ack_time_ms": eff + ack,
                               "latency_jitter_ms": jit}
                self._emit(result, bar.ts, "ORDER_CREATED", order_id=new_order.order_id, side=new_order.side, qty=str(new_order.qty), type=new_order.order_type.value, limit=str(new_order.limit_price) if new_order.limit_price else None, stop=str(new_order.stop_price) if new_order.stop_price else None, tag=new_order.client_tag, **lat_evt)

            # 3) Process pending orders: limits/stops vs this bar, markets fill at next bar open
            next_bar = bars[i + 1] if i + 1 < len(bars) else None
            self._process_pending_orders(result, next_bar, bar)
            self._gc_orders()

            # 4) Mark-to-market + risk update
            self.portfolio.update_equity_marks(bar.ts, {self.symbol: bar.close})
            self._maybe_liquidate_mark_tiered(result, bar)
            eq = self.portfolio.equity({self.symbol: bar.close})
            result.equity_curve.append(eq)

            if self.portfolio.state.killed:
                self._emit(result, bar.ts, "KILLED", reason=self.portfolio.state.kill_reason)
                # Liquidate any open position at market on the next bar's open
                if net.side != "flat" and net.qty > 0 and next_bar is not None:
                    close_side = "sell" if net.side == "long" else "buy"
                    liq = Order(symbol=self.symbol, side=close_side, qty=net.qty, order_type=OrderType.MARKET, reduce_only=True, client_tag="kill_liquidate")
                    fp, _ = can_fill_market(next_bar, liq, self.slippage_bps_one_way)
                    self._apply_fill(result, liq, fp, net.qty, next_bar.ts, is_maker=False)
                break

        result.final_equity = self.portfolio.equity({self.symbol: bars[-1].close}) if bars else self.portfolio.cash
        return result
