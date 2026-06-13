"""Pure Market Maker — Hummingbot's flagship strategy.

Maintains bid + ask quotes around a reference price with an inventory skew
that pushes quotes asymmetrically to mean-revert position size to zero.

Params:
- bid_spread_bps: bps below mid for the bid
- ask_spread_bps: bps above mid for the ask
- order_qty: order size per side
- inventory_target: target net position (signed qty)
- inventory_skew_bps_per_unit: extra bps shift per unit of inventory deviation
- max_inventory_qty: hard cap; quotes pulled past this
- refresh_each_bar: cancel + re-quote each bar
"""
from __future__ import annotations

from decimal import Decimal

from .base import Strategy, StrategyContext, StrategyDecision


class PureMarketMaker(Strategy):
    name = "pmm"

    def on_bar(self, ctx: StrategyContext) -> StrategyDecision:
        p = self.params
        mid = ctx.bar_close
        bid_bps = Decimal(str(p.get("bid_spread_bps", 5)))
        ask_bps = Decimal(str(p.get("ask_spread_bps", 5)))
        qty = Decimal(str(p.get("order_qty", "0.01")))
        inv_target = Decimal(str(p.get("inventory_target", 0)))
        skew_per_unit = Decimal(str(p.get("inventory_skew_bps_per_unit", 50)))
        max_inv = Decimal(str(p.get("max_inventory_qty", "1.0")))
        refresh = bool(p.get("refresh_each_bar", True))

        signed_inv = ctx.position_qty if ctx.position_side == "long" else (-ctx.position_qty if ctx.position_side == "short" else Decimal(0))
        inv_dev = signed_inv - inv_target
        skew_bps = skew_per_unit * inv_dev  # positive deviation -> push quotes lower

        bid_offset = (bid_bps + skew_bps) / Decimal(10000)
        ask_offset = (ask_bps - skew_bps) / Decimal(10000)
        bid_price = mid * (Decimal(1) - bid_offset)
        ask_price = mid * (Decimal(1) + ask_offset)

        place = []
        if signed_inv < max_inv:
            place.append(self.limit(ctx.symbol, "buy", qty, bid_price, post_only=True, tag="pmm_bid"))
        if signed_inv > -max_inv:
            place.append(self.limit(ctx.symbol, "sell", qty, ask_price, post_only=True, tag="pmm_ask"))

        return StrategyDecision(place=place, cancel_all=refresh)
