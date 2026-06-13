#!/usr/bin/env python3
"""P4.1 — single long-range Decimal backtest benchmark.

The Phase-9 load test measures CONCURRENCY over many short jobs; it does NOT measure single-run
latency over a long range. This harness runs ONE bot over ~525k 1-minute bars (1 year) end to end
and reports wall-clock + a cProfile breakdown of the Decimal arithmetic hotspots, so any future
fast-path (P4.2) has a baseline to beat — and must prove byte-identical results to ship.

Usage:
  PYTHONPATH=packages/quant-core python3 scripts/bench_long_range.py --bars 525600 --bot twap
  PYTHONPATH=packages/quant-core python3 scripts/bench_long_range.py --bars 50000 --profile-top 25

Determinism: synthetic bars are generated from a fixed seed; no wall-clock/RNG enters the engine.
"""
from __future__ import annotations

import argparse
import cProfile
import io
import pstats
import random
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal


def make_bars(n: int, seed: int = 7):
    from quant_core.orders import Bar
    rng = random.Random(seed)
    t0 = datetime(2025, 1, 1, tzinfo=timezone.utc)
    px = 30000.0
    bars = []
    for i in range(n):
        px = max(1.0, px * (1.0 + rng.uniform(-0.001, 0.0011)))
        p = Decimal(str(round(px, 2)))
        bars.append(Bar(ts=t0 + timedelta(minutes=i), open=p, high=p + Decimal("5"),
                        low=p - Decimal("5"), close=p, volume=Decimal("100")))
    return bars


def run_once(bars, bot_type: str):
    from quant_core.bot_os import BotSpec, build_bot, run_bot, spec_hash, TEMPLATES
    defaults = next((t.get("default_params", {}) for t in TEMPLATES if t["bot_type"] == bot_type), {})
    spec = BotSpec(bot_type=bot_type, name="bench", symbols=["BTCUSDT"],
                   params=dict(defaults), risk={}, accounting={})
    bot = build_bot(spec.bot_type, spec.params)
    report, _ = run_bot(spec=spec, bot=bot, symbol="BTCUSDT", bars=bars, funding_rows=[],
                        starting_equity=Decimal("100000"), spec_hash_value=spec_hash(spec))
    return report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bars", type=int, default=525600, help="number of 1m bars (~1y = 525600)")
    ap.add_argument("--bot", default="twap")
    ap.add_argument("--profile-top", type=int, default=20)
    ap.add_argument("--no-profile", action="store_true")
    args = ap.parse_args()

    print(f"Generating {args.bars:,} bars…")
    t = time.perf_counter()
    bars = make_bars(args.bars)
    print(f"  bar gen: {time.perf_counter() - t:.2f}s")

    print(f"Running bot={args.bot} over {len(bars):,} bars…")
    t = time.perf_counter()
    if args.no_profile:
        report = run_once(bars, args.bot)
        wall = time.perf_counter() - t
    else:
        prof = cProfile.Profile()
        prof.enable()
        report = run_once(bars, args.bot)
        prof.disable()
        wall = time.perf_counter() - t

    print(f"\n=== RESULT ===")
    print(f"  wall-clock:   {wall:.2f}s for {len(bars):,} bars  ({len(bars)/wall:,.0f} bars/s)")
    print(f"  events:       {len(report.events):,}")
    print(f"  fills:        {len(report.fills):,}")
    print(f"  final_equity: {report.final_equity}")

    if not args.no_profile:
        s = io.StringIO()
        ps = pstats.Stats(prof, stream=s).sort_stats("cumulative")
        ps.print_stats(args.profile_top)
        print("\n=== cProfile (top by cumulative; watch Decimal __mul__/__add__/__truediv__) ===")
        print(s.getvalue())


if __name__ == "__main__":
    main()
