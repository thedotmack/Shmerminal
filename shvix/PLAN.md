# shvix v1 — implementation plan

Status: planned, not built. Spec is `shvix/README.md`. This plan finishes v1.

The repo today: only `shvix/README.md` exists. A prior session claimed it created `daemon.ts` (claude-mem obs 74735) but that file did not persist — assume nothing on disk except the README.

v1 scope: a local MLX daemon + four runbooks + a TS CLI + a `/shvix` slash command, integrated with shmerminal session state. No platform abstractions. One corpus: openclaw recovery.

---

## Phase 0 — Documentation Discovery (done; copy-ready findings)

These are the only external/internal contracts v1 depends on. Don't re-derive.

### 0.1 MLX-LM (Python)

- Package: `mlx-lm`. Imports: `from mlx_lm import load, generate, stream_generate`.
- Load: `model, tokenizer = load("mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")`. Auto-downloads from HF on first call, caches under HF home.
- Generate: `generate(model, tokenizer, prompt, max_tokens=..., temp=0.0, top_p=1.0, **kwargs) -> str`. Streaming via `stream_generate(...) -> Generator[GenerationResponse, None, None]`.
- Chat templates: format prompts with `tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)` then pass to `generate`. Don't hand-format ChatML.
- Recommended v1 model: `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit` (~2.2 GB, 60–80 tok/s M4 Pro). 16 GB unified memory minimum.
- For load-once-serve-many we *don't* use `mlx_lm.server` — we want our own `/fix`, `/classify`, `/health` shape, not OpenAI chat completions. Pattern: load at daemon startup, hold module-global `model`/`tokenizer`, serve from a single-threaded request loop.
- Constrained classification (optional, defer to v1.1): `logits_processors=[mask_fn]` to restrict tokens to the runbook-id alphabet. v1 uses prompt-level instruction + post-hoc validation instead.

Anti-patterns: do not invent `model.classify(...)`; do not pass `model="qwen"` shortcut strings — always full HF repo path; do not stream from inside a single-threaded HTTP handler without a queue.

### 0.2 claude-mem corpus API

- No public Python/Node SDK. Two access paths: MCP tools (build_corpus, query_corpus, search) or the worker HTTP backend at `127.0.0.1:{37700 + (UID % 100)}`.
- v1 uses the **MCP tools** path via shvix's `corpus build` subcommand running inside Claude Code, not direct HTTP — keeps shvix from depending on undocumented internal endpoints.
- Build: `build_corpus({ name: "openclaw", concepts: "openclaw recovery", project: "...", limit: 500 })`. Persisted as `~/.claude-mem/corpora/openclaw.corpus.json` (self-contained JSON, observations + filter + session_id).
- Query at recovery time: shvix daemon has two options. (a) Embed corpus-as-context: read `~/.claude-mem/corpora/openclaw.corpus.json` directly, top-K by simple BM25/keyword over symptom string, inject into prompt. (b) Call `query_corpus` via MCP. v1 picks **(a)** — no MCP roundtrip from a daemon, RAG quality is fine for ~500 short observations.
- File schema: `{ name, description, filter, observations: [{id, type, title, narrative, facts, concepts, ...}], stats, session_id }`. shvix only reads `observations[].title|narrative|facts|concepts`.

Anti-patterns: do not call MCP tools from the running daemon (the daemon is not in a Claude session). do not invent a Python SDK. do not write to `~/.claude-mem/`.

### 0.3 shmerminal session state (read-only contract for shvix runbooks)

All paths under `~/.shmerminal/sessions/<id>/`. Source of truth: `src/sessions.ts`.

