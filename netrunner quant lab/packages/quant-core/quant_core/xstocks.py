"""xStocks (Backed Finance tokenized equities) integration catalog + market model.

Source of truth for tokenized-equity instruments traded on Bybit Spot. Mirrors the
Bybit V5 ``/v5/market/instruments-info`` (category=spot, symbolType="xstocks")
semantics:

  * Symbols are ``<TICKER>XUSDT`` spot pairs (e.g. AAPLX -> ``AAPLXUSDT``), quoted in USDT.
  * ``xstockMultiplier`` maps token<->share:  stock_price = token_price / multiplier ;
    stock_qty = token_qty * multiplier.  Default 1.
  * Spot only: no leverage, no shorting, no funding, no liquidation.
  * 24/7 tradable, but the *underlying* US equity only has Regular Trading Hours
    (RTH, 09:30-16:00 America/New_York, Mon-Fri). Outside RTH the token trades as a
    "prediction market" with thinner liquidity -> wider effective spread.
  * Per-token position cap of 300,000 USDT and EEA/AU/JP region gating apply to LIVE
    Bybit deployment (paper/backtest in the lab is unrestricted).

This module is paper/research metadata only — it never talks to private Bybit
endpoints and holds no API keys.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time, timezone
from decimal import Decimal
from typing import Any

try:  # py>=3.9 stdlib
    from zoneinfo import ZoneInfo
    _NY = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover - fallback if tzdata missing
    _NY = None

# Bybit live constraints (apply to real-money deployment via the execution adapter).
XSTOCK_POSITION_CAP_USDT = Decimal("300000")
XSTOCK_RESTRICTED_REGIONS = ("EEA", "AU", "JP")  # plus service-restricted countries
XSTOCK_QUOTE = "USDT"
XSTOCK_SETTLEMENT_NETWORK = "Solana"

# US equity Regular Trading Hours.
_RTH_OPEN = time(9, 30)
_RTH_CLOSE = time(16, 0)


@dataclass(frozen=True)
class XStock:
    """A tokenized-equity instrument as exposed on Bybit Spot."""
    symbol: str            # Bybit spot pair, e.g. "AAPLXUSDT"
    base_coin: str         # token ticker, e.g. "AAPLX"
    underlying: str        # real ticker, e.g. "AAPL"
    name: str
    sector: str
    asset_class: str = "equity"          # vs "crypto"
    kind: str = "stock"                  # "stock" | "etf"
    xstock_multiplier: Decimal = Decimal("1")
    min_order_qty: Decimal = Decimal("0.0001")
    min_order_amt_usdt: Decimal = Decimal("1")
    tick_size: Decimal = Decimal("0.01")
    symbol_type: str = "xstocks"

    # --- token <-> share conversion (per Bybit xstockMultiplier semantics) ---
    def stock_price(self, token_price: Decimal | str | float) -> Decimal:
        return Decimal(str(token_price)) / self.xstock_multiplier

    def token_price(self, stock_price: Decimal | str | float) -> Decimal:
        return Decimal(str(stock_price)) * self.xstock_multiplier

    def stock_qty(self, token_qty: Decimal | str | float) -> Decimal:
        return Decimal(str(token_qty)) * self.xstock_multiplier

    def token_qty(self, stock_qty: Decimal | str | float) -> Decimal:
        return Decimal(str(stock_qty)) / self.xstock_multiplier

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "base_coin": self.base_coin,
            "underlying": self.underlying,
            "name": self.name,
            "sector": self.sector,
            "asset_class": self.asset_class,
            "kind": self.kind,
            "xstock_multiplier": str(self.xstock_multiplier),
            "min_order_qty": str(self.min_order_qty),
            "min_order_amt_usdt": str(self.min_order_amt_usdt),
            "tick_size": str(self.tick_size),
            "symbol_type": self.symbol_type,
            "quote": XSTOCK_QUOTE,
            "settlement_network": XSTOCK_SETTLEMENT_NETWORK,
            "position_cap_usdt": str(XSTOCK_POSITION_CAP_USDT),
            "bot_enabled": self.symbol in BOT_ENABLED_SYMBOLS,
        }


# Headline xStocks catalog. Only symbols that are actually listed on Bybit Spot are
# included (verified against the V5 kline endpoint — SPYX/QQQX/MSFTX/MSTRX are NOT
# listed and were removed). Multipliers default to 1 (Bybit default); the live value
# comes from instruments-info.xstockMultiplier and can be overridden per-instrument.
XSTOCKS: list[XStock] = [
    XStock("AAPLXUSDT", "AAPLX", "AAPL", "Apple", "Technology"),
    XStock("NVDAXUSDT", "NVDAX", "NVDA", "NVIDIA", "Semiconductors"),
    XStock("TSLAXUSDT", "TSLAX", "TSLA", "Tesla", "Automotive"),
    XStock("METAXUSDT", "METAX", "META", "Meta Platforms", "Technology"),
    XStock("AMZNXUSDT", "AMZNX", "AMZN", "Amazon", "Consumer Discretionary"),
    XStock("GOOGLXUSDT", "GOOGLX", "GOOGL", "Alphabet", "Technology"),
    XStock("HOODXUSDT", "HOODX", "HOOD", "Robinhood", "Financials"),
    XStock("CRCLXUSDT", "CRCLX", "CRCL", "Circle", "Financials"),
    XStock("COINXUSDT", "COINX", "COIN", "Coinbase", "Financials"),
    XStock("MCDXUSDT", "MCDX", "MCD", "McDonald's", "Consumer Staples"),
]

# Names Bybit has enabled for native Spot Grid bots (Mar 2026). The lab can run *all*
# bot types against any xStock; this list is informational parity with Bybit.
BOT_ENABLED_SYMBOLS = {
    "AAPLXUSDT", "TSLAXUSDT", "NVDAXUSDT", "AMZNXUSDT", "GOOGLXUSDT", "HOODXUSDT", "CRCLXUSDT",
}

_BY_SYMBOL = {x.symbol: x for x in XSTOCKS}
_BY_BASE = {x.base_coin: x for x in XSTOCKS}


def all_xstocks() -> list[XStock]:
    return list(XSTOCKS)


def is_xstock(symbol: str) -> bool:
    if not symbol:
        return False
    s = symbol.upper()
    return s in _BY_SYMBOL or s in _BY_BASE or (s.endswith("XUSDT") and s in _BY_SYMBOL)


def xstock_by_symbol(symbol: str) -> XStock | None:
    if not symbol:
        return None
    s = symbol.upper()
    return _BY_SYMBOL.get(s) or _BY_BASE.get(s)


def asset_class_of(symbol: str) -> str:
    """'equity' for xStocks, else 'crypto' (the lab's default universe)."""
    return "equity" if is_xstock(symbol) else "crypto"


def multiplier_of(symbol: str) -> Decimal:
    x = xstock_by_symbol(symbol)
    return x.xstock_multiplier if x else Decimal("1")


# ------------------------------ market hours ------------------------------
def is_regular_trading_hours(ts: datetime) -> bool:
    """True if ``ts`` falls inside US equity Regular Trading Hours (Mon-Fri 09:30-16:00 ET).

    Holidays are not modelled (documented limitation). Naive timestamps are treated as UTC.
    """
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    if _NY is None:
        # Fail loud: a DST-blind fixed UTC offset would mis-gate market hours for ~half
        # the year. Refuse rather than silently compute the wrong RTH window.
        raise RuntimeError(
            "tzdata/zoneinfo 'America/New_York' unavailable — cannot compute US market "
            "hours correctly. Install the tzdata package in the image.")
    local = ts.astimezone(_NY)
    if local.weekday() >= 5:  # Sat/Sun
        return False
    return _RTH_OPEN <= local.time() < _RTH_CLOSE


def session_phase(ts: datetime) -> str:
    """'rth' during regular hours, else 'off_hours' (pre/post-market, weekend, holiday)."""
    return "rth" if is_regular_trading_hours(ts) else "off_hours"


def off_hours_spread_multiplier(ts: datetime, base_multiplier: Decimal | float = Decimal("3")) -> Decimal:
    """Effective-spread widening factor for xStocks outside RTH.

    During RTH the on-chain price is arbitrage-anchored to NYSE/Nasdaq (factor 1).
    Off-hours it behaves as a thin prediction market — model wider slippage.
    """
    return Decimal("1") if is_regular_trading_hours(ts) else Decimal(str(base_multiplier))


def position_cap_breached(notional_usdt: Decimal | float | str) -> bool:
    return Decimal(str(notional_usdt)) > XSTOCK_POSITION_CAP_USDT


def effective_slippage_bps(symbol: str | None, ts: datetime, base_bps: Decimal | float | str) -> Decimal:
    """One-way slippage to apply for a fill, widening xStock fills outside RTH.

    Non-xStock symbols are returned unchanged (multiplier 1), so crypto behaviour
    and all existing tests are unaffected. The verifier replays the same engine, so
    this stays deterministic.
    """
    base = Decimal(str(base_bps))
    if symbol and is_xstock(symbol):
        return base * off_hours_spread_multiplier(ts)
    return base


def catalog_payload() -> dict[str, Any]:
    """Serialisable catalog for the API/GUI."""
    return {
        "xstocks": [x.to_dict() for x in XSTOCKS],
        "count": len(XSTOCKS),
        "quote": XSTOCK_QUOTE,
        "settlement_network": XSTOCK_SETTLEMENT_NETWORK,
        "position_cap_usdt": str(XSTOCK_POSITION_CAP_USDT),
        "restricted_regions": list(XSTOCK_RESTRICTED_REGIONS),
        "bot_enabled_symbols": sorted(BOT_ENABLED_SYMBOLS),
        "rth": {"open_et": "09:30", "close_et": "16:00", "days": "Mon-Fri", "tz": "America/New_York"},
        "constraints": {
            "spot_only": True,
            "leverage": False,
            "short_selling": False,
            "funding": False,
            "dividends": False,
        },
    }
