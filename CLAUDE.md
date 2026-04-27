# shmerm — Project context for Claude Code

You are working on **shmerm**, the Durable Tool Execution CLI. This file is your standing context. Read it first.

## What shmerm is

A CLI that wraps interactive commands (like `claude code`, `aider`, `vim`, dev servers, REPLs) in detached, durable sessions that:

1. Outlive the spawning process — the wrapper exits, the wrapped command keeps running
2. Stream live to a phone-friendly web UI with a kill button
3. Optionally expose a public HTTPS URL via cloudflared (with Pinggy SSH fallback)
4. Provide an inbox channel where humans watching from their phone can message the agent driving the session, without touching the PTY directly

The project's positioning: **CLIs are how agents do work in 2026** (Claude Code, Codex, Aider, Cursor, OpenClaw all drive shells). shmerm is the durability layer for the *tools* those agents invoke — solving "session amnesia" the same way Claude-Mem solves it for conversation context.

Tagline: *terminal shmerminal! we got this.*
Aspirational name: *The Shtateful Agentic Tool Machine.*

## Repo layout

```
src/
  shmerm.ts          main wrapper (PTY + HTTP + WS + tunnel orchestration)
  sessions.ts        detached host process model + unix socket control plane + inbox
  tunnel.ts          cloudflared primary, Pinggy SSH fallback
  shmerm_agent.py    Python adapter for agents driving shmerm sessions
skill/
  SKILL.md           OpenClaw skill manifest (also works for Claude Code skills)
  references/        deep-dive docs the agent loads on demand
README.md
package.json
tsconfig.json
LICENSE              MIT
```

The architecture I want you to preserve:

- **One detached host process per session.** Not a global daemon. State at `~/.shmerminal/sessions/<id>/`.
- **Per-session state directory** with `meta.json`, `host.sock`, `scrollback.log` (rolling 1MB), `inbox.json`.
- **Token-gated URLs.** Random per-session token in the path. No accounts.
- **stderr for status, stdout untouched.** The wrapped program owns stdout.
- **Three input channels in the web UI**: Watch (read-only), Type (raw to PTY), Message agent (writes to inbox.json without touching PTY). These are tabs, not modes.
- **`wait-idle` is the load-bearing primitive** for agents — block until PTY has been quiet for N seconds.

## What's in the source files

The source files in `src/` are a working sketch — they compile and capture every architectural decision, but they need to be wired into a real CLI dispatcher. The current state:

- `shmerm.ts` is the all-in-one wrapper (single-session, foreground). This logic needs to split: the host-side bits move into `sessions.ts:runHost`, and a thin `cli.ts` dispatcher gets created to route subcommands (`run`, `list`, `attach`, `send`, `tail`, `wait-idle`, `inbox`, `reply`, `kill`, `status`, `urls`).
- `sessions.ts` defines the detached-host model and inbox primitives. The host already serves the unix control socket. It needs the HTTP/WS server from `shmerm.ts` integrated so the web UI runs from the host process, not the wrapper.
- `tunnel.ts` is solid. Don't touch unless you have a reason.
- `shmerm_agent.py` is the agent-side adapter (subprocess wrapper around the CLI). Keep it pure-stdlib.

## Your job

1. **Read** `README.md` for the public framing, then this file, then walk `src/` top to bottom.
2. **Plan** the split: write a TODO file or use the planning tool to enumerate the work.
3. **Build** the missing `src/cli.ts` dispatcher and wire the existing pieces into a real installable CLI.
4. **Test** the happy path: `shmerm run -- bash`, hit the URL on a phone, send a message, see it land.
5. **Don't** add dependencies beyond what's in `package.json` without checking with the user first. The dependency surface should stay small (`node-pty`, `ws`, that's it).

## Conventions

- TypeScript, strict mode, ESM (`"type": "module"`).
- No frameworks. No Express, no Fastify — `node:http` + `ws` only.
- No bundler. `tsc` produces `dist/`.
- Comments explain *why*, not *what*.
- Fail loudly. If a session is already running, say so. Don't silently overwrite state.
- Stderr for human-readable output. JSON to stdout when `--json` is passed.

## Style I prefer

When writing code, use dashes-not-semicolons in comments where it reads naturally. Short punchy sentences. Avoid filler. Keep architecture diagrams as ASCII in comments where they help.

When writing prose for me (commit messages, docs, error text), use the contrast-driven, matter-of-fact style from the README. Short paragraphs. Strong verbs. No marketing tone.

## What we're NOT building

- Not a tmux replacement. tmux is for humans; shmerm is for agents who sometimes hand off to humans.
- Not a hosted service. Local-first. No accounts. No telemetry.
- Not a multi-agent orchestrator. One session = one wrapped command. Composition happens above us.
- Not a tunnel provider. We just spawn cloudflared and parse its URL.

## Stop conditions

- If you're about to add a dependency, ask first.
- If you're about to introduce a global daemon or a config schema bigger than `meta.json`, ask first.
- If you're about to rewrite something marked "load-bearing" in this file or in `README.md`, ask first.
