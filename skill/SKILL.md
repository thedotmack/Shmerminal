---
name: shmerm
description: Run interactive CLI tools (claude code, aider, codex, dev servers, builds, REPLs, debuggers — anything PTY-based) inside durable sessions that survive across turns, agent restarts, and laptop closings. Use this skill when (1) you need to run anything interactive that takes more than a few seconds, (2) state must persist between turns (a build cache, an open editor, a paused debugger, an in-progress refactor), (3) the user wants to monitor or interject from their phone, (4) you want to run multiple parallel tool sessions you can return to later, or (5) the user explicitly asks for a "shmerm session", "durable session", "background session", or "session I can watch". Provides session lifecycle (run/list/attach/kill), a live web viewer with kill button, optional public tunnel, and an inbox channel for human interjections that arrive while you are working.
metadata.openclaw: '{"requires": {"bins": ["shmerm"]}, "emoji": "🦞", "install": [{"id": "npm", "kind": "npm", "package": "shmerm", "bins": ["shmerm"], "label": "Install shmerm CLI (npm)"}]}'
---

# shmerm

Durable Tool Execution. You drive the session via CLI; the user watches and steers from their phone.

The session outlives you. Every time you spawn a long-running tool, you get a session ID. Save it. Use it. Look for it on resume. Don't create duplicate sessions.

## The lifecycle, top to bottom

### 1. Resume or create

Always check for an existing session before creating a new one. The user's state file is at `<workspace>/.shmerm-state.json`.

```bash
# resume path
if [ -f .shmerm-state.json ]; then
  ID=$(jq -r .session_id .shmerm-state.json)
  if shmerm status "$ID" --json | jq -e '.status == "running"' > /dev/null 2>&1; then
    # resume: get current state
    shmerm tail "$ID" --lines 200       # learn what happened while you were gone
    shmerm inbox "$ID" --json           # drain anything the user sent
    # → continue from here
  fi
fi

# create path (no existing session, or it exited)
ID=$(shmerm run --tunnel --json -- <command> | jq -r .id)
echo "{\"session_id\": \"$ID\", \"task\": \"<what you're doing>\"}" > .shmerm-state.json
```

If the user wants to share the URL with someone else, run `shmerm urls "$ID"` to print both LAN and public tunnel URLs. **Never paste the kill URL into chat without asking** — it's a one-click destroy button.

### 2. Send work

`shmerm send` writes raw bytes to the PTY. End every command with `\r` to actually run it. Use proper escape codes for control keys:

```bash
shmerm send "$ID" $'ls -la\r'              # Enter
shmerm send "$ID" $'\x03'                   # Ctrl-C (interrupt)
shmerm send "$ID" $'\x04'                   # Ctrl-D (EOF)
shmerm send "$ID" $'\x1b[A'                 # Up arrow
```

For multi-line input or large pasted blobs, write a heredoc to a temp file and `cat` it through, or use `shmerm send` repeatedly — there is no length limit, but the PTY's input buffer might be.

### 3. Wait for the tool to settle

Do not poll `shmerm tail` in a tight loop. Use `wait-idle`:

```bash
shmerm wait-idle "$ID" --quiet-ms 5000 --timeout-ms 600000 --json
```

This blocks until the PTY has emitted no output for 5 seconds, or 600 seconds elapses. The defaults are correct for most tools (claude code, aider, builds). Lower the quiet window for chatty tools (5000 → 2000). Raise it for tools that pause then resume (5000 → 10000). Both flags are milliseconds.

If the response includes `"timeout": true`, the tool is still working. Either wait again or read scrollback to assess progress.

### 4. Read state

```bash
shmerm tail "$ID" --lines 100               # last N lines, plain text
```

Don't tail more than ~500 lines per call. If you need more history, the user wants you to summarize, not regurgitate.

### 5. Check the inbox — every meaningful turn

**This is the most important pattern in this skill.** The user can message you from their phone web UI. Those messages do not land in your context automatically. You must read them.

```bash
shmerm inbox "$ID" --json
```

Returns a JSON array of pending messages. Each message has `id`, `text`, `ts`. Do this:

