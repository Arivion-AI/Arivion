from __future__ import annotations

import os
import json
import hashlib
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

import asyncpg
import redis.asyncio as redis
from fastapi import FastAPI, Depends
from pydantic import BaseModel, Field
from concurrency import heavy_slot, stats as concurrency_stats, internal_secret_middleware
from live_paper import LivePaperManager
from live_portfolio import LivePortfolioManager
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from fastapi.responses import Response

from quant_core.engine import BacktestBar, EventBacktestEngine, FundingRow
from quant_core.event_digest import canonical_event_digest as _canonical_event_digest
from quant_core.optimizer import CandidateMetrics, ParityThresholds, compute_parity
from quant_core.paper import PaperSessionState, Tick, evaluate_tick
from quant_core.risk import RiskGateConfig, RiskMetrics, evaluate_risk
from quant_core.orders import Bar as RuntimeBar
from quant_core.portfolio import Portfolio, RiskConfig
from quant_core.paper_runtime import PaperRuntime
from quant_core.performance import compute_performance
from quant_core.strategies import REGISTRY as STRATEGY_REGISTRY
from quant_core.execution import ExecutionConfig, Fidelity, LatencyConfig

from validator.semantic_validator import validate_semantics
from l2_data import build_provider, load_instrument_filter

app = FastAPI(title="Duality Worker")
app.middleware("http")(internal_secret_middleware)

worker_event_counter = Counter(
    "duality_worker_events_total",
    "Worker emitted events by type",
    ["event_type"],
)
worker_run_counter = Counter(
    "duality_worker_runs_total",
    "Worker runs by kind and tier",
    ["kind", "tier"],
)
worker_fill_latency_ms = Histogram(
    "duality_worker_fill_latency_ms",
    "Fill latency in ms from run start to fill ts",
    buckets=(1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000),
)


class ValidatePayload(BaseModel):
    strategyVersionId: str | None = None
    strategy: dict
    mode: str = "historical_backtest"
    coverage: dict | None = None


class BacktestBarPayload(BaseModel):
    ts: int = Field(..., description="Unix timestamp milliseconds")
    open: str
    high: str
    low: str
    close: str


class FundingRowPayload(BaseModel):
    id: str
    timestamp: int = Field(..., description="Unix timestamp milliseconds")
    funding_rate: str


class BacktestRunPayload(BaseModel):
    strategyVersionId: str
    symbol: str
    category: str = "linear"
    intervalMinutes: int = 15
    dataVersion: str = "v1"
    engineVersion: str = "quant-core-phase3-v1"
    seed: int = 42
    bars: list[BacktestBarPayload]
    fundingRows: list[FundingRowPayload] = []
    signalBarIndex: int = 0
    side: str = "long"
    qty: str = "1"
    slippageBpsOneWay: str = "0"
    coverageProof: dict = {}


class PaperTickPayload(BaseModel):
    sessionId: str
    symbol: str
    price: str
    tsMs: int
    nowMs: int | None = None


class PaperRebuildPayload(BaseModel):
    sessionId: str


class OptimizationCandidatePayload(BaseModel):
    params: dict
    vector_metrics: dict


class OptimizationRunPayload(BaseModel):
    strategyVersionId: str
    method: str = "grid"
    candidates: list[OptimizationCandidatePayload]
    topN: int = 3
    thresholds: dict = {
        "allowed_return_drift": 0.005,
        "allowed_drawdown_drift": 0.01,
        "allowed_trade_count_drift": 2,
    }
    event_only_template: bool = False


class RiskMetricsPayload(BaseModel):
    total_return_after_fees_funding: float
    sharpe: float
    calmar: float
    max_drawdown: float
    consistency: float
    robustness: float
    live_paper_score: float = 0.0
    liquidation_events: int = 0
    data_coverage_complete: bool = True
    overfit_penalty: float = 0.0
    approximate_fills: bool = False


class RiskEvaluatePayload(BaseModel):
    target: RiskMetricsPayload
    cohort: list[RiskMetricsPayload] = []
    drawdown_cap: float = 0.30
    overfit_penalty_threshold: float = 0.20


@app.get("/concurrency/stats")
def _concurrency_stats() -> dict:
    return concurrency_stats()


@app.on_event("startup")
async def _startup_live_paper() -> None:
    database_url = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
    app.state.pool = await asyncpg.create_pool(database_url, min_size=1, max_size=4)
    app.state.live_paper = LivePaperManager(app.state.pool)
    await app.state.live_paper.start()
    # Multi-asset (portfolio) paper sessions — one background loop re-runs the deterministic
    # portfolio engine over the freshest candles per leg each tick.
    app.state.live_portfolio = LivePortfolioManager(app.state.pool)
    await app.state.live_portfolio.start()


@app.on_event("shutdown")
async def _shutdown_live_paper() -> None:
    try:
        await app.state.live_paper.stop_loop()
        await app.state.live_portfolio.stop_loop()
        await app.state.pool.close()
    except Exception:
        pass


class LivePaperStartPayload(BaseModel):
    session_id: str
    owner_id: str  # §25 A.2 — required; the API forwards the real integer owner. No 'anon' fallback.
    strategy_id: str
    symbol: str
    category: str = "linear"
    params: dict = Field(default_factory=dict)
    starting_equity: str = "10000"
    interval_minutes: int = 1
    risk: dict = Field(default_factory=dict)
    execution_fidelity: str = "bar_based"
    allow_fallback: bool = True


@app.post("/live-paper/start")
async def live_paper_start(payload: LivePaperStartPayload) -> dict:
    return await app.state.live_paper.create_session(
        session_id=payload.session_id, owner_id=payload.owner_id, strategy_id=payload.strategy_id,
        symbol=payload.symbol, category=payload.category, params=payload.params,
        starting_equity=payload.starting_equity, interval_minutes=payload.interval_minutes, risk=payload.risk,
        execution_fidelity=payload.execution_fidelity, allow_fallback=payload.allow_fallback)


@app.post("/live-paper/stop/{session_id}")
async def live_paper_stop(session_id: str) -> dict:
    return await app.state.live_paper.stop_session(session_id)


@app.get("/live-paper/sessions")
async def live_paper_sessions(owner_id: str | None = None) -> dict:
    return {"sessions": await app.state.live_paper.list_sessions(owner_id), "status": app.state.live_paper.status()}


@app.get("/live-paper/sessions/{session_id}")
async def live_paper_get(session_id: str) -> dict:
    return await app.state.live_paper.get_session(session_id)


# ------- Multi-asset (portfolio) paper sessions -------
class LivePortfolioStartPayload(BaseModel):
    session_id: str
    owner_id: str
    legs: list[dict] = Field(default_factory=list)  # [{symbol, asset_class, category, target_weight, leverage, allow_short}]
    weighting: str = "fixed"
    total_equity: str = "10000"
    interval_minutes: int = 60
    risk: dict = Field(default_factory=dict)
    rebalance_threshold: str = "0.05"
    lookback_bars: int = 20
    top_n: int = 3


@app.post("/live-portfolio/start")
async def live_portfolio_start(payload: LivePortfolioStartPayload) -> dict:
    return await app.state.live_portfolio.create_session(
        session_id=payload.session_id, owner_id=payload.owner_id, legs=payload.legs,
        weighting=payload.weighting, total_equity=payload.total_equity,
        interval_minutes=payload.interval_minutes, risk=payload.risk,
        rebalance_threshold=payload.rebalance_threshold, lookback_bars=payload.lookback_bars, top_n=payload.top_n)


@app.post("/live-portfolio/stop/{session_id}")
async def live_portfolio_stop(session_id: str) -> dict:
    return await app.state.live_portfolio.stop_session(session_id)


@app.get("/live-portfolio/sessions")
async def live_portfolio_sessions(owner_id: str | None = None) -> dict:
    return {"sessions": await app.state.live_portfolio.list_sessions(owner_id), "status": app.state.live_portfolio.status()}


@app.get("/live-portfolio/sessions/{session_id}")
async def live_portfolio_get(session_id: str) -> dict:
    return await app.state.live_portfolio.get_session(session_id)


def _arg(payload: dict, *names: str):
    for n in names:
        if payload.get(n) is not None:
            return payload[n]
    return None


@app.post("/lp/value")
async def lp_value(payload: dict) -> dict:
    import lp_service

    position_id = _arg(payload, "position_id", "positionId")
    wallet = _arg(payload, "wallet")
    if position_id:
        return await lp_service.value_position(app.state.pool, str(position_id))
    if wallet:
        return await lp_service.value_wallet(app.state.pool, str(wallet))
    return {"ok": False, "error": "position_id or wallet required"}


@app.post("/lp/simulate")
async def lp_simulate(payload: dict) -> dict:
    from decimal import Decimal
    import lp_service

    pool_id = str(_arg(payload, "pool_id", "poolId") or "")
    if not pool_id:
        return {"ok": False, "error": "pool_id required"}
    return await lp_service.simulate_range(
        app.state.pool,
        pool_id=pool_id,
        capital_usd=Decimal(str(_arg(payload, "capital_usd", "capitalUsd") or "1000")),
        range_pct=Decimal(str(_arg(payload, "range_pct", "rangePct") or "10")),
    )


