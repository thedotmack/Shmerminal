"""shvix HTTP daemon — thin proxy to Ollama for classification.

Stdlib only. Endpoints: GET /health, POST /classify, POST /fix (stub).
See shvix/PLAN.md Phase 2 for the contract.
"""

import json
import os
import pathlib
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import corpus as corpus_module
import dispatcher
import ollama_client
import prompts

PORT = int(os.environ.get("SHVIX_PORT", "7749"))
OLLAMA_URL = os.environ.get("SHVIX_OLLAMA_URL", "http://localhost:11434")
MODEL = os.environ.get("SHVIX_MODEL", "gemma4:e4b")
LOG_DIR = pathlib.Path(os.path.expanduser("~/.shvix/logs"))
VERSION = "0.1.0"
START_TIME = time.time()

# Load corpus once at module import. None means cold mode — daemon must still serve.
corpus: corpus_module.Corpus | None = corpus_module.Corpus.load()


def log_request(endpoint: str, payload: dict) -> None:
    today = time.strftime("%Y-%m-%d")
    line = json.dumps({"ts": time.time(), "endpoint": endpoint, **payload})
    with (LOG_DIR / f"{today}.jsonl").open("a") as f:
        f.write(line + "\n")


def _classify(symptom: str, candidates: list[str]) -> tuple[str, float, str, list[str]]:
    """Returns (classification, confidence, raw_response, corpus_hit_ids)."""
    hits: list[dict] = []
    hit_ids: list[str] = []
    if corpus is not None:
        hits = corpus.search(symptom, k=5)
        hit_ids = [h.get("id") for h in hits if h.get("id") is not None]
    prompt = prompts.build_classify_prompt(symptom, candidates, corpus_hits=hits)
    raw = ollama_client.generate(OLLAMA_URL, MODEL, prompt)
    norm = raw.strip().lower()
    # Exact match first
    for c in candidates:
        if norm == c.lower():
            return c, 1.0, raw, hit_ids
    # Prefix match (e.g. "frozen-pty\n" or "frozen-pty.")
    for c in candidates:
        if norm.startswith(c.lower()):
            return c, 0.7, raw, hit_ids
    return "unknown", 0.0, raw, hit_ids


