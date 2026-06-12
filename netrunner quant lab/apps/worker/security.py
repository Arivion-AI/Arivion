"""Pure worker security helpers (no fastapi import) so they are unit-testable without the stack.

The x-internal-secret boundary is the worker's defense against a spoofed ``x-owner-id`` reaching
it directly (leaked port / SSRF): when ``INTERNAL_SECRET`` is set, every non-public request must
carry the matching header that the API injects. A spoofed owner header alone is rejected.
"""
from __future__ import annotations

PUBLIC_PATHS = ("/health", "/metrics")


class OwnerIdError(ValueError):
    """Raised when a job arrives without a valid integer owner_id (the API must forward it)."""


def parse_owner_id(raw) -> int:
    """§25 A.2 — every owned job must carry a real integer owner_id. There is no 'anon' fallback:
    an unowned/mis-owned session is an isolation hole, so we fail loud instead of writing one."""
    s = str(raw).strip()
    if not s or not s.lstrip("-").isdigit():
        raise OwnerIdError(f"missing or non-numeric owner_id: {raw!r}")
    val = int(s)
    if val <= 0:
        raise OwnerIdError(f"owner_id must be a positive integer: {val}")
    return val


def internal_secret_ok(path: str, provided: str | None, expected: str) -> bool:
    """True iff the request may proceed. If no secret is configured the boundary is off (True).
    Public paths are always allowed. Otherwise the provided header must equal the expected secret."""
    if not expected:
        return True
    if path in PUBLIC_PATHS:
        return True
    return provided == expected
