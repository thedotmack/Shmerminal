"""lockfile_stuck runbook — backup (never delete) stale npm/yarn/pnpm/bun lockfiles.

A lockfile is "stale" if mtime > 24h old AND no live process holds it (lsof).
We rename to <path>.shvix-bak-<ts> so the human can restore. Never deletes.
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import time

LOCKFILE_NAMES = ("package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb")
STALE_THRESHOLD_S = 86400  # 24h


def _lsof_holds(path: str) -> tuple[bool, bool]:
    """Returns (lsof_available, path_held). lsof_available=False means no lsof on PATH."""
    try:
        r = subprocess.run(["lsof", path], capture_output=True, timeout=5, check=False)
    except FileNotFoundError:
        return (False, False)
    except subprocess.TimeoutExpired:
        # Treat timeout as "held" — safer than backing up something in use.
        return (True, True)
    held = r.returncode == 0 and bool(r.stdout.strip())
    return (True, held)


def run(context: dict) -> dict:
    raw_cwd = context.get("cwd") or os.getcwd()
    cwd = pathlib.Path(raw_cwd)
    if not cwd.is_dir():
        return {"ok": False, "action_taken": "noop", "details": {"cwd": str(cwd)},
                "requires_human": True, "message": f"cwd {cwd} is not a directory"}

    now = time.time()
    targets_found: list[str] = []
    backed_up: list[dict] = []
    skipped: list[dict] = []
    lsof_missing = False

    for name in LOCKFILE_NAMES:
        p = cwd / name
        if not p.exists():
            continue
        targets_found.append(str(p))
        age = now - os.path.getmtime(p)
        if age < STALE_THRESHOLD_S:
            skipped.append({"path": str(p), "reason": f"fresh (age={int(age)}s)"})
            continue
        available, held = _lsof_holds(str(p))
        if not available:
            lsof_missing = True
            skipped.append({"path": str(p), "reason": "lsof not available"})
            continue
        if held:
            skipped.append({"path": str(p), "reason": "held by live process"})
            continue
        backup = f"{p}.shvix-bak-{int(now)}"
        os.rename(p, backup)
        backed_up.append({"path": str(p), "backup": backup})

    if lsof_missing:
        return {"ok": False, "action_taken": "noop",
                "details": {"targets_found": targets_found, "skipped": skipped},
                "requires_human": True,
                "message": "lsof not on PATH; cannot verify locks aren't held"}

    if backed_up:
        return {"ok": True, "action_taken": "backed_up_lockfiles",
                "details": {"backed_up": backed_up, "skipped": skipped},
                "requires_human": False,
                "message": f"backed up {len(backed_up)} stale lockfile(s); rerun your install"}

    return {"ok": True, "action_taken": "noop",
            "details": {"targets_found": targets_found, "skipped": skipped},
            "requires_human": False, "message": "no stale lockfiles in cwd"}
