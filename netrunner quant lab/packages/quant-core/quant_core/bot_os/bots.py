from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from .base import BotRuntime
from .models import BotContext, BotDecision, BotSpec, BotValidation, OrderIntent
from ..xstocks import (
    asset_class_of,
    is_regular_trading_hours,
    is_xstock,
    position_cap_breached,
)


def _d(value: Any, default: str = "0") -> Decimal:
    if value is None:
        return Decimal(default)
    return Decimal(str(value))


def _clamp(value: Decimal, low: Decimal, high: Decimal) -> Decimal:
    return max(low, min(high, value))


class SpotGridBot(BotRuntime):
    bot_type = "spot_grid"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.symbol = str(params.get("symbol", "BTCUSDT"))
        self.lower = _d(params.get("lower_price", "90000"))
        self.upper = _d(params.get("upper_price", "110000"))
        self.grid_count = int(params.get("grid_count", 10))
        self.grid_spacing = str(params.get("grid_spacing", "arithmetic"))
        self.investment_quote = _d(params.get("investment_quote", "1000"))
        self.levels: list[Decimal] = []
        self.qty_per_level = _d(params.get("qty_per_level", "0"))
        self._init_levels()

    def _init_levels(self) -> None:
        if self.grid_count < 2:
            self.levels = []
            return
        if self.grid_spacing == "geometric":
            ratio = (self.upper / self.lower) ** (Decimal(1) / Decimal(self.grid_count - 1))
            self.levels = [self.lower * (ratio ** Decimal(i)) for i in range(self.grid_count)]
        else:
            step = (self.upper - self.lower) / Decimal(self.grid_count - 1)
            self.levels = [self.lower + step * Decimal(i) for i in range(self.grid_count)]

    def validate(self, spec: BotSpec, coverage: dict[str, Any] | None = None) -> BotValidation:
        errors: list[str] = []
        warnings: list[str] = []
        if self.lower >= self.upper:
            errors.append("GRID_RANGE_INVALID")
        if self.grid_count < 2:
            errors.append("GRID_COUNT_TOO_LOW")
        if self.investment_quote <= 0:
            errors.append("INVESTMENT_NON_POSITIVE")
        if self.grid_count > 400:
            warnings.append("GRID_LEVEL_COUNT_HIGH")
        return BotValidation(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
            eligibility_labels=["APPROXIMATE_FILLS"],
            risk_class="MODERATE",
        )

    def _level_qty(self, reference_price: Decimal) -> Decimal:
        if self.qty_per_level > 0:
            return self.qty_per_level
        if self.grid_count <= 0 or reference_price <= 0:
            return Decimal("0")
        return (self.investment_quote / Decimal(self.grid_count)) / reference_price

    def on_start(self, ctx: BotContext) -> BotDecision:
        mark = ctx.mark(self.symbol)
        qty = self._level_qty(mark)
        orders: list[OrderIntent] = []
        for i, level in enumerate(self.levels):
            if level < mark:
                orders.append(OrderIntent(self.symbol, "buy", qty, "limit", limit_price=level, post_only=True, tag=f"grid_b_{i}"))
            elif level > mark:
                orders.append(OrderIntent(self.symbol, "sell", qty, "limit", limit_price=level, post_only=True, tag=f"grid_s_{i}"))
        return BotDecision(place=orders, logs=[f"grid_levels={len(self.levels)}"])

    def on_fill(self, fill: dict[str, Any], ctx: BotContext) -> BotDecision:
        if not self.levels:
            return BotDecision()
        side = str(fill.get("side", "buy"))
        fill_price = _d(fill.get("price", ctx.mark(self.symbol)))
        qty = _d(fill.get("qty", self._level_qty(fill_price)))
        nearest_idx = min(range(len(self.levels)), key=lambda i: abs(self.levels[i] - fill_price))

        if side == "buy" and nearest_idx + 1 < len(self.levels):
            return BotDecision(
                place=[OrderIntent(self.symbol, "sell", qty, "limit", limit_price=self.levels[nearest_idx + 1], post_only=True, tag="grid_pair_sell")]
            )
        if side == "sell" and nearest_idx - 1 >= 0:
            return BotDecision(
                place=[OrderIntent(self.symbol, "buy", qty, "limit", limit_price=self.levels[nearest_idx - 1], post_only=True, tag="grid_pair_buy")]
            )
        return BotDecision()


