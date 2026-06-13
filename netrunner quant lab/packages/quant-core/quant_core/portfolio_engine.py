"""Multi-asset / multi-token portfolio backtest engine.

Runs a basket of legs (crypto tokens and/or tokenized equities) as ONE book with a
combined cash/equity ledger and shared risk gates — the research-correct model for
multi-asset portfolios (target-weight rebalancing, inverse-vol / risk-parity,
momentum rotation) and the execution model that maps to Bybit's Unified Trading
Account (one account, per-leg ``category`` routing, batch order placement).

Live-execution mapping (once the execution-adapter exists):
  * crypto spot / xStocks  -> category="spot"
  * crypto perps           -> category="linear" (leverage / short allowed)
  * one UTA, cross-margin, ``POST /v5/order/create-batch`` per rebalance.

Venue rules enforced here so a backtested portfolio is always live-feasible:
  * equity (xStock) legs: spot only, long-only, leverage = 1, RTH-aware fills
  * crypto perp legs: leverage / short permitted

Fill model reuses §10: market fills at the *next* bar open + one-way slippage,
xStock fills outside US RTH widened via ``xstocks.effective_slippage_bps``.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from .orders import Bar
from .portfolio import Portfolio, RiskConfig
from .xstocks import asset_class_of, effective_slippage_bps, is_regular_trading_hours, is_xstock

WEIGHTING_SCHEMES = ("fixed", "equal", "inverse_vol", "risk_parity", "momentum")


@dataclass
class PortfolioLeg:
    symbol: str
    bars: list[Bar]
    asset_class: str = "crypto"          # 'crypto' | 'equity'
    category: str = "linear"             # 'linear' (perp) | 'spot'
    target_weight: Decimal = Decimal("0")
    leverage: Decimal = Decimal("1")
    allow_short: bool = False

    def normalized(self) -> "PortfolioLeg":
        ac = self.asset_class or asset_class_of(self.symbol)
        if is_xstock(self.symbol) or ac == "equity":
            ac = "equity"
        if ac == "equity":
            return PortfolioLeg(self.symbol, self.bars, "equity", "spot",
                                self.target_weight, Decimal("1"), False)
        return PortfolioLeg(self.symbol, self.bars, "crypto",
                            self.category if self.category in ("spot", "linear") else "linear",
                            self.target_weight, self.leverage, self.allow_short)


@dataclass
class PortfolioRunResult:
    final_equity: Decimal
    equity_curve: list[Decimal]
    timestamps: list[int]
    fills: list[dict]
    positions: dict
    weights_history: list[dict]
    rebalances: int
    metrics: dict
    risk_state: dict
    risk_notes: list[str]
    errors: list[str] = field(default_factory=list)


def validate_legs(legs: list[PortfolioLeg]) -> list[str]:
    errors: list[str] = []
    if not legs:
        errors.append("LEGS_REQUIRED")
    for leg in legs:
        ac = leg.asset_class or asset_class_of(leg.symbol)
        if (ac == "equity" or is_xstock(leg.symbol)):
            if leg.category not in ("spot",):
                errors.append(f"XSTOCK_SPOT_ONLY:{leg.symbol}")
            if leg.leverage and Decimal(str(leg.leverage)) > 1:
                errors.append(f"XSTOCK_LEVERAGE_NOT_ALLOWED:{leg.symbol}")
            if leg.allow_short:
                errors.append(f"XSTOCK_SHORT_NOT_ALLOWED:{leg.symbol}")
    return errors


def _union_timeline(legs: list[PortfolioLeg]) -> list[int]:
    """UNION of all leg timestamps (not intersection). A 24/7 crypto leg keeps every
    bar; a closed (RTH-only) equity leg is forward-filled and only trades during RTH —
    so the crypto leg's overnight/weekend bars and risk are preserved."""
    out: set[int] = set()
    for leg in legs:
        out |= {int(b.ts.timestamp() * 1000) for b in leg.bars}
    return sorted(out)


def _returns_vol(closes: list[float]) -> float:
    if len(closes) < 3:
        return 0.0
    rets = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes)) if closes[i - 1] > 0]
    if not rets:
        return 0.0
    m = sum(rets) / len(rets)
    var = sum((r - m) ** 2 for r in rets) / max(1, len(rets) - 1)
    return math.sqrt(var)


