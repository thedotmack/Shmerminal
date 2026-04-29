#!/usr/bin/env node
/**
 * cli.ts — the `shmerm` dispatcher.
 *
 * Hand-rolled arg parsing — small surface, no commander/yargs. Every
 * subcommand routes to a primitive in sessions.ts. stderr carries human
 * prose; stdout is reserved for PTY pass-through, JSON, or scrollback.
 */

import {
  startSession,
  listSessions,
  send as sendInput,
  tail as tailScrollback,
  kill as killSession,
  waitIdle,
  readInbox,
  replyInbox,
  lanIp,
  type Meta,
  type InboxMsg,
} from "./sessions.js";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";

// ── shared helpers ────────────────────────────────────────────────────────

const ROOT = path.join(os.homedir(), ".shmerminal", "sessions");
const metaPath = (id: string) => path.join(ROOT, id, "meta.json");
const sockPath = (id: string) => path.join(ROOT, id, "host.sock");

async function readMeta(id: string): Promise<Meta> {
  return JSON.parse(await fsp.readFile(metaPath(id), "utf8"));
}

function die(msg: string, code = 1): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}
function takeOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined) die(`${name} requires a value`);
  args.splice(i, 2);
  return v;
}

function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 1000) return `${d}ms`;
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

// ── run ──────────────────────────────────────────────────────────────────

async function cmdRun(args: string[]) {
  // Split on `--` BEFORE flag parsing so flags meant for the wrapped command
  // aren't eaten by takeFlag. e.g. `shmerm run -- bash --tunnel` should
  // pass `--tunnel` to bash, not toggle our tunnel flag.
  const dashIdx = args.indexOf("--");
  const cliArgs = dashIdx >= 0 ? args.slice(0, dashIdx) : args;
  const childArgs = dashIdx >= 0 ? args.slice(dashIdx + 1) : [];

  const tunnel = takeFlag(cliArgs, "--tunnel");
  const json = takeFlag(cliArgs, "--json");

  let cmd: string | undefined;
  let cmdArgs: string[] = [];
  if (dashIdx >= 0) {
    cmd = childArgs[0];
    cmdArgs = childArgs.slice(1);
  } else {
    cmd = cliArgs[0];
    cmdArgs = cliArgs.slice(1);
  }
  if (!cmd) die("usage: shmerm run [--tunnel] [--json] -- <cmd> [args...]");

  if (tunnel) process.env.SHMERM_TUNNEL = "1";

  // startSession blocks until the host has bound its HTTP port, so meta
  // already has a real port and (when --tunnel) a public_url.
  const meta = await startSession(cmd, cmdArgs);

  const lan = lanIp();
  const localView = `http://127.0.0.1:${meta.port}/view/${meta.token}`;
  const localKill = `http://127.0.0.1:${meta.port}/kill/${meta.token}`;
  const lanView   = `http://${lan}:${meta.port}/view/${meta.token}`;

  if (json) {
    const out = {
      id: meta.id,
      port: meta.port,
      token: meta.token,
      view_url: localView,
      kill_url: localKill,
      public_url: meta.public_url ?? null,
    };
    process.stdout.write(JSON.stringify(out) + "\n");
    return;
  }

  process.stderr.write(`shmerm session ${meta.id}\n`);
  process.stderr.write(`  view  ${localView}\n`);
  if (lan !== "localhost") process.stderr.write(`  lan   ${lanView}\n`);
  if (tunnel && !meta.public_url) {
    process.stderr.write(`  (tunnel requested but no public URL — start cloudflared/ssh and retry)\n`);
  }
  process.stderr.write(`  kill  ${localKill}\n`);
  if (meta.public_url) process.stderr.write(`  public ${meta.public_url}/view/${meta.token}\n`);
}

// ── list ─────────────────────────────────────────────────────────────────

async function cmdList(args: string[]) {
  const json = takeFlag(args, "--json");
  const sessions = await listSessions();

  if (json) {
    process.stdout.write(JSON.stringify(sessions) + "\n");
    return;
  }

  if (!sessions.length) {
    process.stderr.write("(no sessions)\n");
    return;
  }

  const rows = sessions.map(s => ({
    id: s.id,
    status: s.status,
    cmd: [s.cmd, ...s.args].join(" "),
    started: relTime(s.started_at),
    idle: relTime(s.last_byte_at),
  }));
  const widths = {
    id: Math.max(2, ...rows.map(r => r.id.length)),
    status: Math.max(6, ...rows.map(r => r.status.length)),
    cmd: Math.max(3, ...rows.map(r => r.cmd.length)),
    started: Math.max(7, ...rows.map(r => r.started.length)),
    idle: Math.max(4, ...rows.map(r => r.idle.length)),
  };
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  process.stderr.write(
    `${pad("ID", widths.id)}  ${pad("STATUS", widths.status)}  ${pad("CMD", widths.cmd)}  ${pad("STARTED", widths.started)}  ${pad("IDLE", widths.idle)}\n`
  );
  for (const r of rows) {
    process.stderr.write(
      `${pad(r.id, widths.id)}  ${pad(r.status, widths.status)}  ${pad(r.cmd, widths.cmd)}  ${pad(r.started, widths.started)}  ${pad(r.idle, widths.idle)}\n`
    );
  }
}