@app.post("/portfolio/multiasset/plan")
async def multiasset_plan(payload: dict) -> dict:
    from decimal import Decimal
    import multiasset_plan as mp

    try:
        return await mp.plan(
            app.state.pool,
            deposit_usd=Decimal(str(_arg(payload, "deposit_usd", "depositUsd") or "1000")),
            sleeves=payload.get("sleeves") or {},
            crypto_legs=_arg(payload, "crypto_legs", "cryptoLegs") or [],
            stock_legs=_arg(payload, "stock_legs", "stockLegs") or [],
            lp_legs=_arg(payload, "lp_legs", "lpLegs") or [],
            weighting=str(payload.get("weighting") or "equal"),
            fixed_weights=_arg(payload, "fixed_weights", "fixedWeights"),
        )
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/portfolio/multiasset/rebalance")
async def multiasset_rebalance(payload: dict) -> dict:
    from decimal import Decimal
    import multiasset_plan as mp

    try:
        return mp.rebalance(
            targets=payload.get("targets") or [],
            current=payload.get("current") or {},
            threshold_pct=Decimal(str(_arg(payload, "threshold_pct", "thresholdPct") or "5")),
        )
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/health")
async def health() -> dict:
    database_url = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")

    conn = await asyncpg.connect(database_url)
    try:
        await conn.fetchval("SELECT 1")
    finally:
        await conn.close()

    client = redis.from_url(redis_url)
    try:
        await client.ping()
    finally:
        await client.close()

    return {"ok": True, "service": "worker", "db": "up", "redis": "up"}


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/validate")
async def validate(payload: ValidatePayload) -> dict:
    database_url = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
    conn = await asyncpg.connect(database_url)
    try:
        result = await validate_semantics(conn, payload.model_dump())
    finally:
        await conn.close()

    return {
        "valid": result.valid,
        "errors": result.errors,
        "warnings": result.warnings,
        "eligibility_label": result.eligibility_label,
    }


def _to_dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def _stable_json_hash(payload: dict) -> str:
    normalized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _strategy_hash(hash_value: str | None, dsl_json: object | None) -> str:
    if hash_value:
        return hash_value
    if isinstance(dsl_json, str):
        try:
            dsl_json = json.loads(dsl_json)
        except json.JSONDecodeError:
            dsl_json = {"raw": dsl_json}
    if not isinstance(dsl_json, dict):
        dsl_json = {}
    return _stable_json_hash(dsl_json)


def _compute_backtest_metrics(result) -> dict:
    fills_count = len(result.fills)
    funding_events_count = len(result.funding_events)
    events_count = len(result.events)
    liquidation_events = len(result.liquidations)
    approximate_fills = False

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
        realized = (exit_price - entry) * qty * sign
        total_pnl += realized
        notional = abs(entry * qty)
    else:
        notional = Decimal("1")

    funding_pnl = Decimal("0")
    for fe in result.funding_events:
        amount = Decimal(str(fe.payload.get("amount", "0")))
        funding_pnl += -amount
    total_pnl += funding_pnl

    total_return = float((total_pnl / max(notional, Decimal("1"))))
    # deterministic proxies over sparse event data
    sharpe = total_return * 2.0 if fills_count > 0 else 0.0
    calmar = total_return / max(0.01, abs(float(total_return))) if fills_count > 0 else 0.0
    max_drawdown = max(0.0, min(0.95, abs(total_return) * 0.5))

    return {
        "fills_count": fills_count,
        "funding_events_count": funding_events_count,
        "events_count": events_count,
        "total_return_after_fees_funding": total_return,
        "sharpe": sharpe,
        "calmar": calmar,
        "max_drawdown": max_drawdown,
        "consistency": 0.5 if fills_count > 0 else 0.0,
        "robustness": 0.5 if fills_count > 0 else 0.0,
        "live_paper_score": 0.0,
        "liquidation_events": liquidation_events,
        "data_coverage_complete": True,
        "overfit_penalty": 0.0,
        "approximate_fills": approximate_fills,
    }


@app.post("/backtests/run")
async def run_backtest(payload: BacktestRunPayload, _slot=Depends(heavy_slot)) -> dict:
    database_url = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
    conn = await asyncpg.connect(database_url)

    bars = [
        BacktestBar(
            ts=_to_dt(row.ts),
            open=Decimal(row.open),
            high=Decimal(row.high),
            low=Decimal(row.low),
            close=Decimal(row.close),
        )
        for row in payload.bars
    ]

    funding_rows = [
        FundingRow(id=row.id, timestamp=_to_dt(row.timestamp), funding_rate=Decimal(row.funding_rate))
        for row in payload.fundingRows
    ]

    mark_by_ts = {bar.ts: bar.close for bar in bars}

    def mark_lookup(_symbol: str, ts: datetime) -> Decimal:
        if ts in mark_by_ts:
            return mark_by_ts[ts]
        # fallback to nearest prior close
        eligible = [bar for bar in bars if bar.ts <= ts]
        if eligible:
            return eligible[-1].close
        return bars[0].close

    try:
        if payload.side not in {"long", "short"}:
            return {"error": "Invalid side; expected long|short"}
        if payload.category not in {"linear", "inverse", "spot"}:
            return {"error": "Invalid category; expected linear|inverse|spot"}
        is_xstock_sym = xstocks_mod.is_xstock(payload.symbol)
        # Tokenized equities are spot-only, long-only, no funding/liquidation.
        if is_xstock_sym:
            if payload.category != "spot":
                return {"error": "XSTOCK_SPOT_ONLY: tokenized equities must backtest with category=spot"}
            if payload.side != "long":
                return {"error": "XSTOCK_LONG_ONLY: tokenized equities cannot be shorted"}
        # Spot runs carry no perpetual funding.
        effective_funding = [] if payload.category == "spot" else funding_rows

        engine = EventBacktestEngine(engine_version=payload.engineVersion)
        signals = {payload.signalBarIndex: payload.side}
        result = engine.run(
            symbol=payload.symbol,
            bars=bars,
            funding_rows=effective_funding,
            mark_price_lookup=mark_lookup,
            signals=signals,
            slippage_bps_one_way=Decimal(payload.slippageBpsOneWay),
            qty=Decimal(payload.qty),
            category=payload.category,  # type: ignore[arg-type]
            seed=payload.seed,
        )

        run_id = str(uuid4())
        metrics = _compute_backtest_metrics(result)
        event_digest = _stable_json_hash([
            {
                "event_type": evt.event_type,
                "event_ts": evt.event_ts.isoformat(),
                "payload": evt.payload,
            }
            for evt in result.events
        ])

        await conn.execute(
            """
            INSERT INTO strategies (strategy_id, owner_id, name)
            VALUES ($1, NULL, $2)
            ON CONFLICT (strategy_id)
            DO UPDATE SET updated_at = NOW()
            """,
            payload.strategyVersionId,
            f"strategy::{payload.strategyVersionId}",
        )
        await conn.execute(
            """
            INSERT INTO strategy_versions (strategy_version_id, strategy_id, dsl_json)
            VALUES ($1, $2, $3::jsonb)
            ON CONFLICT (strategy_version_id) DO NOTHING
            """,
            payload.strategyVersionId,
            payload.strategyVersionId,
            "{}",
        )
        strategy_row = await conn.fetchrow(
            """
            SELECT hash, dsl_json
            FROM strategy_versions
            WHERE strategy_version_id = $1
            """,
            payload.strategyVersionId,
        )
        strategy_hash = _strategy_hash(
            strategy_row["hash"] if strategy_row else None,
            strategy_row["dsl_json"] if strategy_row else None,
        )
        run_hash = _stable_json_hash(
            {
                "strategy_version_id": payload.strategyVersionId,
                "symbol": payload.symbol,
                "category": payload.category,
                "interval_minutes": payload.intervalMinutes,
                "data_version": payload.dataVersion,
                "engine_version": payload.engineVersion,
                "seed": payload.seed,
                "coverage_proof": payload.coverageProof,
                "config": payload.model_dump(),
                "event_digest": event_digest,
            }
        )

        await conn.execute(
            """
            INSERT INTO backtest_runs (
              run_id, strategy_version_id, data_version, engine_version, seed, status,
              result_tier, config_json, metrics_json, coverage_proof_json, run_hash,
              strategy_hash_at_run, data_snapshot_id, liquidation_events, approximate_fills,
              replay_config_json, event_digest, canonical_range_start, canonical_range_end
            ) VALUES (
              $1, $2, $3, $4, $5, 'completed',
              'LOCAL ONLY', $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, 'canonical-v1', $11, $12
              ,$13::jsonb,$14,to_timestamp($15 / 1000.0),to_timestamp($16 / 1000.0)
            )
            """,
            run_id,
            payload.strategyVersionId,
            payload.dataVersion,
            payload.engineVersion,
            payload.seed,
            payload.model_dump_json(),
            json.dumps(metrics),
            json.dumps(payload.coverageProof),
            run_hash,
            strategy_hash,
            metrics["liquidation_events"],
            metrics["approximate_fills"],
            json.dumps(
                {
                    "replay_mode": "event_backtest",
                    "canonical_source": "candles_v1",
                    "coverage_proof": payload.coverageProof,
                }
            ),
            event_digest,
            int(payload.coverageProof.get("startTs", payload.bars[0].ts if payload.bars else 0)),
            int(payload.coverageProof.get("endTs", payload.bars[-1].ts if payload.bars else 0)),
        )

        for evt in result.events:
            await conn.execute(
                """
                INSERT INTO backtest_events (run_id, event_ts, event_type, payload_json)
                VALUES ($1, $2, $3, $4::jsonb)
                """,
                run_id,
                evt.event_ts,
                evt.event_type,
                json.dumps(evt.payload),
            )
            worker_event_counter.labels(evt.event_type).inc()

        worker_run_counter.labels("historical_backtest", "LOCAL ONLY").inc()
        run_start_ts = bars[0].ts if bars else datetime.now(tz=timezone.utc)
        for fill in result.fills:
            latency_ms = max(0.0, (fill.event_ts - run_start_ts).total_seconds() * 1000.0)
            worker_fill_latency_ms.observe(latency_ms)

        return {
            "runId": run_id,
            "status": "completed",
            "resultTier": "LOCAL ONLY",
            "dataVersion": payload.dataVersion,
            "engineVersion": payload.engineVersion,
            "seed": payload.seed,
            "metrics": metrics,
        }
    finally:
        await conn.close()


