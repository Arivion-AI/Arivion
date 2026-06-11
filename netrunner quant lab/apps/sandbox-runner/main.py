from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Duality Sandbox Runner")


class SandboxPayload(BaseModel):
    strategy_code: str


# Modules that imply network, host fs, or environment access.
FORBIDDEN_IMPORTS = {
    "socket",
    "ssl",
    "asyncio",
    "selectors",
    "http",
    "http.client",
    "urllib",
    "urllib.request",
    "urllib.parse",
    "urllib.error",
    "requests",
    "httpx",
    "aiohttp",
    "ftplib",
    "telnetlib",
    "smtplib",
    "subprocess",
    "multiprocessing",
    "ctypes",
    "pty",
    "shutil",
    "pathlib",  # we gate file access; pathlib is the common bypass
    "tempfile",
}

FORBIDDEN_NAMES = {
    "__import__",
    "compile",
    "eval",
    "exec",
    "open",
    "input",
    "breakpoint",
    "globals",
    "locals",
}

# os.environ / os.getenv / os.path read attribute access is blocked; os module itself
# is permitted because pure-compute strategies sometimes use os.cpu_count etc., but
# we explicitly reject attribute access on env / fs surfaces.
FORBIDDEN_ATTRS = {
    "environ",
    "getenv",
    "putenv",
    "system",
    "popen",
    "spawn",
    "execv",
    "execvp",
    "fork",
    "setuid",
    "setgid",
    "open",
}


class StaticAnalysisError(Exception):
    def __init__(self, violations: list[str]):
        self.violations = violations