- `meta.json` — `Meta` type at `src/sessions.ts:42-48`: `{ id, cmd, args, cwd, pid, child_pid, started_at, last_byte_at, port, token, public_url?, status: "running"|"exited", exit_code? }`. Written at host start (`sessions.ts:128`) and on PTY exit (`sessions.ts:146`). No locking — overwrite-on-write.
- `scrollback.log` — raw PTY bytes, rolling 1 MB cap (`SCROLLBACK_MAX = 1<<20` at `sessions.ts:31`), rotated when 2x exceeded (`sessions.ts:258-263`).
- `host.sock` — unix socket, newline-delimited JSON commands. Verbs at `sessions.ts:171-238`: `input`, `resize`, `attach`, `detach`, `tail`, `meta`, `wait_idle` (returns `{idle_ms, timeout?}`), `kill`, `inbox_read`, `inbox_watch`, `inbox_reply`, `inbox_notify_new`. **shvix runbooks may speak this protocol but must never `kill` without explicit human flag** — matches the protocol redesign in obs 74654 (asymmetric control).
- `inbox.json` — array of `{ id, ts, text, source, delivered_at?, reply?, reply_ts? }` (`sessions.ts:50-58`). Race-prone: read-modify-write with no lock. Runbooks should be idempotent if they touch this.
- **No lockfiles** are created by shmerminal anywhere. The README's "stale lockfile" failure mode is generic — v1 runbook `lockfile-stuck` targets `npm`/`yarn`/`pnpm` lockfiles in CWD, not shmerminal-internal ones. Worth restating in PLAN to prevent confusion.
- **No wedge detector** in shmerminal core. shvix detects wedge by: `meta.status == "running"` AND `Date.now() - last_byte_at > THRESHOLD` AND PTY child responsive to `wait_idle` timeout — see runbook `frozen-pty`.
- Stale-host detection: `meta.pid` does not exist in `/proc` / `kill -0` fails → host crashed, socket is stale, safe to delete `host.sock` and re-spawn.

### 0.4 Slash command contract (Claude Code / OpenClaw)