class FuturesGridBot(SpotGridBot):
    bot_type = "futures_grid"

    def __init__(self, params: dict[str, Any]) -> None:
        super().__init__(params)
        self.direction = str(params.get("direction", "neutral"))

    def validate(self, spec: BotSpec, coverage: dict[str, Any] | None = None) -> BotValidation:
        base = super().validate(spec, coverage)
        warnings = list(base.warnings)
        labels = list(base.eligibility_labels)
        if self.direction not in {"neutral", "long", "short"}:
            base.errors.append("DIRECTION_INVALID")
        if coverage and not coverage.get("has_funding", False):
            base.errors.append("FUNDING_COVERAGE_REQUIRED")
        labels.extend(["APPROXIMATE_LIQUIDATION", "APPROXIMATE_FILLS"])
        if _d(self.params.get("leverage", "1")) > 1 and not (coverage or {}).get("has_margin_tiers", False):
            warnings.append("MARGIN_TIERS_MISSING")
        return BotValidation(
            valid=len(base.errors) == 0,
            errors=base.errors,
            warnings=warnings,
            eligibility_labels=labels,
            risk_class="HIGH",
        )

    def on_start(self, ctx: BotContext) -> BotDecision:
        base = super().on_start(ctx)
        if self.direction == "neutral":
            return base
        filtered: list[OrderIntent] = []
        for order in base.place:
            if self.direction == "long" and order.side == "buy":
                filtered.append(order)
            if self.direction == "short" and order.side == "sell":
                filtered.append(order)
        return BotDecision(place=filtered, logs=[f"direction={self.direction}"])

    def on_bar(self, ctx: BotContext) -> BotDecision:
        position = ctx.positions.get(self.symbol, Decimal("0"))
        notes: list[str] = []
        if self.direction == "long" and position < 0:
            notes.append("LONG_ONLY_VIOLATION")
        if self.direction == "short" and position > 0:
            notes.append("SHORT_ONLY_VIOLATION")
        if self.symbol in ctx.funding_rates:
            notes.append("FUNDING_APPLIED_BEFORE_DECISION")
        return BotDecision(risk_notes=notes)


class DcaBot(BotRuntime):
    bot_type = "dca"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.symbol = str(params.get("symbol", "BTCUSDT"))
        self.investment_quote_per_order = _d(params.get("investment_quote_per_order", "100"))
        self.frequency_bars = max(1, int(params.get("frequency_bars", 1)))
        self.max_total_investment = _d(params.get("max_total_investment", "1000"))
        self.price_filter_max = _d(params.get("price_filter_max", "0"))
        self._bar = 0
        self._invested = Decimal("0")

    def on_bar(self, ctx: BotContext) -> BotDecision:
        self._bar += 1
        price = ctx.price(self.symbol)
        if self._bar % self.frequency_bars != 0:
            return BotDecision()
        if self.price_filter_max > 0 and price > self.price_filter_max:
            return BotDecision(logs=["price_filter_skip"])
        if self._invested + self.investment_quote_per_order > self.max_total_investment:
            return BotDecision(logs=["max_investment_reached"])
        qty = self.investment_quote_per_order / price
        self._invested += self.investment_quote_per_order
        return BotDecision(place=[OrderIntent(self.symbol, "buy", qty, "market", tag=f"dca_{self._bar}")])


class FuturesDcaBot(BotRuntime):
    bot_type = "futures_dca"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.symbol = str(params.get("symbol", "BTCUSDT"))
        self.direction = str(params.get("direction", "long"))
        self.base_margin = _d(params.get("base_order_margin", "100"))
        self.dca_margin = _d(params.get("dca_order_margin", "100"))
        self.price_deviation_fraction = _d(params.get("price_deviation_fraction", "0.03"))
        self.deviation_multiplier = _d(params.get("deviation_multiplier", "1"))
        self.order_multiplier = _d(params.get("dca_order_multiplier", "1"))
        self.max_dca_orders = int(params.get("max_dca_orders", 5))
        self.take_profit_fraction = _d(params.get("take_profit_fraction", "0.01"))
        self._opened = False
        self._avg_entry = Decimal("0")
        self._qty = Decimal("0")
        self._dca_count = 0
        self._next_trigger = Decimal("0")

    def _entry_side(self) -> str:
        return "buy" if self.direction == "long" else "sell"

    def _exit_side(self) -> str:
        return "sell" if self.direction == "long" else "buy"

    def _calc_trigger(self) -> Decimal:
        dev = self.price_deviation_fraction * (self.deviation_multiplier ** Decimal(self._dca_count))
        if self.direction == "long":
            return self._avg_entry * (Decimal(1) - dev)
        return self._avg_entry * (Decimal(1) + dev)

    def on_bar(self, ctx: BotContext) -> BotDecision:
        price = ctx.mark(self.symbol)
        if not self._opened:
            qty = self.base_margin / price
            self._opened = True
            self._qty = qty
            self._avg_entry = price
            self._next_trigger = self._calc_trigger()
            tp = self._avg_entry * (Decimal(1) + self.take_profit_fraction) if self.direction == "long" else self._avg_entry * (Decimal(1) - self.take_profit_fraction)
            return BotDecision(
                place=[
                    OrderIntent(self.symbol, self._entry_side(), qty, "market", tag="f_dca_base"),
                    OrderIntent(self.symbol, self._exit_side(), qty, "limit", limit_price=tp, reduce_only=True, tag="f_dca_tp"),
                ]
            )

        hit = price <= self._next_trigger if self.direction == "long" else price >= self._next_trigger
        if not hit or self._dca_count >= self.max_dca_orders:
            return BotDecision()

        add_margin = self.dca_margin * (self.order_multiplier ** Decimal(self._dca_count))
        add_qty = add_margin / price
        new_qty = self._qty + add_qty
        self._avg_entry = ((self._avg_entry * self._qty) + (price * add_qty)) / new_qty
        self._qty = new_qty
        self._dca_count += 1
        self._next_trigger = self._calc_trigger()
        tp = self._avg_entry * (Decimal(1) + self.take_profit_fraction) if self.direction == "long" else self._avg_entry * (Decimal(1) - self.take_profit_fraction)
        return BotDecision(
            cancel_tags=["f_dca_tp"],
            place=[
                OrderIntent(self.symbol, self._entry_side(), add_qty, "market", tag=f"f_dca_add_{self._dca_count}"),
                OrderIntent(self.symbol, self._exit_side(), self._qty, "limit", limit_price=tp, reduce_only=True, tag="f_dca_tp"),
            ],
            logs=[f"avg_entry={self._avg_entry}"]
        )