// ── attach ───────────────────────────────────────────────────────────────

async function cmdAttach(args: string[]) {
  const id = args[0];
  if (!id) die("usage: shmerm attach <id>");

  const sock = net.createConnection(sockPath(id));
  let buf = "";

  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });

  sock.write(JSON.stringify({ op: "attach" }) + "\n");

  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  const cleanup = (code: number, note?: string) => {
    try { sock.end(); } catch {}
    try { if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false); } catch {}
    process.stdin.pause();
    if (note) process.stderr.write(note);
    process.exit(code);
  };

  // Forward stdin → PTY; intercept Ctrl-] (0x1d) as detach.
  process.stdin.on("data", (chunk: Buffer) => {
    const detachIdx = chunk.indexOf(0x1d);
    if (detachIdx >= 0) {
      // Forward anything before the detach byte, then leave.
      if (detachIdx > 0) {
        const before = chunk.subarray(0, detachIdx).toString("binary");
        sock.write(JSON.stringify({ op: "input", data: before }) + "\n");
      }
      cleanup(0, "\n[detached]\n");
      return;
    }
    sock.write(JSON.stringify({ op: "input", data: chunk.toString("binary") }) + "\n");
  });

  // Resize on terminal resize.
  const onResize = () => {
    const cols = (process.stdout as any).columns ?? 80;
    const rows = (process.stdout as any).rows ?? 24;
    try { sock.write(JSON.stringify({ op: "resize", cols, rows }) + "\n"); } catch {}
  };
  process.stdout.on("resize", onResize);
  onResize();

  sock.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let frame: any;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type === "out" && typeof frame.data === "string") {
        process.stdout.write(frame.data);
      } else if (frame.type === "exit") {
        cleanup(frame.code ?? 0);
      }
    }
  });
  sock.on("close", () => cleanup(0));
  sock.on("error", (e) => { process.stderr.write(`socket error: ${e.message}\n`); cleanup(1); });
}

// ── send ─────────────────────────────────────────────────────────────────

async function cmdSend(args: string[]) {
  const enter = takeFlag(args, "--enter");
  const id = args[0];
  const text = args[1];
  if (!id || text === undefined) die("usage: shmerm send <id> <text> [--enter]");
  await sendInput(id, enter ? text + "\r" : text);
}

// ── tail ─────────────────────────────────────────────────────────────────

async function cmdTail(args: string[]) {
  const linesOpt = takeOpt(args, "--lines");
  const id = args[0];
  if (!id) die("usage: shmerm tail <id> [--lines N]");
  const lines = linesOpt ? parseInt(linesOpt, 10) : 100;
  const data = await tailScrollback(id, lines);
  process.stdout.write(data);
}

// ── wait-idle ────────────────────────────────────────────────────────────

async function cmdWaitIdle(args: string[]) {
  const quietOpt = takeOpt(args, "--quiet-ms");
  const timeoutOpt = takeOpt(args, "--timeout-ms");
  const id = args[0];
  if (!id) die("usage: shmerm wait-idle <id> [--quiet-ms N] [--timeout-ms N]");
  const quiet = quietOpt ? parseInt(quietOpt, 10) : 5000;
  const timeout = timeoutOpt ? parseInt(timeoutOpt, 10) : 120000;
  const frame = await waitIdle(id, quiet, timeout);
  process.stdout.write(JSON.stringify(frame) + "\n");
  if (frame?.timeout) process.exit(1);
}

// ── inbox ────────────────────────────────────────────────────────────────

async function cmdInbox(args: string[]) {
  const json = takeFlag(args, "--json");
  const watch = takeFlag(args, "--watch");
  const id = args[0];
  if (!id) die("usage: shmerm inbox <id> [--json] [--watch]");

  if (!watch) {
    const msgs = await readInbox(id);
    if (json) {
      process.stdout.write(JSON.stringify(msgs) + "\n");
      return;
    }
    if (!msgs.length) {
      process.stderr.write("(empty)\n");
      return;
    }
    for (const m of msgs) printInboxMsg(m);
    return;
  }

  // --watch: stream forever via inbox_watch op.
  const sock = net.createConnection(sockPath(id));
  let buf = "";
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  sock.write(JSON.stringify({ op: "inbox_watch" }) + "\n");

  const onSig = () => { try { sock.end(); } catch {}; process.exit(0); };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  sock.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let frame: any;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type === "inbox" && Array.isArray(frame.msgs)) {
        if (json) {
          process.stdout.write(JSON.stringify(frame.msgs) + "\n");
        } else {
          for (const m of frame.msgs as InboxMsg[]) printInboxMsg(m);
        }
      }
    }
  });
  sock.on("close", () => process.exit(0));
  sock.on("error", (e) => die(`socket error: ${e.message}`));
}

