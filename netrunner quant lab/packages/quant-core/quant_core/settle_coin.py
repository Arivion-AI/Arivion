"""WS-E — UTA settle-coin ledgers + cross-margin equity (duality_final.md).

A real Bybit Unified Trading Account shares collateral across positions (cross), but settles
each perp's PnL/fees/funding in its **settleCoin** (USDT vs USDC), and applies collateral
**haircuts** to non-primary collateral. "One UTA" in the lab was just a label; this models it.

Design (incremental, cross-first; matches the plan):
  * Per-`settleCoin` wallet balances — a USDT-perp's PnL/fee/funding hits the USDT ledger; a
    USDC-perp hits USDC. They are NOT pooled into one number.
  * Cross-margin equity (USD-equiv) = Σ_coin (balance × collateral_ratio × coin_price)
    + Σ_positions unrealized_pnl (each in its settle coin × that coin's price).
  * Collateral haircuts: a versioned ratio table; **USDT defaults to 1.0** so the common
    all-USDT book is exact and the feature is a deterministic no-op until ratios are supplied.
  * Isolated mode: an isolated leg keeps its own margin and its liquidation does not touch the
    shared cross balance (helper provided).

Pure & deterministic: all `Decimal`, no wall-clock/randomness.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

# Default collateral ratios (haircuts). 1.0 = full credit. Ship the public collateral-ratio
# table as a versioned snapshot to override; until then stable-coins credit at par.
DEFAULT_COLLATERAL_RATIO: dict[str, Decimal] = {
    "USDT": Decimal("1.0"),
    "USDC": Decimal("1.0"),
}


@dataclass
class SettleCoinLedger:
    """Cross-margin account split by settle coin."""
    balances: dict[str, Decimal] = field(default_factory=dict)
    collateral_ratio: dict[str, Decimal] = field(default_factory=lambda: dict(DEFAULT_COLLATERAL_RATIO))
    primary: str = "USDT"

    def deposit(self, coin: str, amount: Decimal) -> None:
        self.balances[coin] = self.balances.get(coin, Decimal(0)) + amount

    def settle(self, coin: str, amount: Decimal) -> None:
        """Apply a realized PnL / fee / funding amount (signed) to one coin's ledger.
        Positive = credit, negative = debit. A USDC-perp's loss only reduces USDC."""
        self.balances[coin] = self.balances.get(coin, Decimal(0)) + amount

    def balance(self, coin: str) -> Decimal:
        return self.balances.get(coin, Decimal(0))

    def ratio(self, coin: str) -> Decimal:
        return self.collateral_ratio.get(coin, Decimal("1.0"))

    def wallet_usd(self, coin_prices: dict[str, Decimal] | None = None) -> Decimal:
        """Σ balance × collateral_ratio × coin_price (USD-equiv wallet, pre-unrealized).
        Stable coins price at 1.0 unless overridden."""
        prices = coin_prices or {}
        total = Decimal(0)
        for coin, bal in self.balances.items():
            px = prices.get(coin, Decimal("1.0"))
            total += bal * self.ratio(coin) * px
        return total

    def cross_equity_usd(
        self,
        unrealized_by_coin: dict[str, Decimal] | None = None,
        coin_prices: dict[str, Decimal] | None = None,
    ) -> Decimal:
        """Cross account equity (USD-equiv) = haircut wallet + Σ unrealized PnL (per settle coin,
        valued at that coin's price). Feeds WS-C.5 `cross_account_liquidation`."""
        prices = coin_prices or {}
        equity = self.wallet_usd(prices)
        for coin, upnl in (unrealized_by_coin or {}).items():
            equity += upnl * prices.get(coin, Decimal("1.0"))
        return equity


@dataclass
class IsolatedLeg:
    """An isolated-margin position: its own posted margin; a liquidation here is capped at that
    margin and does NOT draw on the shared cross balance."""
    settle_coin: str
    posted_margin: Decimal

    def liquidation_loss(self, realized_loss: Decimal) -> Decimal:
        """An isolated liquidation can lose at most the posted margin (the shared balance is
        untouched). Returns the loss actually borne by this leg's isolated margin."""
        return min(realized_loss, self.posted_margin)
