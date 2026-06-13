"""Optimizer parameter-grid + random-sample generation (Tier 4 #15).

Takes a parameter space definition and emits a list of candidate parameter dicts
ready to feed to a bot or strategy run. Methods: ``grid`` (cartesian product),
``random`` (uniform samples), ``sobol`` (low-discrepancy quasi-random).

Usage:
    space = {
        "ema_fast": {"values": [5, 8, 13, 21]},
        "ema_slow": {"values": [21, 34, 55]},
        "order_qty": {"min": 0.01, "max": 0.10, "step": 0.01},
    }
    cands = generate_candidates(space, method="grid")        # 4 × 3 × 10 = 120
    cands = generate_candidates(space, method="random", n_samples=50)
"""
from __future__ import annotations

import itertools
import math
import random
from typing import Any, Iterable


def _range_values(spec: dict) -> list:
    """Resolve a single parameter spec into a list of candidate values.

    Supported forms:
      - {"values": [a, b, c]}         — explicit set
      - {"min": x, "max": y, "step": s}   — inclusive numeric range
      - {"min": x, "max": y, "n": k, "log": True}  — k log-spaced samples
    """
    if "values" in spec:
        return list(spec["values"])
    if "min" in spec and "max" in spec:
        lo = float(spec["min"]); hi = float(spec["max"])
        if "step" in spec:
            step = float(spec["step"])
            n_steps = int(round((hi - lo) / step)) + 1
            return [round(lo + i * step, 10) for i in range(n_steps)]
        if "n" in spec:
            n = int(spec["n"])
            if spec.get("log"):
                if lo <= 0:
                    raise ValueError("log spacing requires min > 0")
                a, b = math.log(lo), math.log(hi)
                return [math.exp(a + i * (b - a) / max(1, n - 1)) for i in range(n)]
            return [lo + i * (hi - lo) / max(1, n - 1) for i in range(n)]
    raise ValueError(f"Invalid param spec: {spec}")


def cartesian_grid(space: dict[str, dict]) -> list[dict[str, Any]]:
    names = list(space.keys())
    value_lists = [_range_values(space[n]) for n in names]
    out = []
    for combo in itertools.product(*value_lists):
        out.append(dict(zip(names, combo)))
    return out


def random_samples(space: dict[str, dict], n_samples: int, seed: int | None = None) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    out = []
    for _ in range(n_samples):
        cand: dict[str, Any] = {}
        for name, spec in space.items():
            if "values" in spec:
                cand[name] = rng.choice(list(spec["values"]))
            elif "min" in spec and "max" in spec:
                lo = float(spec["min"]); hi = float(spec["max"])
                if spec.get("log"):
                    if lo <= 0:
                        raise ValueError("log spacing requires min > 0")
                    v = math.exp(rng.uniform(math.log(lo), math.log(hi)))
                else:
                    v = rng.uniform(lo, hi)
                cand[name] = v
            else:
                raise ValueError(f"Invalid spec for {name}: {spec}")
        out.append(cand)
    return out


def sobol_samples(space: dict[str, dict], n_samples: int) -> list[dict[str, Any]]:
    """Quasi-random low-discrepancy sequence — better space coverage than uniform random.

    Pure-Python van der Corput Sobol sequence for n dimensions, no numpy dependency.
    """
    # Cheap stand-in: scrambled Halton (which is similar quality for n < 8).
    def halton(idx: int, base: int) -> float:
        f, r = 1.0, 0.0
        i = idx
        while i > 0:
            f /= base
            r += f * (i % base)
            i //= base
        return r

    primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]
    names = list(space.keys())
    out = []
    for i in range(1, n_samples + 1):
        cand: dict[str, Any] = {}
        for j, name in enumerate(names):
            spec = space[name]
            u = halton(i, primes[j % len(primes)])
            if "values" in spec:
                values = list(spec["values"])
                cand[name] = values[int(u * len(values)) % len(values)]
            elif "min" in spec and "max" in spec:
                lo = float(spec["min"]); hi = float(spec["max"])
                if spec.get("log"):
                    v = math.exp(math.log(lo) + u * (math.log(hi) - math.log(lo)))
                else:
                    v = lo + u * (hi - lo)
                cand[name] = v
        out.append(cand)
    return out


def generate_candidates(
    space: dict[str, dict],
    method: str = "grid",
    n_samples: int = 50,
    seed: int | None = 42,
    max_candidates: int = 1000,
) -> list[dict[str, Any]]:
    """Top-level generator. Caps the candidate list at ``max_candidates`` for safety."""
    if not space:
        raise ValueError("space cannot be empty")
    if method == "grid":
        cands = cartesian_grid(space)
    elif method == "random":
        cands = random_samples(space, n_samples=n_samples, seed=seed)
    elif method == "sobol":
        cands = sobol_samples(space, n_samples=n_samples)
    else:
        raise ValueError(f"unknown method: {method}")
    if len(cands) > max_candidates:
        cands = cands[:max_candidates]
    return cands


def merge_with_base(base_params: dict, override: dict) -> dict:
    """Deep-shallow merge: override wins at top level, scalar overrides scalar."""
    out = dict(base_params)
    for k, v in override.items():
        out[k] = v
    return out
