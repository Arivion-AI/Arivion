#!/usr/bin/env python3
"""Oracle price keeper for the Duality stock vault on Robinhood Chain testnet.

Fetches live equity prices (Yahoo Finance, no key) and pushes them to the on-chain oracle via
`cast send vault.setPrices(...)`, signed by DEPLOY_PRIVATE_KEY (the vault owner). Run on a cron
(e.g. every minute during market hours) to keep mint/redeem prices fresh; the vault enforces a
staleness window on-chain.

  python3 scripts/push_stock_prices.py            # one push
Reads config from the lab .env: DUALITY_STOCK_VAULT_ADDRESS, DUALITY_STOCK_TOKENS,
ROBINHOOD_TESTNET_RPC_URL (or ALCHEMY), DEPLOY_PRIVATE_KEY.

TESTNET ONLY. Prices are reference marks for a demo venue, not a regulated quote.
"""
from __future__ import annotations

import os
import subprocess
import sys
import urllib.request
import json
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    env.update(os.environ)
    return env


def yahoo_price(symbol: str) -> float | None:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=1d"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 duality-oracle"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
        return float(data["chart"]["result"][0]["meta"]["regularMarketPrice"])
    except Exception as e:
        print(f"  ! {symbol}: yahoo fetch failed: {e}", file=sys.stderr)
        return None


def main() -> int:
    env = load_env()
    vault = env.get("DUALITY_STOCK_VAULT_ADDRESS")
    pk = env.get("DEPLOY_PRIVATE_KEY")
    rpc = env.get("ROBINHOOD_TESTNET_ALCHEMY_RPC_URL") or env.get("ROBINHOOD_TESTNET_RPC_URL")
    tokens_cfg = env.get("DUALITY_STOCK_TOKENS", "")
    if not (vault and pk and rpc and tokens_cfg):
        print("missing config (vault/pk/rpc/tokens)", file=sys.stderr)
        return 1
    symbols = [pair.split(":", 1)[0] for pair in tokens_cfg.split(",") if ":" in pair]

    syms_ok: list[str] = []
    prices_1e8: list[str] = []
    for sym in symbols:
        px = yahoo_price(sym)
        if px and px > 0:
            syms_ok.append(sym)
            prices_1e8.append(str(int(round(px * 1e8))))
            print(f"  {sym}: ${px:.2f}")
    if not syms_ok:
        print("no prices fetched; skipping push", file=sys.stderr)
        return 1

    syms_arg = "[" + ",".join(syms_ok) + "]"
    prices_arg = "[" + ",".join(prices_1e8) + "]"
    cmd = [
        "cast", "send", vault, "setPrices(string[],uint256[])", syms_arg, prices_arg,
        "--rpc-url", rpc, "--private-key", pk,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"cast send failed: {res.stderr[:400]}", file=sys.stderr)
        return 1
    print(f"pushed {len(syms_ok)} prices to oracle {vault}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
