from __future__ import annotations

import json
import os
import subprocess
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from urllib import error, parse, request


ROOT = Path(__file__).resolve().parents[2]
API_BASE = os.getenv("API_BASE", "http://localhost:4400")


def sql_lit(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def http_get(path: str, token: str | None = None) -> dict:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    req = request.Request(url=f"{API_BASE}{path}", headers=headers, method="GET")
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


def psql(sql: str) -> str:
    # Use `docker exec` (not `docker compose exec`) — the latter re-resolves the compose
    # project/network on every call and adds ~30s/call on macOS, which made the suite
    # take ~15 min. `docker exec` against the known container name is ~50ms.
    result = subprocess.run(
        [
            "docker", "exec", "-i", "infra-postgres-1",
            "psql", "-U", "duality", "-d", "duality", "-t", "-A", "-c", sql,
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def require_stack() -> None:
    try:
        body = http_get("/health")
    except (OSError, error.URLError) as exc:
        raise unittest.SkipTest(f"API stack is not reachable at {API_BASE}: {exc}") from exc
    if not body.get("ok"):
        raise unittest.SkipTest(f"API stack is unhealthy: {body}")


class MarketReplayPhase7To10IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        require_stack()
        cls.token = http_get("/auth/dev-token?ownerId=1")["token"]

    def setUp(self) -> None:
        self.suffix = str(int(time.time() * 1000))
        self.dv = f"itest-p7-10-{self.suffix}"
        self.symbol = f"TST{self.suffix}USDT"
        self.start_ms = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
        self.end_ms = self.start_ms + 3 * 60_000

    def tearDown(self) -> None:
        psql(
            f"""
            DELETE FROM marketplace_cards WHERE run_id LIKE 'itest-p7-10-%';
            DELETE FROM backtest_runs WHERE run_id LIKE 'itest-p7-10-%';
            DELETE FROM bot_specs WHERE bot_spec_id LIKE 'itest-p7-10-%';
            DELETE FROM strategy_versions WHERE strategy_version_id LIKE 'itest-p7-10-%';
            DELETE FROM strategies WHERE strategy_id LIKE 'itest-p7-10-%';
            DELETE FROM candles WHERE data_version = {sql_lit(self.dv)};
            DELETE FROM mark_candles WHERE data_version = {sql_lit(self.dv)};
            DELETE FROM index_candles WHERE data_version = {sql_lit(self.dv)};
            DELETE FROM l2_snapshots WHERE data_version = {sql_lit(self.dv)};
            DELETE FROM trades WHERE data_version = {sql_lit(self.dv)};
            DELETE FROM instrument_snapshots WHERE data_version = {sql_lit(self.dv)};
            DELETE FROM live_paper_checkpoints WHERE session_id LIKE 'itest-lp-%';
            DELETE FROM live_paper_sessions WHERE session_id LIKE 'itest-lp-%';
            """
        )

    def seed_market_data_with_gap(self) -> None:
        s = self.start_ms
        psql(
            f"""
            INSERT INTO candles (symbol, category, interval, open_time, open, high, low, close, volume, turnover, data_version, checksum)
            VALUES
              ({sql_lit(self.symbol)}, 'linear', '1', to_timestamp({s}/1000.0), '100','101','99','100','1','1',{sql_lit(self.dv)},'c0'),
              ({sql_lit(self.symbol)}, 'linear', '1', to_timestamp(({s}+120000)/1000.0), '102','103','101','102','1','1',{sql_lit(self.dv)},'c2')
            ON CONFLICT (symbol, category, interval, open_time) DO UPDATE SET data_version=EXCLUDED.data_version;

            INSERT INTO mark_candles (symbol, interval, open_time, open, high, low, close, data_version)
            VALUES
              ({sql_lit(self.symbol)}, '1', to_timestamp({s}/1000.0), '100','101','99','100',{sql_lit(self.dv)}),
              ({sql_lit(self.symbol)}, '1', to_timestamp(({s}+60000)/1000.0), '101','102','100','101',{sql_lit(self.dv)}),
              ({sql_lit(self.symbol)}, '1', to_timestamp(({s}+120000)/1000.0), '102','103','101','102',{sql_lit(self.dv)})
            ON CONFLICT (symbol, interval, open_time) DO UPDATE SET data_version=EXCLUDED.data_version;

            INSERT INTO index_candles (symbol, interval, open_time, open, high, low, close, data_version)
            VALUES
              ({sql_lit(self.symbol)}, '1', to_timestamp({s}/1000.0), '100','101','99','100',{sql_lit(self.dv)}),
              ({sql_lit(self.symbol)}, '1', to_timestamp(({s}+60000)/1000.0), '101','102','100','101',{sql_lit(self.dv)}),
              ({sql_lit(self.symbol)}, '1', to_timestamp(({s}+120000)/1000.0), '102','103','101','102',{sql_lit(self.dv)})
            ON CONFLICT (symbol, interval, open_time) DO UPDATE SET data_version=EXCLUDED.data_version;

            INSERT INTO l2_snapshots (ts, symbol, category, sequence_id, checksum, best_bid, best_ask, bid_levels_json, ask_levels_json, data_version)
            VALUES
              (to_timestamp({s}/1000.0), {sql_lit(self.symbol)}, 'linear', 1, 'l0', '99', '101', '[[\"99\",\"10\"]]'::jsonb, '[[\"101\",\"10\"]]'::jsonb, {sql_lit(self.dv)}),
              (to_timestamp(({s}+60000)/1000.0), {sql_lit(self.symbol)}, 'linear', 2, 'l1', '100', '102', '[[\"100\",\"10\"]]'::jsonb, '[[\"102\",\"10\"]]'::jsonb, {sql_lit(self.dv)}),
              (to_timestamp(({s}+120000)/1000.0), {sql_lit(self.symbol)}, 'linear', 3, 'l2', '101', '103', '[[\"101\",\"10\"]]'::jsonb, '[[\"103\",\"10\"]]'::jsonb, {sql_lit(self.dv)})
            ON CONFLICT (symbol, category, ts, sequence_id) DO NOTHING;

            INSERT INTO trades (ts, trade_time_ms, symbol, category, trade_id, side, price, qty, data_version)
            VALUES
              (to_timestamp({s}/1000.0), {s}, {sql_lit(self.symbol)}, 'linear', 'dup-trade', 'Sell', '99', '1', {sql_lit(self.dv)}),
              (to_timestamp({s}/1000.0), {s}, {sql_lit(self.symbol)}, 'linear', 'dup-trade', 'Sell', '99', '1', {sql_lit(self.dv)})
            ON CONFLICT (symbol, category, trade_id, ts) DO NOTHING;

            INSERT INTO instrument_snapshots (
              symbol, tick_size, qty_step, funding_interval_minutes, max_leverage,
              maintenance_margin_tiers_json, extra_filters_json, status, valid_from, data_version
            ) VALUES (
              {sql_lit(self.symbol)}, '0.1', '0.001', 480, '100',
              '[{{"risk_id":1,"notional_cap":"2000000","mmr_fraction":"0.005","initial_margin_fraction":"0.01","max_leverage":"100"}}]'::jsonb,
              '{{"minOrderQty":"0.001","minNotionalValue":"5"}}'::jsonb,
              'Trading', to_timestamp({s}/1000.0), {sql_lit(self.dv)}
            )
            ON CONFLICT (symbol, valid_from) DO UPDATE SET data_version=EXCLUDED.data_version;
            """
        )

    def test_data_coverage_reports_gap_and_trade_dedup(self) -> None:
        self.seed_market_data_with_gap()
        count = psql(
            f"SELECT count(*) FROM trades WHERE symbol={sql_lit(self.symbol)} AND data_version={sql_lit(self.dv)};"
        )
        self.assertEqual(count, "1")

        q = parse.urlencode({
            "symbol": self.symbol,
            "category": "linear",
            "interval": "1",
            "startTs": self.start_ms,
            "endTs": self.end_ms,
        })
        body = http_get(f"/api/data/coverage?{q}", self.token)
        proof = body["coverage_proof"]
        self.assertEqual(proof["candles"]["coverage_pct"], 0.666667)
        self.assertEqual(proof["candles"]["missing_ranges"], [
            {"startMs": self.start_ms + 60_000, "endMs": self.start_ms + 120_000}
        ])
        self.assertEqual(proof["trades"]["rows"], 1)
        self.assertEqual(proof["risk_limit_snapshot"]["tiers"], 1)

    def test_publish_refuses_queue_badge_without_trade_coverage_proof(self) -> None:
        run_id = f"itest-p7-10-run-{self.suffix}"
        spec_id = f"itest-p7-10-spec-{self.suffix}"
        sv = f"itest-p7-10-sv-{self.suffix}"
        proof = {
            "candles": {"coverage_pct": 1, "missing_ranges": [], "rows": 3},
            "l2_snapshots": {"coverage_pct": 1, "depth": 50, "missing_ranges": [], "rows": 3},
            "trades": {"coverage_pct": 0, "missing_ranges": [{"startMs": self.start_ms, "endMs": self.end_ms}], "rows": 0},
            "mark_prices": {"coverage_pct": 1, "missing_ranges": [], "rows": 3},
            "index_prices": {"coverage_pct": 1, "missing_ranges": [], "rows": 3},
            "funding": {"coverage_pct": 0, "rows": 0},
            "instrument_snapshot": {"version": self.dv, "fetched_at": "2026-01-01T00:00:00.000Z"},
            "risk_limit_snapshot": {"version": self.dv, "fetched_at": "2026-01-01T00:00:00.000Z", "tiers": 1},
        }
        fill_model = {
            "mode": "l2_queue_full",
            "l2_provider_used": True,
            "trade_prints_used": True,
            "snapshot_coverage_pct": 1,
            "trade_coverage_pct": 1,
        }
        psql(
            f"""
            INSERT INTO bot_templates (template_id, bot_type, display_name, description, category, risk_class, default_params_json, param_schema_json)
            VALUES ('itest-template', 'chase_limit', 'itest', 'itest', 'execution', 'LOW', '{{}}'::jsonb, '{{}}'::jsonb)
            ON CONFLICT (template_id) DO NOTHING;
            INSERT INTO bot_template_versions (version_id, template_id, version, param_schema_json, compiler_version)
            VALUES ('itest-template-v1', 'itest-template', 1, '{{}}'::jsonb, 'itest')
            ON CONFLICT (version_id) DO NOTHING;
            INSERT INTO bot_specs (bot_spec_id, owner_id, template_version_id, bot_type, name, universe_json, params_json, risk_json, accounting_json, spec_hash)
            VALUES ({sql_lit(spec_id)}, 1, 'itest-template-v1', 'chase_limit', 'itest', '{{"symbols":["BTCUSDT"]}}'::jsonb, '{{}}'::jsonb, '{{}}'::jsonb, '{{}}'::jsonb, 'hash-itest')
            ON CONFLICT (bot_spec_id) DO NOTHING;
            INSERT INTO strategies (strategy_id, owner_id, name)
            VALUES ({sql_lit(sv)}, 1, {sql_lit(sv)})
            ON CONFLICT (strategy_id) DO NOTHING;
            INSERT INTO strategy_versions (strategy_version_id, strategy_id, dsl_json, hash, owner_id)
            VALUES ({sql_lit(sv)}, {sql_lit(sv)}, '{{}}'::jsonb, 'hash-itest', 1)
            ON CONFLICT (strategy_version_id) DO NOTHING;
            INSERT INTO backtest_runs (
              run_id, strategy_version_id, data_version, engine_version, seed, status, result_tier,
              config_json, metrics_json, coverage_proof_json, fill_model_json, run_hash,
              strategy_hash_at_run, data_snapshot_id, liquidation_events, approximate_fills,
              bot_spec_id, compiler_version, canonical_range_start, canonical_range_end
            ) VALUES (
              {sql_lit(run_id)}, {sql_lit(sv)}, {sql_lit(self.dv)}, 'itest-engine', 42, 'completed', 'BACKTEST VERIFIED',
              '{{"symbol":"BTCUSDT","category":"linear","interval_minutes":1}}'::jsonb,
              '{{"total_return_after_fees_funding":0.1}}'::jsonb,
              {sql_lit(json.dumps({"coverage_proof": proof}))}::jsonb,
              {sql_lit(json.dumps(fill_model))}::jsonb,
              'runhash-itest', 'hash-itest', 'canonical-v1', 0, false,
              {sql_lit(spec_id)}, 'itest-compiler',
              to_timestamp({self.start_ms}/1000.0), to_timestamp({self.end_ms}/1000.0)
            )
            ON CONFLICT (run_id) DO NOTHING;
            """
        )
        body = http_post(
            "/api/bots/marketplace/publish",
            {
                "botSpecId": spec_id,
                "runId": run_id,
                "runKind": "backtest",
                "title": "itest",
                "botType": "chase_limit",
                "symbolSet": ["BTCUSDT"],
                "summary": {},
                "metrics": {},
                "risk": {},
                "dataVersion": self.dv,
                "engineVersion": "itest-engine",
                "compilerVersion": "itest-compiler",
                "resultTier": "BACKTEST VERIFIED",
            },
            self.token,
        )
        self.assertFalse(body["published"])
        self.assertEqual(body["resultTier"], "LOCAL ONLY")
        self.assertIn("TRADE_COVERAGE_BELOW_THRESHOLD", body["eligibilityLabels"])

    def _seed_candles(self, symbol: str, base_ms: int, n: int, skip: set[int]) -> None:
        vals = ",\n".join(
            f"(to_timestamp(({base_ms}+{i}*60000)/1000.0), {sql_lit(symbol)}, 'linear', '1', 100,101,99,100,10,0, {sql_lit(self.dv)}, 'x')"
            for i in range(n) if i not in skip
        )
        psql(
            f"INSERT INTO candles (open_time,symbol,category,interval,open,high,low,close,volume,turnover,data_version,checksum) "
            f"VALUES\n{vals}\nON CONFLICT DO NOTHING;"
        )

    def _seed_session(self, session_id: str, symbol: str, start_bar_ms: int) -> None:
        psql(
            f"INSERT INTO live_paper_sessions (session_id, owner_id, strategy_id, symbol, category, params_json, "
            f"starting_equity, interval_minutes, risk_json, status, start_bar_ms, execution_fidelity) "
            f"VALUES ({sql_lit(session_id)}, '1', 'trend_ema_cross', {sql_lit(symbol)}, 'linear', '{{}}'::jsonb, "
            f"10000, 1, '{{}}'::jsonb, 'running', {start_bar_ms}, 'bar_based') "
            f"ON CONFLICT (session_id) DO UPDATE SET status='running', start_bar_ms=EXCLUDED.start_bar_ms;"
        )

    def _await_session(self, session_id: str, predicate, timeout_s: int = 120):
        # Tolerate transient errors: /api/live-paper/sessions proxies to the worker, which is
        # briefly unreachable (502/connection refused) during the restart this test triggers.
        deadline = time.time() + timeout_s
        last = None
        while time.time() < deadline:
            try:
                rows = http_get("/api/live-paper/sessions", self.token).get("sessions", [])
                last = next((s for s in rows if s["session_id"] == session_id), None)
                if last and predicate(last):
                    return last
            except (error.URLError, OSError):
                pass
            time.sleep(5)
        return last

    def test_live_paper_restart_recovery_and_gap_block(self) -> None:
        """Phase 6/10: after a worker restart, a session with contiguous candles resumes via
        deterministic replay (no 400-bar truncation, no equity reset); a session with a candle
        gap is blocked, never silently resumed. One restart exercises both."""
        base = self.start_ms
        ok_sym = f"RCV{self.suffix}USDT"
        gap_sym = f"GAP{self.suffix}USDT"
        ok_sid = f"itest-lp-rcv-{self.suffix}"
        gap_sid = f"itest-lp-gap-{self.suffix}"
        # 30 contiguous bars; and 30 bars with minutes 10..14 missing (a 5-bar hole > tolerance 2).
        self._seed_candles(ok_sym, base, 30, skip=set())
        self._seed_candles(gap_sym, base, 30, skip={10, 11, 12, 13, 14})
        self._seed_session(ok_sid, ok_sym, base)
        self._seed_session(gap_sid, gap_sym, base)
        try:
            subprocess.run(["docker", "restart", "infra-worker-1"], check=True, capture_output=True)
            ok = self._await_session(ok_sid, lambda s: any(
                e.get("type") == "RECOVERY_COMPLETED" for e in s.get("recovery_events", [])))
            gap = self._await_session(gap_sid, lambda s: s.get("status") == "recovery_blocked")
            # Contiguous session: resumed, running, replayed bars (not truncated to 0).
            self.assertIsNotNone(ok)
            self.assertEqual(ok["status"], "running")
            self.assertIn("RECOVERY_COMPLETED", [e.get("type") for e in ok.get("recovery_events", [])])
            self.assertGreater(int(ok.get("bars_seen") or 0), 0)
            # Gapped session: blocked, with the gap-detection event trail.
            self.assertIsNotNone(gap)
            self.assertEqual(gap["status"], "recovery_blocked")
            types = [e.get("type") for e in gap.get("recovery_events", [])]
            self.assertIn("RECOVERY_GAP_DETECTED", types)
            self.assertIn("RECOVERY_BLOCKED", types)
        finally:
            psql(f"DELETE FROM live_paper_checkpoints WHERE session_id IN ({sql_lit(ok_sid)},{sql_lit(gap_sid)});"
                 f"DELETE FROM live_paper_sessions WHERE session_id IN ({sql_lit(ok_sid)},{sql_lit(gap_sid)});")


if __name__ == "__main__":
    unittest.main()