class FuturesMartingaleBot(FuturesDcaBot):
    bot_type = "futures_martingale"

    def __init__(self, params: dict[str, Any]) -> None:
        super().__init__(params)
        self.base_margin = _d(params.get("base_order_margin", "100"))
        self.dca_margin = _d(params.get("safety_order_margin", "100"))
        self.order_multiplier = _d(params.get("safety_order_multiplier", "1.5"))
        self.max_dca_orders = int(params.get("max_safety_orders", 5))
        self.hard_stop_loss_fraction = _d(params.get("hard_stop_loss_fraction", "0"))

    def validate(self, spec: BotSpec, coverage: dict[str, Any] | None = None) -> BotValidation:
        errors: list[str] = []
        warnings: list[str] = []
        if self.hard_stop_loss_fraction <= 0:
            errors.append("HARD_STOP_REQUIRED")
        if self.max_dca_orders <= 0:
            errors.append("MAX_SAFETY_REQUIRED")
        if self.order_multiplier > 2:
            warnings.append("MULTIPLIER_HIGH")

        fee_shock = _d(self.params.get("fee_shock_fraction", "0.001"))
        funding_shock = _d(self.params.get("funding_shock_fraction", "0.001"))
        capital = _d(self.params.get("capital", "0"))
        worst = self.base_margin
        for i in range(self.max_dca_orders):
            worst += self.dca_margin * (self.order_multiplier ** Decimal(i))
        worst *= (Decimal(1) + fee_shock + funding_shock)
        if capital > 0 and worst > capital:
            errors.append("RUIN_MARGIN_EXCEEDS_CAPITAL")

        return BotValidation(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
            eligibility_labels=["APPROXIMATE_LIQUIDATION", "APPROXIMATE_FILLS"],
            risk_class="VERY_HIGH",
        )


@dataclass
class _Leg:
    symbol: str
    side: str
    target_weight: Decimal
    leverage: Decimal


class FuturesComboBot(BotRuntime):
    bot_type = "futures_combo"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.legs: list[_Leg] = []
        for row in params.get("symbols", []):
            self.legs.append(
                _Leg(
                    symbol=str(row["symbol"]),
                    side=str(row.get("side", "long")),
                    target_weight=_d(row.get("target_weight_fraction", "0")),
                    leverage=_d(row.get("leverage", "1")),
                )
            )
        self.total_investment = _d(params.get("total_investment", "10000"))
        self.threshold_fraction = _d(((params.get("rebalance") or {}).get("threshold_fraction", "0.05")))

    def validate(self, spec: BotSpec, coverage: dict[str, Any] | None = None) -> BotValidation:
        errors: list[str] = []
        if not self.legs:
            errors.append("LEGS_REQUIRED")
        gross = sum((abs(leg.target_weight) for leg in self.legs), Decimal(0))
        if abs(gross - Decimal(1)) > Decimal("0.0001"):
            errors.append("GROSS_WEIGHT_SUM_INVALID")
        return BotValidation(
            valid=len(errors) == 0,
            errors=errors,
            eligibility_labels=["SUBJECT_TO_RETENTION"],
            risk_class="HIGH",
        )

    def on_start(self, ctx: BotContext) -> BotDecision:
        orders: list[OrderIntent] = []
        for leg in self.legs:
            mark = ctx.mark(leg.symbol)
            gross_notional = self.total_investment * abs(leg.target_weight) * leg.leverage
            qty = gross_notional / mark if mark > 0 else Decimal("0")
            side = "buy" if leg.side == "long" else "sell"
            orders.append(OrderIntent(leg.symbol, side, qty, "market", tag=f"combo_open_{leg.symbol}"))
        return BotDecision(place=orders)

    def on_bar(self, ctx: BotContext) -> BotDecision:
        if not self.legs:
            return BotDecision()
        gross_notional = Decimal("0")
        current: dict[str, Decimal] = {}
        for leg in self.legs:
            qty = abs(ctx.positions.get(leg.symbol, Decimal("0")))
            notional = qty * ctx.mark(leg.symbol)
            current[leg.symbol] = notional
            gross_notional += notional
        if gross_notional <= 0:
            return BotDecision()

        max_dev = Decimal("0")
        orders: list[OrderIntent] = []
        for leg in self.legs:
            cur_w = current.get(leg.symbol, Decimal("0")) / gross_notional
            tgt_w = abs(leg.target_weight)
            dev = abs(cur_w - tgt_w)
            max_dev = max(max_dev, dev)
            if dev >= self.threshold_fraction:
                target_notional = gross_notional * tgt_w
                delta_notional = target_notional - current.get(leg.symbol, Decimal("0"))
                price = ctx.mark(leg.symbol)
                if price > 0 and delta_notional != 0:
                    qty = abs(delta_notional) / price
                    if delta_notional > 0:
                        side = "buy" if leg.side == "long" else "sell"
                    else:
                        side = "sell" if leg.side == "long" else "buy"
                    orders.append(OrderIntent(leg.symbol, side, qty, "market", tag=f"combo_rebalance_{leg.symbol}"))

        if not orders:
            return BotDecision()
        return BotDecision(place=orders, logs=[f"rebalance_triggered max_dev={max_dev}"])