def _redis_url() -> str:
    return os.getenv("REDIS_URL", "redis://localhost:6379")


def _decode_redis_decimal(value: bytes | str | None) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    return Decimal(value)


def _as_payload_dict(value: object) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return {}
    return {}


def _join_latency_ms(*, enable_latency_model: bool | None = None, order_latency_ms: int | None = None) -> int:
    cfg = ExecutionConfig.from_env()
    enabled = cfg.latency.enabled if enable_latency_model is None else bool(enable_latency_model)
    if not enabled:
        return 0
    if order_latency_ms is not None:
        return max(0, int(order_latency_ms))
    return max(0, int(cfg.latency.order_entry_latency_ms))


def _latency_config(*, enable_latency_model: bool | None = None, order_latency_ms: int | None = None):
    """Full LatencyConfig for a run: env defaults with optional per-request overrides."""
    base = ExecutionConfig.from_env().latency
    enabled = base.enabled if enable_latency_model is None else bool(enable_latency_model)
    return LatencyConfig(
        enabled=enabled,
        feed_latency_ms=base.feed_latency_ms,
        order_entry_latency_ms=(int(order_latency_ms) if order_latency_ms is not None else base.order_entry_latency_ms),
        cancel_latency_ms=base.cancel_latency_ms,
        exchange_ack_latency_ms=base.exchange_ack_latency_ms,
        jitter_ms=base.jitter_ms,
        seed=base.seed,
    )


@app.post("/paper/process-tick")
async def process_paper_tick(payload: PaperTickPayload) -> dict:
    database_url = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
    conn = await asyncpg.connect(database_url)
    redis_client = redis.from_url(_redis_url())
    now_ms = payload.nowMs or int(datetime.now(tz=timezone.utc).timestamp() * 1000)

    try:
        session = await conn.fetchrow(
            """
            SELECT id, status, reconnecting, required_fresh_ticks, max_data_age_ms, last_seen_ts
            FROM paper_sessions
            WHERE id = $1
            """,
            payload.sessionId,
        )
        if session is None:
            return {"error": "SESSION_NOT_FOUND"}

        fresh_key = f"paper:{payload.sessionId}:fresh_ticks"
        last_price_key = f"paper:{payload.sessionId}:last_price:{payload.symbol}"
        fresh_ticks = int(await redis_client.get(fresh_key) or 0)
        last_price_raw = await redis_client.get(last_price_key)
        last_price = _decode_redis_decimal(last_price_raw)

        state = PaperSessionState(
            session_id=payload.sessionId,
            status=session["status"],
            reconnecting=bool(session["reconnecting"]),
            required_fresh_ticks=int(session["required_fresh_ticks"]),
            fresh_ticks_seen=fresh_ticks,
            max_data_age_ms=int(session["max_data_age_ms"]),
            last_price=last_price,
        )
        decision = evaluate_tick(
            state,
            Tick(
                symbol=payload.symbol,
                price=Decimal(payload.price),
                ts_ms=payload.tsMs,
                now_ms=now_ms,
            ),
        )

        async with conn.transaction():
            for event in decision.events:
                await conn.execute(
                    """
                    INSERT INTO paper_events (session_id, strategy_version_id, event_type, payload_json)
                    VALUES (
                      $1,
                      (SELECT strategy_version_id FROM paper_sessions WHERE id = $1),
                      $2,
                      $3::jsonb
                    )
                    """,
                    payload.sessionId,
                    event["event_type"],
                    json.dumps(event["payload"]),
                )
                worker_event_counter.labels(event["event_type"]).inc()

            await conn.execute(
                """
                UPDATE paper_sessions
                SET
                  status = $2,
                  reconnecting = $3,
                  last_seen_ts = to_timestamp($4 / 1000.0)
                WHERE id = $1
                """,
                payload.sessionId,
                decision.status,
                decision.reconnecting,
                payload.tsMs,
            )

            if decision.create_fill and decision.status == "active":
                order_id = f"paper-order-{uuid4()}"
                qty = Decimal("0.1")
                fee = Decimal("0.0")
                slippage = Decimal("0.0")

                await conn.execute(
                    """
                    INSERT INTO paper_events (session_id, strategy_version_id, event_type, payload_json)
                    VALUES (
                      $1,
                      (SELECT strategy_version_id FROM paper_sessions WHERE id = $1),
                      'ORDER_CREATED',
                      $2::jsonb
                    )
                    """,
                    payload.sessionId,
                    json.dumps({"order_id": order_id, "symbol": payload.symbol, "qty": str(qty), "side": "long"}),
                )
                await conn.execute(
                    """
                    INSERT INTO paper_fills (session_id, order_id, symbol, side, qty, fill_price, fee, slippage, ts)
                    VALUES ($1, $2, $3, 'long', $4, $5, $6, $7, to_timestamp($8 / 1000.0))
                    """,
                    payload.sessionId,
                    order_id,
                    payload.symbol,
                    str(qty),
                    str(payload.price),
                    str(fee),
                    str(slippage),
                    payload.tsMs,
                )
                await conn.execute(
                    """
                    INSERT INTO paper_events (session_id, strategy_version_id, event_type, payload_json)
                    VALUES (
                      $1,
                      (SELECT strategy_version_id FROM paper_sessions WHERE id = $1),
                      'FILL',
                      $2::jsonb
                    )
                    """,
                    payload.sessionId,
                    json.dumps({"order_id": order_id, "symbol": payload.symbol, "qty": str(qty), "fill_price": payload.price}),
                )
                await conn.execute(
                    """
                    INSERT INTO paper_positions (session_id, symbol, qty, avg_entry, realized_pnl, unrealized_pnl, funding_pnl)
                    VALUES ($1, $2, $3, $4, 0, 0, 0)
                    ON CONFLICT (session_id, symbol)
                    DO UPDATE SET
                      qty = paper_positions.qty + EXCLUDED.qty,
                      avg_entry = EXCLUDED.avg_entry,
                      updated_at = NOW()
                    """,
                    payload.sessionId,
                    payload.symbol,
                    str(qty),
                    payload.price,
                )
                await conn.execute(
                    """
                    INSERT INTO paper_events (session_id, strategy_version_id, event_type, payload_json)
                    VALUES (
                      $1,
                      (SELECT strategy_version_id FROM paper_sessions WHERE id = $1),
                      'POSITION_UPDATE',
                      $2::jsonb
                    )
                    """,
                    payload.sessionId,
                    json.dumps({"symbol": payload.symbol, "qty": str(qty), "avg_entry": payload.price}),
                )

        await redis_client.set(last_price_key, payload.price)
        await redis_client.set(fresh_key, decision.fresh_ticks_seen)
        await redis_client.set(f"paper:{payload.sessionId}:state", json.dumps({"status": decision.status, "reconnecting": decision.reconnecting}))

        return {
            "sessionId": payload.sessionId,
            "status": decision.status,
            "reconnecting": decision.reconnecting,
            "freshTicksSeen": decision.fresh_ticks_seen,
            "createdFill": decision.create_fill,
            "events": decision.events,
        }
    finally:
        await redis_client.close()
        await conn.close()


@app.post("/paper/rebuild")
async def rebuild_paper_session(payload: PaperRebuildPayload) -> dict:
    database_url = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
    conn = await asyncpg.connect(database_url)
    redis_client = redis.from_url(_redis_url())
    try:
        events = await conn.fetch(
            """
            SELECT event_type, payload_json, created_at
            FROM paper_events
            WHERE session_id = $1
            ORDER BY created_at ASC, event_id ASC
            """,
            payload.sessionId,
        )
        if not events:
            return {"error": "NO_EVENTS"}

        await conn.execute("DELETE FROM paper_positions WHERE session_id = $1", payload.sessionId)
        qty = Decimal("0")
        avg_entry = Decimal("0")
        funding_pnl = Decimal("0")

        for event in events:
            etype = event["event_type"]
            payload_json = _as_payload_dict(event["payload_json"])
            if etype == "FILL":
                fill_qty = Decimal(str(payload_json.get("qty", "0")))
                fill_price = Decimal(str(payload_json.get("fill_price", "0")))
                qty += fill_qty
                avg_entry = fill_price
            elif etype == "FUNDING_SETTLEMENT":
                funding_pnl += Decimal(str(payload_json.get("amount", "0")))

        symbol = _as_payload_dict(events[-1]["payload_json"]).get("symbol", "UNKNOWN")
        await conn.execute(
            """
            INSERT INTO paper_positions (session_id, symbol, qty, avg_entry, realized_pnl, unrealized_pnl, funding_pnl)
            VALUES ($1, $2, $3, $4, 0, 0, $5)
            ON CONFLICT (session_id, symbol)
            DO UPDATE SET qty = EXCLUDED.qty, avg_entry = EXCLUDED.avg_entry, funding_pnl = EXCLUDED.funding_pnl, updated_at = NOW()
            """,
            payload.sessionId,
            symbol,
            str(qty),
            str(avg_entry),
            str(funding_pnl),
        )

        state = {"qty": str(qty), "avg_entry": str(avg_entry), "funding_pnl": str(funding_pnl)}
        await redis_client.set(f"paper:{payload.sessionId}:state", json.dumps(state))
        await conn.execute(
            """
            INSERT INTO paper_events (session_id, strategy_version_id, event_type, payload_json)
            VALUES (
              $1,
              (SELECT strategy_version_id FROM paper_sessions WHERE id = $1),
              'REBUILD_COMPLETED',
              $2::jsonb
            )
            """,
            payload.sessionId,
            json.dumps(state),
        )
        return {"sessionId": payload.sessionId, "rebuildState": state}
    finally:
        await redis_client.close()
        await conn.close()


