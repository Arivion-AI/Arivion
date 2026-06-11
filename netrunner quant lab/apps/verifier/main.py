from __future__ import annotations

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from decimal import Decimal

import asyncpg
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel, Field
from prometheus_client import Counter, CONTENT_TYPE_LATEST, generate_latest

from quant_core.engine import BacktestBar, EventBacktestEngine, FundingRow
from quant_core.performance import METRIC_ABS_TOLERANCE

import replay_core

app = FastAPI(title="Duality Verifier")

verification_counter = Counter(
    "duality_verifier_requests_total",
    "Verifier outcomes",
    ["status", "reason"],
)
run_hash_mismatch_counter = Counter(
    "duality_verifier_run_hash_mismatch_total",
    "Run hash mismatches detected by verifier",
)
local_summary_mismatch_counter = Counter(
    "duality_verifier_local_summary_mismatch_total",
    "Submitted local summary mismatches canonical replay summary",
)


class VerifyPassportPayload(BaseModel):
    runId: str
    strategyVersionId: str
    submittedRunHash: str
    submittedStrategyHash: str
    requestedTier: str = "BACKTEST_VERIFIED"
    dataSnapshotId: str = "canonical-v1"
    localRunSummary: dict = Field(default_factory=dict)
    submittedEngineVersion: str | None = None
    submittedCompilerVersion: str | None = None
    submittedDataVersion: str | None = None
    canonicalEngineVersion: str = "quant-core-phase3-v2"
    canonicalCompilerVersion: str = "bot-spec-compiler-v4.1.0"
    canonicalDataVersion: str = "canonical-v1"


def _db_url() -> str:
    return os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")


def _signing_key() -> bytes:
    return os.getenv("VERIFIER_SIGNING_KEY", "REDACTED_VERIFIER_SIGNING_KEY").encode("utf-8")


def _stable_hash(payload: object) -> str:
    if isinstance(payload, str):
        serialized = payload
    else:
        serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _strategy_hash(row_hash: str | None, dsl_json: object | None) -> str:
    if row_hash:
        return row_hash
    if isinstance(dsl_json, str):
        try:
            dsl_json = json.loads(dsl_json)
        except json.JSONDecodeError:
            dsl_json = {"raw": dsl_json}
    if not isinstance(dsl_json, dict):
        dsl_json = {}
    return _stable_hash(dsl_json)


def _verification_signature(*, run_id: str, tier: str, official_score: float, snapshot_id: str, strategy_hash: str) -> str:
    message = f"{run_id}|{tier}|{official_score:.8f}|{snapshot_id}|{strategy_hash}"
    return hmac.new(_signing_key(), message.encode("utf-8"), hashlib.sha256).hexdigest()


def _to_dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def _as_dict(v) -> dict:
    """asyncpg may return JSONB as a str or an already-parsed dict — normalize to dict."""
    if v is None:
        return {}
    if isinstance(v, dict):
        return v
    try:
        out = json.loads(v)
        return out if isinstance(out, dict) else {}
    except (TypeError, ValueError):
        return {}