class RebalancerBot(FuturesComboBot):
    bot_type = "rebalancer"

    def __init__(self, params: dict[str, Any]) -> None:
        super().__init__(params)
        self.spot_mode = bool(params.get("spot_mode", False))

    def on_bar(self, ctx: BotContext) -> BotDecision:
        decision = super().on_bar(ctx)
        if not self.spot_mode:
            return decision
        filtered: list[OrderIntent] = []
        notes: list[str] = []
        for order in decision.place:
            if order.side == "sell" and ctx.positions.get(order.symbol, Decimal("0")) <= 0:
                notes.append("SPOT_SHORT_BLOCKED")
                continue
            filtered.append(order)
        return BotDecision(place=filtered, logs=decision.logs, risk_notes=notes)


class FundingArbitrageBot(BotRuntime):
    bot_type = "funding_arbitrage"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.spot_symbol = str(params.get("spot_symbol", "BTCUSDT"))
        self.perp_symbol = str(params.get("perp_symbol", "BTCUSDT"))
        self.base_notional = _d(params.get("base_notional", "1000"))
        self.min_funding_rate = _d(params.get("entry_min_funding_rate", "0.0001"))
        self.hedge_ratio = _d(params.get("hedge_ratio", "1"))
        self.allow_reverse = bool(params.get("allow_reverse_carry", False))
        self.opened = False

    def validate(self, spec: BotSpec, coverage: dict[str, Any] | None = None) -> BotValidation:
        errors: list[str] = []
        labels = ["PAPER_ONLY_LIVE", "APPROXIMATE_FILLS"]
        if coverage and not coverage.get("has_funding", False):
            errors.append("FUNDING_COVERAGE_REQUIRED")
        if not self.allow_reverse:
            labels.append("APPROXIMATE_REVERSE_CARRY_BLOCKED")
        return BotValidation(valid=len(errors) == 0, errors=errors, eligibility_labels=labels, risk_class="HIGH")

    def on_bar(self, ctx: BotContext) -> BotDecision:
        if self.opened:
            return BotDecision()
        rate = ctx.funding_rates.get(self.perp_symbol, Decimal("0"))
        if abs(rate) < self.min_funding_rate:
            return BotDecision()

        spot_px = ctx.mark(self.spot_symbol)
        perp_px = ctx.mark(self.perp_symbol)
        spot_qty = (self.base_notional / spot_px) * self.hedge_ratio
        perp_qty = (self.base_notional / perp_px) * self.hedge_ratio

        if rate > 0:
            # positive carry: short perp, long spot
            self.opened = True
            return BotDecision(
                place=[
                    OrderIntent(self.spot_symbol, "buy", spot_qty, "market", tag="arb_spot_long"),
                    OrderIntent(self.perp_symbol, "sell", perp_qty, "market", tag="arb_perp_short"),
                ],
                logs=["positive_carry_opened"],
            )

        if not self.allow_reverse:
            return BotDecision(risk_notes=["REVERSE_CARRY_GATED_APPROXIMATE"])

        self.opened = True
        return BotDecision(
            place=[
                OrderIntent(self.spot_symbol, "sell", spot_qty, "market", tag="arb_spot_short"),
                OrderIntent(self.perp_symbol, "buy", perp_qty, "market", tag="arb_perp_long"),
            ],
            risk_notes=["REVERSE_CARRY_APPROXIMATE"],
        )


class TwapBot(BotRuntime):
    bot_type = "twap"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.symbol = str(params.get("symbol", "BTCUSDT"))
        self.side = str(params.get("side", "buy"))
        self.total_qty = _d(params.get("total_qty", "1"))
        self.slice_count = max(1, int(params.get("slice_count", 10)))
        self._slice_qty = self.total_qty / Decimal(self.slice_count)
        self._sent = 0

    def on_bar(self, ctx: BotContext) -> BotDecision:
        if self._sent >= self.slice_count:
            return BotDecision()
        self._sent += 1
        return BotDecision(
            place=[OrderIntent(self.symbol, self.side, self._slice_qty, "market", tag=f"twap_{self._sent}")],
            logs=[f"slice={self._sent}/{self.slice_count}"],
        )