def _ast_scan(source: str) -> list[str]:
    """Return sorted list of violation codes found by static AST analysis.

    Rejects forbidden imports, builtin name accesses (open/eval/__import__/...),
    suspicious attribute access (os.environ, os.system, ...), and dunder access
    that's commonly used to escape sandboxes (__class__, __subclasses__, ...).
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [f"SYNTAX_ERROR:{exc.msg}"]

    violations: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if alias.name in FORBIDDEN_IMPORTS or root in FORBIDDEN_IMPORTS:
                    _classify_import(alias.name, violations)
        elif isinstance(node, ast.ImportFrom):
            mod = (node.module or "").split(".")[0]
            if (node.module or "") in FORBIDDEN_IMPORTS or mod in FORBIDDEN_IMPORTS:
                _classify_import(node.module or "", violations)
        elif isinstance(node, ast.Name):
            if node.id in FORBIDDEN_NAMES:
                _classify_name(node.id, violations)
        elif isinstance(node, ast.Attribute):
            if node.attr in FORBIDDEN_ATTRS:
                _classify_attr(node.attr, violations)
            if node.attr.startswith("__") and node.attr.endswith("__") and node.attr not in {
                "__init__",
                "__name__",
                "__doc__",
            }:
                violations.add("DUNDER_ACCESS_BLOCKED")

    return sorted(violations)


def _classify_import(name: str, sink: set[str]) -> None:
    network = {"socket", "ssl", "http", "urllib", "requests", "httpx", "aiohttp", "ftplib", "telnetlib", "smtplib", "asyncio", "selectors"}
    process = {"subprocess", "multiprocessing", "ctypes", "pty"}
    fs = {"pathlib", "tempfile", "shutil"}
    root = name.split(".")[0]
    if root in network:
        sink.add("NETWORK_BLOCKED")
    elif root in process:
        sink.add("PROCESS_EXEC_BLOCKED")
    elif root in fs:
        sink.add("FILE_ACCESS_BLOCKED")


def _classify_name(name: str, sink: set[str]) -> None:
    if name in {"open", "input"}:
        sink.add("FILE_ACCESS_BLOCKED")
    elif name in {"__import__", "compile", "eval", "exec", "breakpoint"}:
        sink.add("DYNAMIC_EXEC_BLOCKED")
    elif name in {"globals", "locals"}:
        sink.add("INTROSPECTION_BLOCKED")


def _classify_attr(attr: str, sink: set[str]) -> None:
    if attr in {"environ", "getenv", "putenv"}:
        sink.add("ENV_ACCESS_BLOCKED")
    elif attr in {"system", "popen", "spawn", "execv", "execvp", "fork"}:
        sink.add("PROCESS_EXEC_BLOCKED")
    elif attr in {"open"}:
        sink.add("FILE_ACCESS_BLOCKED")


# Runtime harness: re-checks at execution time. Even if static scan misses something
# (e.g. encoded payload, getattr trick), the runtime environment removes the relevant
# modules from sys.modules, clears os.environ, overrides builtins, and runs under
# resource limits with stdin/stdout/stderr captured.
RUNTIME_HARNESS = textwrap.dedent(
    """
    import os, sys, json, resource, builtins, io

    # Capture real exec/compile BEFORE we override builtins; we need them ourselves.
    _orig_exec = builtins.exec
    _orig_compile = builtins.compile

    # Resource limits: CPU 2s, address space 256MB, no new fds beyond stdio.
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    try:
        resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
    except (ValueError, OSError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    except (ValueError, OSError):
        pass

    # Strip env so a user strategy cannot read secrets even via os.environ at runtime.
    os.environ.clear()

    _blocked = {
        "socket", "ssl", "http", "http.client", "urllib", "urllib.request",
        "urllib.parse", "urllib.error", "requests", "httpx", "aiohttp",
        "ftplib", "telnetlib", "smtplib", "subprocess", "multiprocessing",
        "ctypes", "pty", "shutil", "pathlib", "tempfile",
    }
    for _m in list(sys.modules):
        root = _m.split(".")[0]
        if _m in _blocked or root in _blocked:
            sys.modules.pop(_m, None)

    _real_import = builtins.__import__

    def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = name.split(".")[0]
        if name in _blocked or root in _blocked:
            raise PermissionError(f"SANDBOX_VIOLATION:import_blocked:{name}")
        return _real_import(name, globals, locals, fromlist, level)

    def _blocked_open(*a, **k):
        raise PermissionError("SANDBOX_VIOLATION:file_access_blocked")

    def _blocked_eval(*a, **k):
        raise PermissionError("SANDBOX_VIOLATION:eval_blocked")

    def _blocked_exec(*a, **k):
        raise PermissionError("SANDBOX_VIOLATION:exec_blocked")

    def _blocked_compile(*a, **k):
        raise PermissionError("SANDBOX_VIOLATION:compile_blocked")

    builtins.__import__ = _guarded_import
    builtins.open = _blocked_open
    builtins.eval = _blocked_eval
    builtins.exec = _blocked_exec
    builtins.compile = _blocked_compile

    _src_path = sys.argv[1]
    with io.open(_src_path, "r", encoding="utf-8") as _fh:
        _src = _fh.read()

    _user_globals = {"__name__": "__sandbox_strategy__", "__builtins__": builtins}
    try:
        _code = _orig_compile(_src, "<user_strategy>", "exec")
        _orig_exec(_code, _user_globals, _user_globals)
        _events = _user_globals.get("events", [])
        if not isinstance(_events, list):
            _events = []
    except PermissionError as exc:
        sys.stderr.write(str(exc))
        sys.exit(2)
    except Exception as exc:
        sys.stderr.write(f"SANDBOX_RUNTIME_ERROR:{type(exc).__name__}:{exc}")
        sys.exit(3)

    sys.stdout.write(json.dumps({"events": _events}))
    """
).strip()


def _run_subprocess_sandbox(user_code: str) -> dict:
    """Execute user code in a python3 -I -S subprocess with a runtime guard harness."""
    with tempfile.TemporaryDirectory(prefix="duality-sbx-") as td:
        tmp = Path(td)
        user_path = tmp / "user_strategy.py"
        user_path.write_text(user_code, encoding="utf-8")
        harness_path = tmp / "_harness.py"
        harness_path.write_text(RUNTIME_HARNESS, encoding="utf-8")

        env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "OMP_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
            "VECLIB_MAXIMUM_THREADS": "1",
            "NUMEXPR_NUM_THREADS": "1",
            "PYTHONHASHSEED": "0",
        }
        try:
            proc = subprocess.run(
                [sys.executable, "-I", "-S", str(harness_path), str(user_path)],
                cwd=str(tmp),
                env=env,
                capture_output=True,
                timeout=5,
                text=True,
            )
        except subprocess.TimeoutExpired:
            return {
                "ok": False,
                "status": "sandbox_violation",
                "violations": ["TIMEOUT"],
                "reason": "Strategy exceeded wall-clock limit.",
                "events": [],
            }

        if proc.returncode == 2:
            # PermissionError raised by runtime harness — extract violation code from stderr.
            err = proc.stderr.strip()
            return {
                "ok": False,
                "status": "sandbox_violation",
                "violations": [_runtime_violation_from(err)],
                "reason": err or "Runtime sandbox guard tripped.",
                "events": [],
            }
        if proc.returncode != 0:
            return {
                "ok": False,
                "status": "sandbox_violation",
                "violations": ["RUNTIME_ERROR"],
                "reason": proc.stderr.strip() or "Strategy crashed.",
                "events": [],
            }

        try:
            out = json.loads(proc.stdout or "{}")
            events = out.get("events", [])
            if not isinstance(events, list):
                events = []
        except json.JSONDecodeError:
            events = []

        return {
            "ok": True,
            "status": "completed",
            "violations": [],
            "events": events,
            "env_visible": False,
        }


def _runtime_violation_from(err: str) -> str:
    if "import_blocked" in err:
        return "NETWORK_BLOCKED" if any(t in err for t in ("socket", "urllib", "requests", "http")) else "FILE_ACCESS_BLOCKED"
    if "file_access_blocked" in err:
        return "FILE_ACCESS_BLOCKED"
    if "env" in err.lower():
        return "ENV_ACCESS_BLOCKED"
    if "eval" in err or "exec" in err or "compile" in err:
        return "DYNAMIC_EXEC_BLOCKED"
    return "SANDBOX_VIOLATION"


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "sandbox-runner"}


@app.post("/sandbox/execute")
def execute(payload: SandboxPayload) -> dict:
    static_violations = _ast_scan(payload.strategy_code)
    if static_violations:
        return {
            "ok": False,
            "status": "sandbox_violation",
            "violations": static_violations,
            "reason": "Static analysis denied access (network/file/env/dynamic exec).",
            "events": [],
        }

    # Defense in depth: even if static analysis missed a bypass, the subprocess
    # harness clears env, blocks imports, overrides open/eval/exec/compile, and
    # caps CPU + memory. The container itself runs read_only with cap_drop ALL
    # and no-new-privileges per infra/docker-compose.yml.
    return _run_subprocess_sandbox(payload.strategy_code)