def _handle_fix(body: dict | None) -> tuple[int, dict, dict]:
    """Pure /fix logic. Returns (status, response_body, log_payload).

    Extracted from the HTTP handler so unit tests skip the server.
    """
    t0 = time.time()
    if not isinstance(body, dict):
        return 400, {"error": "invalid_json"}, {"ok": False, "error": "invalid_json"}
    symptom = body.get("symptom")
    if not isinstance(symptom, str):
        return 400, {"error": "missing_fields"}, {"ok": False, "error": "missing_fields"}
    context = body.get("context") or {}
    if not isinstance(context, dict):
        context = {}
    def _ms() -> int:
        return int((time.time() - t0) * 1000)
    try:
        classification, _confidence, _raw, hit_ids = _classify(symptom, dispatcher.candidates())
    except ollama_client.OllamaUnreachable as e:
        return 503, {"error": "ollama_unreachable", "detail": str(e)}, {
            "ok": False, "error": "ollama_unreachable",
            "symptom": symptom, "latency_ms": _ms(), "corpus_hits": [],
        }

    if classification == "unknown":
        resp = {"ok": False, "classification": "unknown", "action_taken": "noop",
                "details": {}, "requires_human": True,
                "message": "human intervention requested", "latency_ms": _ms()}
        log = {"ok": False, "classification": "unknown", "action_taken": "noop",
               "symptom": symptom, "latency_ms": resp["latency_ms"],
               "requires_human": True, "corpus_hits": hit_ids}
        return 200, resp, log

    try:
        result = dispatcher.dispatch(classification, context)
    except Exception as e:  # runbook crashed — clean 200 with requires_human
        resp = {"ok": False, "classification": classification,
                "action_taken": "runbook_error", "details": {"error": str(e)},
                "requires_human": True,
                "message": f"runbook {classification} crashed; see logs",
                "latency_ms": _ms()}
        log = {"ok": False, "error": "runbook_exception",
               "classification": classification, "action_taken": "runbook_error",
               "symptom": symptom, "latency_ms": resp["latency_ms"],
               "requires_human": True, "corpus_hits": hit_ids}
        return 200, resp, log

    resp = {"classification": classification, **result, "latency_ms": _ms()}
    log = {"ok": result["ok"], "classification": classification,
           "action_taken": result["action_taken"], "symptom": symptom,
           "latency_ms": resp["latency_ms"],
           "requires_human": result["requires_human"], "corpus_hits": hit_ids}
    return 200, resp, log


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 — silence stderr access log
        return

    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    _MAX_BODY = 1 << 20  # 1 MiB cap on Content-Length to bound local-DoS surface.

    def _read_json(self) -> dict | None:
        declared = int(self.headers.get("Content-Length", "0") or "0")
        length = min(declared, self._MAX_BODY)
        if length <= 0:
            return {}
        try:
            raw = self.rfile.read(length).decode("utf-8")
            return json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return None

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            ollama_ok = False
            model_pulled = False
            try:
                models = ollama_client.list_models(OLLAMA_URL)
                ollama_ok = True
                model_pulled = MODEL in models
            except Exception:
                pass
            self._send_json(200, {
                "status": "ok",
                "version": VERSION,
                "ollama_reachable": ollama_ok,
                "model": MODEL,
                "model_pulled": model_pulled,
                "uptime_s": int(time.time() - START_TIME),
            })
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/classify":
            self._handle_classify()
            return
        if self.path == "/fix":
            body = self._read_json()
            status, resp, log = _handle_fix(body)
            self._send_json(status, resp)
            log_request("/fix", log)
            return
        self._send_json(404, {"error": "not_found"})

    def _handle_classify(self) -> None:
        t0 = time.time()
        body = self._read_json()
        if not isinstance(body, dict):
            self._send_json(400, {"error": "invalid_json"})
            log_request("/classify", {"ok": False, "error": "invalid_json"})
            return
        symptom = body.get("symptom")
        candidates = body.get("candidates")
        if (
            not isinstance(symptom, str)
            or not isinstance(candidates, list)
            or not all(isinstance(c, str) and c for c in candidates)
        ):
            self._send_json(400, {"error": "missing_fields"})
            log_request("/classify", {"ok": False, "error": "missing_fields"})
            return
        try:
            classification, confidence, raw, hit_ids = _classify(symptom, candidates)
        except ollama_client.OllamaUnreachable as e:
            self._send_json(503, {"error": "ollama_unreachable", "detail": str(e)})
            log_request("/classify", {
                "ok": False, "error": "ollama_unreachable",
                "symptom": symptom,
                "latency_ms": int((time.time() - t0) * 1000),
                "corpus_hits": [],
            })
            return
        latency_ms = int((time.time() - t0) * 1000)
        self._send_json(200, {
            "classification": classification,
            "confidence": confidence,
            "raw": raw,
        })
        log_request("/classify", {
            "ok": True,
            "symptom": symptom,
            "classification": classification,
            "latency_ms": latency_ms,
            "corpus_hits": hit_ids,
        })


def main() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        models = ollama_client.list_models(OLLAMA_URL)
    except ollama_client.OllamaUnreachable:
        print(
            f"shvix: Ollama not running at {OLLAMA_URL}. "
            f"Install: https://ollama.com/download. Then: ollama serve",
            file=sys.stderr,
        )
        sys.exit(1)
    if MODEL not in models:
        print(
            f"shvix: model {MODEL} not pulled. Run: ollama pull {MODEL}",
            file=sys.stderr,
        )
        sys.exit(1)
    corpus_suffix = (
        f", corpus={corpus.size} obs" if corpus is not None
        else ", corpus=none (running cold)"
    )
    print(
        f"shvix daemon listening on :{PORT}, ollama=ok, model={MODEL} pulled{corpus_suffix}",
        file=sys.stderr,
    )
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