class VpPovBot(BotRuntime):
    bot_type = "vp_pov"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.symbol = str(params.get("symbol", "BTCUSDT"))
        self.side = str(params.get("side", "buy"))
        self.target_qty = _d(params.get("target_qty", "1"))
        self.participation = _d(params.get("participation_rate_fraction", "0.05"))
        self.max_participation = _d(params.get("max_participation_rate_fraction", "0.10"))
        self.min_slice = _d(params.get("min_slice_qty", "0.001"))
        self.max_slice = _d(params.get("max_slice_qty", "1"))
        self.anti_spike_z = _d(((params.get("anti_spike_pause") or {}).get("volume_zscore_above", "999")))
        self.executed = Decimal("0")

    def on_bar(self, ctx: BotContext) -> BotDecision:
        remaining = self.target_qty - self.executed
        if remaining <= 0:
            return BotDecision()

        prior_vol = ctx.prior_bar_volume.get(self.symbol, Decimal("0"))
        if prior_vol <= 0:
            return BotDecision(risk_notes=["VP_MISSING_PRIOR_VOLUME"])

        current_vol = ctx.prices.get(f"__volume__:{self.symbol}", prior_vol)
        if prior_vol > 0 and self.anti_spike_z < Decimal("999"):
            ratio = current_vol / prior_vol
            if ratio >= self.anti_spike_z:
                return BotDecision(logs=["anti_spike_pause"])

        target_child = prior_vol * self.participation
        max_allowed = prior_vol * self.max_participation
        child = min(target_child, max_allowed)
        child = _clamp(child, self.min_slice, self.max_slice)
        child = min(child, remaining)
        if child <= 0:
            return BotDecision()
        self.executed += child
        return BotDecision(place=[OrderIntent(self.symbol, self.side, child, "market", tag="vp_child")])


class ChaseLimitBot(BotRuntime):
    bot_type = "chase_limit"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.symbol = str(params.get("symbol", "BTCUSDT"))
        self.side = str(params.get("side", "buy"))
        self.qty = _d(params.get("qty", "1"))
        self.offset_bps = _d(params.get("offset_bps", "0"))
        self.max_chase_distance_bps = _d(params.get("max_chase_distance_bps", "30"))
        self.timeout_bars = int(params.get("timeout_bars", 10))
        self.fallback_policy = str(params.get("fallback_policy", "cancel"))
        self._start_ref = Decimal("0")
        self._bar = 0

    def _price(self, ref: Decimal) -> Decimal:
        offset = ref * (self.offset_bps / Decimal(10000))
        return ref - offset if self.side == "buy" else ref + offset

    def on_start(self, ctx: BotContext) -> BotDecision:
        ref = ctx.mark(self.symbol)
        self._start_ref = ref
        self._bar = 0
        return BotDecision(place=[OrderIntent(self.symbol, self.side, self.qty, "limit", limit_price=self._price(ref), post_only=True, tag="chase")])

    def on_bar(self, ctx: BotContext) -> BotDecision:
        self._bar += 1
        if self._bar >= self.timeout_bars:
            if self.fallback_policy == "market":
                return BotDecision(cancel_all=True, place=[OrderIntent(self.symbol, self.side, self.qty, "market", tag="chase_timeout_market")])
            return BotDecision(cancel_all=True, logs=["chase_timeout_cancel"])

        ref = ctx.mark(self.symbol)
        max_dist = self._start_ref * (self.max_chase_distance_bps / Decimal(10000))
        if self.side == "buy":
            ref = min(ref, self._start_ref + max_dist)
        else:
            ref = max(ref, self._start_ref - max_dist)
        return BotDecision(cancel_all=True, place=[OrderIntent(self.symbol, self.side, self.qty, "limit", limit_price=self._price(ref), post_only=True, tag="chase")])


class IcebergBot(BotRuntime):
    bot_type = "iceberg"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.symbol = str(params.get("symbol", "BTCUSDT"))
        self.side = str(params.get("side", "buy"))
        self.total_qty = _d(params.get("total_qty", "1"))
        self.visible_qty = _d(params.get("visible_qty", "0.1"))
        self.price_limit = _d(params.get("price_limit", "0"))
        self.executed = Decimal("0")

    def _next_qty(self) -> Decimal:
        remaining = self.total_qty - self.executed
        return min(self.visible_qty, remaining)

    def _order(self) -> OrderIntent | None:
        qty = self._next_qty()
        if qty <= 0:
            return None
        if self.price_limit > 0:
            return OrderIntent(self.symbol, self.side, qty, "limit", limit_price=self.price_limit, tag="iceberg_child")
        return OrderIntent(self.symbol, self.side, qty, "market", tag="iceberg_child")

    def on_start(self, ctx: BotContext) -> BotDecision:
        order = self._order()
        return BotDecision(place=[order] if order else [])

    def on_fill(self, fill: dict[str, Any], ctx: BotContext) -> BotDecision:
        self.executed += _d(fill.get("qty", "0"))
        order = self._order()
        return BotDecision(place=[order] if order else [])


