"""Indicator library — Decimal-aware where precision matters, float elsewhere.

All indicators are causal (only past data). No `shift(-1)`, no centered windows.
Each returns ``None`` until it has enough history; tests assert that.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Deque, Iterable


def _to_decimal(x) -> Decimal:
    return x if isinstance(x, Decimal) else Decimal(str(x))


@dataclass
class SMA:
    length: int
    _buf: Deque[Decimal] = field(default_factory=deque)

    def update(self, value) -> Decimal | None:
        v = _to_decimal(value)
        self._buf.append(v)
        if len(self._buf) > self.length:
            self._buf.popleft()
        if len(self._buf) < self.length:
            return None
        return sum(self._buf) / Decimal(self.length)


@dataclass
class EMA:
    length: int
    _value: Decimal | None = None
    _count: int = 0

    @property
    def alpha(self) -> Decimal:
        return Decimal(2) / (Decimal(self.length) + Decimal(1))

    def update(self, value) -> Decimal | None:
        v = _to_decimal(value)
        self._count += 1
        if self._value is None:
            self._value = v
        else:
            self._value = self.alpha * v + (Decimal(1) - self.alpha) * self._value
        # Match common convention: only emit a value once we've seen at least `length` samples.
        if self._count < self.length:
            return None
        return self._value


@dataclass
class RSI:
    """Wilder's RSI. Returns 0–100 as Decimal."""
    length: int
    _last: Decimal | None = None
    _avg_gain: Decimal = Decimal(0)
    _avg_loss: Decimal = Decimal(0)
    _count: int = 0

    def update(self, value) -> Decimal | None:
        v = _to_decimal(value)
        if self._last is None:
            self._last = v
            return None
        change = v - self._last
        gain = change if change > 0 else Decimal(0)
        loss = -change if change < 0 else Decimal(0)
        self._last = v
        self._count += 1
        if self._count <= self.length:
            self._avg_gain += gain / Decimal(self.length)
            self._avg_loss += loss / Decimal(self.length)
        else:
            n = Decimal(self.length)
            self._avg_gain = (self._avg_gain * (n - 1) + gain) / n
            self._avg_loss = (self._avg_loss * (n - 1) + loss) / n
        if self._count < self.length:
            return None
        if self._avg_loss == 0:
            return Decimal(100)
        rs = self._avg_gain / self._avg_loss
        return Decimal(100) - (Decimal(100) / (Decimal(1) + rs))


@dataclass
class ATR:
    """Wilder's ATR over (high, low, close)."""
    length: int
    _last_close: Decimal | None = None
    _value: Decimal | None = None
    _count: int = 0

    def update(self, high, low, close) -> Decimal | None:
        h, l, c = _to_decimal(high), _to_decimal(low), _to_decimal(close)
        if self._last_close is None:
            tr = h - l
        else:
            tr = max(h - l, abs(h - self._last_close), abs(l - self._last_close))
        self._last_close = c
        self._count += 1
        n = Decimal(self.length)
        if self._value is None:
            self._value = tr
        else:
            self._value = (self._value * (n - 1) + tr) / n
        if self._count < self.length:
            return None
        return self._value


@dataclass
class BollingerBands:
    length: int
    num_std: Decimal = Decimal("2")
    _buf: Deque[Decimal] = field(default_factory=deque)

    def update(self, value) -> tuple[Decimal, Decimal, Decimal] | None:
        v = _to_decimal(value)
        self._buf.append(v)
        if len(self._buf) > self.length:
            self._buf.popleft()
        if len(self._buf) < self.length:
            return None
        n = Decimal(self.length)
        mean = sum(self._buf) / n
        variance = sum((x - mean) ** 2 for x in self._buf) / n
        std = variance.sqrt()
        return (mean - self.num_std * std, mean, mean + self.num_std * std)


@dataclass
class MACD:
    fast: int = 12
    slow: int = 26
    signal: int = 9
    _ema_fast: EMA = field(init=False)
    _ema_slow: EMA = field(init=False)
    _ema_signal: EMA = field(init=False)

    def __post_init__(self) -> None:
        self._ema_fast = EMA(self.fast)
        self._ema_slow = EMA(self.slow)
        self._ema_signal = EMA(self.signal)

    def update(self, value) -> tuple[Decimal, Decimal, Decimal] | None:
        f = self._ema_fast.update(value)
        s = self._ema_slow.update(value)
        if f is None or s is None:
            return None
        macd = f - s
        sig = self._ema_signal.update(macd)
        if sig is None:
            return None
        return (macd, sig, macd - sig)


@dataclass
class ZScore:
    """Rolling z-score over a series of values."""
    length: int
    _buf: Deque[Decimal] = field(default_factory=deque)

    def update(self, value) -> Decimal | None:
        v = _to_decimal(value)
        self._buf.append(v)
        if len(self._buf) > self.length:
            self._buf.popleft()
        if len(self._buf) < self.length:
            return None
        n = Decimal(self.length)
        mean = sum(self._buf) / n
        variance = sum((x - mean) ** 2 for x in self._buf) / n
        std = variance.sqrt()
        if std == 0:
            return Decimal(0)
        return (v - mean) / std


@dataclass
class Donchian:
    length: int
    _highs: Deque[Decimal] = field(default_factory=deque)
    _lows: Deque[Decimal] = field(default_factory=deque)

    def update(self, high, low) -> tuple[Decimal, Decimal] | None:
        self._highs.append(_to_decimal(high))
        self._lows.append(_to_decimal(low))
        if len(self._highs) > self.length:
            self._highs.popleft(); self._lows.popleft()
        if len(self._highs) < self.length:
            return None
        return (min(self._lows), max(self._highs))


@dataclass
class VWAP:
    """Session VWAP. Reset with .reset() at session boundaries."""
    _pv: Decimal = Decimal(0)
    _v: Decimal = Decimal(0)

    def reset(self) -> None:
        self._pv = Decimal(0)
        self._v = Decimal(0)

    def update(self, price, volume) -> Decimal | None:
        p, v = _to_decimal(price), _to_decimal(volume)
        self._pv += p * v
        self._v += v
        if self._v == 0:
            return None
        return self._pv / self._v


@dataclass
class Keltner:
    """Keltner channel: EMA ± multiple × ATR."""
    length: int = 20
    atr_mult: Decimal = Decimal("2")
    _ema: EMA = field(init=False)
    _atr: ATR = field(init=False)

    def __post_init__(self) -> None:
        self._ema = EMA(self.length)
        self._atr = ATR(self.length)

    def update(self, high, low, close) -> tuple[Decimal, Decimal, Decimal] | None:
        e = self._ema.update(close)
        a = self._atr.update(high, low, close)
        if e is None or a is None:
            return None
        return (e - self.atr_mult * a, e, e + self.atr_mult * a)


def returns(values: Iterable) -> list[Decimal]:
    """Simple period-over-period returns. First entry is None-equivalent (dropped)."""
    vs = [_to_decimal(v) for v in values]
    out: list[Decimal] = []
    for i in range(1, len(vs)):
        if vs[i - 1] == 0:
            out.append(Decimal(0))
        else:
            out.append((vs[i] - vs[i - 1]) / vs[i - 1])
    return out
