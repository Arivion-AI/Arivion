#!/usr/bin/env python3
"""Load the multi-regime historical library into Postgres via the data-ingestor.

Run from the repo root after ``docker compose up -d``::

    python3 scripts/load_regimes.py            # load every regime
    python3 scripts/load_regimes.py --only btc_2021_bull btc_2022_bear
    python3 scripts/load_regimes.py --skip-existing  # skip regimes that already have full coverage
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

# Local import; works when invoked from repo root.
sys.path.insert(0, "packages/quant-core")
from quant_core.regime_library import REGIMES, HistoricalRegime, regime_by_id  # noqa: E402

API = "http://localhost:4400"


def _get_token() -> str:
    req = urllib.request.Request(url=f"{API}/auth/dev-token?ownerId=1", method="GET")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))["token"]


_TOKEN: str | None = None


def http_post(path: str, body: dict, timeout: int = 600) -> dict:
    global _TOKEN
    if _TOKEN is None:
        _TOKEN = _get_token()
    req = urllib.request.Request(
        url=f"{API}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {_TOKEN}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_regime(regime: HistoricalRegime) -> dict:
    print(f"  → {regime.regime_id}  [{regime.symbol} {regime.interval}]  "
          f"{regime.start.date()} → {regime.end.date()}")
    t0 = time.time()
    try:
        # Use the API regime-load proxy that talks to data-ingestor inside the docker network.
        res = http_post(f"/api/regimes/{regime.regime_id}/load", {}, timeout=600)
        elapsed = time.time() - t0
        print(f"    ok · rows={res.get('rows')}  elapsed={elapsed:.1f}s")
        return {"regime_id": regime.regime_id, "ok": True, "rows": res.get("rows"), "elapsed_s": elapsed}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"    FAIL · http {e.code}  {body[:200]}")
        return {"regime_id": regime.regime_id, "ok": False, "error": body[:200]}
    except Exception as e:
        print(f"    FAIL · {e}")
        return {"regime_id": regime.regime_id, "ok": False, "error": str(e)}


def main() -> None:
    p = argparse.ArgumentParser(description="Load multi-regime historical library into Postgres.")
    p.add_argument("--only", nargs="+", help="Only load these regime_ids")
    args = p.parse_args()

    targets = REGIMES
    if args.only:
        targets = [r for r in REGIMES if r.regime_id in set(args.only)]
        missing = set(args.only) - {r.regime_id for r in targets}
        if missing:
            print(f"Unknown regime_ids: {missing}", file=sys.stderr)
            sys.exit(2)

    print(f"Loading {len(targets)} regime(s) into Postgres via {API} …")
    results = []
    for regime in targets:
        results.append(load_regime(regime))
        # Be polite to Bybit between large fetches.
        time.sleep(0.5)

    ok_count = sum(1 for r in results if r.get("ok"))
    fail_count = sum(1 for r in results if not r.get("ok"))
    total_rows = sum(int(r.get("rows", 0)) for r in results if r.get("ok"))
    print(f"\nDone. {ok_count} ok · {fail_count} fail · {total_rows} rows total.")
    if fail_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
