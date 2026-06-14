"""A.12 sandbox tests + bypass attempts the old regex scanner would miss."""
from __future__ import annotations

import json
import unittest
from urllib import request


SANDBOX_BASE = "http://localhost:7300"


def sandbox_exec(code: str) -> dict:
    req = request.Request(
        url=f"{SANDBOX_BASE}/sandbox/execute",
        data=json.dumps({"strategy_code": code}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


class A12SandboxRCETests(unittest.TestCase):
    def test_obvious_network_file_env_are_blocked(self) -> None:
        code = """
import socket
import os
from pathlib import Path
s = socket.socket()
s.connect(("example.com", 80))
Path("/etc/passwd").read_text()
secret = os.environ.get("VERIFIER_SIGNING_KEY")
"""
        out = sandbox_exec(code)
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], "sandbox_violation")
        self.assertIn("NETWORK_BLOCKED", out["violations"])
        self.assertIn("FILE_ACCESS_BLOCKED", out["violations"])
        self.assertIn("ENV_ACCESS_BLOCKED", out["violations"])

    def test_dynamic_import_bypass_blocked(self) -> None:
        # The old regex scanner only matched literal `socket` token usage.
        # This attempts to bypass via __import__ at runtime.
        code = """
mod = __import__('socket')
s = mod.socket()
"""
        out = sandbox_exec(code)
        self.assertFalse(out["ok"])
        self.assertIn("DYNAMIC_EXEC_BLOCKED", out["violations"])

    def test_urllib_bypass_blocked(self) -> None:
        # urllib was not in the old regex list.
        code = """
import urllib.request
urllib.request.urlopen("http://example.com")
"""
        out = sandbox_exec(code)
        self.assertFalse(out["ok"])
        self.assertIn("NETWORK_BLOCKED", out["violations"])

    def test_subprocess_blocked(self) -> None:
        code = """
import subprocess
subprocess.run(["whoami"])
"""
        out = sandbox_exec(code)
        self.assertFalse(out["ok"])
        self.assertIn("PROCESS_EXEC_BLOCKED", out["violations"])

    def test_os_system_attribute_blocked(self) -> None:
        # `os` is not banned but os.system / os.environ are.
        code = """
import os
os.system("ls /")
"""
        out = sandbox_exec(code)
        self.assertFalse(out["ok"])
        self.assertIn("PROCESS_EXEC_BLOCKED", out["violations"])

    def test_dunder_subclasses_escape_blocked(self) -> None:
        # Classic escape: ().__class__.__bases__[0].__subclasses__() to walk to subprocess.
        code = """
escape = ().__class__.__bases__[0].__subclasses__()
"""
        out = sandbox_exec(code)
        self.assertFalse(out["ok"])
        self.assertIn("DUNDER_ACCESS_BLOCKED", out["violations"])

    def test_clean_strategy_runs(self) -> None:
        # A perfectly clean strategy completes and returns its events.
        code = "events = [{'type': 'SIGNAL', 'side': 'long'}]\n"
        out = sandbox_exec(code)
        self.assertTrue(out["ok"], msg=str(out))
        self.assertEqual(out["status"], "completed")
        self.assertEqual(out["events"], [{"type": "SIGNAL", "side": "long"}])
        self.assertFalse(out["env_visible"])


if __name__ == "__main__":
    unittest.main()
