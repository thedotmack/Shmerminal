"""Read-only helpers for shmerminal session state.

Public module — runbooks and the daemon may import this. Never writes to
`~/.shmerminal/`; callers that need to mutate (only session_corrupted.py) do
their own backup-then-write dance. Stdlib only.
"""
from __future__ import annotations

import json
import os
import pathlib
import socket
from typing import Optional

SESSIONS_DIR = pathlib.Path(os.path.expanduser("~/.shmerminal/sessions"))


def _validate_session_id(session_id: str) -> str:
    # Reject anything that could escape SESSIONS_DIR via separators or "..".
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("invalid session_id")
    parts = pathlib.PurePath(session_id).parts
    if len(parts) != 1 or parts[0] in {".", ".."} or parts[0] != session_id:
        raise ValueError("invalid session_id")
    return session_id


def session_dir(session_id: str) -> pathlib.Path:
    return SESSIONS_DIR / _validate_session_id(session_id)


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


def read_scrollback_tail(session_id: str, n: int = 200) -> Optional[str]:
    """Last N lines of scrollback.log, decoded utf-8 with replace, or None."""
    path = session_dir(session_id) / "scrollback.log"
    try:
        with open(path, "rb") as f:
            data = f.read()
    except (FileNotFoundError, OSError):
        return None
    text = data.decode("utf-8", errors="replace")
    lines = text.split("\n")
    return "\n".join(lines[-n:])


def connect_host_sock(session_id: str) -> Optional[socket.socket]:
    """Open AF_UNIX stream socket to host.sock with 3s connect timeout.

    Returns the connected socket on success; None if the socket is missing,
    refused, or times out. Caller owns the socket and must close it.
    """
    path = str(host_sock_path(session_id))
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(3.0)
        s.connect(path)
        return s
    except (FileNotFoundError, ConnectionRefusedError, socket.timeout, OSError):
        try:
            s.close()
        except OSError:
            pass
        return None
