"""Uniswap v3 / Algebra concentrated-liquidity position math.

Pure, deterministic helpers (Decimal throughout, no I/O) used by the LP asset class: token amounts
from pool state, position USD value, in-range status, fees owed, and impermanent loss. Mirrors the
canonical Uniswap LiquidityAmounts / TickMath logic.

Conventions:
  - sqrtP / sqrtA / sqrtB are sqrtRatioX96 values (i.e. sqrt(price) * 2**96), as the subgraph/pool
    expose them. price here is token1-per-token0 in *raw* (undecimaled) units.
  - liquidity L is the raw uint128 from the pool/position.
  - amounts returned by `position_amounts` are RAW token units (wei); divide by 10**decimals for human.
"""
from __future__ import annotations

import functools
from dataclasses import dataclass
from decimal import Decimal, localcontext


def _highprec(fn):
    """Run with 60-digit Decimal precision locally — never mutate the global context (which would
    corrupt precision-sensitive callers elsewhere in the process)."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with localcontext() as ctx:
            ctx.prec = 60
            return fn(*args, **kwargs)
    return wrapper


Q96 = Decimal(2) ** 96
_TICK_BASE_SQRT = Decimal("1.0001").sqrt()  # 1.0001 ** (1/2)


@_highprec
def sqrt_ratio_x96_from_tick(tick: int) -> Decimal:
    """sqrtRatioX96 = sqrt(1.0001**tick) * 2**96 = (1.0001**(tick/2)) * 2**96."""
    return (_TICK_BASE_SQRT ** Decimal(tick)) * Q96


def _amount0(sqrt_a: Decimal, sqrt_b: Decimal, liquidity: Decimal) -> Decimal:
    """getAmount0Delta: L * Q96 * (sqrtB - sqrtA) / (sqrtA * sqrtB). Raw token0 units."""
    if sqrt_a > sqrt_b:
        sqrt_a, sqrt_b = sqrt_b, sqrt_a
    if sqrt_a <= 0:
        return Decimal(0)
    return liquidity * Q96 * (sqrt_b - sqrt_a) / (sqrt_a * sqrt_b)


def _amount1(sqrt_a: Decimal, sqrt_b: Decimal, liquidity: Decimal) -> Decimal:
    """getAmount1Delta: L * (sqrtB - sqrtA) / Q96. Raw token1 units."""
    if sqrt_a > sqrt_b:
        sqrt_a, sqrt_b = sqrt_b, sqrt_a
    return liquidity * (sqrt_b - sqrt_a) / Q96


@_highprec
def position_amounts(sqrt_price_x96: Decimal, tick_lower: int, tick_upper: int, liquidity: Decimal) -> tuple[Decimal, Decimal]:
    """Raw (amount0, amount1) currently held by a position, given current pool sqrtPriceX96."""
    sqrt_a = sqrt_ratio_x96_from_tick(tick_lower)
    sqrt_b = sqrt_ratio_x96_from_tick(tick_upper)
    if sqrt_a > sqrt_b:
        sqrt_a, sqrt_b = sqrt_b, sqrt_a
    sqrt_p = sqrt_price_x96
    if sqrt_p <= sqrt_a:
        return _amount0(sqrt_a, sqrt_b, liquidity), Decimal(0)
    if sqrt_p < sqrt_b:
        return _amount0(sqrt_p, sqrt_b, liquidity), _amount1(sqrt_a, sqrt_p, liquidity)
    return Decimal(0), _amount1(sqrt_a, sqrt_b, liquidity)


@_highprec
def price0_in_token1(sqrt_price_x96: Decimal, decimals0: int, decimals1: int) -> Decimal:
    """Human price of 1 token0 denominated in token1 (decimal-adjusted)."""
    raw = (sqrt_price_x96 / Q96) ** 2  # token1 per token0, raw units
    return raw * (Decimal(10) ** (decimals0 - decimals1))


def is_in_range(current_tick: int, tick_lower: int, tick_upper: int) -> bool:
    return tick_lower <= current_tick < tick_upper


@_highprec
def fees_owed(
    fee_growth_inside_now_x128: Decimal,
    fee_growth_inside_last_x128: Decimal,
    liquidity: Decimal,
) -> Decimal:
    """feesOwed = L * (feeGrowthInsideNow - feeGrowthInsideLast) / 2**128 (raw token units).

    feeGrowthInsideNow must be derived from the pool's global/tick fee-growth accumulators; when only
    the position's last-checkpoint is known, pass a freshly computed inside value.
    """
    delta = fee_growth_inside_now_x128 - fee_growth_inside_last_x128
    if delta < 0:
        delta += Decimal(2) ** 256  # uint256 wraparound
    return liquidity * delta / (Decimal(2) ** 128)


@dataclass(frozen=True)
class LpPositionValue:
    amount0: Decimal           # human units
    amount1: Decimal
    value_usd: Decimal
    in_range: bool
    price0_usd: Decimal
    price1_usd: Decimal


@_highprec
def position_value_usd(
    *,
    sqrt_price_x96: Decimal,
    current_tick: int,
    tick_lower: int,
    tick_upper: int,
    liquidity: Decimal,
    decimals0: int,
    decimals1: int,
    price0_usd: Decimal,
    price1_usd: Decimal,
) -> LpPositionValue:
    raw0, raw1 = position_amounts(sqrt_price_x96, tick_lower, tick_upper, liquidity)
    amt0 = raw0 / (Decimal(10) ** decimals0)
    amt1 = raw1 / (Decimal(10) ** decimals1)
    value = amt0 * price0_usd + amt1 * price1_usd
    return LpPositionValue(
        amount0=amt0,
        amount1=amt1,
        value_usd=value,
        in_range=is_in_range(current_tick, tick_lower, tick_upper),
        price0_usd=price0_usd,
        price1_usd=price1_usd,
    )


@_highprec
def impermanent_loss_full_range(price_ratio: Decimal) -> Decimal:
    """Classic full-range IL vs holding, as a (negative) fraction. price_ratio = P_now / P_init.

    IL = 2*sqrt(k)/(1+k) - 1.
    """
    if price_ratio <= 0:
        return Decimal(0)
    k = price_ratio
    return (2 * k.sqrt() / (1 + k)) - 1


@_highprec
def impermanent_loss_concentrated(
    *,
    tick_lower: int,
    tick_upper: int,
    sqrt_price_init_x96: Decimal,
    sqrt_price_now_x96: Decimal,
    liquidity: Decimal,
    decimals0: int,
    decimals1: int,
) -> Decimal:
    """IL for a concentrated position vs HODL of the initially-deposited amounts, as a fraction.

    LP value and hold value are both denominated in token1 at the current price, so price0_usd cancels.
    IL = lp_value / hold_value - 1  (<= 0 while in/near range).
    """
    raw0_init, raw1_init = position_amounts(sqrt_price_init_x96, tick_lower, tick_upper, liquidity)
    raw0_now, raw1_now = position_amounts(sqrt_price_now_x96, tick_lower, tick_upper, liquidity)
    # value in token1 raw units at current price: amount1 + amount0 * price(token1 per token0)
    price_now = (sqrt_price_now_x96 / Q96) ** 2  # token1 per token0, raw
    lp_value = raw1_now + raw0_now * price_now
    hold_value = raw1_init + raw0_init * price_now
    if hold_value <= 0:
        return Decimal(0)
    _ = (decimals0, decimals1)  # decimals cancel in the ratio; kept for signature symmetry
    return lp_value / hold_value - 1
