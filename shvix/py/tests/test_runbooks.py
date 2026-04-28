"""Phase 3 runbook tests — stdlib unittest only."""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

# Make `runbooks` importable when run from repo root or shvix/py.
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import shmerminal as sm  # noqa: E402
from runbooks import frozen_pty, lockfile_stuck, port_conflict, session_corrupted  # noqa: E402


DEAD_PID = 99999999  # almost certainly free


def _ensure_dead(pid: int) -> int:
    """Bump until we find a definitely-dead pid (handles the rare collision)."""
    for candidate in (pid, pid - 1, pid - 2):
        try:
            os.kill(candidate, 0)
        except ProcessLookupError:
            return candidate
    return pid  # give up, test may flake; extremely unlikely


class LockfileStuckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="shvix-lock-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_empty_cwd_is_noop(self):
        result = lockfile_stuck.run({"cwd": self.tmp})
        self.assertTrue(result["ok"])
        self.assertEqual(result["action_taken"], "noop")
        self.assertFalse(result["requires_human"])

    def test_fresh_lockfile_untouched(self):
        p = pathlib.Path(self.tmp) / "package-lock.json"
        p.write_text("{}")
        # mtime defaults to now.
        result = lockfile_stuck.run({"cwd": self.tmp})
        self.assertEqual(result["action_taken"], "noop")
        self.assertTrue(p.exists(), "fresh lockfile must not be backed up")

    def test_stale_lockfile_backed_up(self):
        p = pathlib.Path(self.tmp) / "yarn.lock"
        p.write_text("# stale")
        old = time.time() - (86400 * 3)
        os.utime(p, (old, old))

        # Fake lsof: returncode=1, empty stdout (== nothing holds the file).
        fake = subprocess.CompletedProcess(args=[], returncode=1, stdout=b"", stderr=b"")
        with patch("runbooks.lockfile_stuck.subprocess.run", return_value=fake):
            result = lockfile_stuck.run({"cwd": self.tmp})

        self.assertTrue(result["ok"])
        self.assertEqual(result["action_taken"], "backed_up_lockfiles")
        self.assertFalse(p.exists(), "stale lockfile should have been renamed")
        backups = list(pathlib.Path(self.tmp).glob("yarn.lock.shvix-bak-*"))
        self.assertEqual(len(backups), 1)


class SessionCorruptedTests(unittest.TestCase):
    def setUp(self):
        self.tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="shvix-sess-"))
        self._orig_sessions_dir = sm.SESSIONS_DIR
        sm.SESSIONS_DIR = self.tmp_root  # type: ignore[assignment]

    def tearDown(self):
        sm.SESSIONS_DIR = self._orig_sessions_dir  # type: ignore[assignment]
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    def _make_session(self, sid: str) -> pathlib.Path:
        d = self.tmp_root / sid
        d.mkdir(parents=True)
        return d

    def test_valid_state_is_noop(self):
        sid = "amber-otter-aaaa"
        d = self._make_session(sid)
        (d / "meta.json").write_text(json.dumps({"id": sid, "status": "running",
                                                 "pid": os.getpid(), "child_pid": os.getpid()}))
        (d / "inbox.json").write_text("[]")

        result = session_corrupted.run({"session_id": sid})
        self.assertEqual(result["action_taken"], "noop")
        self.assertTrue(result["ok"])

    def test_corrupt_meta_backed_up_and_replaced(self):
        sid = "crimson-falcon-bbbb"
        d = self._make_session(sid)
        (d / "meta.json").write_text("{not json")

        result = session_corrupted.run({"session_id": sid})
        self.assertTrue(result["ok"])
        self.assertEqual(result["action_taken"], "repaired_session_state")
        self.assertTrue(result["details"]["meta_restored"])
        replacement = json.loads((d / "meta.json").read_text())
        self.assertEqual(replacement["id"], sid)
        self.assertEqual(replacement["status"], "exited")
        backups = list(d.glob("meta.json.shvix-bak-*"))
        self.assertEqual(len(backups), 1)

    def test_dead_host_unlinks_sock(self):
        sid = "jade-pine-cccc"
        d = self._make_session(sid)
        dead = _ensure_dead(DEAD_PID)
        (d / "meta.json").write_text(json.dumps({"id": sid, "status": "running",
                                                 "pid": dead, "child_pid": dead}))
        (d / "inbox.json").write_text("[]")
        sock = d / "host.sock"
        sock.write_text("")  # plain file is fine for unlink test

        result = session_corrupted.run({"session_id": sid})
        self.assertTrue(result["ok"])
        self.assertTrue(result["details"]["sock_unlinked"])
        self.assertFalse(sock.exists())


class FrozenPtyTests(unittest.TestCase):
    def setUp(self):
        self.tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="shvix-frozen-"))
        self._orig_sessions_dir = sm.SESSIONS_DIR
        # Point at a nonexistent path for the "no sessions" case.
        sm.SESSIONS_DIR = self.tmp_root / "nope"  # type: ignore[assignment]

    def tearDown(self):
        sm.SESSIONS_DIR = self._orig_sessions_dir  # type: ignore[assignment]
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    def test_no_sessions_dir_requests_human(self):
        result = frozen_pty.run({})
        self.assertFalse(result["ok"])
        self.assertEqual(result["action_taken"], "noop")
        self.assertTrue(result["requires_human"])
        self.assertIn("no wedged session", result["message"])


class PortConflictTests(unittest.TestCase):
    def setUp(self):
        self.tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="shvix-port-"))
        self._orig_sessions_dir = sm.SESSIONS_DIR
        sm.SESSIONS_DIR = self.tmp_root  # type: ignore[assignment]
        self.sid = "lunar-ember-dddd"
        d = self.tmp_root / self.sid
        d.mkdir(parents=True)
        self.host_pid = os.getpid()
        (d / "meta.json").write_text(json.dumps({
            "id": self.sid, "status": "running", "port": 54321,
            "pid": self.host_pid, "child_pid": self.host_pid,
        }))

    def tearDown(self):
        sm.SESSIONS_DIR = self._orig_sessions_dir  # type: ignore[assignment]
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    def _fake_lsof(self, stdout: bytes):
        return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr=b"")

    def test_port_free_is_noop(self):
        with patch("runbooks.port_conflict.subprocess.run", return_value=self._fake_lsof(b"")):
            result = port_conflict.run({"session_id": self.sid})
        self.assertTrue(result["ok"])
        self.assertEqual(result["action_taken"], "noop")
        self.assertIn("free", result["message"])

    def test_port_held_by_self_is_noop(self):
        out = f"{self.host_pid}\n".encode()
        with patch("runbooks.port_conflict.subprocess.run", return_value=self._fake_lsof(out)):
            result = port_conflict.run({"session_id": self.sid})
        self.assertTrue(result["ok"])
        self.assertEqual(result["action_taken"], "noop")

    def test_port_held_by_foreign_pid_requires_human(self):
        foreign = self.host_pid + 12345
        # First call is lsof, second is ps.
        responses = [
            self._fake_lsof(f"{foreign}\n".encode()),
            subprocess.CompletedProcess(args=[], returncode=0,
                                        stdout=b"some-other-server --port 54321\n", stderr=b""),
        ]
        with patch("runbooks.port_conflict.subprocess.run", side_effect=responses):
            result = port_conflict.run({"session_id": self.sid})
        self.assertFalse(result["ok"])
        self.assertTrue(result["requires_human"])
        self.assertEqual(result["details"]["conflicting_pid"], foreign)


if __name__ == "__main__":
    unittest.main()