class ScaledOrderBot(BotRuntime):
    bot_type = "scaled_order"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.symbol = str(params.get("symbol", "BTCUSDT"))
        self.side = str(params.get("side", "buy"))
        self.total_qty = _d(params.get("total_qty", "1"))
        self.lower = _d(params.get("lower_price", "90000"))
        self.upper = _d(params.get("upper_price", "110000"))
        self.order_count = max(1, int(params.get("order_count", 5)))
        self.distribution = str(params.get("distribution", "equal"))

    def _weights(self) -> list[Decimal]:
        if self.distribution == "increasing":
            arr = [Decimal(i + 1) for i in range(self.order_count)]
        elif self.distribution == "decreasing":
            arr = [Decimal(self.order_count - i) for i in range(self.order_count)]
        else:
            arr = [Decimal(1) for _ in range(self.order_count)]
        s = sum(arr, Decimal("0"))
        return [x / s for x in arr]

    def on_start(self, ctx: BotContext) -> BotDecision:
        step = (self.upper - self.lower) / Decimal(max(1, self.order_count - 1))
        weights = self._weights()
        orders: list[OrderIntent] = []
        for i in range(self.order_count):
            price = self.lower + step * Decimal(i)
            qty = self.total_qty * weights[i]
            orders.append(OrderIntent(self.symbol, self.side, qty, "limit", limit_price=price, post_only=True, tag=f"scaled_{i}"))
        return BotDecision(place=orders)


class PositionSnowballBot(BotRuntime):
    bot_type = "position_snowball"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.symbol = str(params.get("symbol", "BTCUSDT"))
        self.direction = str(params.get("direction", "long"))
        self.initial_margin = _d(params.get("initial_margin", "100"))
        self.add_trigger_roi = _d(params.get("add_trigger_roi_fraction", "0.02"))
        self.reinvest_fraction = _d(params.get("profit_reinvestment_fraction", "0.5"))
        self.max_adds = int(params.get("max_adds", 5))
        self.cooldown_bars = int(params.get("cooldown_bars_between_adds", 1))
        self.liq_floor = _d(params.get("liquidation_distance_floor_fraction", "0.03"))
        self.take_profit_roi = _d(params.get("take_profit_roi_fraction", "0.10"))
        self.stop_loss_roi = _d(params.get("stop_loss_roi_fraction", "0.03"))

        self._opened = False
        self._qty = Decimal("0")
        self._avg_entry = Decimal("0")
        self._adds = 0
        self._bar = 0
        self._last_add_bar = -999999

    def _entry_side(self) -> str:
        return "buy" if self.direction == "long" else "sell"

    def _exit_side(self) -> str:
        return "sell" if self.direction == "long" else "buy"

    def _roi(self, mark: Decimal) -> Decimal:
        if self._avg_entry <= 0:
            return Decimal("0")
        if self.direction == "long":
            return (mark - self._avg_entry) / self._avg_entry
        return (self._avg_entry - mark) / self._avg_entry

    def _liquidation_distance(self, mark: Decimal) -> Decimal:
        # Proxy distance: based on mark-vs-average distance as a conservative floor.
        if mark <= 0:
            return Decimal("0")
        return abs(mark - self._avg_entry) / mark

    def on_bar(self, ctx: BotContext) -> BotDecision:
        self._bar += 1
        mark = ctx.mark(self.symbol)

        if not self._opened:
            qty = self.initial_margin / mark
            self._opened = True
            self._qty = qty
            self._avg_entry = mark
            return BotDecision(place=[OrderIntent(self.symbol, self._entry_side(), qty, "market", tag="snowball_open")])

        roi = self._roi(mark)
        if roi <= -self.stop_loss_roi:
            return BotDecision(place=[OrderIntent(self.symbol, self._exit_side(), self._qty, "market", reduce_only=True, tag="snowball_sl")])
        if roi >= self.take_profit_roi:
            return BotDecision(place=[OrderIntent(self.symbol, self._exit_side(), self._qty, "market", reduce_only=True, tag="snowball_tp")])

        if self._adds >= self.max_adds:
            return BotDecision()
        if (self._bar - self._last_add_bar) < self.cooldown_bars:
            return BotDecision()
        if roi < self.add_trigger_roi:
            return BotDecision()

        projected_add_qty = max(self._qty * self.reinvest_fraction, Decimal("0"))
        projected_total_qty = self._qty + projected_add_qty
        projected_avg = ((self._avg_entry * self._qty) + (mark * projected_add_qty)) / projected_total_qty
        projected_distance = abs(mark - projected_avg) / mark if mark > 0 else Decimal("0")
        if projected_distance < self.liq_floor:
            return BotDecision(risk_notes=["RISK_REJECTION:LIQUIDATION_FLOOR_BREACH"])

        self._qty = projected_total_qty
        self._avg_entry = projected_avg
        self._adds += 1
        self._last_add_bar = self._bar
        return BotDecision(place=[OrderIntent(self.symbol, self._entry_side(), projected_add_qty, "market", tag=f"snowball_add_{self._adds}")])


