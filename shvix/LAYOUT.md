# shvix on-disk layout

Runtime state lives under `~/.shvix/` (created on first daemon start):

```text
~/.shvix/
  daemon.pid              # pid of running python daemon, written by `shvix daemon`
  logs/
    YYYY-MM-DD.jsonl      # one line per /classify or /fix request
  corpora/
    openclaw.json         # symlink to ~/.claude-mem/corpora/openclaw.corpus.json
  config.json             # optional overrides (port, model, ollama url). Absent = defaults.
```

Model weights live in **Ollama's** cache (`~/.ollama/models/`), not under `~/.shvix/`. Ollama is the runtime; shvix is a thin proxy.

Configuration:

| Env var            | Default                       | Purpose                              |
|--------------------|-------------------------------|--------------------------------------|
| `SHVIX_PORT`       | `7749`                        | shvix daemon HTTP port               |
| `SHVIX_OLLAMA_URL` | `http://localhost:11434`      | Ollama base URL                      |
| `SHVIX_MODEL`      | `gemma4:e4b`                  | Ollama model tag (e.g. `gemma4:e2b`) |

shvix never writes to `~/.shmerminal/`, `~/.claude-mem/`, or `~/.ollama/`. The corpora symlink is read-only.
