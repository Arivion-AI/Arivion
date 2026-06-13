"""EMA-cross trend follower with trailing stop."""
from __future__ import annotations

from decimal import Decimal

from ..indicators import EMA, ATR
from .base import Strategy, StrategyContext, StrategyDecision


class TrendEmaCross(Strategy):
    name = "trend_ema_cross"

    def __init__(self, params=None):
        super().__init__(params)
        p = self.params
        self._fast = EMA(int(p.get("ema_fast", 20)))
        self._slow = EMA(int(p.get("ema_slow", 50)))
        self._atr = ATR(int(p.get("atr_len", 14)))
        self._qty = Decimal(str(p.get("order_qty", "0.1")))
        self._trail_atr_mult = Decimal(str(p.get("trail_atr_mult", "3.0")))
        self._last_signal: str | None = None

    def on_bar(self, ctx: StrategyContext) -> StrategyDecision:
        f = self._fast.update(ctx.bar_close)
        s = self._slow.update(ctx.bar_close)
        a = self._atr.update(ctx.bar_high, ctx.bar_low, ctx.bar_close)
        if f is None or s is None or a is None:
            return StrategyDecision()

        cross_up = f > s and (self._last_signal != "long")
        cross_down = f < s and (self._last_signal != "short")

        place = []
        if cross_up:
            self._last_signal = "long"
            if ctx.position_side == "short" and ctx.position_qty > 0:
                place.append(self.buy_market(ctx.symbol, ctx.position_qty, tag="close_short"))
            if ctx.position_side != "long":
                place.append(self.buy_market(ctx.symbol, self._qty, tag="trend_long"))
                place.append(self.trailing_stop(ctx.symbol, "sell", self._qty, a * self._trail_atr_mult, reduce_only=True, tag="trail"))
        elif cross_down:
            self._last_signal = "short"
            if ctx.position_side == "long" and ctx.position_qty > 0:
                place.append(self.sell_market(ctx.symbol, ctx.position_qty, tag="close_long"))
            if ctx.position_side != "short":
                place.append(self.sell_market(ctx.symbol, self._qty, tag="trend_short"))
                place.append(self.trailing_stop(ctx.symbol, "buy", self._qty, a * self._trail_atr_mult, reduce_only=True, tag="trail"))
        return StrategyDecision(place=place)