- Skills live at `~/.claude/skills/<name>/SKILL.md` (user) or `<plugin>/skills/<name>/SKILL.md` (plugin, namespaced as `/plugin:name`).
- For a clean `/shvix`, ship as a standalone user skill at `~/.claude/skills/shvix/SKILL.md` *or* as a plugin with manifest `.claude-plugin/plugin.json`. v1: ship inside this repo as `shvix/skill/SKILL.md` and let users symlink.
- Skills are **prompt templates**, not shell scripts. The model reads instructions and decides to call Bash. Use `allowed-tools: Bash` to skip permission prompts.
- Argument substitution: `$ARGUMENTS`, `$1`, etc. Session-id substitution: `${CLAUDE_SESSION_ID}`.
- Transcript path (if shvix daemon needs richer context later): `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. v1 does not read transcripts; symptom string is enough.

---

## Phase 1 — Skeleton, deps, dirs

**Goal:** repo lays out cleanly so phases 2–8 are pure file additions.

Tasks:
1. Create `shvix/package.json` (Node 18+, `"type": "module"`, deps: `node-fetch` not needed — Node 18 has fetch). No bundler. `tsc` to `dist/`. Mirror `shmerm/`'s style.
2. Create `shvix/tsconfig.json` (strict, ESM, target ES2022, outDir `dist`, rootDir `src`).
3. Create `shvix/pyproject.toml` with deps `mlx-lm>=0.20`, plus stdlib only otherwise. No FastAPI, no Flask — use `http.server` from stdlib (matches "no frameworks" rule from CLAUDE.md, even though that file is for shmerm — same project ethos).
4. Create dirs: `shvix/src/` (TS), `shvix/py/` (Python daemon + runbooks), `shvix/skill/` (SKILL.md), `shvix/.claude-plugin/` (manifest).
5. Decide and document on-disk layout: `~/.shvix/{shvix.sock, logs/YYYY-MM-DD.jsonl, model/, corpora/openclaw.json (symlink to claude-mem), config.json}`. **The daemon HTTP port is 7749, configurable via `SHVIX_PORT`.**

Verification:
- `cd shvix && npx tsc --noEmit` succeeds with empty `src/`.
- `python3 -c "import mlx_lm"` succeeds (or fails loudly with install instructions in README).
- Tree matches the layout.

Anti-patterns: don't add Express, FastAPI, Pydantic, Click, or any framework. Don't add a build tool (esbuild/vite/tsup). Don't add `requests` — use stdlib `urllib`.

---

## Phase 2 — Python MLX daemon (HTTP only, no tools yet)

**Goal:** a long-running Python process that loads the model once and serves three endpoints.

File: `shvix/py/daemon.py` (~150 LOC target).

Endpoints:
- `GET /health` → `{ status: "ok", version, model_loaded: bool, model: str, uptime_s }`.
- `POST /classify` → body `{ symptom: str, candidates: string[] }` → `{ classification: str, confidence: float, raw: str }`. Uses model for *classification only* — single-token-ish output, temp=0, max_tokens=16, post-hoc match against candidates (case-insensitive prefix), fallback to `"unknown"`.
- `POST /fix` → stub for phase 4. Return 501 for now.

Implementation pointers (copy-ready locations):
- Model load pattern: see Phase 0.1. Wrap in try/except, log to stderr, exit 1 if model fails to load (fail-fast per CLAUDE.md).
- HTTP server: `from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler`. Single global `(model, tokenizer)` initialized before `serve_forever()`. Single-threaded execution of the model: use a `threading.Lock()` around generate calls (MLX is not thread-safe for concurrent generate on one model).
- Prompt for classify: small system prompt + user template. Keep it < 200 tokens. Persist the exact prompt template in `shvix/py/prompts.py` for testability.
- Logging: every request appends one JSONL line to `~/.shvix/logs/<YYYY-MM-DD>.jsonl` with `{ts, endpoint, symptom?, classification?, latency_ms, ok}`.

Verification:
- `python3 shvix/py/daemon.py` starts, prints `shvix daemon listening on :7749, model loaded in Xs` to stderr.
- `curl localhost:7749/health` returns `model_loaded: true`.
- `curl -X POST localhost:7749/classify -d '{"symptom":"my session won'"'"'t restart","candidates":["frozen-pty","lockfile-stuck","session-corrupted","port-conflict"]}'` returns one of the four candidates or `"unknown"` in < 5 s.
- Daemon survives 10 sequential classify calls without leaking memory (RSS stable to ±200 MB).

Anti-patterns: don't use `mlx_lm.server` (wrong API shape). don't load the model lazily on first request (defeats "stays warm"). don't return free-form generated text from `/classify` — always coerce to a candidate or `"unknown"`. don't shell out to `mlx_lm.generate` CLI — use the Python API.

---

## Phase 3 — Runbook library

**Goal:** four deterministic Python modules under `shvix/py/runbooks/` that perform the actual fixes. Each is a function with a known signature; the daemon dispatches to them by name.

Signature: `def run(context: dict) -> dict` where return is `{ ok: bool, action_taken: str, details: dict, requires_human: bool, message: str }`.

Modules:
1. `shvix/py/runbooks/frozen_pty.py`
   - Read shmerminal session by `context.session_id` if provided; else find latest `~/.shmerminal/sessions/*/meta.json` with `status=="running"` and `now - last_byte_at > 30s`.
   - Connect to `host.sock`, send `wait_idle` with `quiet_ms=2000, timeout_ms=2000`. If returns `timeout=true` AND child PID is alive (`os.kill(child_pid, 0)`) → SIGTERM child, wait 3s, SIGKILL if still alive. **Never** kill the host PID (asymmetric-control rule from obs 74654).
   - Return `{ok, action_taken: "killed_child_pty", details: {child_pid, signal}, requires_human: false}`.

2. `shvix/py/runbooks/lockfile_stuck.py`
   - Scan `context.cwd` for `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb` older than 24h with no live process holding them (`lsof` check).
   - Move to `<file>.shvix-bak-<ts>` (never delete, always backup). Report.

3. `shvix/py/runbooks/session_corrupted.py`
   - Validate `meta.json` parses as JSON and matches expected shape. If not, back it up and reconstruct minimal valid meta from `host.sock` (if reachable) or mark `status: "exited"`, `exit_code: -1` and let shmerminal sweep on next start.
   - Validate `inbox.json` parses; if corrupt, back up and write `[]`.
   - Stale `host.sock` (host PID dead): unlink the socket. Do **not** restart the host — that's the human's choice.

4. `shvix/py/runbooks/port_conflict.py`
   - Read `meta.port` and `meta.pid`. If port is held by a different PID (via `lsof -i :PORT`), return `requires_human: true` with the conflicting process info. Never auto-kill foreign processes.

Verification:
- Unit test each runbook against a fixture session dir at `shvix/py/tests/fixtures/`. `pytest shvix/py/tests/` green.
- Each runbook is < 100 LOC. Each has a docstring stating preconditions and side effects. Each is idempotent.

Anti-patterns: don't add a fifth runbook "just in case" (YAGNI). don't import shmerminal Python adapter — talk to `host.sock` directly. don't use `subprocess.run("rm -rf ...")` ever. don't kill processes the runbook didn't itself create unless explicitly authorized in the runbook's docstring.

---

## Phase 4 — Wire `/fix` end-to-end

**Goal:** symptom in → classification → runbook execution → JSONL log → response.

File edits: `shvix/py/daemon.py` (add `/fix` handler), `shvix/py/dispatcher.py` (new — registry mapping `runbook_id -> module.run`).

Flow:
1. POST `/fix { symptom: str, context?: { session_id?, cwd?, logs? } }`.
2. Call internal `classify()` with the four runbook ids as candidates.
3. If `"unknown"` → return `{ ok: false, classification: "unknown", message: "human intervention requested" }` with HTTP 200 (a clean failure, not 5xx).
4. Else dispatch to runbook with merged context, capture return, log.
5. Response: `{ classification, action_taken, ok, details, requires_human, message, latency_ms }`.

Verification:
- End-to-end manual: spin up shmerminal `shmerm run -- bash`, deliberately wedge it (`sleep 99999`), POST `/fix { symptom: "session is frozen", context: {session_id: "..."} }` → daemon classifies → frozen_pty runs → child PTY killed → host stays alive → response shows `action_taken: "killed_child_pty"`.
- JSONL log line written to today's file.
- Repeat with garbage symptom ("the moon is blue") → returns `unknown`, no runbook side effects.

Anti-patterns: don't let the model decide *how* to run a runbook — only *which*. don't accept a `runbook_id` directly from the client (always classify; if a human wants to force one, they use the `shvix run-runbook <id>` CLI subcommand which is explicitly out of scope for v1).

---

## Phase 5 — Corpus integration (RAG context for /fix)

**Goal:** improve classification by injecting top-K relevant past recoveries from the openclaw corpus into the classify prompt.

File edits: `shvix/py/corpus.py` (new — load + simple retrieval), `shvix/py/daemon.py` (use it in classify).

Approach:
1. At daemon startup, read `~/.claude-mem/corpora/openclaw.corpus.json` if present (else log "no corpus, running cold" and continue — v1 is graceful when corpus is missing).
2. Build an in-memory inverted index: tokenize each observation's `title + subtitle + facts + narrative`, BM25 scores. Stdlib only — no `rank-bm25` dep unless trivial to vendor in <100 LOC. v1: simple TF-IDF cosine works.
3. On classify: retrieve top-K=5 observations matching the symptom, inject into the prompt as "Past similar incidents:" before asking for classification.
4. Track in JSONL log: `corpus_hits: [obs_id, obs_id, ...]` for the self-improving loop.

CLI subcommand `shvix corpus build` (covered in Phase 6) writes the corpus by invoking the `build_corpus` MCP tool — but only when shvix is run from inside a Claude Code session. Outside Claude (pure CLI), `corpus build` prints instructions for how to do it from inside a session. **Don't** try to call the claude-mem worker HTTP backend directly — that's an undocumented internal API.

Verification:
- With corpus present and a symptom phrased ambiguously ("things are weird"), classify returns a more confident result than without (eyeball test on 3 fixtures).
- Without corpus, daemon still serves /classify and /fix.
- `corpus.py` < 150 LOC.

Anti-patterns: don't add `chromadb`, `faiss`, `sentence-transformers`, or any embedding dep. The corpus is small (≤500 observations of < 2KB each); BM25 over titles+facts is plenty. If you're tempted to vector-search, document why in this PLAN first.

---

## Phase 6 — Node TS CLI dispatcher

**Goal:** `shvix <subcommand>` dispatches to either daemon-RPC (HTTP) or local actions.

File: `shvix/src/cli.ts` (~250 LOC), entrypoint registered as `bin: { shvix: "dist/cli.js" }` in `package.json`.

Subcommands (all from README):
- `shvix daemon` → spawns `python3 shvix/py/daemon.py` detached (double-fork pattern, write PID to `~/.shvix/daemon.pid`). Wait up to 60 s for `/health` to return. Print URL to stderr.
- `shvix daemon stop` → read PID, SIGTERM, wait, SIGKILL.
- `shvix recover [--last] [--session id]` → POST `/fix` with context built from shmerminal session state. `--last` finds most recent `~/.shmerminal/sessions/*/` by `started_at`.
- `shvix diagnose <symptom>` → POST `/classify` only, print result. Doesn't act.
- `shvix corpus build [--topic openclaw]` → see Phase 5 caveat.
- `shvix corpus list` → ls `~/.claude-mem/corpora/`.
- `shvix logs [--tail]` → cat / tail `~/.shvix/logs/<today>.jsonl`. Pretty-print unless `--json`.
- `shvix status` → GET `/health`, plus daemon PID, plus corpus stats.

Conventions (mirror shmerm CLAUDE.md style):
- Stderr for human prose. `--json` flag → JSON to stdout.
- Fail loudly on already-running daemon.
- No external CLI parser — hand-rolled `argv.slice(2)` parsing in <50 LOC. We have ~8 subcommands; a parser library is overkill.

Verification:
- `shvix daemon && shvix status` shows model loaded.
- `shvix diagnose "session frozen"` returns `frozen-pty`.
- `shvix recover --last` against a deliberately wedged shmerminal session unwedges it.
- `shvix logs --tail` shows the recovery.

Anti-patterns: don't add `commander`, `yargs`, `oclif`. Don't use `axios` — Node 18 fetch. Don't run the daemon in the same process as the CLI (defeats persistence).

---

## Phase 7 — `/shvix` slash command skill

**Goal:** users in a Claude Code session type `/shvix my session won't restart` and get the daemon's verdict back.

