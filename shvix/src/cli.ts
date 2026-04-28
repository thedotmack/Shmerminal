#!/usr/bin/env node
// shvix CLI dispatcher — talks to the python daemon over HTTP, spawns it detached.
// Hand-rolled argv parsing. Node 18 fetch. No runtime deps.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const DEFAULT_DAEMON_URL = process.env.SHVIX_DAEMON_URL ?? "http://localhost:7749";
const PYTHON = process.env.SHVIX_PYTHON ?? "python3";
const SHVIX_HOME = path.join(os.homedir(), ".shvix");
const PID_FILE = path.join(SHVIX_HOME, "daemon.pid");
const LOG_DIR = path.join(SHVIX_HOME, "logs");
const DAEMON_LOG = path.join(LOG_DIR, "daemon.stderr.log");
const SESSIONS_DIR = path.join(os.homedir(), ".shmerminal", "sessions");
const CORPORA_DIR = path.join(os.homedir(), ".claude-mem", "corpora");

// ---- argv parsing -----------------------------------------------------------

type Args = { positional: string[]; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---- helpers ----------------------------------------------------------------

function ensureHome(): void {
  fs.mkdirSync(SHVIX_HOME, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function get(url: string, timeoutMs = 2000): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function post(url: string, payload: unknown, timeoutMs = 60000): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

function out(json: boolean, human: string, machine: unknown): void {
  if (json) {
    process.stdout.write(JSON.stringify(machine) + "\n");
  } else {
    process.stderr.write(human + "\n");
  }
}

function todayLogPath(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return path.join(LOG_DIR, `${yyyy}-${mm}-${dd}.jsonl`);
}

// ---- subcommands ------------------------------------------------------------

async function cmdDaemonStart(args: Args): Promise<number> {
  ensureHome();
  const json = !!args.flags["json"];
  const existing = readPid();
  if (existing !== null && pidAlive(existing)) {
    process.stderr.write(`Error: shvix daemon already running with pid ${existing}\n`);
    return 2;
  }

  // Resolve daemon.py: dist/cli.js → ../py/daemon.py at repo root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const daemonPath = path.resolve(here, "..", "py", "daemon.py");
  if (!fs.existsSync(daemonPath)) {
    process.stderr.write(`Error: daemon script not found at ${daemonPath}\n`);
    return 1;
  }

  const logFd = fs.openSync(DAEMON_LOG, "a");
  const child = spawn(PYTHON, [daemonPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  if (typeof child.pid !== "number") {
    process.stderr.write("Error: failed to spawn daemon\n");
    return 1;
  }
  fs.writeFileSync(PID_FILE, String(child.pid));

  const deadline = Date.now() + 60_000;
  let lastBody: any = null;
  while (Date.now() < deadline) {
    try {
      const r = await get(`${DEFAULT_DAEMON_URL}/health`, 1000);
      if (r.status === 200 && r.body && typeof r.body === "object") {
        lastBody = r.body;
        if (r.body.ollama_reachable === false) {
          try { process.kill(child.pid, "SIGTERM"); } catch {}
          try { fs.unlinkSync(PID_FILE); } catch {}
          process.stderr.write(
            "Ollama not running. Install: https://ollama.com/download\nThen run: ollama serve\n"
          );
          return 1;
        }
        if (r.body.model_pulled === false) {
          try { process.kill(child.pid, "SIGTERM"); } catch {}
          try { fs.unlinkSync(PID_FILE); } catch {}
          const model = r.body.model ?? "gemma4:e4b";
          process.stderr.write(`Model not pulled. Run: ollama pull ${model}\n`);
          return 1;
        }
        if (r.body.ollama_reachable && r.body.model_pulled) {
          out(
            json,
            `shvix daemon listening on :7749, pid ${child.pid}`,
            { ok: true, pid: child.pid, url: DEFAULT_DAEMON_URL, health: r.body }
          );
          return 0;
        }
      }
    } catch {
      // not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Timed out
  try { process.kill(child.pid, "SIGTERM"); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.stderr.write(
    `daemon failed to become healthy in 60s; see ${DAEMON_LOG}\n` +
    (lastBody ? `last body: ${JSON.stringify(lastBody)}\n` : "")
  );
  return 1;
}

async function cmdDaemonStop(args: Args): Promise<number> {
  const json = !!args.flags["json"];
  const pid = readPid();
  if (pid === null || !pidAlive(pid)) {
    if (pid !== null) { try { fs.unlinkSync(PID_FILE); } catch {} }
    out(json, "no daemon running", { ok: true, running: false });
    return 0;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (pidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  out(json, `stopped daemon pid ${pid}`, { ok: true, pid });
  return 0;
}

function findLatestSession(): { id: string; meta: any } | null {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  let best: { id: string; meta: any; started: number } | null = null;
  for (const id of fs.readdirSync(SESSIONS_DIR)) {
    const metaPath = path.join(SESSIONS_DIR, id, "meta.json");
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const started = Number(meta.started_at ?? 0);
      if (!best || started > best.started) best = { id, meta, started };
    } catch { /* skip unreadable session dirs */ }
  }
  return best ? { id: best.id, meta: best.meta } : null;
}

async function cmdRecover(args: Args): Promise<number> {
  const json = !!args.flags["json"];
  let sessionId: string | undefined;
  if (typeof args.flags["session"] === "string") {
    sessionId = args.flags["session"] as string;
  } else if (args.flags["last"]) {
    const found = findLatestSession();
    if (!found) {
      process.stderr.write("no shmerminal session found under ~/.shmerminal/sessions\n");
      return 1;
    }
    sessionId = found.id;
  }
  const payload = {
    symptom: "auto-recover requested",
    context: { session_id: sessionId, cwd: process.cwd() },
  };
  let r;
  try {
    r = await post(`${DEFAULT_DAEMON_URL}/fix`, payload, 60_000);
  } catch (e: any) {
    process.stderr.write(`daemon not running, run 'shvix daemon' first (${e?.message ?? e})\n`);
    return 1;
  }
  const b = r.body;
  if (json) {
    process.stdout.write(JSON.stringify(b) + "\n");
  } else {
    process.stderr.write(
      `→ classified as ${b?.classification ?? "?"}, action: ${b?.action_taken ?? "?"}, ok: ${b?.ok ?? "?"}\n`
    );
    if (b?.message) process.stderr.write(`  ${b.message}\n`);
  }
  return b?.ok && !b?.requires_human ? 0 : 1;
}

async function cmdDiagnose(args: Args): Promise<number> {
  const json = !!args.flags["json"];
  const symptom = args.positional.join(" ").trim();
  if (!symptom) {
    process.stderr.write("usage: shvix diagnose <symptom>\n");
    return 1;
  }
  const candidates = ["frozen-pty", "lockfile-stuck", "session-corrupted", "port-conflict"];
  let r;
  try {
    r = await post(`${DEFAULT_DAEMON_URL}/classify`, { symptom, candidates }, 30_000);
  } catch (e: any) {
    process.stderr.write(`daemon not running, run 'shvix daemon' first (${e?.message ?? e})\n`);
    return 1;
  }
  const b = r.body;
  if (json) {
    process.stdout.write(JSON.stringify(b) + "\n");
  } else {
    process.stderr.write(
      `classification: ${b?.classification ?? "?"} (confidence ${b?.confidence ?? "?"})\n`
    );
  }
  return 0;
}

function cmdCorpusBuild(_args: Args): number {
  process.stderr.write(
    "shvix corpus build runs from inside a Claude Code session.\n" +
    "From a Claude Code chat, ask:\n" +
    '    Use the build_corpus tool with name "openclaw", concepts "openclaw recovery", limit 500.\n' +
    "The corpus will land at ~/.claude-mem/corpora/openclaw.corpus.json.\n"
  );
  return 0;
}

function cmdCorpusList(args: Args): number {
  const json = !!args.flags["json"];
  let entries: { name: string; size: number; observations?: number }[] = [];
  try {
    for (const f of fs.readdirSync(CORPORA_DIR)) {
      if (!f.endsWith(".corpus.json")) continue;
      const full = path.join(CORPORA_DIR, f);
      const stat = fs.statSync(full);
      let observations: number | undefined;
      try {
        const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
        if (Array.isArray(parsed?.observations)) observations = parsed.observations.length;
      } catch { /* not parseable, leave undefined */ }
      entries.push({ name: f, size: stat.size, observations });
    }
  } catch { /* missing dir → empty list */ }
  if (json) {
    process.stdout.write(JSON.stringify({ corpora: entries }) + "\n");
  } else if (entries.length === 0) {
    process.stderr.write("no corpora found under ~/.claude-mem/corpora/\n");
  } else {
    for (const e of entries) {
      const obs = e.observations !== undefined ? `, ${e.observations} obs` : "";
      process.stderr.write(`${e.name}  ${e.size} bytes${obs}\n`);
    }
  }
  return 0;
}

async function cmdLogs(args: Args): Promise<number> {
  const json = !!args.flags["json"];
  const tail = !!args.flags["tail"];
  const file = todayLogPath();
  if (!fs.existsSync(file)) {
    process.stderr.write("no log for today\n");
    return 0;
  }
  const initial = fs.readFileSync(file, "utf8");
  if (json) process.stdout.write(initial); else process.stderr.write(initial);
  if (!tail) return 0;
  // Simple polling tail.
  let pos = Buffer.byteLength(initial, "utf8");
  return await new Promise<number>((resolve) => {
    const watcher = fs.watchFile(file, { interval: 500 }, (curr) => {
      if (curr.size > pos) {
        const stream = fs.createReadStream(file, { start: pos, end: curr.size - 1 });
        stream.on("data", (chunk) => {
          if (json) process.stdout.write(chunk); else process.stderr.write(chunk);
        });
        stream.on("end", () => { pos = curr.size; });
      } else if (curr.size < pos) {
        // file truncated/rotated
        pos = 0;
      }
    });
    // fs.watchFile registers a listener; void variable to satisfy unused-var lints
    void watcher;
    process.on("SIGINT", () => { fs.unwatchFile(file); resolve(0); });
  });
}

async function cmdStatus(args: Args): Promise<number> {
  const json = !!args.flags["json"];
  const pid = readPid();
  const pidRunning = pid !== null && pidAlive(pid);
  let health: any = null;
  let healthErr: string | null = null;
  try {
    const r = await get(`${DEFAULT_DAEMON_URL}/health`, 1500);
    if (r.status === 200) health = r.body;
    else healthErr = `http ${r.status}`;
  } catch (e: any) {
    healthErr = e?.message ?? "unreachable";
  }
  // corpus snapshot
  let corpusObs: number | null = null;
  let corpusName: string | null = null;
  try {
    const candidate = path.join(CORPORA_DIR, "openclaw.corpus.json");
    if (fs.existsSync(candidate)) {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      corpusName = "openclaw";
      if (Array.isArray(parsed?.observations)) corpusObs = parsed.observations.length;
    }
  } catch { /* ignore corrupt corpus */ }
  // log
  const logFile = todayLogPath();
  let logEntries = 0;
  if (fs.existsSync(logFile)) {
    const raw = fs.readFileSync(logFile, "utf8");
    logEntries = raw.split("\n").filter((l) => l.trim().length > 0).length;
  }
  const snapshot = {
    version: VERSION,
    daemon: { pid, running: pidRunning, url: DEFAULT_DAEMON_URL, health, health_error: healthErr },
    corpus: { name: corpusName, observations: corpusObs },
    log: { path: logFile, entries: logEntries },
  };
  if (json) {
    process.stdout.write(JSON.stringify(snapshot) + "\n");
    return 0;
  }
  const lines: string[] = [];
  lines.push(`shvix v${VERSION}`);
  if (pidRunning) lines.push(`daemon: pid ${pid} (running) at ${DEFAULT_DAEMON_URL}`);
  else if (pid !== null) lines.push(`daemon: pid ${pid} stale (process not alive)`);
  else lines.push(`daemon: not running`);
  if (health) {
    lines.push(`ollama: ${health.ollama_reachable ? "ok" : "down"}`);
    lines.push(`model: ${health.model ?? "?"} (${health.model_pulled ? "pulled" : "not pulled"})`);
  } else if (pidRunning) {
    lines.push(`health: pid alive but ${DEFAULT_DAEMON_URL}/health unreachable (${healthErr})`);
  }
  lines.push(`corpus: ${corpusName ? `${corpusName}, ${corpusObs ?? "?"} obs` : "not loaded"}`);
  lines.push(`log: ${logFile} (${logEntries} entries)`);
  process.stderr.write(lines.join("\n") + "\n");
  return 0;
}

function printHelp(): void {
  process.stderr.write(
    `shvix v${VERSION} — local recovery agent for shmerminal/openclaw

usage:
  shvix daemon                       start daemon (detached)
  shvix daemon stop                  stop daemon
  shvix recover [--last|--session id]   classify + run a runbook
  shvix diagnose <symptom>           classify only (no side effects)
  shvix corpus build [--topic openclaw]  print corpus-build instructions
  shvix corpus list                  list ~/.claude-mem/corpora/
  shvix logs [--tail]                show / follow today's JSONL log
  shvix status                       daemon + ollama + corpus health
  shvix --version
  shvix --help

flags:
  --json     machine-readable output to stdout (human prose still goes to stderr)

env:
  SHVIX_DAEMON_URL   default ${DEFAULT_DAEMON_URL}
  SHVIX_PYTHON       default python3
`
  );
}

// ---- main -------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  const cmd = argv[0];
  const rest = parseArgs(argv.slice(1));
  switch (cmd) {
    case "daemon": {
      if (rest.positional[0] === "stop") return cmdDaemonStop(rest);
      return cmdDaemonStart(rest);
    }
    case "recover":
      return cmdRecover(rest);
    case "diagnose":
      return cmdDiagnose(rest);
    case "corpus": {
      const sub = rest.positional[0];
      if (sub === "build") return cmdCorpusBuild(rest);
      if (sub === "list") return cmdCorpusList(rest);
      process.stderr.write("usage: shvix corpus <build|list>\n");
      return 1;
    }
    case "logs":
      return cmdLogs(rest);
    case "status":
      return cmdStatus(rest);
    default:
      process.stderr.write(`unknown subcommand: ${cmd}\n`);
      printHelp();
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  }
);
