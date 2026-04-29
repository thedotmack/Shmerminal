"""port_conflict runbook — diagnose port held by a foreign PID.

Read-only with respect to processes: NEVER auto-kills foreign procs. If the
port is held by something other than the session's own host PID, we report
the conflicting PID + command and require human action.
"""
from __future__ import annotations

import shutil
import subprocess
from typing import Optional

import shmerminal as sm

_LSOF_BIN = shutil.which("lsof")


def _lsof_pids_on_port(port: int) -> tuple[str, list[int]]:
    """Returns (status, pids) where status is "ok" | "missing" | "timeout"."""
    if not _LSOF_BIN:
        return ("missing", [])
    try:
        r = subprocess.run([_LSOF_BIN, "-nP", "-i", f":{port}", "-t"],
                           capture_output=True, timeout=5, check=False)
    except subprocess.TimeoutExpired:
        return ("timeout", [])
    pids: list[int] = []
    for line in r.stdout.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            pids.append(int(line))
        except ValueError:
            continue
    return ("ok", pids)


def _ps_command(pid: int) -> Optional[str]:
    try:
        r = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                           capture_output=True, timeout=5, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    out = r.stdout.decode("utf-8", errors="replace").strip()
    return out or None


def run(context: dict) -> dict:
    sid = context.get("session_id") or sm.find_latest_session()
    if not sid:
        return {"ok": False, "action_taken": "noop", "details": {},
                "requires_human": True, "message": "no session_id provided and no sessions found"}

    meta = sm.read_meta(sid)
    if not meta:
        return {"ok": False, "action_taken": "noop", "details": {"session_id": sid},
                "requires_human": True, "message": f"meta.json unreadable for session {sid}"}

    port = meta.get("port")
    host_pid = meta.get("pid")
    if not isinstance(port, int) or port <= 0:
        return {"ok": True, "action_taken": "noop",
                "details": {"session_id": sid, "port": port},
                "requires_human": False, "message": "no port assigned to session"}

    status, pids = _lsof_pids_on_port(port)
    if status == "missing":
        return {"ok": False, "action_taken": "noop", "details": {"port": port},
                "requires_human": True,
                "message": "lsof not on PATH; cannot inspect port holders"}
    if status == "timeout":
        return {"ok": False, "action_taken": "noop", "details": {"port": port},
                "requires_human": True,
                "message": f"lsof timed out probing port {port}; cannot determine holders"}

    foreign = [p for p in pids if p != host_pid]
    if not foreign:
        if pids and isinstance(host_pid, int) and host_pid in pids:
            return {"ok": True, "action_taken": "noop",
                    "details": {"port": port, "session_id": sid, "host_pid": host_pid},
                    "requires_human": False,
                    "message": f"port {port} is bound by session host (pid {host_pid})"}
        return {"ok": True, "action_taken": "noop",
                "details": {"port": port, "session_id": sid},
                "requires_human": False, "message": f"port {port} is free"}

    other = foreign[0]
    cmd = _ps_command(other) or "<unknown>"
    return {"ok": False, "action_taken": "noop",
            "details": {"port": port, "conflicting_pid": other, "conflicting_cmd": cmd,
                        "session_id": sid},
            "requires_human": True,
            "message": f"port {port} held by PID {other} ({cmd}); kill it manually if intentional"}