Files:
- `shvix/skill/SKILL.md` — the markdown.
- `shvix/.claude-plugin/plugin.json` — manifest for plugin distribution.

`SKILL.md` content shape (per Phase 0.4):
```yaml
---
name: shvix
description: Diagnose and recover wedged shmerminal/openclaw sessions via local MLX daemon
allowed-tools: Bash
---
The user's symptom: $ARGUMENTS
Active session id: ${CLAUDE_SESSION_ID}

POST this to the local shvix daemon and report its response verbatim:

\`\`\`bash
curl -sS -X POST http://localhost:7749/fix \
  -H "content-type: application/json" \
  -d "$(jq -nc --arg s "$ARGUMENTS" --arg sid "$CLAUDE_SESSION_ID" '{symptom:$s, context:{session_id:$sid}}')"
\`\`\`

If curl fails (daemon not running), tell the user to run `shvix daemon` and try again. Do not attempt to fix the issue yourself.
```

Verification:
- Symlink `shvix/skill` → `~/.claude/skills/shvix`. In a fresh Claude session, `/shvix the terminal is stuck` triggers the skill, which curls the daemon, which classifies + acts, response shows up in the chat.
- Daemon down → skill's bash fails → user gets the "run shvix daemon" message.

Anti-patterns: don't put model logic in the skill. don't pass full transcripts. don't bypass the daemon (no fallback to "ask Claude" — that's not what shvix is).

