<div align="center">

# `shmerm`

**Durable terminal sessions agents and humans share, one turn at a time.**

[![npm](https://img.shields.io/npm/v/shmerm.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/shmerm)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-18%2B-brightgreen.svg?style=flat-square)](#install)
[![status](https://img.shields.io/badge/status-early-orange.svg?style=flat-square)](#status)

<sub><i>The Shtateful Agentic Tool Machine. terminal shmerminal! we got this.</i></sub>

</div>

---

## 60 seconds

```bash
$ shmerm run -- python
id: dusty-fern-9c1a    url: https://gentle-piano.trycloudflare.com/view/<token>

# turn 1 — load a dataframe
$ shmerm send dusty-fern-9c1a $'import pandas as pd; df = pd.read_csv("sales.csv")\r'
$ shmerm wait-idle dusty-fern-9c1a

# turn 2 — query it. (the dataframe is still there.)
$ shmerm send dusty-fern-9c1a $'df.shape\r'
$ shmerm wait-idle dusty-fern-9c1a
$ shmerm tail dusty-fern-9c1a --lines 2
(48291, 12)
>>>
```

> [!NOTE]
> Same Python process. Four separate shell invocations. The dataframe survives between commands because the PTY is alive between commands. Open the URL on your phone to watch it live. The session keeps running after every terminal you have is closed.

---

## How it works

Inputs arrive one at a time. Anyone holding the session ID can take the next turn — an agent, a shell script, you on your phone. The PTY doesn't know the difference.

```
   Time ─────────────────────────────────────────────────────▶

      ┌────────── one long-lived session (PTY alive) ──────────┐
      │                                                        │
 agent ─ shmerm send "step 1" ──▶│                             │
                                 │ ◀── tool prints output ──   │
 agent ─ shmerm wait-idle ──────▶│ ◀── (5s of quiet) ───       │
 agent ─ shmerm tail ───────────▶│ ◀── reads scrollback ──     │
                                 │                             │
 human ─ web UI: Message agent ─▶│   (lands in inbox)          │
 agent ─ shmerm inbox ──────────▶│ ◀── sees the message ──     │
                                 │                             │
 agent ─ shmerm send "step 2" ──▶│                             │
                                 │ ◀── more output ──          │
 human ─ web UI: Type tab ──────▶│   (raw keystrokes)          │
      └────────────────────────────────────────────────────────┘

      [ the agent's process can die and respawn anywhere on the X axis ]
      [ the session keeps running                                      ]
```

Three properties make it work:

- **Detached.** The session lives in its own host process, owns its own PTY, outlives whoever started it. Crashes, sleeps, context resets — the tool keeps its place.
- **Explicit turns.** `shmerm send` is a discrete event, not a typing stream. Agents reason about one move at a time, send it, read what happened. So can humans. The next driver picks up where the last one left off — they just need the session ID.
- **Idle-aware reads.** `shmerm wait-idle` blocks until the tool has been quiet for N seconds. Better signal than scraping for prompt strings. Robust to slow output. Race-free.

---

## Not a tmux

|                                           | `nohup` | `screen` | `tmux` | `shmerm` |
| ----------------------------------------- | :-----: | :------: | :----: | :------: |
| Survives the launching shell exiting      |    ✓    |    ✓     |   ✓    |    ✓     |
| Live web UI, phone-friendly               |         |          |        |    ✓     |
| Public HTTPS URL with one flag            |         |          |        |    ✓     |
| One-shot CLI per turn (no attach required)|         |          |        |    ✓     |
| `wait-idle` primitive for agents          |         |          |        |    ✓     |
| Inbox channel separate from the keyboard  |         |          |        |    ✓     |

> [!TIP]
> tmux is for humans. shmerm is for agents who sometimes hand off to humans.

---

## Why this exists

Agents do real work through CLIs now. Claude Code, Codex, Aider, Cursor — every coding agent worth using drives a shell. But the tools agents invoke have state, and CLIs are stateless from the agent's perspective. Every command is fire-and-forget; any state inside a long-running tool dies the moment the agent's context window clears or its process restarts.

Three problems shmerm ends:

- **Sessions die when the agent's process exits.** Every restart was a cold start. Now the session outlives the agent.
- **There's no way to watch.** The middle was a black box. Now the live terminal streams to a phone-friendly web UI with a kill button always one tap away.
- **There's no way to gently steer.** You either Ctrl-C'd and started over, or you didn't intervene at all. Now the human watching from their phone has a separate channel — an inbox the agent reads on its next poll. No keyboard fight.

Local-first. Install with npm. No service to operate, no account to create.

---

## The agent loop

The shape is always the same: send, wait for quiet, read, decide, send again.

```
        ┌────────────────────────────────────────────┐
        ▼                                            │
   ┌─────────┐    ┌──────────────┐    ┌──────────┐   │
   │  send   │──▶ │  wait-idle   │──▶ │   tail   │   │
   │ (turn)  │    │ (PTY quiet)  │    │ (output) │   │
   └─────────┘    └──────────────┘    └──────────┘   │
                                            │        │
                                            ▼        │
                                      ┌──────────┐   │
                                      │  inbox   │   │  any human
                                      │  check   │   │  message?
                                      └──────────┘   │
                                            │        │
                                            ▼        │
                                      ┌──────────┐   │
                                      │  decide  │───┘
                                      │ next move│
                                      └──────────┘
```

Five lines of bash:

```bash
ID=$(shmerm run --tunnel --json claude code | jq -r .id)
shmerm send  $ID $'refactor src/auth.ts to use the sessions module\r'

while shmerm status $ID --json | jq -e '.status == "running"' > /dev/null; do
  shmerm wait-idle $ID --quiet 5 --timeout 600
  msgs=$(shmerm inbox $ID)               # any human interjections?
  [ "$msgs" != "[]" ] && handle "$msgs"
  decide_next_action_and_send $ID
done
```

The loop above can be killed and restarted by a different process at any iteration. The session doesn't notice.

---

## The mobile UI

Three tabs. Not modes you forget you're in — physical tabs you tap.

| Tab               | What it does                              | Touches PTY?           |
| ----------------- | ----------------------------------------- | ---------------------- |
| **Watch**         | Read-only stream                          | No                     |
| **Type**          | Send keystrokes directly to the terminal  | Yes — bypasses agent   |
| **Message agent** | Sends a message to the agent's inbox      | No                     |

Pending messages render grey. When the agent reads them, they turn green. If the agent calls `shmerm reply`, a reply bubble appears underneath. The UI keeps the human aware of whether their interjection actually landed.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  ~/.shmerminal/sessions/crimson-otter-7f3a/             │
│    meta.json        host pid, port, token, status       │
│    host.sock        unix socket — control plane         │
│    scrollback.log   PTY output (rolling ~1MB)           │
│    inbox.json       human → agent messages              │
└─────────────────────────────────────────────────────────┘
         ▲                ▲                  ▲
         │                │                  │
   ┌─────┴─────┐    ┌─────┴──────┐    ┌──────┴───────┐
   │ host proc │    │ shmerm CLI │    │ web viewer   │
   │ (detached)│    │ (any agent)│    │ (any phone)  │
   │  • PTY    │    │  send/tail │    │  watch/type/ │
   │  • HTTP   │    │  inbox/    │    │  message     │
   │  • WS     │    │  wait-idle │    │              │
   │  • tunnel │    └────────────┘    └──────────────┘
   └───────────┘
```

Per-session host processes, not a global daemon. Killing a session is local; one crashing host doesn't take others down.

PTY is the first backend. Browser sessions, Jupyter kernels, and MCP servers are natural next ones — same session model, same inbox, same web viewer, different bytes.

---

## Install

```bash
npm install -g shmerm
# optional but recommended for public tunnels:
brew install cloudflared          # macOS
# or apt install cloudflared       # debian/ubuntu
```

<sub>Requires Node 18+. Works under Bun. PTY support via <code>node-pty</code>.</sub>

---

<details>
<summary><b>CLI reference</b> — every command and flag</summary>

```
shmerm run [--tunnel] [--name X] <cmd>...     start a session
shmerm list                                    active sessions
shmerm attach <id>                             take over (Ctrl-A D to detach)
shmerm urls <id>                               reprint URLs
shmerm send <id> <text>                        write keystrokes to PTY
shmerm tail <id> [--lines 100]                 read scrollback
shmerm wait-idle <id> [--quiet 5]              block until PTY quiet
shmerm status <id>                             json metadata
shmerm kill <id>

# agent-only inbox commands
shmerm inbox <id>                              read pending, mark delivered
shmerm inbox <id> --watch                      long-poll for new messages
shmerm reply <id> <msg_id> "..."               attach a reply
```

All commands accept `--json` for machine consumption.

</details>

---

## Status

Early. The substrate works; the surface area is still moving. Issues, ideas, and pull requests welcome.

## License

MIT