def _target_weights(scheme: str, legs: list[PortfolioLeg], hist: dict[str, list[float]],
                    lookback: int, top_n: int) -> dict[str, Decimal]:
    syms = [l.symbol for l in legs]
    if scheme == "fixed":
        gross = sum((abs(l.target_weight) for l in legs), Decimal(0)) or Decimal("1")
        return {l.symbol: abs(l.target_weight) / gross for l in legs}
    if scheme == "equal":
        w = Decimal("1") / Decimal(len(legs))
        return {s: w for s in syms}
    if scheme in ("inverse_vol", "risk_parity"):
        vols = {s: _returns_vol(hist[s][-lookback:]) for s in syms}
        inv = {s: (1.0 / v if v > 1e-9 else 0.0) for s, v in vols.items()}
        tot = sum(inv.values())
        if tot <= 0:
            w = Decimal("1") / Decimal(len(legs))
            return {s: w for s in syms}
        return {s: Decimal(str(inv[s] / tot)) for s in syms}
    if scheme == "momentum":
        rets = {}
        for s in syms:
            h = hist[s]
            if len(h) > lookback and h[-1 - lookback] > 0:
                rets[s] = h[-1] / h[-1 - lookback] - 1.0
        ranked = sorted([(s, r) for s, r in rets.items() if r > 0], key=lambda kv: kv[1], reverse=True)
        chosen = [s for s, _ in ranked[:top_n]] or syms
        w = Decimal("1") / Decimal(len(chosen))
        return {s: (w if s in chosen else Decimal("0")) for s in syms}
    raise ValueError(f"unknown weighting scheme: {scheme}")


