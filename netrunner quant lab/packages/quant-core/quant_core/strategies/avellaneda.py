"""Avellaneda-Stoikov optimal market maker.

Reservation price: r = s - q × γ × σ² × (T-t)
Spread: δ = γ × σ² × (T-t) + (2/γ) × ln(1 + γ/k)

Params:
- gamma: risk aversion (>0)
- sigma_lookback: bars to estimate σ
- k: order-arrival intensity proxy (book depth)
- order_qty
- horizon_bars: T-t in bars (default 100, declining is approximated as constant for paper)
"""
from __future__ import annotations

import math
from collections import deque
from decimal import Decimal

from .base import Strategy, StrategyContext, StrategyDecision


class AvellanedaStoikov(Strategy):
    name = "avellaneda_stoikov"

    def __init__(self, params=None):
        super().__init__(params)
        self._prices: deque[Decimal] = deque(maxlen=int(self.params.get("sigma_lookback", 50)))

    @staticmethod
    def _spread_for_gamma(gamma: float, sigma2: float, T: float, k: float) -> float:
        gamma = max(gamma, 1e-12)
        return gamma * sigma2 * T + (2.0 / gamma) * math.log(1.0 + gamma / max(k, 1e-12))

    def _effective_gamma(self, *, p: dict, sigma2: float, T: float, mid: float) -> float:
        mode = str(p.get("gamma_mode", "manual")).lower()
        manual_gamma = max(float(p.get("gamma", 0.1)), 1e-9)
        if mode not in {"auto", "auto_calibrated", "auto-calibrated"}:
            return manual_gamma

        target_bps = max(float(p.get("target_spread_bps", 10.0)), 0.1)
        target_spread = mid * target_bps / 10000.0
        lo, hi = 1e-9, 100.0
        for _ in range(80):
            m = (lo + hi) / 2.0
            s = self._spread_for_gamma(m, sigma2, T, max(float(p.get("k", 1.5)), 1e-12))
            if s > target_spread:
                hi = m
            else:
                lo = m
        return max(1e-9, min(100.0, (lo + hi) / 2.0))

    def on_bar(self, ctx: StrategyContext) -> StrategyDecision:
        p = self.params
        k = float(p.get("k", 1.5))
        T = float(p.get("horizon_bars", 100))
        qty = Decimal(str(p.get("order_qty", "0.01")))

        self._prices.append(ctx.bar_close)
        if len(self._prices) < 5:
            return StrategyDecision()

        # Standard Avellaneda-Stoikov uses LOG-RETURN variance, not raw price-level variance.
        # Using price-level variance produces nonsensical multi-million-dollar spreads on
        # high-priced assets (BTC at $65k → σ²≈1e7 → spread blows out by 7 orders of magnitude).
        floats = [float(x) for x in self._prices]
        rets = [math.log(floats[i] / floats[i - 1]) for i in range(1, len(floats)) if floats[i - 1] > 0]
        if not rets:
            return StrategyDecision()
        mean_r = sum(rets) / len(rets)
        sigma2_ret = sum((r - mean_r) ** 2 for r in rets) / max(1, len(rets) - 1)

        signed_inv = ctx.position_qty if ctx.position_side == "long" else (-ctx.position_qty if ctx.position_side == "short" else Decimal(0))
        q = float(signed_inv)
        s = float(ctx.bar_close)

        # Convert returns-variance into price-space:  σ²_price ≈ s² × σ²_ret.
        sigma2 = s * s * sigma2_ret

        gamma_eff = self._effective_gamma(p=p, sigma2=sigma2, T=T, mid=s)
        r = s - q * gamma_eff * sigma2 * T
        spread = self._spread_for_gamma(gamma_eff, sigma2, T, k)
        bid = Decimal(str(max(0.0, r - spread / 2.0)))
        ask = Decimal(str(r + spread / 2.0))

        place = [
            self.limit(ctx.symbol, "buy", qty, bid, post_only=True, tag="as_bid"),
            self.limit(ctx.symbol, "sell", qty, ask, post_only=True, tag="as_ask"),
        ]
        return StrategyDecision(
            place=place,
            cancel_all=True,
            log=[f"r={r:.2f} spread={spread:.4f} q={q} gamma_eff={gamma_eff:.8f}"],
        )