@dataclass
class _AllocLeg:
    symbol: str
    asset_class: str            # 'crypto' | 'equity'
    side: str                   # 'long' | 'short' (equity forced long)
    target_weight: Decimal      # static target (gross fraction)
    leverage: Decimal
    sleeve: str                 # 'risk_on' | 'risk_off' (regime_switch mode)


class CrossAssetAllocatorBot(BotRuntime):
    """Unified crypto + tokenized-equity (xStocks) allocator.

    One USDT-denominated book that holds and rotates between crypto and tokenized
    US equities, rebalancing 24/7 — including weekends/overnight when TradFi is shut.

    Signal modes:
      * ``static``        — fixed target weights (classic rebalancer).
      * ``momentum``      — hold the top-N assets by trailing return, equal weight.
      * ``regime_switch`` — risk-on => allocate the crypto sleeve; risk-off => the
        equity/defensive sleeve, decided by the crypto sleeve's trailing momentum.

    Constraints enforced for the equity (xStock) sleeve, mirroring Bybit Spot:
      * long-only (no shorting), leverage = 1 (no margin),
      * optional pause of equity orders outside US Regular Trading Hours,
      * 300k USDT/token position-cap awareness.
    """

    bot_type = "cross_asset_allocator"

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.mode = str(params.get("mode", "static"))
        self.total_investment = _d(params.get("total_investment", "100000"))
        rb = params.get("rebalance") or {}
        self.threshold_fraction = _d(rb.get("threshold_fraction", "0.05"))
        self.lookback_bars = int(params.get("lookback_bars", 20))
        self.top_n = int(params.get("top_n", 3))
        self.pause_equity_off_hours = bool(params.get("pause_equity_off_hours", False))
        self.legs: list[_AllocLeg] = []
        for row in params.get("symbols", []):
            symbol = str(row["symbol"])
            ac = str(row.get("asset_class") or asset_class_of(symbol))
            side = str(row.get("side", "long"))
            lev = _d(row.get("leverage", "1"))
            if ac == "equity":
                side = "long"          # spot xStocks cannot be shorted
                lev = Decimal("1")     # nor margined
            self.legs.append(
                _AllocLeg(
                    symbol=symbol,
                    asset_class=ac,
                    side=side,
                    target_weight=_d(row.get("target_weight_fraction", "0")),
                    leverage=lev,
                    sleeve=str(row.get("sleeve") or ("risk_off" if ac == "equity" else "risk_on")),
                )
            )
        self._history: dict[str, list[Decimal]] = {leg.symbol: [] for leg in self.legs}
        self._started = False

    # ---- validation ----
    def validate(self, spec: BotSpec, coverage: dict[str, Any] | None = None) -> BotValidation:
        errors: list[str] = []
        warnings: list[str] = []
        labels: list[str] = []
        if not self.legs:
            errors.append("LEGS_REQUIRED")
        for leg in self.legs:
            if leg.asset_class == "equity":
                if str((next((r for r in self.params.get("symbols", []) if str(r.get("symbol")) == leg.symbol), {})).get("side", "long")) == "short":
                    errors.append(f"XSTOCK_SHORT_NOT_ALLOWED:{leg.symbol}")
                if _d((next((r for r in self.params.get("symbols", []) if str(r.get("symbol")) == leg.symbol), {})).get("leverage", "1")) > 1:
                    errors.append(f"XSTOCK_LEVERAGE_NOT_ALLOWED:{leg.symbol}")
        has_equity = any(leg.asset_class == "equity" for leg in self.legs)
        if has_equity:
            labels.append("XSTOCK_SPOT_24_7")
            warnings.append("XSTOCK_REGION_GATED_LIVE: EEA/AU/JP blocked for live Bybit deployment")
            warnings.append("XSTOCK_SHORT_HISTORY: tokenized-equity history begins mid-2025")
        if self.mode == "static":
            gross = sum((abs(leg.target_weight) for leg in self.legs), Decimal(0))
            if abs(gross - Decimal(1)) > Decimal("0.0001"):
                errors.append("GROSS_WEIGHT_SUM_INVALID")
        if self.mode not in {"static", "momentum", "regime_switch"}:
            errors.append(f"UNKNOWN_MODE:{self.mode}")
        return BotValidation(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
            eligibility_labels=labels or ["HISTORICAL_FACTOR_OK"],
            risk_class="MODERATE",
        )

    # ---- signal -> target weights ----
    def _trailing_return(self, symbol: str) -> Decimal | None:
        h = self._history.get(symbol, [])
        if len(h) <= self.lookback_bars or h[-1 - self.lookback_bars] <= 0:
            return None
        return h[-1] / h[-1 - self.lookback_bars] - Decimal("1")

    def _target_weights(self, ctx: BotContext) -> dict[str, Decimal]:
        if self.mode == "static":
            gross = sum((abs(leg.target_weight) for leg in self.legs), Decimal(0)) or Decimal("1")
            return {leg.symbol: abs(leg.target_weight) / gross for leg in self.legs}

        if self.mode == "momentum":
            rets = {leg.symbol: self._trailing_return(leg.symbol) for leg in self.legs}
            ranked = sorted(
                [(s, r) for s, r in rets.items() if r is not None and r > 0],
                key=lambda kv: kv[1], reverse=True,
            )
            chosen = [s for s, _ in ranked[: self.top_n]]
            if not chosen:  # warm-up or all-negative: equal weight everything
                chosen = [leg.symbol for leg in self.legs]
            w = Decimal("1") / Decimal(len(chosen))
            return {leg.symbol: (w if leg.symbol in chosen else Decimal("0")) for leg in self.legs}

        # regime_switch: pick the sleeve by crypto-sleeve trailing momentum.
        crypto = [leg for leg in self.legs if leg.sleeve == "risk_on"]
        crypto_rets = [self._trailing_return(leg.symbol) for leg in crypto]
        crypto_rets = [r for r in crypto_rets if r is not None]
        risk_on = (sum(crypto_rets) / len(crypto_rets)) > 0 if crypto_rets else True
        sleeve = "risk_on" if risk_on else "risk_off"
        members = [leg for leg in self.legs if leg.sleeve == sleeve] or self.legs
        w = Decimal("1") / Decimal(len(members))
        chosen = {leg.symbol for leg in members}
        return {leg.symbol: (w if leg.symbol in chosen else Decimal("0")) for leg in self.legs}

    # ---- lifecycle ----
    def _record_history(self, ctx: BotContext) -> None:
        for leg in self.legs:
            try:
                self._history[leg.symbol].append(ctx.mark(leg.symbol))
            except KeyError:
                pass

    def _rebalance_to(self, ctx: BotContext, targets: dict[str, Decimal], tag: str) -> BotDecision:
        # Current gross notional across legs.
        current: dict[str, Decimal] = {}
        gross = Decimal("0")
        for leg in self.legs:
            try:
                price = ctx.mark(leg.symbol)
            except KeyError:
                continue
            notional = abs(ctx.positions.get(leg.symbol, Decimal("0"))) * price
            current[leg.symbol] = notional
            gross += notional
        budget = gross if gross > 0 else self.total_investment

        orders: list[OrderIntent] = []
        notes: list[str] = []
        max_dev = Decimal("0")
        for leg in self.legs:
            try:
                price = ctx.mark(leg.symbol)
            except KeyError:
                continue
            tgt_w = targets.get(leg.symbol, Decimal("0"))
            cur_w = (current.get(leg.symbol, Decimal("0")) / budget) if budget > 0 else Decimal("0")
            max_dev = max(max_dev, abs(cur_w - tgt_w))
            target_notional = budget * tgt_w * (leg.leverage if leg.asset_class != "equity" else Decimal("1"))
            delta_notional = target_notional - current.get(leg.symbol, Decimal("0"))
            if price <= 0 or delta_notional == 0:
                continue
            qty = abs(delta_notional) / price
            if delta_notional > 0:
                side = "buy" if leg.side == "long" else "sell"
            else:
                side = "sell" if leg.side == "long" else "buy"

            # Equity sleeve constraints.
            if leg.asset_class == "equity":
                # never go net short via a sell beyond current long inventory
                if side == "sell" and ctx.positions.get(leg.symbol, Decimal("0")) <= 0:
                    notes.append(f"XSTOCK_SHORT_BLOCKED:{leg.symbol}")
                    continue
                if self.pause_equity_off_hours and not is_regular_trading_hours(ctx.ts):
                    notes.append(f"XSTOCK_SKIPPED_OFF_HOURS:{leg.symbol}")
                    continue
                if position_cap_breached(target_notional):
                    notes.append(f"XSTOCK_POSITION_CAP_WARN:{leg.symbol}")
            orders.append(OrderIntent(leg.symbol, side, qty, "market", tag=f"{tag}_{leg.symbol}"))
        return BotDecision(place=orders, risk_notes=notes, logs=[f"{tag} max_dev={max_dev} mode={self.mode}"])

    def on_start(self, ctx: BotContext) -> BotDecision:
        self._record_history(ctx)
        self._started = True
        return self._rebalance_to(ctx, self._target_weights(ctx), "alloc_open")

    def on_bar(self, ctx: BotContext) -> BotDecision:
        self._record_history(ctx)
        targets = self._target_weights(ctx)
        # Only act when some leg drifts beyond threshold (static) or signal shifts
        # (momentum/regime always re-evaluates against threshold drift).
        current: dict[str, Decimal] = {}
        gross = Decimal("0")
        for leg in self.legs:
            try:
                price = ctx.mark(leg.symbol)
            except KeyError:
                continue
            notional = abs(ctx.positions.get(leg.symbol, Decimal("0"))) * price
            current[leg.symbol] = notional
            gross += notional
        if gross <= 0:
            return BotDecision()
        max_dev = Decimal("0")
        for leg in self.legs:
            cur_w = current.get(leg.symbol, Decimal("0")) / gross
            max_dev = max(max_dev, abs(cur_w - targets.get(leg.symbol, Decimal("0"))))
        if max_dev < self.threshold_fraction:
            return BotDecision()
        return self._rebalance_to(ctx, targets, "alloc_rebalance")