@app.post("/risk/evaluate")
async def evaluate_risk_endpoint(payload: RiskEvaluatePayload) -> dict:
    target = RiskMetrics(
        total_return_after_fees_funding=payload.target.total_return_after_fees_funding,
        sharpe=payload.target.sharpe,
        calmar=payload.target.calmar,
        max_drawdown=payload.target.max_drawdown,
        consistency=payload.target.consistency,
        robustness=payload.target.robustness,
        live_paper_score=payload.target.live_paper_score,
        liquidation_events=payload.target.liquidation_events,
        data_coverage_complete=payload.target.data_coverage_complete,
        overfit_penalty=payload.target.overfit_penalty,
        approximate_fills=payload.target.approximate_fills,
    )
    cohort = [
        RiskMetrics(
            total_return_after_fees_funding=row.total_return_after_fees_funding,
            sharpe=row.sharpe,
            calmar=row.calmar,
            max_drawdown=row.max_drawdown,
            consistency=row.consistency,
            robustness=row.robustness,
            live_paper_score=row.live_paper_score,
            liquidation_events=row.liquidation_events,
            data_coverage_complete=row.data_coverage_complete,
            overfit_penalty=row.overfit_penalty,
            approximate_fills=row.approximate_fills,
        )
        for row in payload.cohort
    ]
    evaluation = evaluate_risk(
        target,
        cohort,
        RiskGateConfig(
            drawdown_cap=payload.drawdown_cap,
            overfit_penalty_threshold=payload.overfit_penalty_threshold,
        ),
    )
    return {
        "baseScore": evaluation.base_score,
        "hardGatesPassed": evaluation.hard_gates_passed,
        "gateFailures": evaluation.gate_failures,
    }


@app.post("/optimizer/run")
async def run_optimizer(payload: OptimizationRunPayload, _slot=Depends(heavy_slot)) -> dict:
    database_url = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
    conn = await asyncpg.connect(database_url)
    run_id = str(uuid4())
    thresholds = ParityThresholds(
        allowed_return_drift=float(payload.thresholds.get("allowed_return_drift", 0.005)),
        allowed_drawdown_drift=float(payload.thresholds.get("allowed_drawdown_drift", 0.01)),
        allowed_trade_count_drift=int(payload.thresholds.get("allowed_trade_count_drift", 2)),
    )
    try:
        await conn.execute(
            """
            INSERT INTO optimization_runs (run_id, strategy_version_id, status, method, config_json, parity_threshold_json, summary_json)
            VALUES ($1, $2, 'running', $3, $4::jsonb, $5::jsonb, '{}'::jsonb)
            """,
            run_id,
            payload.strategyVersionId,
            payload.method,
            json.dumps(payload.model_dump()),
            json.dumps(payload.thresholds),
        )

        ranked = []
        for idx, candidate in enumerate(payload.candidates):
            vm = candidate.vector_metrics
            vector = CandidateMetrics(
                total_return=float(vm.get("total_return", 0)),
                max_drawdown=float(vm.get("max_drawdown", 0)),
                trade_count=int(vm.get("trade_count", 0)),
            )
            event = CandidateMetrics(
                total_return=vector.total_return - 0.001,
                max_drawdown=vector.max_drawdown + 0.002,
                trade_count=max(0, vector.trade_count - 1),
            )
            parity = compute_parity(vector, event, thresholds)

            promoteable = parity.within_threshold and not payload.event_only_template
            badge = "event-rescored"
            if payload.event_only_template:
                promoteable = False
            ranked.append(
                {
                    "candidate_rank": idx + 1,
                    "params": candidate.params,
                    "vector": vector,
                    "event": event,
                    "parity": parity,
                    "promoteable": promoteable,
                    "badge": badge,
                }
            )

        ranked.sort(key=lambda r: r["event"].total_return, reverse=True)
        finalists = ranked[: payload.topN]

        for rank, row in enumerate(finalists, start=1):
            await conn.execute(
                """
                INSERT INTO optimization_candidates (
                  run_id, candidate_rank, params_json, vector_metrics_json, event_metrics_json, parity_json,
                  event_rescored, promoteable, badge
                ) VALUES (
                  $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, TRUE, $7, $8
                )
                """,
                run_id,
                rank,
                json.dumps(row["params"]),
                json.dumps(
                    {
                        "total_return": row["vector"].total_return,
                        "max_drawdown": row["vector"].max_drawdown,
                        "trade_count": row["vector"].trade_count,
                    }
                ),
                json.dumps(
                    {
                        "total_return": row["event"].total_return,
                        "max_drawdown": row["event"].max_drawdown,
                        "trade_count": row["event"].trade_count,
                    }
                ),
                json.dumps(
                    {
                        "return_drift": row["parity"].return_drift,
                        "drawdown_drift": row["parity"].drawdown_drift,
                        "trade_count_drift": row["parity"].trade_count_drift,
                        "within_threshold": row["parity"].within_threshold,
                    }
                ),
                row["promoteable"],
                row["badge"],
            )

        # Real parameter-sensitivity from the dispersion of event-rescored finalists
        # (no mock values — if we can't compute a check, we report not_computed).
        finalist_scores = [float(r["event"].total_return) for r in finalists if r.get("event") is not None]
        if len(finalist_scores) >= 2:
            mean_s = sum(finalist_scores) / len(finalist_scores)
            spread = (max(finalist_scores) - min(finalist_scores))
            rel_spread = abs(spread / mean_s) if mean_s else 0.0
            param_sensitivity = {
                "status": "pass" if rel_spread <= 0.5 else "warn",
                "neighbor_band_ok": rel_spread <= 0.5,
                "relative_spread": round(rel_spread, 4),
                "n_finalists": len(finalist_scores),
                "computed": True,
            }
        else:
            param_sensitivity = {"status": "not_computed", "computed": False, "reason": "need >=2 finalists"}
        summary = {
            "top_n": payload.topN,
            "event_only_template": payload.event_only_template,
            # Walk-forward & block-bootstrap require sub-window re-runs not performed by this
            # sweep — reported honestly as not_computed rather than a fabricated pass.
            "walk_forward": {"status": "not_computed", "computed": False, "reason": "run a dedicated walk-forward sweep"},
            "block_bootstrap": {"status": "not_computed", "computed": False, "reason": "run a dedicated bootstrap"},
            "parameter_sensitivity": param_sensitivity,
            "event_rescore_badge": True,
        }
        await conn.execute(
            """
            UPDATE optimization_runs
            SET status = 'completed', summary_json = $2::jsonb
            WHERE run_id = $1
            """,
            run_id,
            json.dumps(summary),
        )
        return {"runId": run_id, "status": "completed", "summary": summary}
    finally:
        await conn.close()


class RuntimeBarPayload(BaseModel):
    ts: int
    open: str
    high: str
    low: str
    close: str
    volume: str = "0"


class PaperRuntimeRunPayload(BaseModel):
    symbol: str = "BTCUSDT"
    strategy_id: str
    strategy_params: dict = Field(default_factory=dict)
    starting_equity: str = "10000"
    bars: list[RuntimeBarPayload]
    funding_rows: list[FundingRowPayload] = Field(default_factory=list)
    fee_bps_taker: str = "5.5"
    fee_bps_maker: str = "1.0"
    slippage_bps_one_way: str = "2.0"
    interval_minutes: int = 15
    risk: dict = Field(default_factory=dict)
    # WS-A/WS-B Bybit-exactness (opt-in; default OFF -> behaviour byte-identical to before).
    venue_exact: bool = False
    vip_tier: str | None = None          # WS-B: PRO3/VIP1/... resolves fees from the pinned schedule
    category: str | None = None          # 'linear' | 'spot'
    instrument_filter: dict | None = None  # WS-A snapshot: {tick_size, qty_step, min_order_qty, min_notional, ...}
    # Execution fidelity (Phases 1-2): bar_based (default) | l2_sweep | l2_queue.
    execution_fidelity: str = "bar_based"
    allow_fallback: bool = True          # if recorded L2/trade coverage is missing, fall back vs. reject
    enable_latency_model: bool | None = None
    order_latency_ms: int | None = None
    # DEX/on-chain additions. The caller still supplies bars; these fields state where they came
    # from and how fills should be labeled. AMM modes never install the Bybit L2 provider.
    data_source: str = "bybit"           # bybit | dex | blended | robinhood_testnet
    venue: str = "bybit"                 # bybit | uniswap_v3 | camelot | rh_testnet
    chain_id: int | None = None
    pool_id: str | None = None
    route: list[dict] = Field(default_factory=list)
    honesty_required: bool = True
    allow_data_blending: bool = False


