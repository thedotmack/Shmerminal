"""Read-only helpers for shmerminal session state.

Becomes shvix/py/shmerminal.py in Phase 8 — kept underscore-prefixed inside
runbooks/ so we don't promise public API yet. Only what frozen_pty,
session_corrupted, and port_conflict need today.
"""
from __future__ import annotations

import json
import os
import pathlib
from typing import Optional

SESSIONS_DIR = pathlib.Path(os.path.expanduser("~/.shmerminal/sessions"))


def session_dir(session_id: str) -> pathlib.Path:
    return SESSIONS_DIR / session_id


def host_sock_path(session_id: str) -> pathlib.Path:
    return session_dir(session_id) / "host.sock"


def find_latest_session() -> Optional[str]:
    """Newest session dir by mtime, or None if SESSIONS_DIR missing/empty."""
    if not SESSIONS_DIR.is_dir():
        return None
    candidates = [p for p in SESSIONS_DIR.iterdir() if p.is_dir()]
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0].name


def read_meta(session_id: str) -> Optional[dict]:
    """Parsed meta.json or None if missing/invalid."""
    meta_path = session_dir(session_id) / "meta.json"
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
