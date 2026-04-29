# shmerm CLI reference

Full command surface. Load this when you need flags or JSON schemas the main runbook doesn't cover.

## Output discipline

Stderr carries human-readable lines. Stdout carries JSON (when `--json` is passed) or PTY pass-through (`attach`, `tail`). `--json` is supported on `run`, `list`, `status`, `inbox`, and `wait-idle`. The other commands print to stderr only.

## Commands

### `shmerm run [--tunnel] [--json] -- <cmd> [args...]`

Start a new durable session. The wrapper exits as soon as the host has bound its HTTP port; the host process keeps running.

- `--tunnel` — also start a public tunnel (cloudflared, Pinggy fallback). Adds 5–15s to startup because `run` blocks until `public_url` is written. If the tunnel never reports, the session still returns; a warning is printed.
- `--` — separator before the wrapped command. Required when the wrapped command has its own flags (`shmerm run -- bash --login`); optional when the first non-flag arg is the command.

**Output (`--json`):**
```json
{
  "id": "crimson-otter-7f3a",
  "port": 51823,
  "token": "<32 hex chars>",
  "view_url": "http://127.0.0.1:51823/view/<token>",
  "kill_url": "http://127.0.0.1:51823/kill/<token>",
  "public_url": "https://gentle-piano.trycloudflare.com"
}
```

`public_url` is `null` when `--tunnel` was not requested or the tunnel failed to come up. To build the public view URL, append `/view/<token>` yourself.

### `shmerm list [--json]`

List all sessions on this machine. Shows running and recently-exited (within the 1h GC window).

**Output (`--json`):** array of meta objects (see `status` for the schema).

### `shmerm status <id> [--json]`

Single session metadata. Use the JSON form before any operation that assumes a session is alive.

**Output (`--json`):**
```json
{
  "id": "crimson-otter-7f3a",
  "cmd": "bash",
  "args": [],
  "cwd": "/Users/me/proj",
  "pid": 12345,
  "child_pid": 12346,
  "started_at": 1745692800000,
  "last_byte_at": 1745692911234,
  "port": 51823,
  "token": "<32 hex chars>",
  "public_url": "https://....trycloudflare.com",
  "status": "running",
  "exit_code": 0
}
```

`status` is `"running"` or `"exited"`. `exit_code` is only meaningful when exited.

### `shmerm urls <id>`

Reprint the local, LAN, and (when present) public view + kill URLs for a session. Output is human-readable, on stderr, one URL per line. There is no `--json` form — read `status --json` if you need the raw `port` / `token` / `public_url` fields.

### `shmerm send <id> <text> [--enter]`

Write `text` to the PTY. With `--enter`, append `\r` (Enter) so the receiving program runs the line. Without it, `text` is sent verbatim — useful for sending escape sequences or building up a line in pieces.

**Common escape sequences (use bash `$'...'` syntax to interpret):**
| Need | Escape |
|---|---|
| Enter | `\r` (or just pass `--enter`) |
| Ctrl-C | `\x03` |
| Ctrl-D | `\x04` |
| Ctrl-Z | `\x1a` |
| Esc | `\x1b` |
| Up arrow | `\x1b[A` |
| Down | `\x1b[B` |
| Right | `\x1b[C` |
| Left | `\x1b[D` |
| Tab | `\t` |

### `shmerm tail <id> [--lines N]`

Read scrollback. Default 100 lines. Output is plain text on stdout — no framing, no JSON.

### `shmerm wait-idle <id> [--quiet-ms N] [--timeout-ms N] [--json]`

Block until the PTY has been silent for `--quiet-ms` milliseconds, or `--timeout-ms` milliseconds elapse, whichever comes first.

Defaults: `--quiet-ms 5000`, `--timeout-ms 120000`.

**Output (`--json`):**
```json
{ "type": "idle", "idle_ms": 5123, "timeout": false }
```

When the timeout fires, `timeout: true` and the wrapper exits with code 1. The default human-readable form prints `idle (idle_ms=5123)` or `timeout (idle_ms=120000)` to stderr.

### `shmerm attach <id>`

Take over the local TTY interactively. Stdin is forwarded to the PTY raw; PTY output goes to stdout. **Detach with Ctrl-]** (the byte `0x1d`). Resize events follow the local terminal.

Agents should not call this — use `send` + `wait-idle` + `tail` instead.

### `shmerm kill <id>`

Send SIGTERM to the wrapped process. The host stays alive for 1h after exit so you can still `tail` and read `inbox`, then GC's the directory.

## Inbox commands

Inbox messages flow human → agent. The web UI's "Message agent" tab writes to the inbox. The inbox is per-session, persisted in `~/.shmerminal/sessions/<id>/inbox.json`.

Inbox writes are serialized per session via an in-process lock, so concurrent `inbox_send` / `inbox_read` / `inbox_reply` calls won't last-writer-win.

### `shmerm inbox <id> [--json]`

Read all undelivered messages, mark them delivered, return them.

**Output (`--json`):**
```json
[
  {
    "id": "a3f9",
    "ts": 1745692950123,
    "text": "also check the staging env first",
    "source": "web",
    "delivered_at": 1745692951000
  }
]
```

After this call, those messages will not appear in subsequent reads.

### `shmerm inbox <id> --watch [--json]`

Long-poll. Streams `{type:"inbox", msgs}` frames as new messages arrive. Stay-open until SIGINT. Use this for push-mode receivers; use plain `shmerm inbox` at decision points.

### `shmerm reply <id> <msg_id> <text>`

Attach a reply to a specific human message. Visible in the web UI as a nested reply bubble. Replies broadcast to all connected web clients in real time.

## Exit codes

The CLI uses a small set:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic error (message on stderr); also returned by `wait-idle` on timeout |
| 2 | Usage error (unknown subcommand, missing required argument) |

Specific failures (session not found, host unreachable) surface as `error: ...` on stderr with exit 1.

## State directory

Per-session state lives at `~/.shmerminal/sessions/<id>/`:

| File | Contents |
|---|---|
| `meta.json` | host pid, port, token, status, timestamps, optional public_url |
| `host.sock` | unix socket — control plane |
| `scrollback.log` | rolling ~1MB PTY output |
| `inbox.json` | human messages with delivery state |

A session directory is removed 1 hour after the wrapped process exits. Until then, you can still `tail` and read `inbox`.

## Common failure modes

- **`session exited` while you were waiting**: the wrapped tool exited (intentionally or crashed). Check `status` for `exit_code`.
- **`tunnel requested but no public URL`**: cloudflared isn't installed or hit Cloudflare's edge, and the SSH/Pinggy fallback didn't come up. The session still works on LAN.
- **PTY input swallowed**: you forgot the Enter. Use `--enter` or include `\r` in the text.
- **`shmerm: command not found` on resume**: the user has shmerm in a non-default path. Check `command -v shmerm` before assuming it's available, or fall back to `npx shmerm`.