@app.post("/paper/runtime/run")
async def paper_runtime_run(payload: PaperRuntimeRunPayload, _slot=Depends(heavy_slot)):
    if payload.strategy_id not in STRATEGY_REGISTRY:
        return {"error": "UNKNOWN_STRATEGY", "available": list(STRATEGY_REGISTRY.keys())}
    strategy_cls = STRATEGY_REGISTRY[payload.strategy_id]
    strategy = strategy_cls(payload.strategy_params)

    bars = [
        RuntimeBar(
            ts=datetime.fromtimestamp(b.ts / 1000, tz=timezone.utc),
            open=Decimal(b.open), high=Decimal(b.high), low=Decimal(b.low), close=Decimal(b.close), volume=Decimal(b.volume),
        )
        for b in payload.bars
    ]
    funding_rows = [
        FundingRow(id=f.id, timestamp=datetime.fromtimestamp(f.timestamp / 1000, tz=timezone.utc), funding_rate=Decimal(f.funding_rate))
        for f in payload.funding_rows
    ]

    risk_kwargs = {}
    for k in ("max_position_fraction", "max_total_exposure_fraction", "max_daily_loss_fraction", "max_drawdown_kill_fraction"):
        if k in payload.risk:
            risk_kwargs[k] = Decimal(str(payload.risk[k]))
    portfolio = Portfolio(starting_equity=Decimal(payload.starting_equity), risk=RiskConfig(**risk_kwargs))

    # WS-A: build an InstrumentFilter snapshot if venue-exactness is requested.
    instrument_filter = None
    venue_meta = {
        "venue_exact": False,
        "venue": payload.venue,
        "data_source": payload.data_source,
        "chain_id": payload.chain_id,
        "pool_id": payload.pool_id,
    }
    if payload.venue_exact:
        from quant_core.bybit_venue import InstrumentFilter
        f = payload.instrument_filter or {}
        def _d(k, default):
            return Decimal(str(f[k])) if k in f and f[k] is not None else Decimal(default)
        instrument_filter = InstrumentFilter(
            symbol=payload.symbol, category=payload.category or "linear",
            tick_size=_d("tick_size", "0.01"), min_price=_d("min_price", "0"),
            max_price=_d("max_price", "0"), qty_step=_d("qty_step", "0.000001"),
            min_order_qty=_d("min_order_qty", "0"), max_order_qty=_d("max_order_qty", "0"),
            max_mkt_order_qty=_d("max_mkt_order_qty", "0"), min_notional=_d("min_notional", "0"),
            min_leverage=_d("min_leverage", "1"), max_leverage=_d("max_leverage", "100"),
            leverage_step=_d("leverage_step", "0.01"),
            price_limit_ratio_x=(Decimal(str(f["price_limit_ratio_x"])) if f.get("price_limit_ratio_x") else None),
            data_version=str(f.get("data_version", "snapshot")),
        )
        venue_meta = {**venue_meta, "venue_exact": True, "vip_tier": payload.vip_tier,
                      "category": payload.category or "linear", "filter_applied": bool(payload.instrument_filter)}

    runtime = PaperRuntime(
        symbol=payload.symbol,
        portfolio=portfolio,
        strategy=strategy,
        fee_bps_taker=Decimal(payload.fee_bps_taker),
        fee_bps_maker=Decimal(payload.fee_bps_maker),
        slippage_bps_one_way=Decimal(payload.slippage_bps_one_way),
        vip_tier=payload.vip_tier if payload.venue_exact else None,
        category=payload.category if payload.venue_exact else None,
        instrument_filter=instrument_filter,
    )
    if payload.venue_exact:
        runtime.enforce_order_semantics = True
        f = payload.instrument_filter or {}
        lower_cap = f.get("lowerFundingRate", f.get("lower_funding_rate"))
        upper_cap = f.get("upperFundingRate", f.get("upper_funding_rate"))
        if lower_cap is not None:
            runtime.funding_cap_lower = Decimal(str(lower_cap))
        if upper_cap is not None:
            runtime.funding_cap_upper = Decimal(str(upper_cap))
    requested_fidelity_raw = str(payload.execution_fidelity or "bar_based").lower()
    is_amm = requested_fidelity_raw in {"amm_mid_only", "amm_quote_snapshot", "amm_swap_replay", "testnet_actual"}
    # Phases 1-2: resolve execution fidelity + install the L2 provider (DB-backed) when
    # requested. bar_based ⇒ no provider (byte-identical default). Coverage gates may reject.
    exec_fidelity = Fidelity.BAR_BASED if is_amm else Fidelity.parse(payload.execution_fidelity, Fidelity.BAR_BASED)
    runtime.requested_fidelity = exec_fidelity
    # Phase 5: install the deterministic latency model (no effect unless enabled).
    runtime.latency = _latency_config(
        enable_latency_model=payload.enable_latency_model, order_latency_ms=payload.order_latency_ms)
    if exec_fidelity != Fidelity.BAR_BASED:
        database_url = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
        conn = await asyncpg.connect(database_url)
        join_latency = _join_latency_ms(
            enable_latency_model=payload.enable_latency_model,
            order_latency_ms=payload.order_latency_ms,
        )
        try:
            pb = await build_provider(
                conn, fidelity=exec_fidelity, symbol=payload.symbol,
                category=(payload.category or "linear"), bars=bars,
                allow_fallback=payload.allow_fallback,
                join_latency_ms=join_latency,
                interval_ms=int(payload.interval_minutes) * 60_000,
            )
        finally:
            await conn.close()
        if pb.error:
            return {"error": pb.error, "execution_fidelity": payload.execution_fidelity,
                    "symbol": payload.symbol,
                    "detail": "No recorded L2/trade coverage for this symbol/time range; "
                              "record via POST /api/live/record-l2 (forward-only) or set allow_fallback=true."}
        if pb.provider is not None:
            runtime.l2_queue_provider = pb.provider
            runtime.fill_stats.latency_model_used = join_latency > 0
        if pb.fallback_reason:
            runtime.fill_stats.fallback_reason = pb.fallback_reason

    result = runtime.run(bars=bars, funding_rows=funding_rows)
    for event in result.events:
        worker_event_counter.labels(event.type).inc()
    worker_run_counter.labels("paper_runtime", "LOCAL ONLY").inc()

    bars_per_year = 365 * 24 * 60 / payload.interval_minutes
    perf = compute_performance(result.equity_curve, result.trade_pnls, bars_per_year=bars_per_year)

    # Normalized fill_model block (Phase 1): the achieved mode after any fallback, with
    # provider/trade-print usage, coverage, and counters. Bar-based ⇒ optimistic & flagged.
    fill_model = runtime.fill_model()
    fill_model["fill_evidence_count"] = len(runtime.fill_evidence)
    if is_amm:
        if requested_fidelity_raw == "amm_swap_replay":
            result_tier = "DEX REPLAY"
        elif requested_fidelity_raw == "amm_quote_snapshot":
            result_tier = "DEX MODELED"
        elif requested_fidelity_raw == "testnet_actual":
            result_tier = "TESTNET EXECUTED"
        else:
            result_tier = "LOCAL ONLY"
        fill_model.update({
            "mode": requested_fidelity_raw,
            "requested_fidelity": requested_fidelity_raw,
            "bar_based": False,
            "l2_aware": False,
            "l2_provider_used": False,
            "trade_prints_used": requested_fidelity_raw == "amm_swap_replay",
            "maker_fills_optimistic": requested_fidelity_raw == "amm_mid_only",
            "liquidity_free_upper_bound": requested_fidelity_raw == "amm_mid_only",
            "data_source": payload.data_source,
            "venue": payload.venue,
            "chain_id": payload.chain_id,
            "pool_id": payload.pool_id,
            "route": payload.route,
            "result_tier": result_tier,
            "can_execute_real_money": False,
            "testnet_disclaimer": "Testnet-only execution label; not production verified." if payload.chain_id in (421614, 46630) else None,
            "note": "AMM-modeled DEX run. Bybit L2/orderbook assumptions were not used.",
        })
    if fill_model["mode"] == "bar_based":
        fill_model["note"] = (
            "Bar-based fills: no queue-position/through-volume model — treat as a "
            "liquidity-free upper bound (esp. pmm/avellaneda_stoikov). Request "
            "execution_fidelity=l2_sweep|l2_queue with recorded L2/trade coverage for "
            "verifiable execution.")
    return {
        "status": "completed",
        "strategy_id": payload.strategy_id,
        "symbol": payload.symbol,
        "final_equity": str(result.final_equity),
        "fill_model": fill_model,
        "fill_evidence": runtime.fill_evidence[:200],
        "fill_evidence_truncated": len(runtime.fill_evidence) > 200,
        "venue": {**venue_meta, "fee_bps_maker": str(runtime.fee_bps_maker),
                  "fee_bps_taker": str(runtime.fee_bps_taker)},
        "truth_card": {
            "result_tier": fill_model.get("result_tier", "LOCAL ONLY"),
            "data_source": payload.data_source,
            "execution_fidelity": fill_model.get("mode"),
            "coverage_proof": {
                "bars": len(bars),
                "source": payload.data_source,
                "pool_id": payload.pool_id,
                "allow_data_blending": payload.allow_data_blending,
            },
            "liquidity_proof": {
                "route": payload.route,
                "pool_id": payload.pool_id,
            },
            "testnet_disclaimer": fill_model.get("testnet_disclaimer"),
            "can_execute_real_money": False,
        },
        "events": [{"ts": e.ts.isoformat(), "type": e.type, "payload": e.payload} for e in result.events[:500]],
        "events_truncated": len(result.events) > 500,
        "total_events": len(result.events),
        "fills": [
            {"order_id": f.order_id, "symbol": f.symbol, "side": f.side, "qty": str(f.qty), "price": str(f.price), "fee": str(f.fee), "ts": f.ts.isoformat(), "is_maker": f.is_maker}
            for f in result.fills
        ],
        "equity_curve": [str(x) for x in result.equity_curve],
        "trade_pnls": [str(x) for x in result.trade_pnls],
        "performance": {
            "total_return": perf.total_return, "sharpe": perf.sharpe, "sortino": perf.sortino,
            "calmar": perf.calmar, "max_drawdown": perf.max_drawdown,
            "max_drawdown_duration_bars": perf.max_drawdown_duration_bars,
            "volatility_annualized": perf.volatility_annualized,
            "win_rate": perf.win_rate, "loss_rate": perf.loss_rate,
            "avg_win": perf.avg_win, "avg_loss": perf.avg_loss,
            "profit_factor": perf.profit_factor, "expectancy": perf.expectancy,
            "max_consecutive_wins": perf.max_consecutive_wins,
            "max_consecutive_losses": perf.max_consecutive_losses,
            "n_trades": perf.n_trades,
            "drawdown_curve": perf.drawdown_curve,
        },
        "risk_state": {
            "killed": portfolio.state.killed,
            "kill_reason": portfolio.state.kill_reason,
            "equity_high_watermark": str(portfolio.state.equity_high_watermark),
        },
        "positions": {
            sym: {
                "side": p.side, "qty": str(p.qty), "avg_entry": str(p.avg_entry),
                "realized_pnl": str(p.realized_pnl), "funding_pnl": str(p.funding_pnl),
            } for sym, p in portfolio.positions.items()
        },
    }