1. Drain the inbox before any significant decision (next LLM turn, next tool send, next plan-revision).
2. For each message, treat it as **higher priority than your current plan**. The human typed it specifically to redirect or augment what you're doing.
3. Decide: does this change my plan? Does it just add context? Is it a question I should answer?
4. Optionally close the loop with a reply:
   ```bash
   shmerm reply "$ID" "<msg_id>" "got it, switching to staging first"
   ```
   The user sees this in the web UI as a reply bubble under their message. Use it for nontrivial acknowledgments only — don't reply "ok" to every message.

**Do not skip inbox checks just because you are in a hurry.** A user who messages from their phone has waited longer than you have. Their message is the most relevant input you will receive on this turn.

### 6. End the session

When the work is genuinely done — not paused, not waiting, *done*:

```bash
shmerm kill "$ID"
rm .shmerm-state.json
```

Do not kill sessions just because you are ending a turn. The whole point is they outlive you. Kill only when the underlying task is complete or the user explicitly asks you to stop.

## When *not* to use this skill

- Single short commands that finish in under 2 seconds (`ls`, `cat`, `git status`). Just use the bash tool.
- Read-only reconnaissance where state doesn't matter. `find`, `grep`, `cat /etc/...`. Bash tool.
- Pure file edits with no execution. Use file tools.
- One-shot CLI invocations that produce output and exit. Bash tool.

If the command is "run X and tell me when it's done," and X takes <10 seconds, just run it directly.

## When to *definitely* use this skill

- Anything `claude code`, `codex`, `aider`, `cursor` — these are interactive agents that need their own session.
- Long builds, test runs, deployments where the user might want to watch.
- REPLs, notebooks, debuggers, anything stateful where losing state means starting over.
- Dev servers (`npm run dev`, `vite`, `next dev`) — the user wants to keep them running and see logs.
- Anything where the user has said "watch this" or "let me know when it's done" or "send me the URL."

## Patterns

### Driving claude code from inside OpenClaw

```bash
ID=$(shmerm run --tunnel --json -- claude code | jq -r .id)
echo "{\"session_id\": \"$ID\"}" > .shmerm-state.json
shmerm send "$ID" $'<the user request, escaped>\r'

while shmerm status "$ID" --json | jq -e '.status == "running"' >/dev/null; do
  shmerm wait-idle "$ID" --quiet-ms 8000 --timeout-ms 900000 --json

  # human interjections (highest priority)
  msgs=$(shmerm inbox "$ID" --json)
  if [ "$msgs" != "[]" ] && [ -n "$msgs" ]; then
    # incorporate into your reasoning, then forward to claude code:
    text=$(echo "$msgs" | jq -r '.[].text' | head -c 2000)
    shmerm send "$ID" "$(printf '%s\r' "$text")"
  fi

  # decide: are we done?
  out=$(shmerm tail "$ID" --lines 50)
  # → reason about $out, decide next action
done
```

### Sharing the live view with the user

```bash
PUB=$(shmerm status "$ID" --json | jq -r '.public_url // empty')
TOK=$(shmerm status "$ID" --json | jq -r '.token')
[ -n "$PUB" ] && echo "$PUB/view/$TOK"
# echoes: https://gentle-piano-supplies-fork.trycloudflare.com/view/<token>
```

Send that URL through the user's preferred channel (the OpenClaw messaging integration). Do not send the kill URL unless they explicitly asked for a kill switch. `shmerm urls "$ID"` prints all the URLs (local, lan, public, plus their kill counterparts) to stderr in human-readable form.

### Recovering from a crash

If your OpenClaw process restarts mid-task, the next turn you take should be:

1. Look for `.shmerm-state.json`.
2. If present, run the resume path above.
3. If the session is still running, drain inbox and tail to learn what the user said while you were gone.
4. If the session has exited, surface the exit code and last 100 lines to the user before deciding what to do next.

## References

- **Full CLI reference**: see `references/cli-reference.md` (full command surface, all flags, JSON output schemas)
- **Inbox protocol details**: see `references/inbox-protocol.md` (delivery semantics, reply timing, multi-message handling)

Read those only when you actually need them. The runbook above covers 90% of cases.

## Stop conditions (safety)

- If a `shmerm` command returns non-zero exit, do not retry blindly. Check `shmerm status` first.
- If `shmerm list` shows more than 5 sessions you started, stop creating new ones — list them to the user and ask which to clean up.
- Never run `shmerm run` without a state file write. Orphaned sessions are how phone-watching users lose track of what their agent is doing.
- The kill URL is destructive and unauthenticated beyond the token. Treat it like an API key. Print to user only when they explicitly want a remote kill switch.
