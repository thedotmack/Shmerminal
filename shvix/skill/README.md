# shvix skill — `/shvix <symptom>`

Forwards a symptom to the local shvix daemon (`http://localhost:7749/fix`)
and reports the daemon's verdict. The skill is a thin dispatcher; all
classification and recovery logic lives in the daemon.

## Install (user skill)

Symlink this directory into your Claude / OpenClaw skills path:

```bash
ln -s "$(pwd)/shvix/skill" ~/.claude/skills/shvix
```

Then `/shvix the terminal is stuck` from any Claude Code or OpenClaw session.

## Install (plugin)

The plugin manifest at `shvix/.claude-plugin/plugin.json` describes the
package. Install via your harness's plugin loader, pointing it at the
repo root.

## Prerequisite

The daemon must be running. Start it once per machine:

```bash
shvix daemon
```

If the daemon is down, the skill will tell the user to start it — it does
not fall back to ad-hoc fixes.
