"""Funding mean reversion — matches the §6.1 flagship spec example.

Fades crowded funding when slow trend agrees. Uses ATR-based exits.
Params: funding_z_threshold, ema_slow_len, atr_len, stop_atr_mult, tp_atr_mult,
        order_qty, max_holding_bars
"""
from __future__ import annotations

from decimal import Decimal

from ..indicators import EMA, ATR, ZScore
from .base import Strategy, StrategyContext, StrategyDecision


class FundingFade(Strategy):
    name = "funding_fade"

    def __init__(self, params=None):
        super().__init__(params)
        p = self.params
        self._ema_slow = EMA(int(p.get("ema_slow_len", 80)))
        self._atr = ATR(int(p.get("atr_len", 14)))
        self._funding_z = ZScore(int(p.get("funding_z_lookback", 30)))
        self._z_thresh = Decimal(str(p.get("funding_z_threshold", "1.75")))
        self._stop_mult = Decimal(str(p.get("stop_atr_mult", "1.8")))
        self._tp_mult = Decimal(str(p.get("tp_atr_mult", "2.4")))
        self._qty = Decimal(str(p.get("order_qty", "0.1")))
        self._max_hold = int(p.get("max_holding_bars", 96))
        self._bars_held = 0

    def on_bar(self, ctx: StrategyContext) -> StrategyDecision:
        ema = self._ema_slow.update(ctx.bar_close)
        atr = self._atr.update(ctx.bar_high, ctx.bar_low, ctx.bar_close)
        z = self._funding_z.update(ctx.funding_rate_last) if ctx.funding_rate_last is not None else None
        if ema is None or atr is None:
            return StrategyDecision()

        if ctx.position_side != "flat":
            self._bars_held += 1
            if self._bars_held >= self._max_hold:
                close_side = "sell" if ctx.position_side == "long" else "buy"
                self._bars_held = 0
                return StrategyDecision(
                    place=[self.sell_market(ctx.symbol, ctx.position_qty, tag="hold_timeout") if close_side == "sell" else self.buy_market(ctx.symbol, ctx.position_qty, tag="hold_timeout")],
                    log=["max_holding hit"],
                )
            return StrategyDecision()

        if z is None:
            return StrategyDecision()

        # Long fade: funding deeply negative + slow uptrend
        if z < -self._z_thresh and ctx.bar_close > ema:
            entry = ctx.bar_close
            sl = entry - atr * self._stop_mult
            tp = entry + atr * self._tp_mult
            self._bars_held = 0
            return StrategyDecision(place=[
                self.buy_market(ctx.symbol, self._qty, tag="ff_long"),
                self.stop_market(ctx.symbol, "sell", self._qty, sl, reduce_only=True, tag="ff_sl"),
                self.limit(ctx.symbol, "sell", self._qty, tp, post_only=False, tag="ff_tp"),
            ])

        if z > self._z_thresh and ctx.bar_close < ema:
            entry = ctx.bar_close
            sl = entry + atr * self._stop_mult
            tp = entry - atr * self._tp_mult
            self._bars_held = 0
            return StrategyDecision(place=[
                self.sell_market(ctx.symbol, self._qty, tag="ff_short"),
                self.stop_market(ctx.symbol, "buy", self._qty, sl, reduce_only=True, tag="ff_sl"),
                self.limit(ctx.symbol, "buy", self._qty, tp, post_only=False, tag="ff_tp"),
            ])

        return StrategyDecision()
