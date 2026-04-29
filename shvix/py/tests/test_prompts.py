"""Phase 5 prompt tests — stdlib unittest only."""
from __future__ import annotations

import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import prompts  # noqa: E402


class BuildClassifyPromptTests(unittest.TestCase):
    def test_no_corpus_matches_phase2_baseline(self) -> None:
        prompt = prompts.build_classify_prompt("session frozen", ["a", "b"])
        self.assertNotIn("Past similar incidents:", prompt)
        self.assertIn("Candidates:\n- a\n- b", prompt)
        self.assertIn("Symptom:\nsession frozen", prompt)

    def test_empty_corpus_hits_treated_as_none(self) -> None:
        a = prompts.build_classify_prompt("foo", ["x"], corpus_hits=None)
        b = prompts.build_classify_prompt("foo", ["x"], corpus_hits=[])
        self.assertEqual(a, b)
        self.assertNotIn("Past similar incidents:", b)

    def test_corpus_hits_block_present(self) -> None:
        hits = [
            {"title": "stale lockfile", "narrative": "deleted package-lock.json"},
            {"title": "frozen pty", "narrative": "sent sigterm to child"},
        ]
        prompt = prompts.build_classify_prompt("things are weird", ["a"], corpus_hits=hits)
        self.assertIn("Past similar incidents:", prompt)
        self.assertIn("stale lockfile: deleted package-lock.json", prompt)
        self.assertIn("frozen pty: sent sigterm to child", prompt)

    def test_corpus_hits_truncated_to_top_3(self) -> None:
        hits = [
            {"title": f"hit{i}", "narrative": f"narrative-{i}"} for i in range(7)
        ]
        prompt = prompts.build_classify_prompt("s", ["a"], corpus_hits=hits)
        for i in range(3):
            self.assertIn(f"hit{i}:", prompt)
        for i in range(3, 7):
            self.assertNotIn(f"hit{i}:", prompt)

    def test_long_narrative_truncated_to_about_200_chars(self) -> None:
        long = "x" * 500
        hits = [{"title": "t", "narrative": long}]
        prompt = prompts.build_classify_prompt("s", ["a"], corpus_hits=hits)
        # Find the narrative line; ensure it does not contain all 500 x's.
        self.assertIn("...", prompt)
        # Hard upper bound: the line shouldn't carry more than ~210 x's.
        self.assertNotIn("x" * 250, prompt)


if __name__ == "__main__":
    unittest.main()
