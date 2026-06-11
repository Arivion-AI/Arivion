"""Engine-faithful replay core for the verifier (P0.2).

The trust layer is only sound if the verifier re-runs the **same engine** that produced the
result (§6: ``/api/backtests`` single-signal runs use ``EventBacktestEngine``; bot/algo runs use
``PaperRuntime`` via ``quant_core.bot_os.run_bot`` — different engines, different fidelity).

Before this module the verifier replayed ``EventBacktestEngine`` for *everything*, so a bot
passport could never reproduce (structurally different events + run-hash → ``RUN_HASH_MISMATCH``)
and had no independent re-execution check at all.

This module is the **pure, importable core** (no DB, no network) so engine selection and the
byte-for-byte comparison are golden-testable. The verifier endpoint is thin wiring on top:
``select_engine`` → (``EventBacktestEngine`` | ``replay_bot_run``) → ``events_digest`` compare.

Determinism: every reconstruction is Decimal, seeded, no wall-clock — identical inputs reproduce
identical events byte-for-byte. Curve-derived scalar metrics are compared with
``quant_core.performance.METRIC_ABS_TOLERANCE`` (events/fills stay byte-exact); see §21.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from quant_core.engine import FundingRow
from quant_core.event_digest import (
    canonical_event_digest as _shared_canonical_digest,
    canonicalize_order_ids as _shared_canonicalize,
    stable_json_hash as _shared_stable_hash,
)
from quant_core.orders import Bar as RuntimeBar
from quant_core.performance import METRIC_ABS_TOLERANCE, compute_performance

ENGINE_EVENT_BACKTEST = "event_backtest"
ENGINE_PAPER_RUNTIME_BOT = "paper_runtime_bot"

# Reason codes (machine-readable) for replays the pure core cannot perform deterministically.
# These runs need DB-backed inputs (recorded L2/trade provider, or instrument/risk snapshots for
# venue-exact). The endpoint — which has a DB connection — supplies them; the pure core defers
# rather than silently degrade to bar-based (which would be a false verification).
REASON_NEEDS_DB_PROVIDER = "BOT_REPLAY_REQUIRES_DB_BACKED_INPUTS"
REASON_UNKNOWN_BOT_TYPE = "UNKNOWN_BOT_TYPE"
# The full LatencyConfig (feed/cancel/ack/jitter/seed) is env-resolved at run time and NOT captured
# in the run record's config_json — so a latency-enabled run is not independently reproducible from
# the record alone. Defer rather than replay with a different (env-default) latency profile.
REASON_LATENCY_NOT_CAPTURED = "BOT_REPLAY_LATENCY_CONFIG_NOT_CAPTURED_IN_RUN_RECORD"


# Thin aliases over the shared quant_core.event_digest helpers (single source of truth shared with
# the worker, so worker-stored and verifier-replayed digests are computed identically).
def events_digest(events: list[dict]) -> str:
    """Raw digest — matches the worker's ``_stable_json_hash`` over the event list byte-for-byte."""
    return _shared_stable_hash(events)


_canonicalize_order_ids = _shared_canonicalize


def canonical_events_digest(events: list[dict]) -> str:
    """Cross-process-stable digest (order IDs canonicalized). See quant_core.event_digest."""
    return _shared_canonical_digest(events)


def select_engine(replay_config: dict | None, bot_spec_id: str | None) -> str:
    """Pick the engine that PRODUCED the run, from its persisted provenance.

    Bot/algo runs are tagged ``replay_config_json.run_kind in {bot_backtest, bot_paper}`` and/or
    carry a ``bot_spec_id``. Everything else is a simple single-signal EventBacktestEngine run."""
    rc = replay_config or {}
    run_kind = str(rc.get("run_kind") or "")
    if run_kind.startswith("bot") or rc.get("replay_mode") == "paper_runtime_event_replay":
        return ENGINE_PAPER_RUNTIME_BOT
    if bot_spec_id:
        return ENGINE_PAPER_RUNTIME_BOT
    return ENGINE_EVENT_BACKTEST


@dataclass
class BotReplayResult:
    ok: bool
    events: list[dict] = field(default_factory=list)
    event_digest: str | None = None            # raw digest (process-local order IDs)
    canonical_event_digest: str | None = None  # cross-process-stable digest (canonicalized IDs)
    final_equity: str | None = None
    fill_model: dict = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)
    reason: str | None = None  # machine reason code when ok is False


def _bars_from(rows: list[dict]) -> list[RuntimeBar]:
    return [
        RuntimeBar(
            ts=datetime.fromtimestamp(int(b["ts"]) / 1000, tz=timezone.utc),
            open=Decimal(str(b["open"])), high=Decimal(str(b["high"])),
            low=Decimal(str(b["low"])), close=Decimal(str(b["close"])),
            volume=Decimal(str(b.get("volume", "0"))),
        )
        for b in rows
    ]


def _funding_from(rows: list[dict]) -> list[FundingRow]:
    return [
        FundingRow(
            id=str(f.get("id", f"f_{i}")),
            timestamp=datetime.fromtimestamp(int(f["timestamp"]) / 1000, tz=timezone.utc),
            funding_rate=Decimal(str(f["funding_rate"])),
        )
        for i, f in enumerate(rows, start=1)
    ]


