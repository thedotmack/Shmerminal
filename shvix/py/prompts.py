"""Prompt templates for shvix classification calls.

Kept tiny and deterministic — under 400 tokens of output. The model only
needs to pick a runbook id, so the prompt is mostly the candidate list and
the verbatim symptom. corpus_hits is wired in for Phase 5; v1 ignores it.
"""

# Module-level template. Use .format(...) so callers can inspect / test it.
_CLASSIFY_TEMPLATE = """You are a recovery classifier. Pick exactly ONE of the candidate runbook ids.

Candidates:
{candidate_lines}

Symptom:
{symptom}

Respond with only the runbook id, nothing else. If none match, respond with: unknown"""


def build_classify_prompt(
    symptom: str,
    candidates: list[str],
    corpus_hits: list[dict] | None = None,
) -> str:
    """Build a single-turn classify prompt.

    corpus_hits is accepted for Phase 5 RAG context — currently ignored so
    callers don't have to refactor when retrieval lands.
    """
    candidate_lines = "\n".join(f"- {c}" for c in candidates)
    return _CLASSIFY_TEMPLATE.format(
        candidate_lines=candidate_lines,
        symptom=symptom.strip(),
    )
