# shvix

**Local Recovery Agent.**
*The boring one. On purpose.*
*offline by default — your laptop is the cloud.*

> Status: **draft**. Nothing here is built yet. This is the shape.

---

shvix is a tiny local agent that fixes things when they bork. It runs an MLX model on your Mac, scoped to a corpus you give it, with a narrow set of tools it's allowed to use. v1 ships with one corpus: OpenClaw recovery. When OpenClaw wedges itself, you type `/shvix` and shvix gets it back online — without ever touching the network.

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

**"It's a small fix but I'm offline."** MLX runs Qwen2.5-Coder-class models on Apple Silicon at usable speeds, with no network. Plane, train, café wifi captive portal, rate limit, outage — shvix works.

**Fixes you've made before, made again from scratch.** Every shvix recovery feeds back into the corpus. Same bork next month? shvix already knows the runbook.

---

## How it works

shvix is three things wired together:

1. **A local MLX model.** Small (7B–14B class), loaded once, kept warm. Its job is classification, not creativity.
2. **A corpus.** A claude-mem knowledge brain scoped to the failure domain. For v1 that's OpenClaw recovery — every observation across every session that solved an OpenClaw bork.
3. **A narrow tool surface.** Deterministic Python that does the actual work: read logs, kill PIDs, restore session state from `~/.shmerminal/sessions/<id>/`, restart processes, clear stale sockets, diff against last-known-good config.

The split matters. The model picks the runbook. Python executes it. A 7B model classifying into 8 known failure modes is reliable. A 7B model freely calling `rm -rf` is a liability.

---

## What you get

**A daemon.** Runs on a unix socket at `~/.shvix/shvix.sock`. Loads the model once. Stays warm. Idle CPU is near zero.

**A slash command.** `/shvix <symptom>` from inside OpenClaw POSTs the symptom plus recent logs to the daemon and waits for the verdict.

**A CLI.** For when OpenClaw is fully dead and the slash command isn't reachable. `shvix recover` reads the last broken session and tries to revive it.

**A corpus loader.** `shvix corpus build` walks claude-mem observations matching a topic (default: OpenClaw recovery) and bakes a brain shvix queries on every call.

**A self-improving loop.** Every shvix invocation — symptom, picked runbook, did-it-work — gets logged and observed by claude-mem. Tomorrow's brain is smarter than today's.

---

## CLI surface

```
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

```
┌──────────────────────────────────────────────────────────┐
│  ~/.shvix/                                               │
│    shvix.sock         control plane                      │
│    model/             MLX weights (downloaded once)      │
│    corpora/openclaw/  claude-mem brain for the domain    │
│    history.jsonl      every recovery, classified + outcome│
└──────────────────────────────────────────────────────────┘
         ▲                ▲                  ▲
         │                │                  │
   ┌─────┴──────┐   ┌─────┴──────┐    ┌──────┴───────┐
   │ shvix      │   │ /shvix     │    │ shvix CLI    │
   │ daemon     │   │ slash cmd  │    │ (recover,    │
   │ • MLX      │   │ (inside    │    │  diagnose,   │
   │ • corpus   │   │  OpenClaw) │    │  corpus,     │
   │ • tools    │   └────────────┘    │  logs)       │
   │ • runbooks │                     └──────────────┘
   └────────────┘
```

One daemon per machine. Per-corpus brains. Recovery actions are deterministic Python, not free-form tool calls — the model picks which one to run, not how to run it.

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
npm install -g shvix
shvix corpus build --topic openclaw   # one-time, builds local brain
shvix daemon &                         # starts in the background
```

Requires:
- Apple Silicon Mac (MLX)
- Python 3.11+ with `mlx-lm`
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

- Which model. Qwen2.5-Coder-7B is the obvious starting point, but a smaller classifier might be enough.
- Corpus refresh cadence. Rebuild on every shvix invocation? Nightly? On-demand?
- Slash command transport. HTTP on localhost is simplest. Unix socket is cleaner but harder to reach from inside a sandboxed agent.
- Failure-mode taxonomy. The first runbook library is hand-written — what are the top ~10 ways OpenClaw borks itself?

---

## Status

Sketch. Reading welcome, code coming.

---

## License

MIT
