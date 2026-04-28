"""Corpus retrieval for shvix RAG context — pure stdlib TF-IDF cosine.

Reads ~/.claude-mem/corpora/openclaw.corpus.json (read-only). Loads once
at construction; search is per-call and small. No embeddings, no deps.
"""
from __future__ import annotations

import json
import math
import os
import pathlib
import re
from collections import Counter

DEFAULT_CORPUS_PATH = pathlib.Path(
    os.path.expanduser("~/.claude-mem/corpora/openclaw.corpus.json")
)

# Tiny stopword set — keep under 15 entries.
_STOPWORDS = {"the", "a", "an", "is", "of", "to", "and", "or", "in", "on", "for", "with"}
_TOKEN_RE = re.compile(r"\w+")


def _tokenize(text: str) -> list[str]:
    return [
        t for t in (m.lower() for m in _TOKEN_RE.findall(text))
        if len(t) >= 2 and t not in _STOPWORDS
    ]


def _doc_text(obs: dict) -> str:
    title = obs.get("title") or ""
    narrative = obs.get("narrative") or ""
    facts = obs.get("facts") or []
    concepts = obs.get("concepts") or []
    if not isinstance(facts, list):
        facts = []
    if not isinstance(concepts, list):
        concepts = []
    return f"{title}\n{narrative}\n{' '.join(str(f) for f in facts)}\n{' '.join(str(c) for c in concepts)}"


class Corpus:
    """In-memory TF-IDF index over openclaw observations."""

    def __init__(self, observations: list[dict]) -> None:
        self._observations: list[dict] = list(observations)
        # Per-doc term frequency: list parallel to _observations.
        self._tfs: list[Counter[str]] = []
        # Posting list: token → set of doc indices (for IDF doc-frequency).
        self._postings: dict[str, set[int]] = {}
        for i, obs in enumerate(self._observations):
            tokens = _tokenize(_doc_text(obs))
            tf: Counter[str] = Counter(tokens)
            self._tfs.append(tf)
            for tok in tf:
                self._postings.setdefault(tok, set()).add(i)
        self._n_docs = len(self._observations)

    @classmethod
    def load(cls, path: pathlib.Path | None = None) -> "Corpus | None":
        """Returns None if path doesn't exist — daemon must still serve."""
        p = path if path is not None else DEFAULT_CORPUS_PATH
        try:
            data = json.loads(pathlib.Path(p).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            # Unreadable / malformed — graceful degradation, treat as missing.
            return None
        observations = data.get("observations") or []
        if not isinstance(observations, list):
            observations = []
        return cls(observations=observations)

    @property
    def size(self) -> int:
        return self._n_docs

    def search(self, query: str, k: int = 5) -> list[dict]:
        """Return top-K observations sorted by TF-IDF cosine, score > 0 only."""
        if not query or not query.strip() or self._n_docs == 0:
            return []
        q_tokens = _tokenize(query)
        if not q_tokens:
            return []
        q_tf: Counter[str] = Counter(q_tokens)

        # Per-token IDF — only for tokens that appear in any doc.
        idf: dict[str, float] = {}
        for tok in q_tf:
            df = len(self._postings.get(tok, ()))
            idf[tok] = math.log(self._n_docs / (1 + df))

        # Query vector + norm (over query tokens only).
        q_vec = {tok: q_tf[tok] * idf[tok] for tok in q_tf}
        q_norm = math.sqrt(sum(v * v for v in q_vec.values()))
        if q_norm == 0:
            return []

        # Candidate docs = union of postings over query tokens. No-IDF docs are skipped.
        candidates: set[int] = set()
        for tok in q_tf:
            candidates.update(self._postings.get(tok, ()))

        scored: list[tuple[float, int]] = []
        for i in candidates:
            tf = self._tfs[i]
            # Doc norm over query-tokens-only is wrong; use full doc norm for honest cosine.
            d_norm_sq = 0.0
            for tok, count in tf.items():
                # Use IDF=log(N/(1+df)) for all doc tokens — recompute on the fly.
                df = len(self._postings.get(tok, ()))
                w = count * math.log(self._n_docs / (1 + df))
                d_norm_sq += w * w
            d_norm = math.sqrt(d_norm_sq)
            if d_norm == 0:
                continue
            dot = 0.0
            for tok, qw in q_vec.items():
                if tok in tf:
                    df = len(self._postings.get(tok, ()))
                    dw = tf[tok] * math.log(self._n_docs / (1 + df))
                    dot += qw * dw
            score = dot / (q_norm * d_norm)
            if score > 0:
                scored.append((score, i))

        scored.sort(key=lambda x: x[0], reverse=True)
        out: list[dict] = []
        for score, i in scored[:k]:
            obs = dict(self._observations[i])
            obs["_score"] = score
            out.append(obs)
        return out
