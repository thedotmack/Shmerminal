"""session_corrupted runbook — repair a shmerminal session dir in place.

Idempotent. Backs up corrupt meta.json / inbox.json before replacing them
with minimal valid stand-ins. Unlinks a stale host.sock when the host PID
is dead. Never restarts the host — that's the human's call.
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import time
from typing import Optional

import shmerminal as sm


def _read_text(path: pathlib.Path) -> Optional[str]:
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return None


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def run(context: dict) -> dict:
    sid = context.get("session_id") or sm.find_latest_session()
    if not sid:
        return {"ok": False, "action_taken": "noop", "details": {},
                "requires_human": True, "message": "no session_id provided and no sessions found"}
    sdir = sm.session_dir(sid)
    if not sdir.is_dir():
        return {"ok": False, "action_taken": "noop", "details": {"session_id": sid},
                "requires_human": True, "message": f"session dir {sdir} does not exist"}

    ts = int(time.time())
    backups: list[str] = []
    meta_restored = inbox_restored = sock_unlinked = False

    # 1) meta.json — backup + minimal replacement if missing/invalid.
    meta_path = sdir / "meta.json"
    parsed_meta: Optional[dict] = None
    meta_text = _read_text(meta_path)
    if meta_text is not None:
        try:
            cand = json.loads(meta_text)
            if isinstance(cand, dict) and isinstance(cand.get("id"), str):
                parsed_meta = cand
        except json.JSONDecodeError:
            pass
        if parsed_meta is None:
            backup = meta_path.with_name(f"meta.json.shvix-bak-{ts}")
            shutil.copy2(meta_path, backup)
            backups.append(str(backup))
            parsed_meta = {"id": sid, "status": "exited", "exit_code": -1}
            meta_path.write_text(json.dumps(parsed_meta, indent=2), encoding="utf-8")
            meta_restored = True

    # 2) inbox.json — backup + replace with [] if corrupt.
    inbox_path = sdir / "inbox.json"
    if inbox_path.exists():
        text = _read_text(inbox_path)
        valid = False
        if text is not None:
            try:
                valid = isinstance(json.loads(text), list)
            except json.JSONDecodeError:
                valid = False
        if not valid:
            backup = inbox_path.with_name(f"inbox.json.shvix-bak-{ts}")
            shutil.copy2(inbox_path, backup)
            backups.append(str(backup))
            inbox_path.write_text("[]", encoding="utf-8")
            inbox_restored = True

    # 3) Stale host.sock when host PID is dead.
    sock_path = sdir / "host.sock"
    host_pid = parsed_meta.get("pid") if isinstance(parsed_meta, dict) else None
    if isinstance(host_pid, int) and not _pid_alive(host_pid) and sock_path.exists():
        os.unlink(sock_path)
        sock_unlinked = True

    if meta_restored or inbox_restored or sock_unlinked:
        return {"ok": True, "action_taken": "repaired_session_state",
                "details": {"meta_restored": meta_restored, "inbox_restored": inbox_restored,
                            "sock_unlinked": sock_unlinked, "backups": backups, "session_id": sid},
                "requires_human": False,
                "message": f"repaired session {sid} (meta={meta_restored} inbox={inbox_restored} sock={sock_unlinked})"}
    return {"ok": True, "action_taken": "noop", "details": {"session_id": sid},
            "requires_human": False, "message": f"session {sid} state looks clean"}
