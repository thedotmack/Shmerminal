"""Prompt templates for shvix classification calls.

Kept tiny and deterministic — under 800 tokens of output. The model only
needs to pick a runbook id, so the prompt is mostly the candidate list,
the verbatim symptom, and (Phase 5) up to 3 corpus excerpts as RAG hints.
"""

# Module-level template. Use .format(...) so callers can inspect / test it.
_CLASSIFY_TEMPLATE = """You are a recovery classifier. Pick exactly ONE of the candidate runbook ids.

Candidates:
{candidate_lines}{corpus_block}

Symptom:
{symptom}

Respond with only the runbook id, nothing else. If none match, respond with: unknown"""

_CORPUS_MAX_HITS = 3
_NARRATIVE_TRUNCATE = 200


def _format_corpus_block(corpus_hits: list[dict]) -> str:
    lines = ["", "", "Past similar incidents:"]
    for hit in corpus_hits[:_CORPUS_MAX_HITS]:
        title = (hit.get("title") or "").strip() or "(untitled)"
        narrative = (hit.get("narrative") or "").strip()
        if len(narrative) > _NARRATIVE_TRUNCATE:
            narrative = narrative[:_NARRATIVE_TRUNCATE].rstrip() + "..."
        # Single-line excerpt — collapse newlines so the block stays compact.
        narrative = " ".join(narrative.split())
        lines.append(f"- {title}: {narrative}")
    return "\n".join(lines)


def build_classify_prompt(
    symptom: str,
    candidates: list[str],
    corpus_hits: list[dict] | None = None,
) -> str:
    """Build a single-turn classify prompt.

    When corpus_hits is non-empty, prepends a "Past similar incidents:" block
    (top 3 max) before the symptom. Empty list / None → identical to the
    Phase 2 baseline.
    """
    candidate_lines = "\n".join(f"- {c}" for c in candidates)
    corpus_block = ""
    if corpus_hits:
        corpus_block = _format_corpus_block(corpus_hits)
    return _CLASSIFY_TEMPLATE.format(
        candidate_lines=candidate_lines,
        corpus_block=corpus_block,
        symptom=symptom.strip(),
    )
