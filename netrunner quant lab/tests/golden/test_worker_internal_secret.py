"""§25 P1.5 — the worker's x-internal-secret boundary (concurrency.py:internal_secret_middleware)
had no test. This codifies it via the pure helper: a spoofed x-owner-id reaching the worker
directly, without the API-injected secret, must be rejected."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_WORKER = str(Path(__file__).resolve().parents[2] / "apps" / "worker")
if _WORKER not in sys.path:
    sys.path.insert(0, _WORKER)

from security import internal_secret_ok, parse_owner_id, OwnerIdError  # noqa: E402


class InternalSecretBoundaryTests(unittest.TestCase):
    SECRET = "s3cr3t"

    def test_spoofed_owner_without_secret_is_rejected(self) -> None:
        # An attacker hits the worker directly with a forged x-owner-id but no/the-wrong secret.
        self.assertFalse(internal_secret_ok("/bots/runs", provided=None, expected=self.SECRET))
        self.assertFalse(internal_secret_ok("/bots/runs", provided="wrong", expected=self.SECRET))

    def test_api_injected_secret_passes(self) -> None:
        self.assertTrue(internal_secret_ok("/bots/runs", provided=self.SECRET, expected=self.SECRET))

    def test_public_paths_exempt(self) -> None:
        self.assertTrue(internal_secret_ok("/health", provided=None, expected=self.SECRET))
        self.assertTrue(internal_secret_ok("/metrics", provided=None, expected=self.SECRET))

    def test_boundary_off_when_unset(self) -> None:
        # No secret configured -> boundary disabled (dev/local), any request proceeds.
        self.assertTrue(internal_secret_ok("/bots/runs", provided=None, expected=""))


class OwnerIdValidationTests(unittest.TestCase):
    def test_valid_numeric_owner(self) -> None:
        self.assertEqual(parse_owner_id("42"), 42)
        self.assertEqual(parse_owner_id(7), 7)

    def test_anon_is_rejected(self) -> None:
        # §25 A.2 — the old 'anon' default must now fail loud, not persist an unowned row.
        with self.assertRaises(OwnerIdError):
            parse_owner_id("anon")

    def test_missing_or_nonpositive_rejected(self) -> None:
        for bad in ("", None, "0", "-3", "abc", "1.5"):
            with self.assertRaises(OwnerIdError):
                parse_owner_id(bad)


if __name__ == "__main__":
    unittest.main()
