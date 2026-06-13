"""Multi-regime historical library (Tier 4 #14).

Named historical price slices for BTC across the recent 5 years. Each regime is
authored with a fixed UTC date range + a human-readable label.

Usage:
    from quant_core.regime_library import REGIMES, regime_by_id
    bull_2021 = regime_by_id("btc_2021_bull")
    print(bull_2021.start_ms, bull_2021.end_ms, bull_2021.description)

Data lives in Postgres `candles` after running ``scripts/load_regimes.py``.
The runtime fetches a specific regime's bars via the existing /api/data/coverage
or directly via SQL — this module is the catalog, not the storage.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone


def _ms(year: int, month: int, day: int) -> int:
    return int(datetime(year, month, day, tzinfo=timezone.utc).timestamp() * 1000)


@dataclass(frozen=True)
class HistoricalRegime:
    regime_id: str
    label: str
    symbol: str
    category: str          # 'linear' | 'spot'
    interval: str          # '60' (1h) | 'D' (1d)
    start_ms: int
    end_ms: int
    expected_regime: str   # 'bull' | 'bear' | 'chop' | 'mixed' | 'crash'
    description: str
    data_version: str = "regime-library-v1"

    @property
    def start(self) -> datetime:
        return datetime.fromtimestamp(self.start_ms / 1000, tz=timezone.utc)

    @property
    def end(self) -> datetime:
        return datetime.fromtimestamp(self.end_ms / 1000, tz=timezone.utc)


REGIMES: list[HistoricalRegime] = [
    HistoricalRegime(
        regime_id="btc_2021_bull",
        label="BTC 2021 — Full-year bull cycle ($29k → $46k, peak $69k)",
        symbol="BTCUSDT", category="linear", interval="D",
        start_ms=_ms(2021, 1, 1), end_ms=_ms(2022, 1, 1),
        expected_regime="bull",
        description="Bitcoin's strongest year on record. Two legs of rally (Jan-Apr to $64k, "
                    "Jul-Nov to $69k), single mid-year drawdown to $30k. Use this for testing "
                    "trend-following and DCA strategies under sustained uptrend.",
    ),
    HistoricalRegime(
        regime_id="btc_2022_bear",
        label="BTC 2022 — Crypto winter ($47k → $16k, includes LUNA + FTX)",
        symbol="BTCUSDT", category="linear", interval="D",
        start_ms=_ms(2022, 1, 1), end_ms=_ms(2023, 1, 1),
        expected_regime="bear",
        description="Sustained downtrend with two macro shocks (LUNA collapse May, FTX November). "
                    "Use for testing kill-switch behavior, martingale ruin scenarios, and "
                    "DCA cost-averaging on the way down.",
    ),
    HistoricalRegime(
        regime_id="btc_2023_recovery",
        label="BTC 2023 — Sideways recovery ($16k → $42k)",
        symbol="BTCUSDT", category="linear", interval="D",
        start_ms=_ms(2023, 1, 1), end_ms=_ms(2024, 1, 1),
        expected_regime="mixed",
        description="Choppy recovery with multiple range expansions. ETF-anticipation rally in Q4. "
                    "Good for grid/MM strategies and regime-detection tests.",
    ),
    HistoricalRegime(
        regime_id="btc_2024_halving",
        label="BTC 2024 — Halving + ETF era ($42k → $94k)",
        symbol="BTCUSDT", category="linear", interval="D",
        start_ms=_ms(2024, 1, 1), end_ms=_ms(2025, 1, 1),
        expected_regime="bull",
        description="Spot-ETF approval Jan, halving April, sustained climb. Mid-year chop. "
                    "Tests funding-arb (frequent positive funding), trend-following.",
    ),
    HistoricalRegime(
        regime_id="btc_2025_recent",
        label="BTC 2025 YTD — Mixed",
        symbol="BTCUSDT", category="linear", interval="D",
        start_ms=_ms(2025, 1, 1), end_ms=_ms(2026, 1, 1),
        expected_regime="mixed",
        description="Most recent regime. Strong Q1 then summer chop. Use for "
                    "walk-forward out-of-sample testing.",
    ),
    # ETH companions for cross-coin tests
    HistoricalRegime(
        regime_id="eth_2021_bull",
        label="ETH 2021 — DeFi summer aftermath + NFT bull ($730 → $3700)",
        symbol="ETHUSDT", category="linear", interval="D",
        start_ms=_ms(2021, 1, 1), end_ms=_ms(2022, 1, 1),
        expected_regime="bull",
        description="ETH's strongest year. Use alongside btc_2021_bull for correlation tests.",
    ),
    HistoricalRegime(
        regime_id="eth_2022_bear",
        label="ETH 2022 — Bear + Merge ($3700 → $1200)",
        symbol="ETHUSDT", category="linear", interval="D",
        start_ms=_ms(2022, 1, 1), end_ms=_ms(2023, 1, 1),
        expected_regime="bear",
        description="Sustained downtrend with the Merge (Sep) as the only positive catalyst.",
    ),
    # Short-window 1h slices for fast tests
    HistoricalRegime(
        regime_id="btc_2024_oct_chop_1h",
        label="BTC Oct 2024 — One month chop (1h)",
        symbol="BTCUSDT", category="linear", interval="60",
        start_ms=_ms(2024, 10, 1), end_ms=_ms(2024, 11, 1),
        expected_regime="chop",
        description="High-frequency slice. ~720 bars. Use for fast PMM / Avellaneda / grid tests.",
    ),
    HistoricalRegime(
        regime_id="btc_2022_may_luna_crash_1h",
        label="BTC May 2022 — LUNA collapse (1h)",
        symbol="BTCUSDT", category="linear", interval="60",
        start_ms=_ms(2022, 5, 1), end_ms=_ms(2022, 6, 1),
        expected_regime="crash",
        description="Stress-test slice. Contains the LUNA depeg and BTC slide from $39k to $29k. "
                    "Use to verify kill switches, drawdown gates, liquidation distance.",
    ),
    # --- xStocks (tokenized US equities on Bybit Spot). History begins mid-2025. ---
    HistoricalRegime(
        regime_id="nvdax_2025_recent", label="NVDAx 2025+ — Tokenized NVIDIA (spot)",
        symbol="NVDAXUSDT", category="spot", interval="D",
        start_ms=_ms(2025, 7, 1), end_ms=_ms(2026, 2, 1), expected_regime="mixed",
        description="Tokenized NVIDIA equity on Bybit Spot. Spot-only, long-only, RTH-aware.",
    ),
    HistoricalRegime(
        regime_id="aaplx_2025_recent", label="AAPLx 2025+ — Tokenized Apple (spot)",
        symbol="AAPLXUSDT", category="spot", interval="D",
        start_ms=_ms(2025, 7, 1), end_ms=_ms(2026, 2, 1), expected_regime="mixed",
        description="Tokenized Apple equity on Bybit Spot.",
    ),
    HistoricalRegime(
        regime_id="tslax_2025_recent", label="TSLAx 2025+ — Tokenized Tesla (spot)",
        symbol="TSLAXUSDT", category="spot", interval="D",
        start_ms=_ms(2025, 7, 1), end_ms=_ms(2026, 2, 1), expected_regime="mixed",
        description="Tokenized Tesla equity on Bybit Spot.",
    ),
    HistoricalRegime(
        regime_id="googlx_2025_recent", label="GOOGLx 2025+ — Tokenized Alphabet (spot)",
        symbol="GOOGLXUSDT", category="spot", interval="D",
        start_ms=_ms(2025, 7, 1), end_ms=_ms(2026, 2, 1), expected_regime="mixed",
        description="Tokenized Alphabet equity on Bybit Spot. Verified-listed; replaces the unlisted SPYx.",
    ),
]


def regime_by_id(regime_id: str) -> HistoricalRegime | None:
    for r in REGIMES:
        if r.regime_id == regime_id:
            return r
    return None


def regimes_by_symbol(symbol: str) -> list[HistoricalRegime]:
    return [r for r in REGIMES if r.symbol == symbol]


def regimes_by_expected(regime_kind: str) -> list[HistoricalRegime]:
    return [r for r in REGIMES if r.expected_regime == regime_kind]