def replay_bot_run(config_json: dict) -> BotReplayResult:
    """Re-run a bot/algo passport via the SAME ``run_bot``/``PaperRuntime`` path that produced it,
    reconstructing every fidelity input captured in ``config_json`` (the persisted
    ``BotRunPayload.model_dump()``): spec, bars, funding, fees, slippage, starting equity, risk,
    venue-exact/vip_tier/category/order-semantics, and latency.

    L2/queue fidelity needs the DB-backed provider, which the pure core cannot build — those runs
    return ``ok=False`` with ``REASON_L2_NEEDS_DB`` so the endpoint can supply a provider (it has a
    DB connection) rather than the core silently degrading to bar-based (which would be a false
    verification). bar_based bots — the common case — replay fully here.
    """
    from quant_core.bot_os import BotSpec, build_bot, run_bot, spec_hash as v4_spec_hash, TEMPLATES

    spec_d = config_json.get("spec") or {}
    bot_type = str(spec_d.get("bot_type", ""))
    if bot_type not in {t["bot_type"] for t in TEMPLATES}:
        return BotReplayResult(ok=False, reason=REASON_UNKNOWN_BOT_TYPE)

    fidelity = str(config_json.get("execution_fidelity", "bar_based"))
    venue_exact = bool(config_json.get("venue_exact", False))
    # L2/queue fidelity needs the recorded provider; venue_exact needs the instrument/risk
    # snapshots — both DB-backed. Defer to the endpoint rather than replay a different (bar-based)
    # path, which would falsely "verify" a run that was actually produced differently.
    if fidelity != "bar_based" or venue_exact:
        return BotReplayResult(ok=False, reason=REASON_NEEDS_DB_PROVIDER)
    if config_json.get("enable_latency_model"):
        return BotReplayResult(ok=False, reason=REASON_LATENCY_NOT_CAPTURED)

    spec = BotSpec(
        bot_type=bot_type, name=str(spec_d.get("name", "untitled")),
        symbols=list(spec_d.get("symbols", [])), params=dict(spec_d.get("params", {})),
        risk=dict(spec_d.get("risk", {})), accounting=dict(spec_d.get("accounting", {})),
    )
    bot = build_bot(spec.bot_type, spec.params)
    bars = _bars_from(config_json.get("bars", []))
    funding = _funding_from(config_json.get("funding_rows", []))
    side_bars = {sym: _bars_from(rows) for sym, rows in (config_json.get("side_bars") or {}).items()}

    # Plain bar_based bot: reproduce exactly the args bots_run used for this case (no provider,
    # no venue knobs, no latency unless captured) → byte-identical event stream.
    report, _ = run_bot(
        spec=spec, bot=bot, symbol=str(config_json.get("symbol", "BTCUSDT")),
        bars=bars, funding_rows=funding,
        starting_equity=Decimal(str(config_json.get("starting_equity", "10000"))),
        risk=dict(config_json.get("risk", {})),
        fee_bps_taker=Decimal(str(config_json.get("fee_bps_taker", "5.5"))),
        fee_bps_maker=Decimal(str(config_json.get("fee_bps_maker", "1.0"))),
        slippage_bps_one_way=Decimal(str(config_json.get("slippage_bps_one_way", "2.0"))),
        spec_hash_value=v4_spec_hash(spec),
        compiler_version=str(config_json.get("compiler_version", "")) or _compiler_version(),
        side_bars=side_bars,
    )
    interval_minutes = max(1, int(config_json.get("interval_minutes", 15)))
    perf = compute_performance(report.equity_curve, report.trade_pnls,
                               bars_per_year=365 * 24 * 60 / interval_minutes)
    return BotReplayResult(
        ok=True, events=report.events,
        event_digest=events_digest(report.events),
        canonical_event_digest=canonical_events_digest(report.events),
        final_equity=str(report.final_equity), fill_model=report.fill_model,
        metrics={
            "total_return_after_fees_funding": perf.total_return,
            "sharpe": perf.sharpe, "sortino": perf.sortino, "calmar": perf.calmar,
            "max_drawdown": perf.max_drawdown,
            "liquidation_events": len([e for e in report.events if e.get("type") == "LIQUIDATION"]),
            "fills_count": len(report.fills),
        },
    )


def _compiler_version() -> str:
    try:
        from quant_core.bot_os import COMPILER_VERSION
        return COMPILER_VERSION
    except Exception:
        return ""


@dataclass
class CompareResult:
    events_match: bool
    metrics_match: bool
    reasons: list[str] = field(default_factory=list)


def compare_replay(
    *, stored_event_digest: str | None, recomputed_event_digest: str | None,
    stored_metrics: dict, recomputed_metrics: dict,
    tol: float = METRIC_ABS_TOLERANCE,
) -> CompareResult:
    """Events/fills are compared byte-exact (via the digest); the gating scalar
    ``total_return_after_fees_funding`` is compared within ``tol`` (§21).

    Pass CANONICAL digests (``canonical_events_digest`` of both stored and replayed event
    streams) so the byte-for-byte comparison is robust to the process-global order-ID counter;
    raw ``events_digest`` comparison only agrees when both processes started the counter identically.
    """
    reasons: list[str] = []
    events_match = bool(stored_event_digest) and stored_event_digest == recomputed_event_digest
    if not events_match:
        reasons.append("EVENT_DIGEST_MISMATCH")
    key = "total_return_after_fees_funding"
    sm = float(stored_metrics.get(key, 0.0) or 0.0)
    rm = float(recomputed_metrics.get(key, 0.0) or 0.0)
    metrics_match = abs(sm - rm) <= tol
    if not metrics_match:
        reasons.append(f"METRIC_MISMATCH:{key}:{sm}!={rm}")
    return CompareResult(events_match=events_match, metrics_match=metrics_match, reasons=reasons)