def _verify_bot_passport(row, payload: "VerifyPassportPayload") -> dict:
    """Verify a bot/algo passport by REPLAYING PaperRuntime (run_bot) — the same engine that
    produced it — and comparing the cross-process-stable canonical event digest byte-for-byte plus
    the gating metric within ``METRIC_ABS_TOLERANCE`` (§21). Never falls back to EventBacktestEngine.
    """
    replay_meta = _as_dict(row["replay_config_json"])
    run_kind = str(replay_meta.get("run_kind") or "")
    config_json = _as_dict(row["config_json"])

    # Engine-agnostic provenance gates (same as the simple path).
    canonical_snapshot = row["data_snapshot_id"] or "canonical-v1"
    if payload.dataSnapshotId != canonical_snapshot:
        verification_counter.labels("rejected", "DATA_SNAPSHOT_MISMATCH").inc()
        return {"status": "rejected", "reason": "DATA_SNAPSHOT_MISMATCH", "canonicalSnapshotId": canonical_snapshot}
    if row["run_hash"] and payload.submittedRunHash != row["run_hash"]:
        run_hash_mismatch_counter.inc()
        verification_counter.labels("rejected", "RUN_HASH_MISMATCH").inc()
        return {"status": "rejected", "reason": "RUN_HASH_MISMATCH", "expectedRunHash": row["run_hash"]}

    # Replay via the SAME engine. bar_based bots replay fully here; L2/venue/latency runs need
    # DB-backed inputs and are honestly deferred with a machine reason code (never false-verified).
    replay = replay_core.replay_bot_run(config_json)
    if not replay.ok:
        verification_counter.labels("rejected", replay.reason or "BOT_REPLAY_DEFERRED").inc()
        return {"status": "rejected", "reason": "BOT_REPLAY_NOT_REPRODUCIBLE", "detail": replay.reason}

    stored_canonical = row["canonical_event_digest"]
    if not stored_canonical:
        # Legacy bot run persisted before canonical digests existed — cannot verify its events.
        verification_counter.labels("rejected", "CANONICAL_DIGEST_NOT_RECORDED").inc()
        return {"status": "rejected", "reason": "CANONICAL_EVENT_DIGEST_NOT_RECORDED",
                "detail": "Re-run the bot to record a reproducible event digest."}

    cmp = replay_core.compare_replay(
        stored_event_digest=stored_canonical,
        recomputed_event_digest=replay.canonical_event_digest,
        stored_metrics=_as_dict(row["metrics_json"]),
        recomputed_metrics=replay.metrics,
    )
    if not (cmp.events_match and cmp.metrics_match):
        run_hash_mismatch_counter.inc()
        verification_counter.labels("rejected", "BOT_REPLAY_MISMATCH").inc()
        return {"status": "rejected", "reason": "BOT_REPLAY_MISMATCH", "details": cmp.reasons,
                "expectedCanonicalDigest": stored_canonical,
                "recomputedCanonicalDigest": replay.canonical_event_digest}

    official_score = float(replay.metrics.get("total_return_after_fees_funding", 0.0))
    strategy_hash_at_run = _strategy_hash(row["strategy_hash_at_run"], row["dsl_json"])
    tier = "LIVE PAPER VERIFIED" if run_kind == "bot_paper" else "BACKTEST VERIFIED"
    signature = _verification_signature(
        run_id=payload.runId, tier=tier, official_score=official_score,
        snapshot_id=canonical_snapshot, strategy_hash=strategy_hash_at_run,
    )
    verification_counter.labels("verified", "OK").inc()
    return {
        "status": "verified",
        "tier": tier,
        "engine": "paper_runtime_bot",
        "officialScore": official_score,
        "verificationHash": signature,
        "officialSummary": {
            "total_return_after_fees_funding": replay.metrics.get("total_return_after_fees_funding"),
            "sharpe": replay.metrics.get("sharpe"),
            "sortino": replay.metrics.get("sortino"),
            "max_drawdown": replay.metrics.get("max_drawdown"),
            "canonical_snapshot_id": canonical_snapshot,
            "verified_at": datetime.now(tz=timezone.utc).isoformat(),
            "canonical_event_digest": replay.canonical_event_digest,
            "metric_comparison_tolerance": METRIC_ABS_TOLERANCE,
            "fill_model": replay.fill_model,
        },
        "ignoredLocalSummary": payload.localRunSummary,
    }


def _compute_backtest_metrics(result) -> dict:
    fills_count = len(result.fills)
    liquidation_events = len(result.liquidations)
    total_pnl = Decimal("0")
    if result.fills:
        first_fill = result.fills[0].payload
        side = str(first_fill.get("side", "long"))
        qty = Decimal(str(first_fill.get("qty", "0")))
        entry = Decimal(str(first_fill.get("fill_price", "0")))
        exit_price = entry
        if result.exits:
            exit_price = Decimal(str(result.exits[-1].payload.get("exit_price", entry)))
        sign = Decimal("1") if side == "long" else Decimal("-1")
        total_pnl += (exit_price - entry) * qty * sign
        notional = abs(entry * qty)
    else:
        notional = Decimal("1")

    funding_pnl = Decimal("0")
    for fe in result.funding_events:
        amount = Decimal(str(fe.payload.get("amount", "0")))
        funding_pnl += -amount
    total_pnl += funding_pnl

    total_return = float((total_pnl / max(notional, Decimal("1"))))
    # Honesty (P0.2/P0.3): the simple single-signal engine has no equity curve to derive risk-
    # adjusted ratios from, so Sharpe/Sortino/drawdown are NOT computable here. Report them as
    # not-computed rather than fabricating them (the prior code returned total_return*2.0 and
    # abs(total_return)*0.5 — invented numbers). Only total_return is the gated/compared scalar.
    return {
        "total_return_after_fees_funding": total_return,
        "sharpe": None,
        "sortino": None,
        "max_drawdown": None,
        "metrics_not_computed": ["sharpe", "sortino", "max_drawdown"],
        "metrics_not_computed_reason": "SINGLE_SIGNAL_ENGINE_NO_EQUITY_CURVE",
        "liquidation_events": liquidation_events,
        "approximate_fills": False,
    }


