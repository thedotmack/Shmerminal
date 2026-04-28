"""Stdlib-only Ollama HTTP client. See shvix/PLAN.md Phase 0.1 for shape.

GET /api/tags returns {"models": [{"name": "...", ...}]}.
POST /api/generate with stream=false returns {"response": "...", "done": true}.
"""

import json
import urllib.error
import urllib.request


class OllamaUnreachable(RuntimeError):
    """Raised when the Ollama HTTP server can't be reached or times out."""


def list_models(base_url: str, timeout: float = 5.0) -> list[str]:
    """GET {base_url}/api/tags → list of model name tags.

    Raises OllamaUnreachable on connection refused, DNS error, or timeout.
    """
    url = f"{base_url.rstrip('/')}/api/tags"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise OllamaUnreachable(f"GET {url}: {e}") from e
    return [m["name"] for m in data.get("models", [])]


def generate(
    base_url: str,
    model: str,
    prompt: str,
    num_predict: int = 16,
    temperature: float = 0.0,
    timeout: float = 60.0,
) -> str:
    """POST {base_url}/api/generate with stream=false → response text (stripped).

    Raises OllamaUnreachable on URL errors / timeouts.
    """
    url = f"{base_url.rstrip('/')}/api/generate"
    body = json.dumps({
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": temperature,
            "num_predict": num_predict,
        },
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise OllamaUnreachable(f"POST {url}: {e}") from e
    return data.get("response", "").strip()
