# shvix

**Local Recovery Agent.**
*The boring one. On purpose.*
*offline by default — your laptop is the cloud.*

> Status: **v0.1**. Recovery for openclaw on Mac/Linux/Windows, offline. Ollama-backed.

---

shvix is a tiny local agent that fixes things when they bork. It runs a small open-weight model via [Ollama](https://ollama.com) on your laptop — Mac, Linux, or Windows — scoped to a corpus you give it, with a narrow set of tools it's allowed to use. v1 ships with one corpus: OpenClaw recovery. When OpenClaw wedges itself, you type `/shvix` and shvix gets it back online — without ever touching the network.

```bash
# from inside OpenClaw, when something's wrong:
/shvix my session won't restart

# from the outside, when OpenClaw is fully dead:
shvix recover --last
```

Same agent. Two entry points. One offline.

---

## Why this exists

Agents bork themselves. A stale lockfile, a half-written config, a session host that died but left its socket behind, a runaway PID, a config schema that drifted. The fixes are usually small and known. The pain is that the agent driving the work is the same agent that just broke, so it can't recover itself — and when you're offline or rate-limited, no cloud model is coming to save you.

shvix sits **outside** the thing it recovers. Separate process, separate context, separate brain. When OpenClaw dies, shvix is still alive. When the network's down, shvix doesn't care — the model lives on disk, the corpus lives on disk, the tools are local Python.

Three concrete problems it ends:

**Recovery agents that die with their patient.** A repair tool inside the broken thing isn't a repair tool. shvix runs as its own daemon. OpenClaw can crash, restart, segfault, hang — shvix is unaffected.

**"It's a small fix but I'm offline."** Ollama runs Gemma 4 at usable speeds on any modern laptop with no network. Plane, train, café wifi captive portal, rate limit, outage — shvix works.

**Fixes you've made before, made again from scratch.** Every shvix recovery feeds back into the corpus. Same bork next month? shvix already knows the runbook.

---

## How it works

shvix is three things wired together:

1. **A local model via Ollama.** `gemma4:e4b` by default — 4B-effective Gemma 4 Instruct, ~9.6 GB on disk, kept warm. Its job is classification, not creativity. Swap with `SHVIX_MODEL` if you'd rather run something else.
2. **A corpus.** A claude-mem knowledge brain scoped to the failure domain. For v1 that's OpenClaw recovery — every observation across every session that solved an OpenClaw bork.
3. **A narrow tool surface.** Deterministic Python that does the actual work: read logs, kill PIDs, restore session state from `~/.shmerminal/sessions/<id>/`, restart processes, clear stale sockets, diff against last-known-good config.

The split matters. The model picks the runbook. Python executes it. A 4B model classifying into a handful of known failure modes is reliable. A 4B model freely calling `rm -rf` is a liability.

shvix never kills shmerminal host processes — only PTY children that wait_idle confirms are wedged. shvix never deletes session directories; only stale `host.sock` files when the host PID is provably dead. Backup files are always created (suffix `*.shvix-bak-<ts>`) before any in-place rewrite of `meta.json` or `inbox.json`.

---

## What you get

**A daemon.** A small Python HTTP server on `localhost:7749`. Sits in front of Ollama, adds prompt templating, RAG over the corpus, and runbook dispatch. Idle CPU is near zero — Ollama keeps the model warm.

**A slash command.** `/shvix <symptom>` from inside OpenClaw POSTs the symptom plus recent logs to the daemon and waits for the verdict.

**A CLI.** For when OpenClaw is fully dead and the slash command isn't reachable. `shvix recover` reads the last broken session and tries to revive it.

**A corpus loader.** `shvix corpus build` walks claude-mem observations matching a topic (default: OpenClaw recovery) and bakes a brain shvix queries on every call.

**A self-improving loop.** Every shvix invocation — symptom, picked runbook, did-it-work — gets logged and observed by claude-mem. Tomorrow's brain is smarter than today's.

---

## CLI surface

```text
shvix daemon                          start the local model server
shvix recover [--last] [--session id] try to fix the most recent bork
shvix diagnose <symptom>              classify without acting
shvix corpus build [--topic openclaw] (re)build the brain
shvix corpus list                     show available corpora
shvix logs [--tail]                   what shvix has done lately
shvix status                          daemon health, model loaded, corpus stats
```

All commands accept `--json`. The daemon also speaks HTTP on `localhost` for the OpenClaw slash command.

---

## Architecture

```text
┌──────────────────────────────────────────────────────────┐
│  ~/.shvix/                                               │
│    daemon.pid         pid of running shvix daemon         │
│    corpora/openclaw   claude-mem brain for the domain     │
│    logs/*.jsonl       every recovery, classified + outcome│
└──────────────────────────────────────────────────────────┘
         ▲                ▲                  ▲
         │                │                  │
   ┌─────┴──────┐   ┌─────┴──────┐    ┌──────┴───────┐
   │ shvix      │   │ /shvix     │    │ shvix CLI    │
   │ daemon     │   │ slash cmd  │    │ (recover,    │
   │ :7749      │   │ (inside    │    │  diagnose,   │
   │ • corpus   │   │  OpenClaw) │    │  corpus,     │
   │ • tools    │   └────────────┘    │  logs)       │
   │ • runbooks │                     └──────────────┘
   └─────┬──────┘
         │ HTTP
         ▼
   ┌────────────────────────────┐
   │ Ollama @ :11434            │
   │ gemma4:e4b — kept warm     │
   │ (~/.ollama/models/)        │
   └────────────────────────────┘
```

One shvix daemon per machine, sitting in front of one Ollama instance. Per-corpus brains. Recovery actions are deterministic Python, not free-form tool calls — the model picks which one to run, not how to run it.

---

## The corpus model

v1 ships with one corpus (OpenClaw recovery), but the primitive generalizes. A corpus is just a claude-mem knowledge brain plus a set of allowed tools. Future corpora write themselves:

- **dotfiles** — fix a broken shell config from the agent that broke it
- **k8s** — recover a wedged local cluster
- **build** — diagnose a stuck CI runner
- **internal-runbooks** — your team's playbook, scoped to your stack

We're not building the platform first. v1 is OpenClaw recovery, full stop. The platform falls out once the wedge works.

---

## Install

Not yet installable. When it is:

```bash
# 1. Install Ollama (one-time)
brew install ollama                    # mac
# or: curl -fsSL https://ollama.com/install.sh | sh    # linux
# or: winget install Ollama.Ollama                     # windows
ollama serve &                         # background runtime
ollama pull gemma4:e4b                 # ~9.6 GB, one-time

# 2. Install shvix
npm install -g shvix
shvix corpus build --topic openclaw    # one-time, builds local brain
shvix daemon &                         # starts in the background
```

Requires:
- Ollama (macOS / Linux / Windows; autodetects Metal / CUDA / ROCm / CPU)
- ~10 GB disk for the `gemma4:e4b` model; 16 GB RAM recommended (use `gemma4:e2b` on 8 GB)
- Python 3.10+ (stdlib only — no pip install needed)
- A claude-mem install with observation history (the corpus needs something to learn from)
- Node 18+ for the CLI

---

## What this is NOT

- **Not a general coding agent.** shvix doesn't write features. It restores known-good states.
- **Not a cloud service.** No accounts, no telemetry, no network calls. The model and corpus are on your disk.
- **Not a replacement for OpenClaw.** It's the recovery layer underneath. OpenClaw drives the work; shvix unsticks it when it jams.
- **Not creative.** If shvix can't classify the symptom into a known runbook, it says so and asks the human. A boring agent that gives up cleanly beats a clever one that makes it worse.

---

## Open questions

Things still to nail down before this becomes code:

- Which model long-term. v1 ships `gemma4:e4b` (Ollama). `gemma4:e2b` may be enough for the classify-only task. Worth measuring after we have logs.
- Corpus refresh cadence. Rebuild on every shvix invocation? Nightly? On-demand?
- Slash command transport. HTTP on localhost is simplest. Unix socket is cleaner but harder to reach from inside a sandboxed agent.
- Failure-mode taxonomy. The first runbook library is hand-written — what are the top ~10 ways OpenClaw borks itself?

---

## Status

v0.1. Daemon, runbooks, CLI, and slash command are wired. The corpus is
optional — shvix runs cold without it. Apple Silicon / Linux / Windows
all supported via Ollama.

---

## License

MIT
