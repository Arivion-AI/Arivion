from __future__ import annotations

import json
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from urllib import request


API_BASE = "http://localhost:4400"


def http_post(path: str, payload: dict) -> dict:
    req = request.Request(
        url=f"{API_BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get(path: str) -> dict:
    with request.urlopen(f"{API_BASE}{path}", timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


class Phase9LoadTests(unittest.TestCase):
    def test_100_concurrent_paper_sessions(self) -> None:
        suffix = str(int(time.time()))
        health = http_get("/health")
        self.assertTrue(health["ok"])

        for i in range(100):
            owner_id = 1000 + i
            acct = f"load-acct-{suffix}-{i}"
            http_post(
                "/api/paper/accounts",
                {"accountId": acct, "ownerId": owner_id, "startingBalance": "10000"},
            )

        for i in range(100):
            acct = f"load-acct-{suffix}-{i}"
            sess = f"load-sess-{suffix}-{i}"
            http_post(
                "/api/paper/sessions",
                {
                    "sessionId": sess,
                    "accountId": acct,
                    "strategyVersionId": f"load-sv-{suffix}",
                    "symbol": "BTCUSDT",
                    "maxDataAgeMs": 30000,
                    "requiredFreshTicks": 3,
                },
            )

        now_ms = int(time.time() * 1000)

        def tick(i: int) -> dict:
            sess = f"load-sess-{suffix}-{i}"
            return http_post(
                f"/api/paper/sessions/{sess}/tick",
                {
                    "symbol": "BTCUSDT",
                    "price": str(65000 + i),
                    "tsMs": now_ms + i,
                    "nowMs": now_ms + i,
                },
            )

        with ThreadPoolExecutor(max_workers=25) as pool:
            results = list(pool.map(tick, range(100)))

        for out in results:
            self.assertIn("sessionId", out)
            self.assertNotIn("error", out)

        health_after = http_get("/health")
        self.assertTrue(health_after["ok"])


if __name__ == "__main__":
    unittest.main()