---

## Phase 8 — shmerminal integration polish

**Goal:** `shvix recover --last` works without the user passing a session id. Runbooks read shmerminal state safely.

Tasks:
1. Add `shvix/py/shmerminal.py` — read-only helper. `find_latest_session()`, `read_meta(id)`, `read_scrollback_tail(id, n=200)`, `connect_host_sock(id) -> socket`. ~80 LOC. No writes.
2. The `port-conflict` runbook compares `meta.port` against actual listeners.
3. `shvix recover --last` includes the last 200 lines of scrollback in the request `context.logs` so corpus retrieval has more signal.
4. Document in README (one paragraph) that shvix never kills shmerminal host processes — only PTY children — and never deletes session dirs (only stale `host.sock` files when host PID is dead).

Verification:
- Wedge a real shmerminal session. Run `shvix recover --last`. Watch host PID stay alive across recovery. Confirm via `ps`.
- Inspect daemon logs: scrollback tail was included.

Anti-patterns: don't import `shmerm_agent.py` — it's a wrapper around the shmerm CLI, not a library. We talk to the socket directly. Don't write to any file under `~/.shmerminal/` except backups created by `session_corrupted.py`.

---

## Phase 9 — Verification, README polish, ship

1. End-to-end script `shvix/scripts/e2e.sh`: starts daemon, builds a fake wedged session, runs `shvix recover --last`, asserts JSON exit code, kills daemon. Runs in < 60 s on a warm model.
2. `shvix --version` and a real `package.json` version (start at `0.1.0`).
3. Update `shvix/README.md`: change "Status: draft. Nothing here is built yet" → "Status: v0.1. Recovery for openclaw on apple silicon, offline." Add Install + Quickstart sections with real commands.
4. `tsc --noEmit`, `python3 -m py_compile shvix/py/**/*.py`, `pytest shvix/py/tests/` all green.
5. Grep for anti-patterns:
   - `grep -rn 'rm -rf' shvix/py/` → empty.
   - `grep -rn 'kill.*host_pid\|kill.*meta\.pid' shvix/py/` → empty (we only kill child PIDs).
   - `grep -rn 'mlx_lm\.server' shvix/py/` → empty.
   - `grep -rn 'import requests\|from flask\|import express' shvix/` → empty.
