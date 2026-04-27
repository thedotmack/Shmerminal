"""
shmerm_agent.py — agent-side adapter for shmerm Durable Tool Execution.

Gives a Claude / GPT / Aider / whatever-agent these primitives:

    Session.resume_or_create(state_path, cmd)
        → either picks up an existing session or starts a new one,
          saving the id to state_path so future agent restarts
          land in the same shmerm session.

    sess.send(text)
    sess.tail(lines)
    sess.wait_idle(quiet_seconds, timeout_seconds)
    sess.kill()
    sess.reply(msg_id, text)

    sess.poll_inbox()              — Pattern 1: synchronous drain
    sess.drain()                   — Pattern 2: non-blocking, reads from the
                                     background watcher queue
    sess.inbox()                   — Pattern 2: blocking generator over the
                                     watcher queue

The watcher thread starts automatically when used as a context manager.

Example
-------
    from shmerm_agent import Session

    with Session.resume_or_create("./.agent_state.json",
                                  cmd=["claude", "code"],
                                  tunnel=True) as sess:
        print(f"session: {sess.id}")

        # if we just resumed, this is a no-op; if fresh, kick things off
        if sess.fresh:
            sess.send("refactor src/auth.ts to use sessions module\\r")

        while sess.is_running():
            sess.wait_idle(quiet_seconds=5, timeout_seconds=300)

            # check for human interjections from the phone
            for msg in sess.drain():
                print(f"[human via UI]: {msg.text}")
                # in a real agent: prepend to LLM context as a system message
                #   context.append({"role": "system",
                #                   "content": f"<human_interjection>{msg.text}</human_interjection>"})
                # then optionally acknowledge it on the UI:
                sess.reply(msg.id, "noted, incorporating now")

            # ... real agent: call LLM, decide next action, sess.send(...) ...
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Generator, Optional


@dataclass
class InboxMsg:
    id: str
    ts: int
    text: str
    source: str = "web"
    delivered_at: Optional[int] = None
    reply: Optional[str] = None
    reply_ts: Optional[int] = None


class Session:
    def __init__(self, session_id: str, *, fresh: bool = False) -> None:
        self.id = session_id
        self.fresh = fresh                       # True if just created (vs resumed)
        self._q: "queue.Queue[InboxMsg]" = queue.Queue()
        self._stop = threading.Event()
        self._watcher: Optional[threading.Thread] = None
        self._proc: Optional[subprocess.Popen] = None

    # ── construction / lifecycle ────────────────────────────────────────
    @classmethod
    def resume_or_create(
        cls,
        state_path: str | Path,
        cmd: list[str],
        *,
        tunnel: bool = False,
    ) -> "Session":
        state_path = Path(state_path)

        # try resume
        if state_path.exists():
            try:
                state = json.loads(state_path.read_text())
                sid = state.get("session_id")
                if sid and cls._is_running(sid):
                    return cls(sid, fresh=False)
            except (json.JSONDecodeError, OSError):
                pass  # fall through to create

        # create new
        args = ["shmerm", "run", "--json"]
        if tunnel:
            args.append("--tunnel")
        args.append("--")
        args.extend(cmd)
        out = subprocess.run(args, capture_output=True, text=True, check=True)
        meta = json.loads(out.stdout)
        sid = meta["id"]

        # persist
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps({"session_id": sid, "started_at": time.time()}))
        return cls(sid, fresh=True)

    # ── status / control ────────────────────────────────────────────────
    @staticmethod
    def _is_running(sid: str) -> bool:
        try:
            r = subprocess.run(
                ["shmerm", "status", sid, "--json"],
                capture_output=True, text=True, timeout=5,
            )
            return r.returncode == 0 and json.loads(r.stdout).get("status") == "running"
        except Exception:
            return False

    def is_running(self) -> bool:
        return self._is_running(self.id)

    def send(self, text: str) -> None:
        subprocess.run(["shmerm", "send", self.id, text], check=True)

    def tail(self, lines: int = 100) -> str:
        r = subprocess.run(
            ["shmerm", "tail", self.id, "--lines", str(lines)],
            capture_output=True, text=True, check=True,
        )
        return r.stdout

    def wait_idle(self, quiet_seconds: int = 5, timeout_seconds: int = 600) -> dict:
        r = subprocess.run(
            ["shmerm", "wait-idle", self.id,
             "--quiet", str(quiet_seconds),
             "--timeout", str(timeout_seconds),
             "--json"],
            capture_output=True, text=True, check=True,
        )
        return json.loads(r.stdout)

    def kill(self) -> None:
        subprocess.run(["shmerm", "kill", self.id], check=False)

    def reply(self, msg_id: str, text: str) -> None:
        subprocess.run(["shmerm", "reply", self.id, msg_id, text], check=True)

    # ── Pattern 1: synchronous drain ────────────────────────────────────
    def poll_inbox(self) -> list[InboxMsg]:
        """One-shot: read pending messages, mark delivered, return them.
        Cheap. Call before each LLM turn."""
        r = subprocess.run(
            ["shmerm", "inbox", self.id, "--json"],
            capture_output=True, text=True, check=True,
        )
        raw = json.loads(r.stdout) if r.stdout.strip() else []
        return [InboxMsg(**m) for m in raw]

    # ── Pattern 2: background watcher ──────────────────────────────────
    def start_watcher(self) -> None:
        """Hold `shmerm inbox --watch` open in a thread.
        Messages flow into a queue you read via drain() or inbox()."""
        if self._watcher is not None:
            return
        self._watcher = threading.Thread(target=self._watch_loop, daemon=True)
        self._watcher.start()

    def _watch_loop(self) -> None:
        self._proc = subprocess.Popen(
            ["shmerm", "inbox", self.id, "--watch", "--json"],
            stdout=subprocess.PIPE, text=True, bufsize=1,
        )
        try:
            for line in self._proc.stdout:               # type: ignore[union-attr]
                if self._stop.is_set():
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msgs = payload if isinstance(payload, list) else [payload]
                for m in msgs:
                    self._q.put(InboxMsg(**m))
        finally:
            try:
                self._proc.terminate()
            except Exception:
                pass

    def drain(self) -> list[InboxMsg]:
        """Pull all queued messages without blocking.
        Call at safe checkpoints in your agent loop (e.g., before next LLM call)."""
        out: list[InboxMsg] = []
        while True:
            try:
                out.append(self._q.get_nowait())
            except queue.Empty:
                break
        return out

    def inbox(self) -> Generator[InboxMsg, None, None]:
        """Blocking generator. Yields each message as it arrives.
        Useful for an agent loop that's waiting for human input."""
        while not self._stop.is_set():
            try:
                yield self._q.get(timeout=1.0)
            except queue.Empty:
                continue

    # ── context manager ────────────────────────────────────────────────
    def __enter__(self) -> "Session":
        self.start_watcher()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        try:
            if self._proc:
                self._proc.terminate()
        except Exception:
            pass
