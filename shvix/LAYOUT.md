# shvix on-disk layout

Runtime state lives under `~/.shvix/` (created on first daemon start):

```
~/.shvix/
  daemon.pid              # pid of running python daemon, written by `shvix daemon`
  logs/
    YYYY-MM-DD.jsonl      # one line per /classify or /fix request
  model/                  # reserved for future local model artifacts; HF cache stays in ~/.cache/huggingface
  corpora/
    openclaw.json         # symlink to ~/.claude-mem/corpora/openclaw.corpus.json
  config.json             # optional overrides (port, model id). Absent = defaults.
```

Daemon HTTP port: **7749**. Override via `SHVIX_PORT`.

Default model: `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit`. Override via `SHVIX_MODEL`.

shvix never writes to `~/.shmerminal/` or `~/.claude-mem/`. The corpora symlink is read-only.
