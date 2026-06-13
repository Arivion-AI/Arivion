"""Execution-fidelity configuration + the normalized ``fill_model`` contract.

This is the shared spine for the market-replay upgrade (Phases 0-1). It defines:

* ``Fidelity`` — the *requested* execution mode (bar_based | l2_sweep | l2_queue).
* ``LatencyConfig`` / ``ExecutionConfig`` — opt-in knobs, env-overridable. **Defaults
  preserve byte-identical bar-based behaviour** (no provider, no latency, no caps).
* ``FillModelStats`` — counters/flags the runtime accumulates during a run.
* ``build_fill_model`` — turns (requested fidelity + stats) into the normalized
  ``fill_model`` dict that EVERY run path (backtest, paper-runtime, bot-run, live-paper)
  must return, with the *achieved* ``mode`` after any fallback.
* ``verify_execution_tier`` — the honesty gate: recorded L2 alone NEVER grants a
  verified-execution badge; the fill engine must have actually consumed L2/trade data.

Nothing here touches a database or network — it is pure and deterministic so the
golden suite can exercise it directly.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum


class Fidelity(str, Enum):
    """The execution fidelity a caller *requests*."""

    BAR_BASED = "bar_based"
    L2_SWEEP = "l2_sweep"
    L2_QUEUE = "l2_queue"

    @classmethod
    def parse(cls, value: "str | Fidelity | None", default: "Fidelity") -> "Fidelity":
        if value is None:
            return default
        if isinstance(value, cls):
            return value
        v = str(value).strip().lower()
        for m in cls:
            if v == m.value:
                return m
        # tolerate the achieved-mode spellings as requests too
        if v in ("l2_sweep_only", "sweep"):
            return cls.L2_SWEEP
        if v in ("l2_queue_full", "queue"):
            return cls.L2_QUEUE
        return default


# fill_model.mode values — the *achieved* mode (after fallback), distinct from the request.
MODE_BAR = "bar_based"
MODE_SWEEP = "l2_sweep_only"
MODE_QUEUE = "l2_queue_full"


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(float(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class LatencyConfig:
    """Phase 5 latency knobs. ``enabled=False`` ⇒ 0ms everywhere, model-not-used."""

    enabled: bool = False
    feed_latency_ms: int = 0
    order_entry_latency_ms: int = 0
    cancel_latency_ms: int = 0
    exchange_ack_latency_ms: int = 0
    jitter_ms: int = 0
    seed: int = 42

    @classmethod
    def from_env(cls) -> "LatencyConfig":
        return cls(
            enabled=_env_bool("ENABLE_LATENCY_MODEL", False),
            feed_latency_ms=_env_int("DEFAULT_FEED_LATENCY_MS", 0),
            order_entry_latency_ms=_env_int("DEFAULT_ORDER_LATENCY_MS", 0),
            cancel_latency_ms=_env_int("DEFAULT_CANCEL_LATENCY_MS", 0),
            exchange_ack_latency_ms=_env_int("DEFAULT_ACK_LATENCY_MS", 0),
            jitter_ms=_env_int("DEFAULT_JITTER_MS", 0),
            seed=_env_int("LATENCY_SEED", 42),
        )


# Valid L2 depth tiers Bybit exposes for orderbook.{depth}.{symbol}.
VALID_L2_DEPTHS = (1, 50, 200, 500, 1000)


@dataclass
class ExecutionConfig:
    """Resolved per-run execution configuration. ``from_env`` reads the Phase-0 flags;
    callers may override any field (e.g. from a request's ``execution_fidelity``)."""

    fidelity: Fidelity = Fidelity.BAR_BASED
    enable_public_trades: bool = False
    l2_depth: int = 50
    # When a fidelity upgrade lacks the data it needs for a bar/run, fall back to the
    # next-lower fidelity (and record fallback_reason) rather than hard-failing.
    allow_fallback: bool = True
    # Coverage gates (fraction 0..1) a run must meet to earn the corresponding badge.
    snapshot_coverage_threshold: float = 0.98
    trade_coverage_threshold: float = 0.98
    latency: LatencyConfig = field(default_factory=LatencyConfig)

    @classmethod
    def from_env(cls, **overrides) -> "ExecutionConfig":
        depth = _env_int("L2_DEPTH", 50)
        if depth not in VALID_L2_DEPTHS:
            depth = 50
        cfg = cls(
            fidelity=Fidelity.parse(os.getenv("EXECUTION_FIDELITY"), Fidelity.BAR_BASED),
            enable_public_trades=_env_bool("ENABLE_PUBLIC_TRADES", False),
            l2_depth=depth,
            allow_fallback=_env_bool("EXECUTION_ALLOW_FALLBACK", True),
            snapshot_coverage_threshold=_env_float("L2_SNAPSHOT_COVERAGE_THRESHOLD", 0.98),
            trade_coverage_threshold=_env_float("TRADE_COVERAGE_THRESHOLD", 0.98),
            latency=LatencyConfig.from_env(),
        )
        for k, v in overrides.items():
            if v is None:
                continue
            if k == "fidelity":
                v = Fidelity.parse(v, cfg.fidelity)
            setattr(cfg, k, v)
        return cfg

    @property
    def requires_l2(self) -> bool:
        return self.fidelity in (Fidelity.L2_SWEEP, Fidelity.L2_QUEUE)

    @property
    def requires_trades(self) -> bool:
        return self.fidelity == Fidelity.L2_QUEUE


@dataclass
class FillModelStats:
    """Mutable counters/flags a ``PaperRuntime`` accumulates over a run. The runtime owns
    one of these; ``build_fill_model`` reads it at the end."""

    maker_fills: int = 0
    taker_fills: int = 0
    rejected_orders: int = 0
    # True once the L2 provider's fill path actually executed at least once.
    l2_provider_used: bool = False
    # True once a fill decision actually consumed trade-print (through_volume) data.
    trade_prints_used: bool = False
    latency_model_used: bool = False
    # Coverage the provider observed while running (fraction 0..1). -1 ⇒ not measured.
    snapshot_coverage_pct: float = -1.0
    trade_coverage_pct: float = -1.0
    fallback_reason: str | None = None
    # P1.1 fidelity honesty: where the consumed L2 came from and its snapshot cadence. The
    # verification GATE is source-agnostic (verify_execution_tier ignores these) — they exist so a
    # queue-aware result honestly STATES how it was produced (e.g. depth-500 archive snapshots have
    # a cadence, not tick-by-tick deltas, so lower queue-position precision than Tardis incremental
    # L2). None ⇒ realtime/unknown ⇒ keys omitted from fill_model (byte-identical default).
    l2_source: str | None = None        # e.g. "realtime-ws" | "bybit-archive-ob500" | "tardis-incr"
    l2_cadence_ms: int | None = None     # observed snapshot cadence; None for tick-by-tick


def build_fill_model(
    requested: Fidelity,
    stats: FillModelStats,
    *,
    market_impact_coef: float = 0.0,
    maker_participation_rate: float = 0.0,
) -> dict:
    """Produce the normalized ``fill_model`` block.

    The ``mode`` reflects what the engine ACTUALLY did (after any fallback), never merely
    what was requested. Rules mirror the Phase-1 spec:

    * bar_based: never l2_aware/provider/trade-prints; maker fills are optimistic & a
      liquidity-free upper bound.
    * l2_sweep_only: l2_aware only if the provider ran; no trade prints; maker fills not
      optimistic (sweep gates them); fallback_reason explains any downgrade.
    * l2_queue_full: provider + trade prints used; not optimistic; coverage reported.
    """
    provider_ran = stats.l2_provider_used
    trades_used = stats.trade_prints_used

    # Resolve the achieved mode from the request + what actually happened.
    if requested == Fidelity.L2_QUEUE and provider_ran and trades_used:
        mode = MODE_QUEUE
    elif requested in (Fidelity.L2_QUEUE, Fidelity.L2_SWEEP) and provider_ran:
        mode = MODE_SWEEP
    else:
        mode = MODE_BAR

    has_maker = stats.maker_fills > 0
    if mode == MODE_BAR:
        l2_aware = False
        maker_optimistic = has_maker
        liquidity_free_upper_bound = True
    elif mode == MODE_SWEEP:
        l2_aware = True
        # Sweep gating removes the worst optimism; still no through-volume queueing.
        maker_optimistic = False
        liquidity_free_upper_bound = False
    else:  # MODE_QUEUE
        l2_aware = True
        maker_optimistic = False
        liquidity_free_upper_bound = False

    def _cov(x: float) -> float:
        return round(x, 6) if x >= 0 else 0.0

    fm = {
        "mode": mode,
        "requested_fidelity": requested.value,
        "bar_based": mode == MODE_BAR,
        "l2_aware": l2_aware,
        "l2_provider_used": provider_ran,
        "trade_prints_used": trades_used,
        "maker_fills_optimistic": maker_optimistic,
        "liquidity_free_upper_bound": liquidity_free_upper_bound,
        "snapshot_coverage_pct": _cov(stats.snapshot_coverage_pct),
        "trade_coverage_pct": _cov(stats.trade_coverage_pct),
        "latency_model_used": stats.latency_model_used,
        "fallback_reason": stats.fallback_reason,
        "maker_fills": stats.maker_fills,
        "taker_fills": stats.taker_fills,
        "rejected_orders": stats.rejected_orders,
        # Surfaced for the bar-based proxy honesty (unchanged semantics).
        "maker_participation_rate": maker_participation_rate,
        "market_impact_coef": market_impact_coef,
    }
    # P1.1 provenance — emitted ONLY when a provider actually declared a source, so the default
    # (realtime/bar-based) fill_model is byte-identical to before this field existed. When present,
    # also state the spread-cost honesty (P3.2): the bid-ask spread is only charged under L2
    # fidelity; bar_based fills at bar prices ± fixed slippage do not pay it.
    if stats.l2_source is not None:
        fm["l2_source"] = stats.l2_source
        fm["l2_cadence_ms"] = stats.l2_cadence_ms
        fm["spread_cost_modeled"] = (mode != MODE_BAR)
    return fm


@dataclass
class TierDecision:
    l2_verified: bool
    queue_verified: bool
    reasons: list[str]


def verify_execution_tier(
    fill_model: dict,
    *,
    snapshot_threshold: float = 0.98,
    trade_threshold: float = 0.98,
) -> TierDecision:
    """The verification gate. Recorded L2 rows alone are NOT sufficient — the engine must
    have consumed L2 (for sweep/queue) and trade prints (for full queue), at adequate
    coverage. Returns which badges, if any, the run has earned and why not otherwise."""
    reasons: list[str] = []
    fm = fill_model or {}
    mode = fm.get("mode")
    provider_used = bool(fm.get("l2_provider_used"))
    trades_used = bool(fm.get("trade_prints_used"))
    snap_cov = float(fm.get("snapshot_coverage_pct") or 0.0)
    trade_cov = float(fm.get("trade_coverage_pct") or 0.0)

    # --- L2-verified (sweep or queue) ---
    l2_verified = True
    if not provider_used:
        l2_verified = False
        reasons.append("L2_PROVIDER_NOT_USED")
    if mode not in (MODE_SWEEP, MODE_QUEUE):
        l2_verified = False
        reasons.append(f"MODE_NOT_L2:{mode}")
    if snap_cov < snapshot_threshold:
        l2_verified = False
        reasons.append(f"SNAPSHOT_COVERAGE_BELOW_THRESHOLD:{snap_cov:.4f}<{snapshot_threshold}")

    # --- Full queue-verified ---
    queue_verified = True
    if mode != MODE_QUEUE:
        queue_verified = False
        reasons.append(f"MODE_NOT_QUEUE:{mode}")
    if not trades_used:
        queue_verified = False
        reasons.append("TRADE_PRINTS_NOT_USED")
    if trade_cov < trade_threshold:
        queue_verified = False
        reasons.append(f"TRADE_COVERAGE_BELOW_THRESHOLD:{trade_cov:.4f}<{trade_threshold}")
    if fm.get("maker_fills_optimistic"):
        queue_verified = False
        reasons.append("MAKER_FILLS_OPTIMISTIC")

    # Queue-verified implies L2-verified.
    if queue_verified:
        l2_verified = True

    return TierDecision(l2_verified=l2_verified, queue_verified=queue_verified, reasons=reasons)
