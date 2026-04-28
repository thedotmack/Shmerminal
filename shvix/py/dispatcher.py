"""Tiny runbook registry. Maps classification ids → callable runbooks.

The model picks WHICH runbook (an id from `candidates()`); the dispatcher
controls HOW it runs (just calls .run on the registered module). Phase 4
anti-pattern: clients must not pass runbook_id directly — always classify.
"""
from __future__ import annotations

from typing import Callable

from runbooks import frozen_pty, lockfile_stuck, port_conflict, session_corrupted

# Stable insertion order — feeds the classifier prompt deterministically.
RUNBOOKS: dict[str, Callable[[dict], dict]] = {
    "frozen-pty": frozen_pty.run,
    "lockfile-stuck": lockfile_stuck.run,
    "session-corrupted": session_corrupted.run,
    "port-conflict": port_conflict.run,
}


def candidates() -> list[str]:
    """Stable ordering for the classifier prompt."""
    return list(RUNBOOKS.keys())


def dispatch(runbook_id: str, context: dict) -> dict:
    """Look up and call. Raises KeyError if id not in RUNBOOKS — caller decides handling."""
    return RUNBOOKS[runbook_id](context)
