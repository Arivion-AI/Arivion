"""Shared event-digest helper (quant_core.event_digest) — single source of truth used by both
the worker (to persist canonical_event_digest) and the verifier (to reproduce it). P0.2."""
from __future__ import annotations

import unittest

from quant_core.event_digest import (
    canonical_event_digest,
    canonicalize_order_ids,
    stable_json_hash,
)


class EventDigestTests(unittest.TestCase):
    def test_stable_json_hash_matches_worker_recipe(self) -> None:
        # Must equal sha256 of json.dumps(payload, sort_keys=True, separators=(",", ":")).
        import hashlib, json
        payload = [{"type": "FILL", "payload": {"qty": "1", "order_id": "ord-9"}}]
        expected = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(stable_json_hash(payload), expected)

    def test_canonicalize_remaps_first_appearance(self) -> None:
        events = [
            {"type": "ORDER_CREATED", "order_id": "ord-7", "payload": {"order_id": "ord-7"}},
            {"type": "ORDER_CREATED", "payload": {"order_id": "ord-12"}},
            {"type": "FILL", "payload": {"order_id": "ord-7", "qty": "1"}},
        ]
        canon = canonicalize_order_ids(events)
        self.assertEqual(canon[0]["payload"]["order_id"], "o0")
        self.assertEqual(canon[0]["order_id"], "o0")
        self.assertEqual(canon[1]["payload"]["order_id"], "o1")
        self.assertEqual(canon[2]["payload"]["order_id"], "o0")  # same original -> same token
        # non-id fields preserved
        self.assertEqual(canon[2]["payload"]["qty"], "1")

    def test_canonical_digest_invariant_to_id_offset(self) -> None:
        """Two event streams identical except for the global order-ID offset hash the same
        canonically — the property the verifier relies on."""
        a = [{"type": "FILL", "payload": {"order_id": "ord-3", "p": "1"}},
             {"type": "FILL", "payload": {"order_id": "ord-4", "p": "2"}}]
        b = [{"type": "FILL", "payload": {"order_id": "ord-103", "p": "1"}},
             {"type": "FILL", "payload": {"order_id": "ord-104", "p": "2"}}]
        self.assertNotEqual(stable_json_hash(a), stable_json_hash(b))         # raw differs
        self.assertEqual(canonical_event_digest(a), canonical_event_digest(b))  # canonical agrees

    def test_canonical_digest_detects_real_difference(self) -> None:
        a = [{"type": "FILL", "payload": {"order_id": "ord-3", "p": "1"}}]
        c = [{"type": "FILL", "payload": {"order_id": "ord-3", "p": "2"}}]  # different price
        self.assertNotEqual(canonical_event_digest(a), canonical_event_digest(c))


if __name__ == "__main__":
    unittest.main()