async def _fetch_canonical_bars_and_funding(conn: asyncpg.Connection, row: asyncpg.Record) -> tuple[list[BacktestBar], list[FundingRow], dict]:
    config_json = row["config_json"] or {}
    coverage = row["coverage_proof_json"] or {}
    symbol = str(coverage.get("symbol") or config_json.get("symbol") or "BTCUSDT")
    category = str(coverage.get("category") or config_json.get("category") or "linear")
    interval = str(coverage.get("interval") or config_json.get("interval") or "15")
    start_ts = int(coverage.get("startTs") or 0)
    end_ts = int(coverage.get("endTs") or 0)

    bars: list[BacktestBar] = []
    if start_ts > 0 and end_ts > 0:
        rows = await conn.fetch(
            """
            SELECT EXTRACT(EPOCH FROM open_time) * 1000 AS ts_ms, open, high, low, close
            FROM candles
            WHERE symbol = $1
              AND category = $2
              AND interval = $3
              AND open_time BETWEEN to_timestamp($4 / 1000.0) AND to_timestamp($5 / 1000.0)
            ORDER BY open_time ASC
            """,
            symbol,
            category,
            interval,
            start_ts,
            end_ts,
        )
        bars = [
            BacktestBar(
                ts=_to_dt(int(r["ts_ms"])),
                open=Decimal(str(r["open"])),
                high=Decimal(str(r["high"])),
                low=Decimal(str(r["low"])),
                close=Decimal(str(r["close"])),
            )
            for r in rows
        ]

    if not bars:
        # fallback: replay against pinned run config bars if canonical slice unavailable
        local_bars = config_json.get("bars", [])
        bars = [
            BacktestBar(
                ts=_to_dt(int(r["ts"])),
                open=Decimal(str(r["open"])),
                high=Decimal(str(r["high"])),
                low=Decimal(str(r["low"])),
                close=Decimal(str(r["close"])),
            )
            for r in local_bars
        ]

    funding_rows: list[FundingRow] = []
    if start_ts > 0 and end_ts > 0:
        fr = await conn.fetch(
            """
            SELECT EXTRACT(EPOCH FROM funding_rate_timestamp) * 1000 AS ts_ms, funding_rate
            FROM funding_rates
            WHERE symbol = $1
              AND category = $2
              AND funding_rate_timestamp BETWEEN to_timestamp($3 / 1000.0) AND to_timestamp($4 / 1000.0)
            ORDER BY funding_rate_timestamp ASC
            """,
            symbol,
            category,
            start_ts,
            end_ts,
        )
        funding_rows = [
            FundingRow(
                id=f"f_{idx}",
                timestamp=_to_dt(int(r["ts_ms"])),
                funding_rate=Decimal(str(r["funding_rate"])),
            )
            for idx, r in enumerate(fr, start=1)
        ]

    if not funding_rows:
        local_funding = config_json.get("fundingRows", [])
        funding_rows = [
            FundingRow(id=str(r.get("id", f"f_{i}")), timestamp=_to_dt(int(r["timestamp"])), funding_rate=Decimal(str(r["funding_rate"])))
            for i, r in enumerate(local_funding, start=1)
        ]

    return bars, funding_rows, {
        "symbol": symbol,
        "category": category,
        "interval": interval,
        "start_ts": start_ts,
        "end_ts": end_ts,
    }


