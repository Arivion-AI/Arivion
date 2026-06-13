"""Shared event-digest helpers (determinism / verification spine).

The worker hashes a run's event list into ``event_digest`` (and from there ``run_hash``). Order
IDs in those events come from a PROCESS-GLOBAL counter (``orders._order_id_counter``, never reset),
so the RAW digest depends on how many orders the process created earlier — it is not reproducible
across processes (the worker that produced the run vs the verifier that replays it).

``canonical_event_digest`` canonicalizes order IDs to a per-run, first-appearance sequence before
hashing, so two faithful replays of the same run agree regardless of the global counter. Production
order-ID assignment is intentionally NOT changed (that would alter the byte-identity of already-
verified run hashes); the canonical digest is the cross-process-stable comparison key.

Pure & deterministic — no DB, no wall-clock, no RNG.
"""
from __future__ import annotations

import hashlib
import json


def stable_json_hash(payload) -> str:
    """Canonical JSON sha256 — MUST match apps/worker/main.py:_stable_json_hash byte-for-byte."""
    normalized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def canonicalize_order_ids(events: list[dict]) -> list[dict]:
    """Remap every distinct ``order_id`` (top-level or in ``payload``) to ``o0,o1,…`` in
    first-appearance order. Leaves all other fields untouched."""
    mapping: dict[str, str] = {}

    def remap(v: str) -> str:
        if v not in mapping:
            mapping[v] = f"o{len(mapping)}"
        return mapping[v]

    out: list[dict] = []
    for e in events:
        ne = dict(e)
        payload = e.get("payload")
        if isinstance(payload, dict) and isinstance(payload.get("order_id"), str):
            np = dict(payload)
            np["order_id"] = remap(payload["order_id"])
            ne["payload"] = np
        if isinstance(e.get("order_id"), str):
            ne["order_id"] = remap(e["order_id"])
        out.append(ne)
    return out


def canonical_event_digest(events: list[dict]) -> str:
    """Cross-process-stable digest of an event list (order IDs canonicalized)."""
    return stable_json_hash(canonicalize_order_ids(events))
