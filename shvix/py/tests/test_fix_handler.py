"""Phase 4 /fix handler tests — stdlib unittest, no live HTTP server.

We test `_handle_fix` directly (extracted as a pure function) and patch
`ollama_client.generate` + `dispatcher.RUNBOOKS` so no Ollama or real
runbook is touched.
"""
from __future__ import annotations

import pathlib
import sys
import unittest
from unittest.mock import patch

# Make `daemon` and `dispatcher` importable from shvix/py/.
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import daemon  # noqa: E402
import dispatcher  # noqa: E402
import ollama_client  # noqa: E402


def _ok_runbook(context: dict) -> dict:
    return {
        "ok": True,
        "action_taken": "killed_child_pty",
        "details": {"child_pid": 1234, "signal": "SIGTERM",
                    "session_id": context.get("session_id")},
        "requires_human": False,
        "message": "killed wedged PTY child 1234",
    }


def _crashing_runbook(context: dict) -> dict:
    raise RuntimeError("boom")


# A registry that's deterministic for tests — same id ordering as production.
FAKE_RUNBOOKS = {
    "frozen-pty": _ok_runbook,
    "lockfile-stuck": _ok_runbook,
    "session-corrupted": _ok_runbook,
    "port-conflict": _ok_runbook,
}


class HappyPathTests(unittest.TestCase):
    def test_valid_symptom_dispatches_runbook(self):
        with patch.object(dispatcher, "RUNBOOKS", FAKE_RUNBOOKS), \
             patch("ollama_client.generate", return_value="frozen-pty"):
            status, resp, log = daemon._handle_fix({
                "symptom": "the terminal is wedged",
                "context": {"session_id": "amber-otter-aaaa"},
            })
        self.assertEqual(status, 200)
        self.assertEqual(resp["classification"], "frozen-pty")
        self.assertEqual(resp["action_taken"], "killed_child_pty")
        self.assertTrue(resp["ok"])
        self.assertFalse(resp["requires_human"])
        self.assertIn("latency_ms", resp)
        self.assertEqual(resp["details"]["session_id"], "amber-otter-aaaa")
        # log line shape
        self.assertTrue(log["ok"])
        self.assertEqual(log["classification"], "frozen-pty")
        self.assertEqual(log["action_taken"], "killed_child_pty")

    def test_missing_context_is_optional(self):
        with patch.object(dispatcher, "RUNBOOKS", FAKE_RUNBOOKS), \
             patch("ollama_client.generate", return_value="lockfile-stuck"):
            status, resp, _ = daemon._handle_fix({"symptom": "weird lockfile"})
        self.assertEqual(status, 200)
        self.assertEqual(resp["classification"], "lockfile-stuck")
        self.assertTrue(resp["ok"])


class UnknownClassificationTests(unittest.TestCase):
    def test_unknown_returns_200_requires_human(self):
        with patch.object(dispatcher, "RUNBOOKS", FAKE_RUNBOOKS), \
             patch("ollama_client.generate", return_value="the moon is blue"):
            status, resp, log = daemon._handle_fix({"symptom": "things are weird"})
        self.assertEqual(status, 200)  # NOT 4xx — clean "model said no"
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["classification"], "unknown")
        self.assertEqual(resp["action_taken"], "noop")
        self.assertTrue(resp["requires_human"])
        self.assertEqual(resp["message"], "human intervention requested")
        self.assertIn("latency_ms", resp)
        self.assertFalse(log["ok"])
        self.assertTrue(log["requires_human"])


class RunbookCrashTests(unittest.TestCase):
    def test_runbook_exception_returns_200_with_runbook_error(self):
        crashing = {**FAKE_RUNBOOKS, "frozen-pty": _crashing_runbook}
        with patch.object(dispatcher, "RUNBOOKS", crashing), \
             patch("ollama_client.generate", return_value="frozen-pty"):
            status, resp, log = daemon._handle_fix({"symptom": "frozen"})
        self.assertEqual(status, 200)
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["classification"], "frozen-pty")
        self.assertEqual(resp["action_taken"], "runbook_error")
        self.assertTrue(resp["requires_human"])
        self.assertIn("boom", resp["details"]["error"])
        self.assertIn("crashed", resp["message"])
        self.assertEqual(log["error"], "runbook_exception")
        self.assertFalse(log["ok"])


class OllamaUnreachableTests(unittest.TestCase):
    def test_ollama_down_returns_503(self):
        def boom(*a, **kw):
            raise ollama_client.OllamaUnreachable("connection refused")
        with patch.object(dispatcher, "RUNBOOKS", FAKE_RUNBOOKS), \
             patch("ollama_client.generate", side_effect=boom):
            status, resp, log = daemon._handle_fix({"symptom": "frozen"})
        self.assertEqual(status, 503)
        self.assertEqual(resp["error"], "ollama_unreachable")
        self.assertFalse(log["ok"])
        self.assertEqual(log["error"], "ollama_unreachable")


class BadInputTests(unittest.TestCase):
    def test_missing_symptom_is_400(self):
        status, resp, log = daemon._handle_fix({"context": {"session_id": "x"}})
        self.assertEqual(status, 400)
        self.assertEqual(resp["error"], "missing_fields")
        self.assertFalse(log["ok"])

    def test_symptom_wrong_type_is_400(self):
        status, resp, _ = daemon._handle_fix({"symptom": 42})
        self.assertEqual(status, 400)
        self.assertEqual(resp["error"], "missing_fields")

    def test_invalid_json_is_400(self):
        # `None` is what `_read_json` returns on JSON parse failure.
        status, resp, log = daemon._handle_fix(None)
        self.assertEqual(status, 400)
        self.assertEqual(resp["error"], "invalid_json")
        self.assertEqual(log["error"], "invalid_json")


class DispatcherTests(unittest.TestCase):
    def test_candidates_is_stable(self):
        self.assertEqual(
            dispatcher.candidates(),
            ["frozen-pty", "lockfile-stuck", "session-corrupted", "port-conflict"],
        )

    def test_dispatch_unknown_id_raises_keyerror(self):
        with self.assertRaises(KeyError):
            dispatcher.dispatch("nope", {})

    def test_dispatch_calls_registered_runbook(self):
        with patch.object(dispatcher, "RUNBOOKS",
                          {"frozen-pty": _ok_runbook}):
            out = dispatcher.dispatch("frozen-pty", {"session_id": "s1"})
        self.assertTrue(out["ok"])
        self.assertEqual(out["details"]["session_id"], "s1")


if __name__ == "__main__":
    unittest.main()
