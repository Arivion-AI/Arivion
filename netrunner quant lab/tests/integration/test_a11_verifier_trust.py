from __future__ import annotations

import hashlib
import json
import subprocess
import time
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from urllib import request

from quant_core.engine import BacktestBar, EventBacktestEngine


ROOT = Path(__file__).resolve().parents[2]
API_BASE = "http://localhost:4400"


def http_get(path: str) -> dict:
    req = request.Request(url=f"{API_BASE}{path}", method="GET")
    with request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_post(path: str, payload: dict, token: str) -> dict:
    req = request.Request(
        url=f"{API_BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    with request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def psql(sql: str) -> None:
    subprocess.run(
        [
            "docker",
            "compose",
            "-f",
            "infra/docker-compose.yml",
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "duality",
            "-d",
            "duality",
            "-c",
            sql,
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )


def stable_hash(payload: object) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")).hexdigest()


class A11VerifierTrustTests(unittest.TestCase):
    def setUp(self) -> None:
        self.suffix = str(int(time.time() * 1000))
        self.strategy_version_id = f"sv-a11-{self.suffix}"
        self.strategy_id = self.strategy_version_id
        self.run_id = f"run-a11-{self.suffix}"
        self.strategy_hash = stable_hash({"strategy": self.strategy_version_id})
        self.token = http_get("/auth/dev-token?ownerId=101")["token"]

        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        bars = [
            BacktestBar(ts=start + timedelta(minutes=15 * i), open=Decimal(str(100 + i)), high=Decimal(str(101 + i)), low=Decimal(str(99 + i)), close=Decimal(str(100 + i)))
            for i in range(4)
        ]
        coverage = {
            "symbol": "BTCUSDT",
            "category": "linear",
            "interval": "15",
            "startTs": int(bars[0].ts.timestamp() * 1000),
            "endTs": int(bars[-1].ts.timestamp() * 1000),
            "expectedBars": 4,
            "actualBars": 4,
            "missingBars": 0,
            "duplicateBars": 0,
        }
        config = {
            "strategyVersionId": self.strategy_version_id,
            "symbol": "BTCUSDT",
            "category": "linear",
            "intervalMinutes": 15,
            "dataVersion": "v1",
            "engineVersion": "quant-core-phase3-v2",
            "seed": 42,
            "bars": [
                {"ts": int(b.ts.timestamp() * 1000), "open": str(b.open), "high": str(b.high), "low": str(b.low), "close": str(b.close)}
                for b in bars
            ],
            "fundingRows": [],
            "signalBarIndex": 0,
            "side": "long",
            "qty": "1",
            "slippageBpsOneWay": "0",
        }
        engine = EventBacktestEngine(engine_version="quant-core-phase3-v2")
        mark_by_ts = {b.ts: b.close for b in bars}
        result = engine.run(
            symbol="BTCUSDT",
            bars=bars,
            funding_rows=[],
            mark_price_lookup=lambda _s, ts: mark_by_ts.get(ts, bars[-1].close),
            signals={0: "long"},
            slippage_bps_one_way=Decimal("0"),
            qty=Decimal("1"),
            category="linear",
            seed=42,
        )
        event_digest = stable_hash([
            {"event_type": e.event_type, "event_ts": e.event_ts.isoformat(), "payload": e.payload}
            for e in result.events
        ])
        self.run_hash = stable_hash(
            {
                "strategy_version_id": self.strategy_version_id,
                "symbol": "BTCUSDT",
                "category": "linear",
                "interval_minutes": 15,
                "data_version": "v1",
                "engine_version": "quant-core-phase3-v2",
                "seed": 42,
                "coverage_proof": coverage,
                "config": config,
                "event_digest": event_digest,
            }
        )

        psql(
            f"""
            INSERT INTO users (id, email, display_name)
            VALUES (101, 'a11-101@local', 'A11 User')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO strategies (strategy_id, owner_id, name)
            VALUES ('{self.strategy_id}', 101, '{self.strategy_id}')
            ON CONFLICT (strategy_id) DO NOTHING;

            INSERT INTO strategy_versions (strategy_version_id, strategy_id, dsl_json, hash, owner_id)
            VALUES ('{self.strategy_version_id}', '{self.strategy_id}', '{{}}'::jsonb, '{self.strategy_hash}', 101)
            ON CONFLICT (strategy_version_id) DO UPDATE SET hash = EXCLUDED.hash, owner_id = EXCLUDED.owner_id;

            INSERT INTO candles (symbol, category, interval, open_time, open, high, low, close, volume, turnover, data_version, checksum)
            VALUES
              ('BTCUSDT','linear','15',to_timestamp({coverage["startTs"]}/1000.0),'100','101','99','100','1','1','v1','c1'),
              ('BTCUSDT','linear','15',to_timestamp({coverage["startTs"] + 900000}/1000.0),'101','102','100','101','1','1','v1','c2'),
              ('BTCUSDT','linear','15',to_timestamp({coverage["startTs"] + 1800000}/1000.0),'102','103','101','102','1','1','v1','c3'),
              ('BTCUSDT','linear','15',to_timestamp({coverage["startTs"] + 2700000}/1000.0),'103','104','102','103','1','1','v1','c4')
            ON CONFLICT (symbol, category, interval, open_time) DO UPDATE SET close = EXCLUDED.close;

            INSERT INTO backtest_runs (
              run_id, strategy_version_id, data_version, engine_version, seed, status, result_tier,
              config_json, metrics_json, coverage_proof_json, run_hash, strategy_hash_at_run, data_snapshot_id,
              liquidation_events, approximate_fills, event_digest
            ) VALUES (
              '{self.run_id}', '{self.strategy_version_id}', 'v1', 'quant-core-phase3-v2', 42, 'completed', 'LOCAL ONLY',
              '{json.dumps(config)}'::jsonb,
              '{{"total_return_after_fees_funding":999,"sharpe":999,"max_drawdown":999}}'::jsonb,
              '{json.dumps(coverage)}'::jsonb,
              '{self.run_hash}', '{self.strategy_hash}', 'canonical-v1', 0, false, '{event_digest}'
            )
            ON CONFLICT (run_id) DO UPDATE SET
              run_hash = EXCLUDED.run_hash,
              strategy_hash_at_run = EXCLUDED.strategy_hash_at_run,
              config_json = EXCLUDED.config_json,
              coverage_proof_json = EXCLUDED.coverage_proof_json;
            """
        )

    def test_mismatched_local_summary_is_rejected(self) -> None:
        body = http_post(
            "/api/passports/publish",
            {
                "runId": self.run_id,
                "strategyHash": self.strategy_hash,
                "requestVerification": True,
                "requestedTier": "BACKTEST_VERIFIED",
                "localRunSummary": {
                    "total_return_after_fees_funding": 0.5,
                    "sharpe": 4.5,
                    "calmar": 3.0,
                    "max_drawdown": 0.10,
                    "consistency": 0.9,
                    "robustness": 0.9,
                    "live_paper_score": 0.0,
                    "liquidation_events": 0,
                    "data_coverage_complete": True,
                    "overfit_penalty": 0.05,
                    "approximate_fills": False,
                },
                "cohort": [],
            },
            self.token,
        )
        self.assertEqual(body["status"], "REJECTED")
        self.assertEqual(body["tier"], "UNVERIFIED PAPER")

    def test_canonical_summary_verifies(self) -> None:
        body = http_post(
            "/api/passports/publish",
            {
                "runId": self.run_id,
                "strategyHash": self.strategy_hash,
                "requestVerification": True,
                "requestedTier": "BACKTEST_VERIFIED",
                "localRunSummary": {
                    "total_return_after_fees_funding": 0.0,
                    "sharpe": 0.0,
                    "calmar": 0.0,
                    "max_drawdown": 0.0,
                    "consistency": 0.6,
                    "robustness": 0.6,
                    "live_paper_score": 0.0,
                    "liquidation_events": 0,
                    "data_coverage_complete": True,
                    "overfit_penalty": 0.05,
                    "approximate_fills": False,
                },
                "cohort": [],
            },
            self.token,
        )
        self.assertEqual(body["status"], "VERIFIED")
        self.assertEqual(body["tier"], "BACKTEST VERIFIED")
        self.assertAlmostEqual(body["officialScore"], 0.0, places=6)


if __name__ == "__main__":
    unittest.main()

