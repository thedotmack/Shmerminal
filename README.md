# shmerm

**Durable Tool Execution CLI.**
*The Shtateful Agentic Tool Machine.*
*terminal shmerminal! we got this.*

---

shmerm makes the tools your agents drive — terminals, browsers, kernels, anything stateful — survive crashes, restarts, agent context resets, and your laptop closing. Wrap any interactive command. Get a session ID. Hand it to an agent. Watch from your phone. Walk away. Come back hours later and pick up exactly where you left off.

```bash
shmerm run --tunnel claude code
# 🔗 view  https://gentle-piano-supplies-fork.trycloudflare.com/view/<token>
# 💀 kill  https://gentle-piano-supplies-fork.trycloudflare.com/kill/<token>
# id: crimson-otter-7f3a
```

That URL works on your phone. The session keeps running after you close the terminal.

---

## Why this exists

Agents do real work through CLIs now. Claude Code, Codex, Aider, Cursor, every coding agent worth using drives a shell. The CLI is the native interface for agent-tool interaction — composable, observable, Unix-shaped, and already understood by the LLMs running them.

But the tools agents invoke have state, and CLIs are stateless from the agent's perspective. Every command is fire-and-forget. Any state inside a long-running tool — a build cache, a debugger session, an open editor, a half-finished refactor — dies the moment the agent's context window clears or its process restarts.

shmerm closes that gap. Local-first, install-with-npm, no service to operate, no account to create.

Three concrete problems it ends:

**Sessions die when the agent's process exits.** Every restart is a cold start. shmerm runs each tool session in a detached host process that outlives whatever spawned it.

**There's no way to watch.** The agent runs. You hope. When it finishes you read the diff. The middle is a black box. shmerm streams the live terminal to a phone-friendly web UI with a kill button.

**There's no way to gently steer.** You either Ctrl-C and start over, or you don't intervene at all. shmerm gives the human watching from their phone a separate channel — an inbox the agent reads on its next poll. No keyboard fight.

---

## What you get

**A wrapper.** Your interactive command runs as normal in your terminal. Nothing changes locally.

**A web viewer.** Streams the same bytes to a phone-friendly page. Three tabs at the bottom: Watch, Type, Message agent. The kill button is always one tap away.

**A public tunnel.** Optional `--tunnel` flag spawns a free Cloudflare quick tunnel. cloudflared first, Pinggy SSH fallback. No accounts, no signups.

**Persistent sessions.** Detached host process per session. State at `~/.shmerminal/sessions/<id>/`. The wrapper exiting doesn't kill anything.

**An agent inbox.** A human watching from their phone can send messages to the *agent* (not the PTY). The agent reads them on its next poll. Replies are optional and visible in the UI.

---

## The agent loop

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

`wait-idle` is the primitive that makes this work. It blocks until the PTY has been quiet for N seconds — a far better signal than scraping stdout for prompt strings.

---

## The mobile UI

Three tabs. Not modes you forget you're in; physical tabs you tap.

| Tab | What it does | Touches PTY? |
|---|---|---|
| **Watch** | Read-only stream | No |
| **Type** | Send keystrokes directly to the terminal | Yes — bypasses agent |
| **Message agent** | Sends a message to the agent's inbox | No |

Pending messages render grey. When the agent reads them, they turn green. If the agent calls `shmerm reply`, a reply bubble appears underneath. The UI keeps the human aware of whether their interjection actually landed.

---

## CLI surface

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

Requires Node 18+. Works under Bun. PTY support via `node-pty`.

---

## Status

Early. The substrate works; the surface area is still moving. Issues, ideas, and pull requests welcome.

---

## License

MIT
