"""TWAP executor — chops a target qty into N equal slices over a bar horizon."""
from __future__ import annotations

from decimal import Decimal

from .base import Strategy, StrategyContext, StrategyDecision


class TwapExecutor(Strategy):
    name = "twap"

    def __init__(self, params=None):
        super().__init__(params)
        p = self.params
        self._total_qty = Decimal(str(p.get("total_qty", "1.0")))
        self._side = p.get("side", "buy")
        self._n_slices = int(p.get("n_slices", 10))
        self._slice_qty = self._total_qty / Decimal(self._n_slices)
        self._executed = 0

    def on_bar(self, ctx: StrategyContext) -> StrategyDecision:
        if self._executed >= self._n_slices:
            return StrategyDecision()
        self._executed += 1
        order = self.buy_market(ctx.symbol, self._slice_qty, tag=f"twap_{self._executed}") if self._side == "buy" else self.sell_market(ctx.symbol, self._slice_qty, tag=f"twap_{self._executed}")
        return StrategyDecision(place=[order], log=[f"TWAP slice {self._executed}/{self._n_slices}"])