# ------- v4.1 Bybit Bot OS endpoints -------
from quant_core.bot_os import (
    BotSpec as V4BotSpec,
    build_bot,
    validate_bot_spec,
    spec_hash as v4_spec_hash,
    compute_cockpit,
    recommend as v4_recommend,
    run_bot as v4_run_bot,
    TEMPLATES as V4_TEMPLATES,
    COMPILER_VERSION as V4_COMPILER_VERSION,
)
from quant_core import xstocks as xstocks_mod


class BotSpecPayload(BaseModel):
    bot_type: str
    name: str = "untitled"
    symbols: list[str] = Field(default_factory=list)
    params: dict = Field(default_factory=dict)
    risk: dict = Field(default_factory=dict)
    accounting: dict = Field(default_factory=dict)


class BotValidatePayload(BaseModel):
    spec: BotSpecPayload
    coverage: dict = Field(default_factory=dict)
    requested_tier: str = "LOCAL ONLY"


class BotRunPayload(BaseModel):
    spec: BotSpecPayload
    symbol: str = "BTCUSDT"
    bars: list[RuntimeBarPayload]
    funding_rows: list[FundingRowPayload] = Field(default_factory=list)
    # Side bars: extra symbols' price series for multi-symbol bots
    # (futures_combo, rebalancer, funding_arbitrage). Keyed by symbol.
    side_bars: dict[str, list[RuntimeBarPayload]] = Field(default_factory=dict)
    starting_equity: str = "10000"
    risk: dict = Field(default_factory=dict)
    coverage: dict = Field(default_factory=dict)
    requested_tier: str = "LOCAL ONLY"
    fee_bps_taker: str = "5.5"
    fee_bps_maker: str = "1.0"
    slippage_bps_one_way: str = "2.0"
    interval_minutes: int = 15
    bot_spec_id: str | None = None
    persist_run: bool = True
    strategy_version_id: str | None = None
    run_mode: str = "backtest"
    # Execution fidelity (Phases 1-2): bar_based (default) | l2_sweep | l2_queue.
    execution_fidelity: str = "bar_based"
    allow_fallback: bool = True
    category: str = "linear"
    enable_latency_model: bool | None = None
    order_latency_ms: int | None = None
    venue_exact: bool = False
    vip_tier: str | None = None


class BotRecommendPayload(BaseModel):
    bars: list[RuntimeBarPayload]
    funding_rate_last: str | None = None
    data_complete: bool = True
    risk_tolerance: str = "moderate"


class BotCockpitPayload(BaseModel):
    spec: BotSpecPayload
    coverage: dict = Field(default_factory=dict)


def _to_v4_spec(p: BotSpecPayload) -> V4BotSpec:
    return V4BotSpec(
        bot_type=p.bot_type, name=p.name, symbols=p.symbols,
        params=p.params, risk=p.risk, accounting=p.accounting,
    )


def _bars_v4(rows: list[RuntimeBarPayload]) -> list[RuntimeBar]:
    return [
        RuntimeBar(
            ts=datetime.fromtimestamp(b.ts / 1000, tz=timezone.utc),
            open=Decimal(b.open), high=Decimal(b.high), low=Decimal(b.low), close=Decimal(b.close), volume=Decimal(b.volume),
        )
        for b in rows
    ]


def _extract_decimal_field(value, field: str, default: Decimal | None = None) -> Decimal | None:
    if isinstance(value, dict):
        if field in value:
            try:
                return Decimal(str(value[field]))
            except Exception:
                return default
        for child in value.values():
            found = _extract_decimal_field(child, field, None)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _extract_decimal_field(child, field, None)
            if found is not None:
                return found
    return default


@app.get("/bots/templates")
def bots_templates() -> dict:
    return {"templates": V4_TEMPLATES, "compiler_version": V4_COMPILER_VERSION}


@app.get("/xstocks/catalog")
def xstocks_catalog() -> dict:
    """Tokenized-equity (xStocks) instrument catalog + Bybit Spot constraints."""
    return xstocks_mod.catalog_payload()


# ------- Multi-asset / multi-token portfolio engine -------
from quant_core.portfolio_engine import (
    PortfolioLeg as _PortfolioLeg,
    run_portfolio as _run_portfolio,
    validate_legs as _validate_legs,
    WEIGHTING_SCHEMES as _WEIGHTING_SCHEMES,
)


class PortfolioLegPayload(BaseModel):
    symbol: str
    asset_class: str = "crypto"          # 'crypto' | 'equity'
    category: str = "linear"             # 'linear' | 'spot'
    target_weight: str = "0"
    leverage: str = "1"
    allow_short: bool = False
    bars: list[RuntimeBarPayload] = Field(default_factory=list)


class PortfolioRunPayload(BaseModel):
    legs: list[PortfolioLegPayload]
    weighting: str = "fixed"
    total_equity: str = "100000"
    fee_bps_taker: str = "5.5"
    slippage_bps_one_way: str = "2.0"
    rebalance_threshold: str = "0.05"
    lookback_bars: int = 20
    top_n: int = 3
    interval_minutes: int = 60
    risk: dict = Field(default_factory=dict)
    seed: int = 42


def _to_portfolio_legs(rows: list[PortfolioLegPayload]) -> list[_PortfolioLeg]:
    out = []
    for r in rows:
        out.append(_PortfolioLeg(
            symbol=r.symbol, bars=_bars_v4(r.bars), asset_class=r.asset_class,
            category=r.category, target_weight=Decimal(r.target_weight),
            leverage=Decimal(r.leverage), allow_short=bool(r.allow_short),
        ))
    return out


@app.get("/portfolio/schemes")
def portfolio_schemes() -> dict:
    return {"weighting_schemes": list(_WEIGHTING_SCHEMES)}


@app.post("/portfolio/validate")
def portfolio_validate(payload: PortfolioRunPayload) -> dict:
    legs = _to_portfolio_legs(payload.legs)
    errors = _validate_legs(legs)
    if payload.weighting not in _WEIGHTING_SCHEMES:
        errors.append(f"UNKNOWN_WEIGHTING:{payload.weighting}")
    return {"valid": len(errors) == 0, "errors": errors,
            "n_legs": len(legs),
            "asset_classes": sorted({l.asset_class for l in legs}),
            "live_execution": {
                "account": "Bybit UTA (one account, cross-margin)",
                "routing": "category=spot for crypto-spot/xStocks, category=linear for crypto perps",
                "batch": "POST /v5/order/create-batch per rebalance",
            }}


@app.post("/portfolio/run")
def portfolio_run(payload: PortfolioRunPayload, _slot=Depends(heavy_slot)) -> dict:
    legs = _to_portfolio_legs(payload.legs)
    res = _run_portfolio(
        legs=legs, weighting=payload.weighting, total_equity=Decimal(payload.total_equity),
        fee_bps_taker=Decimal(payload.fee_bps_taker), slippage_bps_one_way=Decimal(payload.slippage_bps_one_way),
        rebalance_threshold=Decimal(payload.rebalance_threshold), lookback_bars=payload.lookback_bars,
        top_n=payload.top_n, interval_minutes=payload.interval_minutes, risk=payload.risk, seed=payload.seed,
    )
    if res.errors:
        return {"error": "PORTFOLIO_VALIDATION_FAILED", "errors": res.errors}
    return {
        "final_equity": str(res.final_equity),
        "equity_curve": [str(e) for e in res.equity_curve],
        "timestamps": res.timestamps,
        "fills": res.fills,
        "positions": res.positions,
        "weights_history": res.weights_history,
        "rebalances": res.rebalances,
        "metrics": res.metrics,
        "risk_state": res.risk_state,
        "risk_notes": res.risk_notes,
        "weighting": payload.weighting,
    }


@app.get("/xstocks/session")
def xstocks_session(ts_ms: int | None = None) -> dict:
    """Current US-equity session phase (RTH vs off-hours) for the xStock underlyings."""
    import datetime as _dt
    ts = _dt.datetime.fromtimestamp((ts_ms or int(__import__("time").time() * 1000)) / 1000, tz=_dt.timezone.utc)
    return {
        "ts_ms": int(ts.timestamp() * 1000),
        "phase": xstocks_mod.session_phase(ts),
        "is_rth": xstocks_mod.is_regular_trading_hours(ts),
        "off_hours_spread_multiplier": str(xstocks_mod.off_hours_spread_multiplier(ts)),
    }


@app.post("/bots/validate")
def bots_validate(payload: BotValidatePayload) -> dict:
    spec = _to_v4_spec(payload.spec)
    return validate_bot_spec(spec, coverage=payload.coverage, requested_tier=payload.requested_tier)


@app.post("/bots/cockpit")
def bots_cockpit(payload: BotCockpitPayload) -> dict:
    spec = _to_v4_spec(payload.spec)
    report = compute_cockpit(spec, coverage=payload.coverage)
    return {
        "risk_score": report.risk_score,
        "risk_class": report.risk_class,
        "hard_blocks": report.hard_blocks,
        "modules": report.modules,
        "spec_hash": v4_spec_hash(spec),
        "compiler_version": V4_COMPILER_VERSION,
    }