6. Manual: install plugin from `.claude-plugin/plugin.json`, fire `/shvix:diagnose terminal stuck` from a real Claude Code session, verify response.

---

## Out of scope for v1 (don't build)

- Multiple corpora. v1 is openclaw, full stop.
- LoRA fine-tuning loop. We log everything to JSONL — that's the future training data, not today's feature.
- Streaming responses. Classify is fast (< 1 s on 7B-4bit); streaming UX is unnecessary.
- Constrained-decoding via logits processors. Defer to v1.1 if classification accuracy < 90%.
- Unix-socket transport for the daemon. HTTP localhost is enough for v1; the README's `~/.shvix/shvix.sock` claim is aspirational.
- Web UI. shvix is invisible — its UI is the slash command.
- Auto-recovery cron / file watchers. Triggered by human or agent only.
- Cross-platform support. Apple Silicon only.

## Stop conditions (per CLAUDE.md)

- Adding any Python or Node dep beyond `mlx-lm` (Python) and zero (Node) — ask first.
- Anything that writes to `~/.claude-mem/` — ask first.
- Anything that kills a non-shvix-spawned process other than a shmerminal PTY child — ask first.
- Touching `src/sessions.ts` or other shmerm core files from shvix — ask first; shvix is a tenant, not an owner.