def run_portfolio(
    *,
    legs: list[PortfolioLeg],
    weighting: str = "fixed",
    total_equity: Decimal = Decimal("100000"),
    fee_bps_taker: Decimal = Decimal("5.5"),
    slippage_bps_one_way: Decimal = Decimal("2.0"),
    rebalance_threshold: Decimal = Decimal("0.05"),
    lookback_bars: int = 20,
    top_n: int = 3,
    interval_minutes: int = 60,
    risk: dict[str, Any] | None = None,
    seed: int = 42,
    liquidation_model: str = "simple",
    risk_tiers_by_symbol: "dict | None" = None,
) -> PortfolioRunResult:
    errors = validate_legs(legs)          # validate the RAW legs so illegal configs surface
    if weighting not in WEIGHTING_SCHEMES:
        errors.append(f"UNKNOWN_WEIGHTING:{weighting}")
    if errors:
        return PortfolioRunResult(total_equity, [], [], [], {}, [], 0, {}, {}, [], errors)
    legs = [leg.normalized() for leg in legs]   # then normalize to a guaranteed live-feasible spec

    import bisect
    from datetime import datetime as _dt, timezone as _tz
    timeline = _union_timeline(legs)
    if len(timeline) < 2:
        return PortfolioRunResult(total_equity, [], [], [], {}, [], 0, {}, {}, ["INSUFFICIENT_BARS"])

    bar_at: dict[str, dict[int, Bar]] = {
        leg.symbol: {int(b.ts.timestamp() * 1000): b for b in leg.bars} for leg in legs
    }
    leg_ts: dict[str, list[int]] = {s: sorted(d.keys()) for s, d in bar_at.items()}
    leg_by_sym = {leg.symbol: leg for leg in legs}

    def bar_for(sym: str, ts: int) -> Bar | None:
        """Forward-filled bar: the last bar at-or-before ts (None if the leg hasn't started)."""
        arr = leg_ts[sym]
        j = bisect.bisect_right(arr, ts) - 1
        return bar_at[sym][arr[j]] if j >= 0 else None

    def is_rth_ms(ts_ms: int) -> bool:
        return is_regular_trading_hours(_dt.fromtimestamp(ts_ms / 1000, tz=_tz.utc))

    rc = RiskConfig()
    for k in ("max_position_fraction", "max_total_exposure_fraction", "max_daily_loss_fraction", "max_drawdown_kill_fraction"):
        if risk and k in risk:
            setattr(rc, k, Decimal(str(risk[k])))
    pf = Portfolio(starting_equity=total_equity, risk=rc)

    hist: dict[str, list[float]] = {leg.symbol: [] for leg in legs}
    equity_curve: list[Decimal] = []
    fills: list[dict] = []
    weights_history: list[dict] = []
    risk_notes: list[str] = []
    rebalances = 0

    def marks_at(idx: int) -> dict[str, Decimal]:
        ts = timeline[idx]
        out: dict[str, Decimal] = {}
        for s in bar_at:
            b = bar_for(s, ts)
            if b is not None:
                out[s] = b.close
        return out

    for i, ts in enumerate(timeline):
        bar_dt = _dt.fromtimestamp(ts / 1000, tz=_tz.utc)
        marks = marks_at(i)
        for s in hist:
            b = bar_for(s, ts)
            hist[s].append(float(b.close) if b is not None else (hist[s][-1] if hist[s] else 0.0))
        pf.update_equity_marks(bar_dt, marks)
        equity = pf.equity(marks)
        equity_curve.append(equity)

        # WS-C.5 cross-margin (opt-in): liquidate the whole account when account equity falls
        # to/below Σ maintenance-margin across leveraged perp legs, using the Bybit tiered MM
        # (mark = close proxy). Default "simple" skips this (behaviour unchanged).
        if (liquidation_model == "mark_price_tiered" and risk_tiers_by_symbol
                and not pf.state.killed):
            from . import bybit_venue as _bv
            total_mm = Decimal(0)
            for s, pos in pf.positions.items():
                if pos.side == "flat" or pos.qty <= 0:
                    continue
                leg = leg_by_sym.get(s)
                lev = Decimal(str(leg.leverage)) if (leg and leg.leverage) else Decimal(1)
                tiers = risk_tiers_by_symbol.get(s)
                if lev <= 1 or not tiers:
                    continue
                mk = marks.get(s, pos.avg_entry)
                tier = _bv.select_tier(tiers, abs(pos.qty) * mk)
                total_mm += _bv.maintenance_margin(pos.qty, mk, tier, entry=pos.avg_entry,
                                                   taker_fee_bps=fee_bps_taker)
            if total_mm > 0 and _bv.cross_account_liquidation(equity, total_mm):
                pf.state.killed = True
                pf.state.kill_reason = pf.state.kill_reason or "MARK_TIERED_CROSS_LIQUIDATION"
                risk_notes.append(f"CROSS_LIQ@{i}:equity={equity} <= sumMM={total_mm}")

        # Hard ruin floor: a real book cannot go below zero — liquidate at ruin
        # regardless of configured kill thresholds.
        if equity <= 0 and not pf.state.killed:
            pf.state.killed = True
            pf.state.kill_reason = pf.state.kill_reason or "RUIN_ZERO_EQUITY"

        if pf.state.killed:
            # flatten everything at next open, then stop.
            nxt = timeline[i + 1] if i + 1 < len(timeline) else None
            if nxt is not None:
                for s, pos in list(pf.positions.items()):
                    if pos.side != "flat" and pos.qty > 0:
                        nb = bar_for(s, nxt)
                        if nb is None:
                            continue
                        side = "sell" if pos.side == "long" else "buy"
                        eff = effective_slippage_bps(s, nb.ts, slippage_bps_one_way)
                        fp = nb.open * (Decimal(1) + eff / Decimal(10000)) if side == "buy" else nb.open * (Decimal(1) - eff / Decimal(10000))
                        fee = abs(pos.qty) * fp * (fee_bps_taker / Decimal(10000))
                        pf.apply_fill(symbol=s, side=side, qty=pos.qty, price=fp, fee=fee)
                        fills.append({"ts": nb.ts.isoformat(), "symbol": s, "side": side, "qty": str(pos.qty), "price": str(fp), "fee": str(fee), "tag": "kill_flatten"})
            risk_notes.append(f"KILLED:{pf.state.kill_reason}")
            break

        if i + 1 >= len(timeline):
            break  # no next bar to fill against

        targets = _target_weights(weighting, legs, hist, lookback_bars, top_n)
        # current weights
        gross = pf.exposure(marks)
        cur_w = {s: (abs(pf.positions[s].qty) * marks[s] / gross if gross > 0 and s in pf.positions else Decimal(0)) for s in bar_at}
        max_dev = max((abs(cur_w.get(s, Decimal(0)) - targets.get(s, Decimal(0))) for s in bar_at), default=Decimal(0))
        first = (i == 0)
        if not first and max_dev < rebalance_threshold:
            continue

        rebalances += 1
        weights_history.append({"ts": ts, **{s: float(targets.get(s, Decimal(0))) for s in bar_at}})
        budget = gross if gross > 0 else total_equity
        nxt = timeline[i + 1]
        for leg in legs:
            s = leg.symbol
            tgt_w = targets.get(s, Decimal(0))
            lev = leg.leverage if leg.asset_class == "crypto" else Decimal("1")
            target_notional = budget * tgt_w * lev
            cur_notional = (abs(pf.positions[s].qty) * marks[s]) if s in pf.positions else Decimal(0)
            delta = target_notional - cur_notional
            if delta == 0:
                continue
            nb = bar_for(s, nxt)
            if nb is None:
                continue
            side = "buy" if delta > 0 else "sell"
            # equity legs: long-only; and only trade during US Regular Trading Hours —
            # off-hours the position is HELD FLAT (crypto keeps trading 24/7).
            if leg.asset_class == "equity":
                if not is_rth_ms(nxt):
                    risk_notes.append(f"XSTOCK_OFFHOURS_HOLD:{s}")
                    continue
                if side == "sell" and (s not in pf.positions or pf.positions[s].qty <= 0):
                    risk_notes.append(f"XSTOCK_SHORT_BLOCKED:{s}")
                    continue
            eff = effective_slippage_bps(s, nb.ts, slippage_bps_one_way)
            fp = nb.open * (Decimal(1) + eff / Decimal(10000)) if side == "buy" else nb.open * (Decimal(1) - eff / Decimal(10000))
            if fp <= 0:
                continue
            qty = abs(delta) / fp
            fee = qty * fp * (fee_bps_taker / Decimal(10000))
            pf.apply_fill(symbol=s, side=side, qty=qty, price=fp, fee=fee)
            fills.append({"ts": _dt.fromtimestamp(nxt / 1000, tz=_tz.utc).isoformat(), "symbol": s, "side": side, "qty": str(qty),
                          "price": str(fp), "fee": str(fee), "asset_class": leg.asset_class,
                          "rth": is_rth_ms(nxt) if leg.asset_class == "equity" else None,
                          "tag": "rebalance"})

    final_marks = marks_at(min(len(timeline), len(equity_curve)) - 1) if equity_curve else {}
    final_equity = pf.equity(final_marks) if final_marks else total_equity
    metrics = _portfolio_metrics(equity_curve, interval_minutes)
    return PortfolioRunResult(
        final_equity=final_equity,
        equity_curve=equity_curve,
        timestamps=timeline[:len(equity_curve)],
        fills=fills,
        positions={s: {"side": p.side, "qty": str(p.qty), "avg_entry": str(p.avg_entry),
                       "realized_pnl": str(p.realized_pnl), "asset_class": leg_by_sym[s].asset_class}
                   for s, p in pf.positions.items()},
        weights_history=weights_history,
        rebalances=rebalances,
        metrics=metrics,
        risk_state={"killed": pf.state.killed, "kill_reason": pf.state.kill_reason,
                    "equity_high_watermark": str(pf.state.equity_high_watermark)},
        risk_notes=sorted(set(risk_notes)),
    )


def _portfolio_metrics(equity_curve: list[Decimal], interval_minutes: int) -> dict:
    if len(equity_curve) < 2:
        return {"total_return": 0.0, "sharpe": 0.0, "max_drawdown": 0.0}
    eq = [float(e) for e in equity_curve]
    total_return = (eq[-1] - eq[0]) / eq[0] if eq[0] > 0 else 0.0
    rets = [(eq[i] - eq[i - 1]) / eq[i - 1] for i in range(1, len(eq)) if eq[i - 1] > 0]
    if rets:
        # Clean Sharpe: robust to tiny samples / flat (sparsely-traded) curves — no absurd magnitudes.
        from .metrics import robust_sharpe
        bars_per_year = (365 * 24 * 60) / max(1, interval_minutes)
        sharpe = robust_sharpe(rets, bars_per_year)
    else:
        sharpe = 0.0
    peak = eq[0]
    max_dd = 0.0
    for v in eq:
        peak = max(peak, v)
        if peak > 0:
            max_dd = max(max_dd, (peak - v) / peak)
    return {"total_return": total_return, "sharpe": sharpe, "max_drawdown": max_dd, "bars": len(eq)}
