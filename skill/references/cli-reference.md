# shmerm CLI reference

Full command surface. Load this when you need flags or JSON schemas the main runbook doesn't cover.

## Global flags

- `--json` — machine-readable output. Available on every command.
- `--quiet` — suppress non-essential stderr.

## Commands

### `shmerm run [--tunnel] [--name X] [--readonly] -- <cmd>...`

Start a new durable session.

- `--tunnel` — also start a public tunnel (cloudflared, Pinggy fallback). May add 2-5s to startup.
- `--name X` — override the auto-generated session ID with a custom slug. Useful for stable cross-restart references like `--name myproject-build`.
- `--readonly` — viewers can watch but not type. Use for demos.
- `--` — separator before the wrapped command.

**Output (`--json`):**
```json
{
  "id": "crimson-otter-7f3a",
  "port": 51823,
  "token": "...",
  "lan": { "view": "http://192.168.1.42:51823/view/<token>",
           "kill": "http://192.168.1.42:51823/kill/<token>" },
  "public": { "view": "https://....trycloudflare.com/view/<token>",
              "kill": "https://....trycloudflare.com/kill/<token>",
              "provider": "cloudflared" },
  "started_at": 1745692800000
}
```

If `--tunnel` was not requested, `public` is omitted.

### `shmerm list [--json]`

List all sessions on this machine. Shows running and recently-exited (within 1h GC window).

**Output:** array of meta objects.

### `shmerm status <id> [--json]`

Single session metadata. Use the JSON form before any operation that assumes a session is alive.

**Key fields:** `status` ("running" | "exited"), `last_byte_at` (ms epoch), `cmd`, `args`, `exit_code` (if exited).

### `shmerm urls <id> [--json]`

Reprint URLs without restarting tunnel. Cheap, idempotent.

### `shmerm send <id> <text>`

Write bytes to PTY. No automatic newline — include `\r` yourself.

**Common escape sequences:**
| Need | Escape |
|---|---|
| Enter | `\r` |
| Ctrl-C | `\x03` |
| Ctrl-D | `\x04` |
| Ctrl-Z | `\x1a` |
| Esc | `\x1b` |
| Up arrow | `\x1b[A` |
| Down | `\x1b[B` |
| Right | `\x1b[C` |
| Left | `\x1b[D` |
| Tab | `\t` |

Bash `$'...'` syntax interprets these. POSIX sh does not.

### `shmerm tail <id> [--lines N] [--follow]`

Read scrollback. Default 100 lines. `--follow` streams new output to stdout (use sparingly — prefer `wait-idle` then `tail`).

### `shmerm wait-idle <id> [--quiet SECONDS] [--timeout SECONDS] [--json]`

Block until the PTY has been silent for `quiet` seconds, or `timeout` seconds elapse.

**Output (`--json`):**
```json
{ "idle_ms": 5123, "timeout": false }
```

If `timeout: true`, the tool is still emitting. Decide: wait again, or read scrollback to make progress.

### `shmerm attach <id>`

Take over the local TTY (interactive — only useful if a human runs it). Detach with `Ctrl-A D`. Agents should not call this.

### `shmerm kill <id>`

Send SIGTERM to the wrapped process. Tunnel and host process clean up.

## Inbox commands

Inbox messages flow human → agent. The web UI's "Message agent" tab writes to the inbox. The inbox is per-session, persisted in `~/.shmerminal/sessions/<id>/inbox.json`.

### `shmerm inbox <id> [--json]`

Read all undelivered messages, mark them delivered, return them.

**Output:**
```json
[
  {
    "id": "a3f9",
    "ts": 1745692950123,
    "text": "also check the staging env first",
    "source": "web",
    "delivered_at": null
  }
]
```

After this call, those messages will not appear in subsequent reads. Idempotent in that sense — re-running won't cause double-processing.

### `shmerm inbox <id> --watch [--json]`

Long-poll. Blocks until at least one new message arrives. Outputs a JSON line per delivery batch.

Use this for push-mode receivers (sidecar pattern). Don't use it as your primary inbox check; use the regular `shmerm inbox` at decision points.

### `shmerm reply <id> <msg_id> <text>`

Attach a reply to a specific human message. Visible in the web UI as a nested reply bubble.

**Output (`--json`):**
```json
{
  "id": "a3f9",
  "delivered_at": 1745692951000,
  "reply": "got it, switching gears",
  "reply_ts": 1745692952000
}
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic error (read stderr) |
| 2 | Session not found |
| 3 | Session already exited |
| 4 | shmerm host unreachable (socket closed) |
| 5 | Tunnel failure (only with `--tunnel`) |

## State directory

Per-session state lives at `~/.shmerminal/sessions/<id>/`:

| File | Contents |
|---|---|
| `meta.json` | host pid, port, token, status, timestamps |
| `host.sock` | unix socket — control plane |
| `scrollback.log` | rolling ~1MB PTY output |
| `inbox.json` | human messages with delivery state |

A session is GC'd 1 hour after it exits. Until then, you can still tail and read inbox.

## Common failure modes

- **`session exited` from `wait-idle`**: the wrapped tool exited (intentionally or crashed). Check `status` for `exit_code`.
- **`tunnel failed`**: cloudflared isn't installed or hit Cloudflare's edge. shmerm falls back to Pinggy SSH (60-min cap). LAN URLs always work.
- **PTY input swallowed**: you forgot the `\r`. Send a literal Enter.
- **`shmerm: command not found` on resume**: the user has shmerm in a non-default path. Check `command -v shmerm` before assuming it's available, fall back to `npx shmerm` if needed.
