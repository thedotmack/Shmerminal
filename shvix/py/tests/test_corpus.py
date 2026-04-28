"""Phase 5 corpus tests — stdlib unittest only."""
from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import corpus as corpus_module  # noqa: E402


FIXTURES = [
    {
        "id": "obs-lockfile-1",
        "title": "npm install hung due to stale lockfile",
        "narrative": "package-lock.json was out of sync; deleting and reinstalling unwedged the build.",
        "facts": ["npm", "lockfile", "package-lock.json"],
        "concepts": ["lockfile recovery"],
    },
    {
        "id": "obs-frozen-1",
        "title": "Terminal session frozen after long sleep",
        "narrative": "PTY child stopped emitting bytes; sending SIGTERM to the child process resolved it.",
        "facts": ["pty", "frozen", "sigterm"],
        "concepts": ["frozen pty"],
    },
    {
        "id": "obs-port-1",
        "title": "Port conflict on 7749",
        "narrative": "Another process held the port; required human intervention.",
        "facts": ["port", "conflict", "lsof"],
        "concepts": ["port conflict"],
    },
    {
        "id": "obs-corrupt-1",
        "title": "meta.json was malformed",
        "narrative": "Session state corrupted on disk; backed up and reconstructed.",
        "facts": ["meta.json", "corruption"],
        "concepts": ["session corruption"],
    },
]


class CorpusSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.corpus = corpus_module.Corpus(observations=FIXTURES)

    def test_lockfile_query_ranks_lockfile_obs_first(self) -> None:
        hits = self.corpus.search("lockfile npm", k=2)
        self.assertGreaterEqual(len(hits), 1)
        self.assertEqual(hits[0]["id"], "obs-lockfile-1")
        for h in hits:
            self.assertIn("_score", h)
            self.assertGreater(h["_score"], 0)

    def test_unrelated_query_filters_zero_scores(self) -> None:
        hits = self.corpus.search("totally unrelated query xyz", k=5)
        # Score-0 hits get filtered out — list may be empty or only > 0 entries.
        for h in hits:
            self.assertGreater(h["_score"], 0)

    def test_empty_query_returns_empty(self) -> None:
        self.assertEqual(self.corpus.search("", k=5), [])
        self.assertEqual(self.corpus.search("   ", k=5), [])

    def test_size_property(self) -> None:
        self.assertEqual(self.corpus.size, 4)

    def test_load_missing_path_returns_none(self) -> None:
        ghost = pathlib.Path("/tmp/shvix-does-not-exist-xyzzy.json")
        self.assertFalse(ghost.exists())
        self.assertIsNone(corpus_module.Corpus.load(ghost))

    def test_load_from_file(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = pathlib.Path(td) / "openclaw.corpus.json"
            p.write_text(json.dumps({
                "name": "openclaw",
                "observations": FIXTURES,
            }))
            loaded = corpus_module.Corpus.load(p)
            self.assertIsNotNone(loaded)
            assert loaded is not None
            self.assertGreater(loaded.size, 0)
            self.assertEqual(loaded.size, len(FIXTURES))


if __name__ == "__main__":
    unittest.main()
