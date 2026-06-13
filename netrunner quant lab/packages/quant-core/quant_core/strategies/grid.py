"""Static grid trader. Marked APPROXIMATE_FILLS by the validator; OHLC backtest
results are unverifiable per spec, but legal for paper.
"""
from __future__ import annotations

from decimal import Decimal

from .base import Strategy, StrategyContext, StrategyDecision


class GridTrader(Strategy):
    name = "grid"

    def __init__(self, params=None):
        super().__init__(params)
        p = self.params
        self._anchor: Decimal | None = None
        self._spacing_bps = Decimal(str(p.get("spacing_bps", 30)))
        self._num_levels = int(p.get("num_levels", 5))
        self._qty_per = Decimal(str(p.get("qty_per_level", "0.01")))
        self._refresh = bool(p.get("refresh_each_bar", False))

    def on_bar(self, ctx: StrategyContext) -> StrategyDecision:
        if self._anchor is None:
            self._anchor = ctx.bar_close
        place = []
        spacing = self._spacing_bps / Decimal(10000)
        for i in range(1, self._num_levels + 1):
            bid = self._anchor * (Decimal(1) - spacing * Decimal(i))
            ask = self._anchor * (Decimal(1) + spacing * Decimal(i))
            place.append(self.limit(ctx.symbol, "buy", self._qty_per, bid, post_only=True, tag=f"grid_b{i}"))
            place.append(self.limit(ctx.symbol, "sell", self._qty_per, ask, post_only=True, tag=f"grid_a{i}"))
        return StrategyDecision(place=place, cancel_all=self._refresh)
