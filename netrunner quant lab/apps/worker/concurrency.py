"""Concurrency control for heavy compute endpoints (backtests, paper, portfolio,
optimizer) so 100 users running many strategies stay fair and the box stays alive.

  * GLOBAL cap  — at most HEAVY_CONCURRENCY heavy jobs in flight (≈ 1 job/core).
  * PER-OWNER cap — a single user can hold at most OWNER_CONCURRENCY slots, so one
    user's sweep can't starve the other 99 (token-bucket fairness).
  * Over-limit -> HTTP 429 (owner limit) / 429 SERVER_BUSY (global wait timeout).

Owner identity comes from the ``x-owner-id`` header the API forwards from the JWT.
"""
from __future__ import annotations

import asyncio
import os
from collections import defaultdict

from fastapi import Header, HTTPException, Request
from fastapi.responses import JSONResponse

from security import internal_secret_ok

INTERNAL_SECRET = os.getenv("INTERNAL_SECRET", "")


async def internal_secret_middleware(request: Request, call_next):
    """Defense-in-depth: if INTERNAL_SECRET is set, every request must carry a matching
    x-internal-secret header (the API adds it). So a spoofed x-owner-id alone — e.g. from
    a leaked worker port or SSRF — is rejected. /health and /metrics are exempt.
    Logic lives in the pure ``internal_secret_ok`` (security.py) so it is unit-testable."""
    if not internal_secret_ok(request.url.path, request.headers.get("x-internal-secret"), INTERNAL_SECRET):
        return JSONResponse(status_code=401, content={"error": "INTERNAL_SECRET_MISMATCH"})
    return await call_next(request)

HEAVY_CONCURRENCY = int(os.getenv("HEAVY_CONCURRENCY", str(max(2, os.cpu_count() or 2))))
OWNER_CONCURRENCY = int(os.getenv("OWNER_CONCURRENCY", "3"))
ACQUIRE_TIMEOUT = float(os.getenv("HEAVY_ACQUIRE_TIMEOUT", "30"))

_global_sem = asyncio.Semaphore(HEAVY_CONCURRENCY)
_owner_inflight: dict[str, int] = defaultdict(int)
_lock = asyncio.Lock()
_stats = {"active": 0, "max_active": 0, "queued_peak": 0, "total": 0,
          "rejected_owner": 0, "rejected_busy": 0}
_queued = 0


async def heavy_slot(x_owner_id: str = Header(default="anon")):
    """FastAPI dependency (with yield) that enforces the caps around a heavy job."""
    global _queued
    owner = x_owner_id or "anon"
    async with _lock:
        if _owner_inflight[owner] >= OWNER_CONCURRENCY:
            _stats["rejected_owner"] += 1
            raise HTTPException(status_code=429, detail={
                "error": "OWNER_CONCURRENCY_LIMIT", "owner": owner, "limit": OWNER_CONCURRENCY})
        _owner_inflight[owner] += 1
        _queued += 1
        _stats["queued_peak"] = max(_stats["queued_peak"], _queued)
    acquired = False
    try:
        try:
            await asyncio.wait_for(_global_sem.acquire(), timeout=ACQUIRE_TIMEOUT)
            acquired = True
        except asyncio.TimeoutError:
            _stats["rejected_busy"] += 1
            raise HTTPException(status_code=429, detail={
                "error": "SERVER_BUSY", "global_limit": HEAVY_CONCURRENCY})
        async with _lock:
            _queued -= 1
            _stats["active"] += 1
            _stats["total"] += 1
            _stats["max_active"] = max(_stats["max_active"], _stats["active"])
        yield
    finally:
        async with _lock:
            _owner_inflight[owner] = max(0, _owner_inflight[owner] - 1)
            if acquired:
                _stats["active"] -= 1
            else:
                _queued = max(0, _queued - 1)
        if acquired:
            _global_sem.release()


def stats() -> dict:
    return {
        **_stats,
        "heavy_concurrency": HEAVY_CONCURRENCY,
        "owner_concurrency": OWNER_CONCURRENCY,
        "acquire_timeout_s": ACQUIRE_TIMEOUT,
        "owners_inflight": {k: v for k, v in _owner_inflight.items() if v > 0},
    }