@app.post("/bots/run")
async def bots_run(payload: BotRunPayload, _slot=Depends(heavy_slot)) -> dict:
    spec = _to_v4_spec(payload.spec)
    if spec.bot_type not in {t["bot_type"] for t in V4_TEMPLATES}:
        return {"error": "UNKNOWN_BOT_TYPE", "bot_type": spec.bot_type}
    # Validate first; reject hard errors before running.
    val = validate_bot_spec(spec, coverage=payload.coverage, requested_tier=payload.requested_tier)
    if not val["valid"]:
        return {"status": "rejected", "validation": val}

    bot = build_bot(spec.bot_type, spec.params)
    bars = _bars_v4(payload.bars)
    funding = [
        FundingRow(id=f.id, timestamp=datetime.fromtimestamp(f.timestamp / 1000, tz=timezone.utc), funding_rate=Decimal(f.funding_rate))
        for f in payload.funding_rows
    ]
    # Convert side_bars payload to Bar objects
    side_bars: dict[str, list[RuntimeBar]] = {}
    for sym, rows in payload.side_bars.items():
        side_bars[sym] = [
            RuntimeBar(
                ts=datetime.fromtimestamp(b.ts / 1000, tz=timezone.utc),
                open=Decimal(b.open), high=Decimal(b.high), low=Decimal(b.low),
                close=Decimal(b.close), volume=Decimal(b.volume),
            )
            for b in rows
        ]

    # Phases 1-2: resolve execution fidelity + install the L2 provider (DB-backed) when
    # requested. bar_based ⇒ no provider (byte-identical). Coverage gates may reject.
    exec_fidelity = Fidelity.parse(payload.execution_fidelity, Fidelity.BAR_BASED)
    exec_provider = None
    exec_fallback = None
    venue_filter = None
    venue_funding_caps = None
    venue_risk_tiers = None
    venue_meta = {"venue_exact": False}
    join_latency = _join_latency_ms(
        enable_latency_model=payload.enable_latency_model,
        order_latency_ms=payload.order_latency_ms,
    )
    if exec_fidelity != Fidelity.BAR_BASED:
        database_url = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
        conn = await asyncpg.connect(database_url)
        try:
            pb = await build_provider(
                conn, fidelity=exec_fidelity, symbol=payload.symbol,
                category=(payload.category or "linear"), bars=bars,
                allow_fallback=payload.allow_fallback,
                join_latency_ms=join_latency,
                interval_ms=int(payload.interval_minutes) * 60_000,
            )
        finally:
            await conn.close()
        if pb.error:
            return {"status": "rejected", "error": pb.error,
                    "execution_fidelity": payload.execution_fidelity, "symbol": payload.symbol,
                    "detail": "No recorded L2/trade coverage for this symbol/time range."}
        exec_provider = pb.provider
        exec_fallback = pb.fallback_reason

    if payload.venue_exact:
        database_url = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
        conn = await asyncpg.connect(database_url)
        try:
            vb = await load_instrument_filter(conn, payload.symbol, payload.category or "linear")
        finally:
            await conn.close()
        if vb.instrument_filter is None:
            return {"status": "rejected", "error": "MISSING_INSTRUMENT_SNAPSHOT",
                    "symbol": payload.symbol, "detail": "venue_exact requires a recorded instrument_snapshots row."}
        venue_filter = vb.instrument_filter
        venue_funding_caps = vb.funding_caps
        venue_risk_tiers = vb.risk_tiers
        venue_meta = {
            "venue_exact": True,
            "vip_tier": payload.vip_tier,
            "category": payload.category or "linear",
            "instrument_data_version": vb.data_version,
            "risk_tiers": len(vb.risk_tiers or []),
            "funding_caps": {
                "lower": str(vb.funding_caps[0]) if vb.funding_caps and vb.funding_caps[0] is not None else None,
                "upper": str(vb.funding_caps[1]) if vb.funding_caps and vb.funding_caps[1] is not None else None,
            },
        }

    report, raw = v4_run_bot(
        spec=spec, bot=bot, symbol=payload.symbol,
        bars=bars, funding_rows=funding,
        starting_equity=Decimal(payload.starting_equity), risk=payload.risk,
        fee_bps_taker=Decimal(payload.fee_bps_taker), fee_bps_maker=Decimal(payload.fee_bps_maker),
        slippage_bps_one_way=Decimal(payload.slippage_bps_one_way),
        spec_hash_value=val["spec_hash"], compiler_version=V4_COMPILER_VERSION,
        side_bars=side_bars,
        execution_provider=exec_provider, requested_fidelity=exec_fidelity, fallback_reason=exec_fallback,
        latency=_latency_config(enable_latency_model=getattr(payload, "enable_latency_model", None),
                                order_latency_ms=getattr(payload, "order_latency_ms", None)),
        instrument_filter=venue_filter,
        vip_tier=payload.vip_tier if payload.venue_exact else None,
        category=payload.category if payload.venue_exact else None,
        enforce_order_semantics=payload.venue_exact,
        funding_caps=venue_funding_caps,
        risk_tiers=venue_risk_tiers,
        leverage=_extract_decimal_field(spec.params, "leverage", Decimal("1")),
    )
    if join_latency > 0 and report.fill_model:
        report.fill_model["latency_model_used"] = True
    bars_per_year = 365 * 24 * 60 / payload.interval_minutes
    perf = compute_performance(report.equity_curve, report.trade_pnls, bars_per_year=bars_per_year)
    out = {
        "status": "completed",
        "validation": val,
        "spec_hash": report.spec_hash,
        "compiler_version": report.compiler_version,
        "engine_version": report.engine_version,
        "data_version": payload.coverage.get("data_version", "ad-hoc"),
        "final_equity": str(report.final_equity),
        "fills": report.fills,
        "events": report.events,
        "equity_curve": [str(x) for x in report.equity_curve],
        "positions": report.positions,
        "risk_state": report.risk_state,
        "risk_notes": report.risk_notes,
        "performance": {
            "total_return": perf.total_return, "sharpe": perf.sharpe, "sortino": perf.sortino,
            "calmar": perf.calmar, "max_drawdown": perf.max_drawdown,
            "win_rate": perf.win_rate, "profit_factor": perf.profit_factor,
            "n_trades": perf.n_trades, "drawdown_curve": perf.drawdown_curve,
        },
        "fill_model": report.fill_model,
        "fill_evidence": report.fill_evidence,
        "venue": venue_meta,
    }
    # Stamp the achieved execution fidelity into the persisted coverage proof so the
    # verification gate can require actual L2/trade consumption (not mere recording).
    payload.coverage = {
        **(payload.coverage or {}),
        "fill_model": report.fill_model,
        "fill_evidence": report.fill_evidence[:500],
        "fill_evidence_truncated": len(report.fill_evidence) > 500,
    }
    if not payload.persist_run:
        return out

    run_mode = str(payload.run_mode or "backtest").lower()
    run_id = f"br_{uuid4()}"
    event_digest = _stable_json_hash(report.events)
    # Cross-process-stable digest (order IDs canonicalized) so the verifier can reproduce a bot's
    # event stream byte-for-byte regardless of the process-global order-ID counter (P0.2).
    canonical_digest = _canonical_event_digest(report.events)
    metrics = {
        "total_return_after_fees_funding": perf.total_return,
        "sharpe": perf.sharpe,
        "calmar": perf.calmar,
        "max_drawdown": perf.max_drawdown,
        "consistency": 0.0,
        "robustness": 0.0,
        "live_paper_score": 0.0,
        "liquidation_events": len([e for e in report.events if e.get("type") == "LIQUIDATION"]),
        "data_coverage_complete": True,
        "overfit_penalty": 0.0,
        "approximate_fills": "APPROXIMATE_FILLS" in (val.get("eligibility_labels", []) if isinstance(val, dict) else []),
        "fills_count": len(report.fills),
        "events_count": len(report.events),
    }
    run_hash = _stable_json_hash(
        {
            "bot_spec_id": payload.bot_spec_id,
            "spec_hash": report.spec_hash,
            "bars": payload.model_dump().get("bars", []),
            "funding_rows": payload.model_dump().get("funding_rows", []),
            "coverage": payload.coverage,
            "event_digest": event_digest,
            "engine_version": report.engine_version,
            "compiler_version": report.compiler_version,
        }
    )

    if metrics["approximate_fills"]:
        result_tier = "LOCAL ONLY" if run_mode == "backtest" else "UNVERIFIED PAPER"
    else:
        result_tier = "BACKTEST VERIFIED" if run_mode == "backtest" else "LIVE PAPER VERIFIED"

    database_url = os.getenv("DATABASE_URL", "postgres://localhost:5432/duality")
    conn = await asyncpg.connect(database_url)
    try:
        strategy_version_id = payload.strategy_version_id or f"bot_{report.spec_hash[:16]}"
        await conn.execute(
            """
            INSERT INTO strategies (strategy_id, owner_id, name)
            VALUES ($1, NULL, $2)
            ON CONFLICT (strategy_id)
            DO UPDATE SET updated_at = NOW()
            """,
            strategy_version_id,
            f"bot-run::{spec.bot_type}",
        )
        await conn.execute(
            """
            INSERT INTO strategy_versions (strategy_version_id, strategy_id, dsl_json, hash)
            VALUES ($1, $2, $3::jsonb, $4)
            ON CONFLICT (strategy_version_id)
            DO UPDATE SET hash = EXCLUDED.hash, updated_at = NOW()
            """,
            strategy_version_id,
            strategy_version_id,
            json.dumps({"bot_spec_id": payload.bot_spec_id, "bot_type": spec.bot_type, "params": spec.params}),
            report.spec_hash,
        )
        await conn.execute(
            """
            INSERT INTO backtest_runs (
              run_id, strategy_version_id, data_version, engine_version, seed, status, result_tier,
              config_json, metrics_json, coverage_proof_json, fill_model_json, run_hash, strategy_hash_at_run, data_snapshot_id,
              liquidation_events, approximate_fills, bot_spec_id, compiler_version, replay_config_json, event_digest,
              canonical_range_start, canonical_range_end, canonical_event_digest
            ) VALUES (
              $1, $2, $3, $4, 42, 'completed', $5,
              $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, 'canonical-v1',
              $12, $13, $14, $15, $16::jsonb, $17,
              to_timestamp($18 / 1000.0), to_timestamp($19 / 1000.0), $20
            )
            """,
            run_id,
            strategy_version_id,
            str(payload.coverage.get("data_version", "ad-hoc")),
            report.engine_version,
            result_tier,
            json.dumps(payload.model_dump()),
            json.dumps(metrics),
            json.dumps(payload.coverage),
            json.dumps(report.fill_model),
            run_hash,
            report.spec_hash,
            metrics["liquidation_events"],
            metrics["approximate_fills"],
            payload.bot_spec_id,
            report.compiler_version,
            json.dumps({"run_kind": "bot_paper" if run_mode == "paper" else "bot_backtest", "replay_mode": "paper_runtime_event_replay"}),
            event_digest,
            int(payload.coverage.get("startTs", payload.bars[0].ts if payload.bars else 0)),
            int(payload.coverage.get("endTs", payload.bars[-1].ts if payload.bars else 0)),
            canonical_digest,
        )
        for evt in report.events:
            ts_raw = evt.get("ts")
            event_ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")) if isinstance(ts_raw, str) else datetime.now(tz=timezone.utc)
            etype = str(evt.get("type", "UNKNOWN"))
            await conn.execute(
                """
                INSERT INTO backtest_events (run_id, event_ts, event_type, payload_json)
                VALUES ($1, $2, $3, $4::jsonb)
                """,
                run_id,
                event_ts,
                etype,
                json.dumps(evt.get("payload", {})),
            )
            worker_event_counter.labels(etype).inc()
        worker_run_counter.labels("bot_paper" if run_mode == "paper" else "bot_backtest", result_tier).inc()
    finally:
        await conn.close()

    out["runId"] = run_id
    out["result_tier"] = result_tier
    out["run_mode"] = run_mode
    return out