@app.get("/health")
async def health() -> dict:
    conn = await asyncpg.connect(_db_url())
    try:
        await conn.fetchval("SELECT 1")
    finally:
        await conn.close()
    return {"ok": True, "service": "verifier", "db": "up"}


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/verify/passport")
async def verify_passport(payload: VerifyPassportPayload) -> dict:
    conn = await asyncpg.connect(_db_url())
    try:
        row = await conn.fetchrow(
            """
            SELECT
              br.run_id, br.strategy_version_id, br.config_json, br.metrics_json, br.coverage_proof_json, br.run_hash, br.strategy_hash_at_run, br.data_snapshot_id,
              br.engine_version, br.data_version, br.compiler_version, br.event_digest,
              br.replay_config_json, br.bot_spec_id, br.canonical_event_digest,
              sv.hash AS strategy_hash_current, sv.dsl_json
            FROM backtest_runs br
            JOIN strategy_versions sv ON sv.strategy_version_id = br.strategy_version_id
            WHERE br.run_id = $1 AND br.strategy_version_id = $2
            LIMIT 1
            """,
            payload.runId,
            payload.strategyVersionId,
        )
        if row is None:
            verification_counter.labels("rejected", "RUN_OR_STRATEGY_NOT_FOUND").inc()
            return {"status": "rejected", "reason": "RUN_OR_STRATEGY_NOT_FOUND"}

        # P0.2 — re-run the SAME engine that produced the result. Bot/algo runs (PaperRuntime via
        # run_bot) MUST be replayed by run_bot, NOT the simple single-signal EventBacktestEngine.
        if replay_core.select_engine(_as_dict(row["replay_config_json"]), row["bot_spec_id"]) \
                == replay_core.ENGINE_PAPER_RUNTIME_BOT:
            return _verify_bot_passport(row, payload)

        bars, funding_rows, replay_meta = await _fetch_canonical_bars_and_funding(conn, row)
        if len(bars) < 2:
            verification_counter.labels("rejected", "CANONICAL_DATA_UNAVAILABLE").inc()
            return {"status": "rejected", "reason": "CANONICAL_DATA_UNAVAILABLE"}

        config_json = row["config_json"] or {}
        signal_idx = int(config_json.get("signalBarIndex", 0))
        side = str(config_json.get("side", "long"))
        qty = Decimal(str(config_json.get("qty", "1")))
        slippage = Decimal(str(config_json.get("slippageBpsOneWay", "0")))
        category = str(config_json.get("category", "linear"))

        mark_by_ts = {b.ts: b.close for b in bars}

        def mark_lookup(_symbol: str, ts: datetime) -> Decimal:
            if ts in mark_by_ts:
                return mark_by_ts[ts]
            prior = [b for b in bars if b.ts <= ts]
            if prior:
                return prior[-1].close
            return bars[0].close

        engine = EventBacktestEngine(engine_version=str(row["engine_version"] or payload.canonicalEngineVersion))
        result = engine.run(
            symbol=replay_meta["symbol"],
            bars=bars,
            funding_rows=funding_rows,
            mark_price_lookup=mark_lookup,
            signals={signal_idx: side},
            slippage_bps_one_way=slippage,
            qty=qty,
            category=category,  # type: ignore[arg-type]
            seed=42,
        )
        replay_metrics = _compute_backtest_metrics(result)
        replay_event_digest = _stable_hash(
            [
                {
                    "event_type": evt.event_type,
                    "event_ts": evt.event_ts.isoformat(),
                    "payload": evt.payload,
                }
                for evt in result.events
            ]
        )
        canonical_snapshot = row["data_snapshot_id"] or "canonical-v1"
        strategy_hash_at_run = _strategy_hash(row["strategy_hash_at_run"], row["dsl_json"])
        strategy_hash_current = _strategy_hash(row["strategy_hash_current"], row["dsl_json"])
        computed_run_hash = _stable_hash(
            {
                "strategy_version_id": row["strategy_version_id"],
                "symbol": config_json.get("symbol", replay_meta["symbol"]),
                "category": config_json.get("category", replay_meta["category"]),
                "interval_minutes": config_json.get("intervalMinutes", 15),
                "data_version": row["data_version"],
                "engine_version": row["engine_version"],
                "seed": config_json.get("seed", 42),
                "coverage_proof": row["coverage_proof_json"] or {},
                "config": config_json,
                "event_digest": replay_event_digest,
            }
        )
        run_hash_expected = row["run_hash"] or computed_run_hash
        if row["run_hash"] and row["run_hash"] != computed_run_hash:
            run_hash_mismatch_counter.inc()
            verification_counter.labels("rejected", "RUN_HASH_MISMATCH").inc()
            return {"status": "rejected", "reason": "RUN_HASH_MISMATCH"}

        if payload.dataSnapshotId != canonical_snapshot:
            verification_counter.labels("rejected", "DATA_SNAPSHOT_MISMATCH").inc()
            return {"status": "rejected", "reason": "DATA_SNAPSHOT_MISMATCH", "canonicalSnapshotId": canonical_snapshot}
        if payload.submittedRunHash != run_hash_expected:
            run_hash_mismatch_counter.inc()
            verification_counter.labels("rejected", "RUN_HASH_MISMATCH").inc()
            return {"status": "rejected", "reason": "RUN_HASH_MISMATCH", "expectedRunHash": run_hash_expected}
        if payload.submittedStrategyHash != strategy_hash_at_run:
            verification_counter.labels("rejected", "STRATEGY_HASH_MISMATCH").inc()
            return {"status": "rejected", "reason": "STRATEGY_HASH_MISMATCH"}
        if strategy_hash_current != strategy_hash_at_run:
            verification_counter.labels("rejected", "VERSION_MODIFIED_AFTER_RUN_HASH").inc()
            return {"status": "rejected", "reason": "VERSION_MODIFIED_AFTER_RUN_HASH"}
        if payload.requestedTier == "LIVE_PAPER_VERIFIED":
            verification_counter.labels("rejected", "LIVE_PAPER_NOT_HOSTED_FROM_START").inc()
            return {"status": "rejected", "reason": "LIVE_PAPER_NOT_HOSTED_FROM_START"}

        if payload.submittedEngineVersion and payload.submittedEngineVersion != payload.canonicalEngineVersion:
            verification_counter.labels("rejected", "ENGINE_VERSION_MISMATCH").inc()
            return {
                "status": "rejected",
                "reason": "ENGINE_VERSION_MISMATCH",
                "expected": payload.canonicalEngineVersion,
                "submitted": payload.submittedEngineVersion,
            }
        if payload.submittedCompilerVersion and payload.submittedCompilerVersion != payload.canonicalCompilerVersion:
            verification_counter.labels("rejected", "COMPILER_VERSION_MISMATCH").inc()
            return {
                "status": "rejected",
                "reason": "COMPILER_VERSION_MISMATCH",
                "expected": payload.canonicalCompilerVersion,
                "submitted": payload.submittedCompilerVersion,
            }
        if payload.submittedDataVersion and payload.submittedDataVersion != payload.canonicalDataVersion:
            verification_counter.labels("rejected", "DATA_VERSION_MISMATCH").inc()
            return {
                "status": "rejected",
                "reason": "DATA_VERSION_MISMATCH",
                "expected": payload.canonicalDataVersion,
                "submitted": payload.submittedDataVersion,
            }

        local_return = float(payload.localRunSummary.get("total_return_after_fees_funding", 0.0))
        if abs(local_return - replay_metrics["total_return_after_fees_funding"]) > 1e-9:
            local_summary_mismatch_counter.inc()
            verification_counter.labels("rejected", "LOCAL_SUMMARY_MISMATCH").inc()
            return {
                "status": "rejected",
                "reason": "LOCAL_SUMMARY_MISMATCH",
                "expected": replay_metrics["total_return_after_fees_funding"],
                "submitted": local_return,
            }

        official_score = float(replay_metrics["total_return_after_fees_funding"])
        tier = "BACKTEST VERIFIED"
        signature = _verification_signature(
            run_id=payload.runId,
            tier=tier,
            official_score=official_score,
            snapshot_id=canonical_snapshot,
            strategy_hash=strategy_hash_at_run,
        )
        now_iso = datetime.now(tz=timezone.utc).isoformat()
        verification_counter.labels("verified", "OK").inc()

        return {
            "status": "verified",
            "tier": tier,
            "officialScore": official_score,
            "verificationHash": signature,
            "officialSummary": {
                "total_return_after_fees_funding": replay_metrics["total_return_after_fees_funding"],
                "sharpe": replay_metrics["sharpe"],
                "max_drawdown": replay_metrics["max_drawdown"],
                "canonical_snapshot_id": canonical_snapshot,
                "verified_at": now_iso,
                "replay_event_digest": replay_event_digest,
            },
            "ignoredLocalSummary": payload.localRunSummary,
        }
    finally:
        await conn.close()
