---
name: shvix
description: Diagnose and recover wedged shmerminal/openclaw sessions via the local shvix daemon. Use when the user reports a stuck terminal, frozen PTY, lockfile, port conflict, or corrupted session state.
allowed-tools: Bash
---

The user's symptom: $ARGUMENTS
Active session id: ${CLAUDE_SESSION_ID}

shvix is the recovery agent. Your job is to forward the symptom to the local
shvix daemon and report its response verbatim. Do not attempt to diagnose or
fix the issue yourself — the daemon owns classification and runbook execution.

Run exactly this Bash block:

```bash
payload=$(jq -nc --arg s "$ARGUMENTS" --arg sid "$CLAUDE_SESSION_ID" \
  '{symptom: $s, context: {session_id: $sid}}')
curl -sS --fail-with-body \
  -X POST http://localhost:7749/fix \
  -H 'content-type: application/json' \
  -d "$payload"
```

Then:

- On success: print the JSON response verbatim. The daemon's `message` field is
  the human-facing summary; `action_taken` is the runbook that ran;
  `requires_human: true` means a human must take the next step.
- On `curl` failure (connection refused, non-2xx, etc.): tell the user the
  shvix daemon is not running and instruct them to start it with
  `shvix daemon` in another terminal, then re-run `/shvix <symptom>`.
  Do not retry. Do not try to fix the underlying issue without the daemon.
- If `classification` is `"unknown"`: report it and stop. Do not guess a
  runbook. Human intervention is the correct outcome.