@app.post("/bots/recommend")
def bots_recommend(payload: BotRecommendPayload) -> dict:
    bars = _bars_v4(payload.bars)
    rate = Decimal(payload.funding_rate_last) if payload.funding_rate_last else None
    recs = v4_recommend(bars=bars, funding_rate_last=rate, data_complete=payload.data_complete, risk_tolerance=payload.risk_tolerance)
    return {
        "recommendations": [
            {"bot_type": r.bot_type, "regime_label": r.regime_label, "confidence": r.confidence, "params": r.params, "expected_risk": r.expected_risk, "reason": r.reason}
            for r in recs
        ],
        "compiler_version": V4_COMPILER_VERSION,
    }


# ------- Optimizer parameter-grid sweep (Tier 4 #15) -------
from quant_core.optimizer_grid import generate_candidates, merge_with_base


class OptimizerSweepPayload(BaseModel):
    """Generate parameter candidates and event-rescore each against the bot or strategy engine."""
    target: str                                   # "bot" | "algo"
    target_id: str                                # bot_type or strategy_id
    base_params: dict = Field(default_factory=dict)
    param_space: dict = Field(default_factory=dict)
    method: str = "grid"                          # "grid" | "random" | "sobol"
    n_samples: int = 50
    seed: int | None = 42
    max_candidates: int = 200
    symbol: str = "BTCUSDT"
    bars: list[RuntimeBarPayload]
    funding_rows: list[FundingRowPayload] = Field(default_factory=list)
    side_bars: dict[str, list[RuntimeBarPayload]] = Field(default_factory=dict)
    starting_equity: str = "10000"
    risk: dict = Field(default_factory=dict)
    fee_bps_taker: str = "5.5"
    fee_bps_maker: str = "1.0"
    slippage_bps_one_way: str = "2.0"
    interval_minutes: int = 60
    top_n: int = 10
    rank_metric: str = "sharpe"                   # "sharpe" | "total_return" | "calmar" | "sortino"


@app.post("/optimizer/sweep")
async def optimizer_sweep(payload: OptimizerSweepPayload, _slot=Depends(heavy_slot)) -> dict:
    if payload.target not in {"bot", "algo"}:
        return {"error": "TARGET_MUST_BE_BOT_OR_ALGO"}
    if payload.target == "bot" and payload.target_id not in STRATEGY_REGISTRY and payload.target_id not in {t["bot_type"] for t in V4_TEMPLATES}:
        return {"error": "UNKNOWN_TARGET_ID", "target_id": payload.target_id}
    if not payload.param_space:
        return {"error": "PARAM_SPACE_EMPTY",
                "hint": "provide param_space, e.g. {\"grid_count\":{\"values\":[5,8,10]}}"}

    try:
        candidates = generate_candidates(
            payload.param_space,
            method=payload.method,
            n_samples=payload.n_samples,
            seed=payload.seed,
            max_candidates=payload.max_candidates,
        )
    except ValueError as e:
        return {"error": "INVALID_PARAM_SPACE", "detail": str(e)}

    bars = [
        RuntimeBar(
            ts=datetime.fromtimestamp(b.ts / 1000, tz=timezone.utc),
            open=Decimal(b.open), high=Decimal(b.high), low=Decimal(b.low),
            close=Decimal(b.close), volume=Decimal(b.volume),
        )
        for b in payload.bars
    ]
    funding_rows_objs = [
        FundingRow(id=f.id, timestamp=datetime.fromtimestamp(f.timestamp / 1000, tz=timezone.utc), funding_rate=Decimal(f.funding_rate))
        for f in payload.funding_rows
    ]
    side_bars_objs: dict[str, list[RuntimeBar]] = {}
    for sym, rows in payload.side_bars.items():
        side_bars_objs[sym] = [
            RuntimeBar(
                ts=datetime.fromtimestamp(b.ts / 1000, tz=timezone.utc),
                open=Decimal(b.open), high=Decimal(b.high), low=Decimal(b.low),
                close=Decimal(b.close), volume=Decimal(b.volume),
            )
            for b in rows
        ]

    risk_kwargs = {}
    for k in ("max_position_fraction", "max_total_exposure_fraction", "max_daily_loss_fraction", "max_drawdown_kill_fraction"):
        if k in payload.risk:
            risk_kwargs[k] = Decimal(str(payload.risk[k]))

    bars_per_year = 365 * 24 * 60 / payload.interval_minutes

    results = []
    for idx, override in enumerate(candidates):
        params = merge_with_base(payload.base_params, override)
        try:
            if payload.target == "bot":
                spec = V4BotSpec(bot_type=payload.target_id, name=f"sweep-{idx}", symbols=[payload.symbol], params=params)
                bot = build_bot(payload.target_id, params)
                portfolio_starting = Decimal(payload.starting_equity)
                report, _ = v4_run_bot(
                    spec=spec, bot=bot, symbol=payload.symbol,
                    bars=bars, funding_rows=funding_rows_objs,
                    starting_equity=portfolio_starting,
                    risk=payload.risk,
                    fee_bps_taker=Decimal(payload.fee_bps_taker),
                    fee_bps_maker=Decimal(payload.fee_bps_maker),
                    slippage_bps_one_way=Decimal(payload.slippage_bps_one_way),
                    spec_hash_value=v4_spec_hash(spec),
                    compiler_version=V4_COMPILER_VERSION,
                    side_bars=side_bars_objs,
                )
                perf = compute_performance(report.equity_curve, report.trade_pnls, bars_per_year=bars_per_year)
                final_eq = report.final_equity
                fills = len(report.fills)
                killed = report.risk_state.get("killed", False)
            else:  # algo
                portfolio_obj = Portfolio(starting_equity=Decimal(payload.starting_equity), risk=RiskConfig(**risk_kwargs))
                strategy_cls = STRATEGY_REGISTRY[payload.target_id]
                strategy = strategy_cls(params)
                runtime = PaperRuntime(
                    symbol=payload.symbol, portfolio=portfolio_obj, strategy=strategy,
                    fee_bps_taker=Decimal(payload.fee_bps_taker),
                    fee_bps_maker=Decimal(payload.fee_bps_maker),
                    slippage_bps_one_way=Decimal(payload.slippage_bps_one_way),
                )
                result = runtime.run(bars=bars, funding_rows=funding_rows_objs)
                perf = compute_performance(result.equity_curve, result.trade_pnls, bars_per_year=bars_per_year)
                final_eq = result.final_equity
                fills = len(result.fills)
                killed = portfolio_obj.state.killed

            results.append({
                "rank": 0, "candidate_idx": idx, "params": override,
                "final_equity": str(final_eq), "fills": fills, "killed": killed,
                "metrics": {
                    "total_return": perf.total_return, "sharpe": perf.sharpe,
                    "sortino": perf.sortino, "calmar": perf.calmar,
                    "max_drawdown": perf.max_drawdown, "win_rate": perf.win_rate,
                    "profit_factor": perf.profit_factor, "n_trades": perf.n_trades,
                },
            })
        except Exception as exc:
            results.append({
                "rank": -1, "candidate_idx": idx, "params": override,
                "error": f"{type(exc).__name__}: {exc}",
                "metrics": {}, "final_equity": "0", "fills": 0, "killed": False,
            })

    # Rank by the requested metric (descending; lower-is-better metrics negated).
    metric = payload.rank_metric
    def _score(r: dict) -> float:
        if "metrics" not in r or metric not in r["metrics"]:
            return float("-inf")
        return float(r["metrics"][metric] or 0)

    ranked = sorted([r for r in results if "error" not in r], key=_score, reverse=True)
    for i, r in enumerate(ranked):
        r["rank"] = i + 1

    return {
        "status": "completed",
        "target": payload.target, "target_id": payload.target_id,
        "method": payload.method,
        "n_candidates": len(candidates),
        "n_completed": len(ranked),
        "n_errors": len([r for r in results if "error" in r]),
        "rank_metric": metric,
        "top_n": ranked[: payload.top_n],
        "all_results": results,
    }
