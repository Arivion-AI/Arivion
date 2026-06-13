"""Bybit-exactness venue layer (duality_final.md).

Pure, deterministic functions that replicate Bybit v5 venue mechanics so a strategy
that paper-trades here behaves the same on Bybit live:

  WS-A  conform_order        — instrument-filter conformance (tick/step/notional/leverage/band)
  WS-B  resolve_fee_bps      — VIP-tiered, per-category maker/taker fees (with rebates)
  WS-C  liquidation math     — mark-price tiered MMR, IM, MM, LP, bankruptcy, cross-account
  WS-D  clamp_funding_rate   — per-symbol funding caps
  WS-F  PostOnly / reduceOnly — order-type semantics

PRIME DIRECTIVES (from the spec):
  * Determinism is sacred — every function is a pure function of its inputs; no wall-clock,
    no randomness; all money/price/margin math in Decimal.
  * Point-in-time honesty — filters/tiers/fees are CURRENT-ONLY on Bybit; callers snapshot
    them and pin by data_version. These functions never fetch; they take the snapshot.
  * Flag, don't hide — callers attach the honesty flags to results.

All percent fields from Bybit (`maintenanceMargin`, `initialMargin`) are PERCENT (e.g. "0.5"
= 0.5%); the dataclasses below store the already-divided fraction unless noted.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, ROUND_DOWN, ROUND_UP, ROUND_FLOOR

Side = str  # "buy" | "sell"


# ====================================================================== WS-A
@dataclass(frozen=True)
class InstrumentFilter:
    symbol: str
    category: str                                   # 'linear' | 'spot' | 'inverse'
    tick_size: Decimal
    min_price: Decimal = Decimal("0")
    max_price: Decimal = Decimal("0")               # 0 => unbounded
    qty_step: Decimal = Decimal("0.000001")
    min_order_qty: Decimal = Decimal("0")
    max_order_qty: Decimal = Decimal("0")           # 0 => unbounded (limit/postonly)
    max_mkt_order_qty: Decimal = Decimal("0")       # 0 => unbounded (market)
    min_notional: Decimal = Decimal("0")
    min_leverage: Decimal = Decimal("1")
    max_leverage: Decimal = Decimal("100")
    leverage_step: Decimal = Decimal("0.01")
    price_limit_ratio_x: Decimal | None = None      # perp price-band (vs mark)
    price_limit_ratio_y: Decimal | None = None
    data_version: str = "snapshot"


def _round_to(value: Decimal, step: Decimal, rounding) -> Decimal:
    if step <= 0:
        return value
    return (value / step).quantize(Decimal("1"), rounding=rounding) * step


def round_price_to_tick(price: Decimal, tick: Decimal, side: Side) -> Decimal:
    """Buy limit rounds DOWN, sell limit rounds UP (never improve beyond the requested side)."""
    return _round_to(price, tick, ROUND_DOWN if side == "buy" else ROUND_UP)


def round_qty_to_step(qty: Decimal, step: Decimal) -> Decimal:
    return _round_to(abs(qty), step, ROUND_FLOOR)


@dataclass
class ConformResult:
    ok: bool
    price: Decimal | None = None
    qty: Decimal | None = None
    leverage: Decimal | None = None
    reason: str | None = None         # TICK_VIOLATION | MIN_QTY | MIN_NOTIONAL | PRICE_BAND | MAX_QTY | ...
    adjustments: list[str] = field(default_factory=list)


def conform_order(
    *, side: Side, price: Decimal | None, qty: Decimal, instr: InstrumentFilter,
    is_market: bool = False, leverage: Decimal | None = None, mark_price: Decimal | None = None,
) -> ConformResult:
    """Apply Bybit instrument filters to an order BEFORE it can rest/fill. Returns the
    conformed (snapped) price/qty/leverage or a typed rejection reason — exactly as a live
    Bybit rejection. Pure function of (order, snapshot)."""
    adj: list[str] = []
    out_price = price

    # 1. price -> tick + bounds (skip for pure market orders without a price)
    if price is not None and instr.tick_size > 0:
        snapped = round_price_to_tick(price, instr.tick_size, side)
        if snapped != price:
            adj.append("PRICE_SNAPPED_TO_TICK")
        if instr.min_price > 0 and snapped < instr.min_price:
            return ConformResult(False, reason="TICK_VIOLATION")
        if instr.max_price > 0 and snapped > instr.max_price:
            return ConformResult(False, reason="TICK_VIOLATION")
        out_price = snapped

    # 2. qty -> step + min/max
    out_qty = round_qty_to_step(qty, instr.qty_step)
    if out_qty != abs(qty):
        adj.append("QTY_SNAPPED_TO_STEP")
    if instr.min_order_qty > 0 and out_qty < instr.min_order_qty:
        return ConformResult(False, reason="MIN_QTY")
    max_q = instr.max_mkt_order_qty if is_market else instr.max_order_qty
    if max_q > 0 and out_qty > max_q:
        return ConformResult(False, reason="MAX_QTY")

    # 3. min notional
    ref_price = out_price if out_price is not None else mark_price
    if instr.min_notional > 0 and ref_price is not None and ref_price * out_qty < instr.min_notional:
        return ConformResult(False, reason="MIN_NOTIONAL")

    # 4. leverage clamp (perps)
    out_lev = None
    if leverage is not None:
        out_lev = max(instr.min_leverage, min(instr.max_leverage, leverage))
        if instr.leverage_step > 0:
            out_lev = _round_to(out_lev, instr.leverage_step, ROUND_DOWN)
            out_lev = max(instr.min_leverage, out_lev)
        if out_lev != leverage:
            adj.append("LEVERAGE_CLAMPED")

    # 5. price band (perps) — reject limit prices outside the allowed band around mark
    if (out_price is not None and mark_price is not None
            and instr.price_limit_ratio_x is not None and not is_market):
        x = instr.price_limit_ratio_x
        upper = mark_price * (Decimal(1) + x)
        lower = mark_price * (Decimal(1) - x)
        if out_price > upper or out_price < lower:
            return ConformResult(False, reason="PRICE_BAND")

    return ConformResult(True, price=out_price, qty=out_qty, leverage=out_lev, adjustments=adj)


# ====================================================================== WS-B
# Versioned snapshot of Bybit's PUBLIC fee schedule (captured value; refresh from the public
# fee page / GET /v5/market/fee-group-info). Fees are in BPS. Negative maker = rebate.
# These are representative public Bybit values; ship the live snapshot in production.
FEE_SCHEDULE_VERSION = "bybit-public-2026-05"
FEE_SCHEDULE: dict[str, dict[str, dict[str, Decimal]]] = {
    "linear": {
        "NONVIP": {"maker": Decimal("2.0"), "taker": Decimal("5.5")},
        "VIP1":   {"maker": Decimal("1.8"), "taker": Decimal("5.0")},
        "VIP2":   {"maker": Decimal("1.6"), "taker": Decimal("5.0")},
        "VIP3":   {"maker": Decimal("1.5"), "taker": Decimal("4.5")},
        "PRO1":   {"maker": Decimal("-0.5"), "taker": Decimal("3.0")},   # market-maker rebate
        "PRO3":   {"maker": Decimal("-1.0"), "taker": Decimal("2.5")},
    },
    "inverse": {
        "NONVIP": {"maker": Decimal("2.0"), "taker": Decimal("5.5")},
        "PRO1":   {"maker": Decimal("-0.5"), "taker": Decimal("3.0")},
    },
    "spot": {
        "NONVIP": {"maker": Decimal("10.0"), "taker": Decimal("10.0")},
        "VIP1":   {"maker": Decimal("6.0"), "taker": Decimal("8.0")},
        "VIP2":   {"maker": Decimal("4.0"), "taker": Decimal("7.0")},
        "VIP3":   {"maker": Decimal("2.0"), "taker": Decimal("6.0")},
        "PRO1":   {"maker": Decimal("0.0"), "taker": Decimal("4.0")},
    },
}


def resolve_fee_bps(category: str, is_maker: bool, vip_tier: str = "NONVIP") -> Decimal:
    """(category, maker|taker, vip_tier) -> bps. Falls back to NONVIP / linear if unknown."""
    cat = category if category in FEE_SCHEDULE else "linear"
    table = FEE_SCHEDULE[cat]
    row = table.get(vip_tier.upper(), table["NONVIP"])
    return row["maker" if is_maker else "taker"]


# ====================================================================== WS-C
@dataclass(frozen=True)
class RiskTier:
    tier_id: int
    risk_limit_value: Decimal     # position-value cap for this tier (USDT)
    mmr: Decimal                  # maintenance-margin FRACTION (mmr_pct/100)
    imr: Decimal                  # initial-margin FRACTION (imr_pct/100)
    max_leverage: Decimal
    mm_deduction: Decimal         # precomputed deduction making the ladder continuous
    is_lowest_risk: bool = False


def risk_tier_from_pct(tier_id, risk_limit_value, mmr_pct, imr_pct, max_leverage,
                       mm_deduction, is_lowest_risk=False) -> RiskTier:
    """Build a RiskTier from PERCENT fields (divides mmr/imr by 100).

    UNIT NOTE — cross-validated against the live venue (2026-05): Bybit's *private account*
    endpoint (`/v5/position/list`) reports maintenance/initial margin as PERCENTAGES
    ("0.5" = 0.5%); for those use THIS constructor. But the *public market* endpoint
    `/v5/market/risk-limit` (the lab's actual data source) returns them as FRACTIONS already
    ("0.005" = 0.5%) — for that use `risk_tier_from_fraction`, which does NOT divide.
    """
    return RiskTier(int(tier_id), Decimal(str(risk_limit_value)),
                    Decimal(str(mmr_pct)) / Decimal(100), Decimal(str(imr_pct)) / Decimal(100),
                    Decimal(str(max_leverage)), Decimal(str(mm_deduction)), bool(is_lowest_risk))


def risk_tier_from_fraction(tier_id, risk_limit_value, mmr_fraction, imr_fraction, max_leverage,
                            mm_deduction=0, is_lowest_risk=False) -> RiskTier:
    """Build a RiskTier from the PUBLIC `/v5/market/risk-limit` row, whose maintenanceMargin /
    initialMargin are ALREADY fractions (no ÷100). Canonical path for the lab's
    `instrument_snapshots.maintenance_margin_tiers_json` data."""
    return RiskTier(int(tier_id), Decimal(str(risk_limit_value)),
                    Decimal(str(mmr_fraction)), Decimal(str(imr_fraction)),
                    Decimal(str(max_leverage)), Decimal(str(mm_deduction)), bool(is_lowest_risk))


def risk_tiers_from_snapshot(tiers_json: list[dict]) -> list[RiskTier]:
    """Map the stored `maintenance_margin_tiers_json` (from collect_instruments_info) into
    RiskTier objects. Fractions used as-is (public market-endpoint units).

    The public /v5/market/risk-limit response does NOT include `mmDeduction` (verified live
    2026-05 — it returns only id/riskLimitValue/maintenanceMargin/initialMargin/maxLeverage),
    so we COMPUTE the deduction that makes the MM ladder continuous:
        MM_ded(1) = 0
        MM_ded(n) = riskLimitValue(n-1) * (MMR_n - MMR_{n-1}) + MM_ded(n-1)
    If a row already carries `mm_deduction`, it is trusted (override)."""
    ladder = sorted(tiers_json, key=lambda r: Decimal(str(r.get("notional_cap") or "0")))
    out: list[RiskTier] = []
    prev_cap = Decimal(0)
    prev_mmr = Decimal(0)
    prev_ded = Decimal(0)
    for i, t in enumerate(ladder):
        mmr = Decimal(str(t.get("mmr_fraction", "0")))
        if t.get("mm_deduction") is not None:
            ded = Decimal(str(t.get("mm_deduction")))
        elif i == 0:
            ded = Decimal(0)
        else:
            ded = prev_cap * (mmr - prev_mmr) + prev_ded
        out.append(risk_tier_from_fraction(
            t.get("risk_id", i + 1), t.get("notional_cap", "0"),
            t.get("mmr_fraction", "0"), t.get("initial_margin_fraction", "0"),
            t.get("max_leverage", "1"), mm_deduction=ded,
            is_lowest_risk=bool(t.get("is_lowest_risk", i == 0))))
        prev_cap = Decimal(str(t.get("notional_cap") or "0"))
        prev_mmr = mmr
        prev_ded = ded
    return out


def select_tier(tiers: list[RiskTier], position_value: Decimal) -> RiskTier:
    """Lowest tier whose risk_limit_value >= position value (re-evaluate every bar)."""
    ladder = sorted(tiers, key=lambda t: t.risk_limit_value)
    for t in ladder:
        if position_value <= t.risk_limit_value:
            return t
    return ladder[-1]   # beyond the top tier -> use the highest


def initial_margin(qty: Decimal, entry: Decimal, tier: RiskTier, leverage: Decimal | None = None) -> Decimal:
    pv_entry = abs(qty) * entry
    return pv_entry / leverage if (leverage and leverage > 0) else pv_entry * tier.imr


def fee_to_close(qty: Decimal, entry: Decimal, taker_fee_bps: Decimal) -> Decimal:
    return abs(qty) * entry * (taker_fee_bps / Decimal(10000))


def maintenance_margin(qty: Decimal, mark: Decimal, tier: RiskTier,
                       entry: Decimal | None = None, taker_fee_bps: Decimal = Decimal("5.5")) -> Decimal:
    """MM = PV_mark·MMR − mm_deduction + fee_to_close."""
    pv_mark = abs(qty) * mark
    ftc = fee_to_close(qty, entry if entry is not None else mark, taker_fee_bps)
    return pv_mark * tier.mmr - tier.mm_deduction + ftc


def liquidation_price(side: Side, entry: Decimal, qty: Decimal, im: Decimal, mm: Decimal,
                      extra_margin: Decimal = Decimal(0)) -> Decimal:
    """Isolated-mode LP (USDT linear). Long: entry − (IM+extra−MM)/|qty|; short: +."""
    delta = (im + extra_margin - mm) / abs(qty)
    return entry - delta if side in ("buy", "long") else entry + delta


def bankruptcy_price(side: Side, entry: Decimal, im: Decimal, qty: Decimal) -> Decimal:
    """0%-margin price: long ≈ entry − IM/|qty|; short ≈ entry + IM/|qty|."""
    d = im / abs(qty)
    return entry - d if side in ("buy", "long") else entry + d


def liq_triggered(side: Side, lp: Decimal, mark_high: Decimal, mark_low: Decimal) -> bool:
    """Long liquidates if mark_low ≤ LP; short if mark_high ≥ LP (intrabar, mark series)."""
    return mark_low <= lp if side in ("buy", "long") else mark_high >= lp


def cross_account_liquidation(account_equity: Decimal, total_maintenance_margin: Decimal) -> bool:
    """Cross-margin (the lab's one-UTA default): liquidate when equity ≤ Σ MM."""
    return account_equity <= total_maintenance_margin


@dataclass
class PositionLiq:
    tier_id: int
    mm: Decimal
    im: Decimal
    lp: Decimal
    bankruptcy: Decimal
    triggered: bool


def position_liquidation(
    *, side: Side, qty: Decimal, entry: Decimal, mark_high: Decimal, mark_low: Decimal,
    tiers: list[RiskTier], leverage: Decimal | None = None,
    taker_fee_bps: Decimal = Decimal("5.5"), extra_margin: Decimal = Decimal(0),
    mark_close: Decimal | None = None,
) -> PositionLiq:
    """One-call WS-C isolated-position liquidation: select tier by PV_mark, compute IM/MM/LP/
    bankruptcy, and test whether the mark high/low crossed LP this bar. Pure & deterministic.

    `mark_close` (or the midpoint) is used for tier selection / MM valuation; the high/low drive
    the intrabar trigger. Returns all the numbers + the trigger so callers can settle at the
    bankruptcy price and emit honest events."""
    q = abs(qty)
    mark_ref = mark_close if mark_close is not None else (mark_high + mark_low) / Decimal(2)
    tier = select_tier(tiers, q * mark_ref)
    im = initial_margin(qty, entry, tier, leverage=leverage)
    mm = maintenance_margin(qty, mark_ref, tier, entry=entry, taker_fee_bps=taker_fee_bps)
    lp = liquidation_price(side, entry, qty, im, mm, extra_margin=extra_margin)
    bp = bankruptcy_price(side, entry, im, qty)
    trig = liq_triggered(side, lp, mark_high, mark_low)
    return PositionLiq(tier.tier_id, mm, im, lp, bp, trig)


# ====================================================================== WS-D
def clamp_funding_rate(rate: Decimal, lower_cap: Decimal | None, upper_cap: Decimal | None) -> Decimal:
    """Clamp a funding rate to the symbol's [lowerFundingRate, upperFundingRate] snapshot."""
    out = rate
    if lower_cap is not None:
        out = max(out, lower_cap)
    if upper_cap is not None:
        out = min(out, upper_cap)
    return out


# ====================================================================== WS-F
def post_only_would_cross(side: Side, limit_price: Decimal,
                          best_bid: Decimal | None, best_ask: Decimal | None) -> bool:
    """A PostOnly buy crosses if its price ≥ best ask; a PostOnly sell if ≤ best bid.
    Bybit cancels such an order (it would be a taker) — model as REJECTED, not a taker fill."""
    if side == "buy" and best_ask is not None:
        return limit_price >= best_ask
    if side == "sell" and best_bid is not None:
        return limit_price <= best_bid
    return False


def resolve_trigger_price(trigger_by: str, last: Decimal,
                          mark: Decimal | None = None, index: Decimal | None = None) -> Decimal:
    """WS-F: pick the reference price a conditional/stop order triggers on.
    LastPrice (default) | MarkPrice | IndexPrice. Falls back to last if the series is absent."""
    tb = (trigger_by or "LastPrice").lower()
    if tb == "markprice" and mark is not None:
        return mark
    if tb == "indexprice" and index is not None:
        return index
    return last


def clamp_reduce_only(order_side: Side, order_qty: Decimal,
                      position_side: str, position_qty: Decimal) -> Decimal:
    """reduceOnly can only reduce, never flip/increase. Returns the allowed fill qty (≥0)."""
    if position_side == "flat" or position_qty <= 0:
        return Decimal(0)
    reducing = (position_side == "long" and order_side == "sell") or \
               (position_side == "short" and order_side == "buy")
    if not reducing:
        return Decimal(0)
    return min(order_qty, position_qty)