function printInboxMsg(m: InboxMsg) {
  const ts = new Date(m.ts).toISOString();
  process.stderr.write(`[${m.id}] ${ts} ${m.text}\n`);
}

// ── reply ────────────────────────────────────────────────────────────────

async function cmdReply(args: string[]) {
  const id = args[0];
  const msgId = args[1];
  const text = args[2];
  if (!id || !msgId || text === undefined) die("usage: shmerm reply <id> <msg_id> <text>");
  await replyInbox(id, msgId, text);
}

// ── kill ─────────────────────────────────────────────────────────────────

async function cmdKill(args: string[]) {
  const id = args[0];
  if (!id) die("usage: shmerm kill <id>");
  await killSession(id);
}

// ── status ───────────────────────────────────────────────────────────────

async function cmdStatus(args: string[]) {
  const json = takeFlag(args, "--json");
  const id = args[0];
  if (!id) die("usage: shmerm status <id> [--json]");
  const meta = await readMeta(id);
  if (json) {
    process.stdout.write(JSON.stringify(meta) + "\n");
    return;
  }
  process.stderr.write(`id      ${meta.id}\n`);
  process.stderr.write(`status  ${meta.status}${meta.exit_code !== undefined ? ` (exit ${meta.exit_code})` : ""}\n`);
  process.stderr.write(`cmd     ${[meta.cmd, ...meta.args].join(" ")}\n`);
  process.stderr.write(`cwd     ${meta.cwd}\n`);
  process.stderr.write(`pid     ${meta.pid} (child ${meta.child_pid})\n`);
  process.stderr.write(`port    ${meta.port}\n`);
  process.stderr.write(`token   ${meta.token}\n`);
  process.stderr.write(`started ${new Date(meta.started_at).toISOString()} (${relTime(meta.started_at)} ago)\n`);
  process.stderr.write(`idle    ${relTime(meta.last_byte_at)}\n`);
  if (meta.public_url) process.stderr.write(`public  ${meta.public_url}\n`);
}

// ── urls ─────────────────────────────────────────────────────────────────

async function cmdUrls(args: string[]) {
  const id = args[0];
  if (!id) die("usage: shmerm urls <id>");
  const meta = await readMeta(id);
  const lan = lanIp();
  process.stderr.write(`view  http://127.0.0.1:${meta.port}/view/${meta.token}\n`);
  process.stderr.write(`kill  http://127.0.0.1:${meta.port}/kill/${meta.token}\n`);
  if (lan !== "localhost") {
    process.stderr.write(`lan   http://${lan}:${meta.port}/view/${meta.token}\n`);
    process.stderr.write(`lan-k http://${lan}:${meta.port}/kill/${meta.token}\n`);
  }
  if (meta.public_url) {
    process.stderr.write(`pub   ${meta.public_url}/view/${meta.token}\n`);
    process.stderr.write(`pub-k ${meta.public_url}/kill/${meta.token}\n`);
  }
}

// ── help ─────────────────────────────────────────────────────────────────

function printHelp() {
  process.stderr.write(`shmerm — durable tool execution

usage: shmerm <subcommand> [args]

subcommands:
  run [--tunnel] [--json] -- <cmd> [args...]   start a detached session
  list [--json]                                list sessions
  attach <id>                                  attach to a session (Ctrl-] detaches)
  send <id> <text> [--enter]                   write text to the PTY
  tail <id> [--lines N]                        last N lines of scrollback (default 100)
  wait-idle <id> [--quiet-ms N] [--timeout-ms N]
                                               block until PTY is quiet
  inbox <id> [--json] [--watch]                read pending inbox messages (or --watch)
  reply <id> <msg_id> <text>                   reply to an inbox message
  kill <id>                                    terminate the session
  status <id> [--json]                         show session meta
  urls <id>                                    print URLs for a session
  help, -h, --help                             this message
`);
}

// ── dispatcher ───────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const sub = argv[0];
const rest = argv.slice(1);

async function main() {
  switch (sub) {
    case "run":       return cmdRun(rest);
    case "list":      return cmdList(rest);
    case "attach":    return cmdAttach(rest);
    case "send":      return cmdSend(rest);
    case "tail":      return cmdTail(rest);
    case "wait-idle": return cmdWaitIdle(rest);
    case "inbox":     return cmdInbox(rest);
    case "reply":     return cmdReply(rest);
    case "kill":      return cmdKill(rest);
    case "status":    return cmdStatus(rest);
    case "urls":      return cmdUrls(rest);
    case "-h":
    case "--help":
    case "help":
    case undefined:
      printHelp();
      return;
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n`);
      printHelp();
      process.exit(2);
  }
}

main().catch((e) => { process.stderr.write(`error: ${e?.message ?? e}\n`); process.exit(1); });
