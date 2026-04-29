"""frozen_pty runbook — kill a wedged PTY child while leaving the host alive.

Authorized to send SIGTERM/SIGKILL to meta["child_pid"] only. Never touches
meta["pid"] (the host process). Asymmetric-control rule per claude-mem obs 74654.
"""
from __future__ import annotations

import json
import os
import signal
import socket
import time
from typing import Optional
import shmerminal as sm

WEDGE_THRESHOLD_S = 30.0


def _result(ok, action, details, human, msg):
    return {"ok": ok, "action_taken": action, "details": details,
            "requires_human": human, "message": msg}


def _find_latest_wedged_session() -> Optional[str]:
    if not sm.SESSIONS_DIR.is_dir():
        return None
    now_ms = time.time() * 1000
    best: tuple[float, str] | None = None
    for p in sm.SESSIONS_DIR.iterdir():
        if not p.is_dir():
            continue
        meta = sm.read_meta(p.name)
        if not meta or meta.get("status") != "running":
            continue
        last = meta.get("last_byte_at")
        if not isinstance(last, (int, float)) or (now_ms - last) / 1000.0 <= WEDGE_THRESHOLD_S:
            continue
        mtime = p.stat().st_mtime
        if best is None or mtime > best[0]:
            best = (mtime, p.name)
    return best[1] if best else None


def _send_sock_verb(sock_path: str, verb: dict, timeout: float = 3.0) -> Optional[dict]:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(timeout)
        s.connect(sock_path)
        s.sendall((json.dumps(verb) + "\n").encode("utf-8"))
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
        line = buf.split(b"\n", 1)[0].decode("utf-8", errors="replace")
        return json.loads(line) if line.strip() else None
    except (OSError, json.JSONDecodeError, socket.timeout):
        return None
    finally:
        try:
            s.close()
        except OSError:
            pass


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0); return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def run(context: dict) -> dict:
    sid = context.get("session_id") or _find_latest_wedged_session()
    if not sid:
        return _result(False, "noop", {}, True, "no wedged session found")
    meta = sm.read_meta(sid)
    if not meta:
        return _result(False, "noop", {"session_id": sid}, True,
                       f"meta.json unreadable for session {sid}")
    child_pid = meta.get("child_pid")
    host_pid = meta.get("pid")
    sock_path = str(sm.host_sock_path(sid))
    resp = _send_sock_verb(sock_path, {"op": "wait_idle", "quiet_ms": 2000, "timeout_ms": 2000}, 3.0)
    if resp is None:
        return _result(False, "noop", {"session_id": sid}, True,
                       "host.sock unreachable — host may have crashed; try shvix runbook session-corrupted")
    if not resp.get("timeout"):
        return _result(True, "noop", {"session_id": sid, "idle_ms": resp.get("idle_ms")}, True,
                       f"session is responsive (idle_ms={resp.get('idle_ms')}); not freezing")
    # Asymmetric-control rule: only ever signal child_pid, and never let a
    # corrupt meta.json route us at the host PID or a non-positive value.
    if (
        not isinstance(child_pid, int)
        or child_pid <= 0
        or (isinstance(host_pid, int) and child_pid == host_pid)
        or not _pid_alive(child_pid)
    ):
        return _result(False, "noop", {"session_id": sid, "child_pid": child_pid}, True,
                       "wait_idle timed out but child PID is gone; session may be exiting")
    try:
        os.kill(child_pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return _result(False, "noop", {"session_id": sid, "child_pid": child_pid}, True,
                       "child PID no longer signalable; session state changed")
    sig_used = "SIGTERM"
    deadline = time.time() + 3.0
    while time.time() < deadline:
        if not _pid_alive(child_pid):
            break
        time.sleep(0.25)
    if _pid_alive(child_pid):
        try:
            os.kill(child_pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            return _result(False, "noop",
                           {"session_id": sid, "child_pid": child_pid, "signal": sig_used},
                           True, "child PID became unsignalable before SIGKILL")
        sig_used = "SIGKILL"
        # SIGKILL is async from the caller's view; wait briefly so a back-to-back
        # /fix call doesn't see the same wedged child still alive.
        kill_deadline = time.time() + 1.0
        while time.time() < kill_deadline:
            if not _pid_alive(child_pid):
                break
            time.sleep(0.05)
    return _result(True, "killed_child_pty",
                   {"child_pid": child_pid, "signal": sig_used, "session_id": sid},
                   False, f"killed wedged PTY child {child_pid}")
