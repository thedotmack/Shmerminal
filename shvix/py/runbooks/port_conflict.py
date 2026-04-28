"""port_conflict runbook — diagnose port held by a foreign PID.

Read-only with respect to processes: NEVER auto-kills foreign procs. If the
port is held by something other than the session's own host PID, we report
the conflicting PID + command and require human action.
"""
from __future__ import annotations

import subprocess
from typing import Optional

import shmerminal as sm


def _lsof_pids_on_port(port: int) -> tuple[bool, list[int]]:
    """Returns (lsof_available, pids). lsof_available=False -> no lsof on PATH."""
    try:
        r = subprocess.run(["lsof", "-nP", "-i", f":{port}", "-t"],
                           capture_output=True, timeout=5, check=False)
    except FileNotFoundError:
        return (False, [])
    except subprocess.TimeoutExpired:
        return (True, [])
    pids: list[int] = []
    for line in r.stdout.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            pids.append(int(line))
        except ValueError:
            continue
    return (True, pids)


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

    available, pids = _lsof_pids_on_port(port)
    if not available:
        return {"ok": False, "action_taken": "noop", "details": {"port": port},
                "requires_human": True,
                "message": "lsof not on PATH; cannot inspect port holders"}

    foreign = [p for p in pids if p != host_pid]
    if not foreign:
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
