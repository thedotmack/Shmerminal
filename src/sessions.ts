/**
 * sessions.ts — stateful shmerm sessions that outlive the launching process,
 *               plus an inbox channel for human → agent messages.
 *
 * Storage tree per session at ~/.shmerminal/sessions/<id>/
 *   meta.json         host pid, port, token, status, last_byte_at
 *   host.pid          host process pid
 *   host.sock         unix socket — control plane
 *   scrollback.log    PTY output (rolling ~1MB)
 *   inbox.json        human → agent messages with delivery + reply state
 *
 * Two roles share this file:
 *   1. host(id)         runs in the detached background process (owns PTY)
 *   2. client primitives the `shmerm` CLI uses to talk to the host
 *
 * The inbox is the new interesting part. It's the channel the mobile web
 * UI uses to talk *to the agent* without touching the PTY. Three states
 * per message: pending → delivered → replied (optional).
 */

import * as pty from "node-pty";
import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ROOT = path.join(os.homedir(), ".shmerminal", "sessions");
const SCROLLBACK_MAX = 1 << 20;

const ADJ = ["amber","crimson","jade","lunar","onyx","quiet","rapid","silver","velvet","wild"];
const NOUN = ["otter","falcon","ember","pine","atlas","river","comet","willow","fennec","heron"];
function newId(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  const h = crypto.randomBytes(2).toString("hex");
  return `${a}-${n}-${h}`;
}

export type Meta = {
  id: string; cmd: string; args: string[]; cwd: string;
  pid: number; child_pid: number;
  started_at: number; last_byte_at: number;
  port: number; token: string; public_url?: string;
  status: "running" | "exited"; exit_code?: number;
};

export type InboxMsg = {
  id: string;
  ts: number;
  text: string;
  source: "web" | "cli";
  delivered_at?: number;     // when the agent first read it
  reply?: string;            // optional structured reply from agent
  reply_ts?: number;
};

const dirOf = (id: string) => path.join(ROOT, id);
const sockOf = (id: string) => path.join(dirOf(id), "host.sock");
const metaOf = (id: string) => path.join(dirOf(id), "meta.json");
const logOf  = (id: string) => path.join(dirOf(id), "scrollback.log");
const inboxOf = (id: string) => path.join(dirOf(id), "inbox.json");

// ── inbox helpers (used by both host and standalone shmerm.ts) ───────────
export async function inboxList(id: string): Promise<InboxMsg[]> {
  try { return JSON.parse(await fsp.readFile(inboxOf(id), "utf8")); }
  catch { return []; }
}
async function inboxWrite(id: string, msgs: InboxMsg[]) {
  await fsp.mkdir(dirOf(id), { recursive: true });
  await fsp.writeFile(inboxOf(id), JSON.stringify(msgs, null, 2));
}
export async function inboxAppend(id: string, m: { text: string; source: "web" | "cli" }): Promise<InboxMsg> {
  const msgs = await inboxList(id);
  const msg: InboxMsg = { id: crypto.randomBytes(4).toString("hex"), ts: Date.now(), ...m };
  msgs.push(msg);
  await inboxWrite(id, msgs);
  return msg;
}
export async function inboxMarkDelivered(id: string, msgIds?: string[]): Promise<InboxMsg[]> {
  const msgs = await inboxList(id);
  const target = msgIds ? new Set(msgIds) : null;
  const now = Date.now();
  const touched: InboxMsg[] = [];
  for (const m of msgs) {
    if (m.delivered_at) continue;
    if (target && !target.has(m.id)) continue;
    m.delivered_at = now;
    touched.push(m);
  }
  await inboxWrite(id, msgs);
  return touched;
}
export async function inboxAddReply(id: string, msgId: string, reply: string): Promise<InboxMsg | null> {
  const msgs = await inboxList(id);
  const m = msgs.find(x => x.id === msgId);
  if (!m) return null;
  m.reply = reply;
  m.reply_ts = Date.now();
  if (!m.delivered_at) m.delivered_at = m.reply_ts;
  await inboxWrite(id, msgs);
  return m;
}

// ─────────────────────────────────────────────────────────────────────────
// HOST: detached background process
// ─────────────────────────────────────────────────────────────────────────
export async function runHost(id: string, cmd: string, args: string[]) {
  const dir = dirOf(id);
  await fsp.mkdir(dir, { recursive: true });

  const term = pty.spawn(cmd, args, {
    name: "xterm-256color",
    cols: 120, rows: 30,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  const meta: Meta = {
    id, cmd, args, cwd: process.cwd(),
    pid: process.pid, child_pid: term.pid,
    started_at: Date.now(), last_byte_at: Date.now(),
    port: 0, token: crypto.randomBytes(16).toString("hex"),
    status: "running",
  };
  await writeMeta(meta);
  // (the HTTP/WS server from shmerm.ts boots here in the full integration;
  //  it imports the inbox helpers above so web clients hit the same store.)

  const log = fs.createWriteStream(logOf(id), { flags: "a" });
  const attached = new Set<net.Socket>();
  const inboxSubs = new Set<net.Socket>();   // sockets in `inbox --watch` mode

  term.onData((data) => {
    meta.last_byte_at = Date.now();
    log.write(data);
    rotateIfNeeded(id).catch(() => {});
    const frame = JSON.stringify({ type: "out", data }) + "\n";
    for (const s of attached) s.write(frame);
  });

  term.onExit(({ exitCode }) => {
    meta.status = "exited"; meta.exit_code = exitCode ?? 0;
    writeMeta(meta).finally(() => {
      const f = JSON.stringify({ type: "exit", code: exitCode ?? 0 }) + "\n";
      for (const s of attached) { try { s.write(f); s.end(); } catch {} }
      setTimeout(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}), 60 * 60 * 1000);
      process.exit(0);
    });
  });

  await fsp.unlink(sockOf(id)).catch(() => {});
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        handle(msg, sock).catch((e) => sock.write(JSON.stringify({ type: "error", msg: String(e) }) + "\n"));
      }
    });
    sock.on("close", () => { attached.delete(sock); inboxSubs.delete(sock); });
  });
  server.listen(sockOf(id));

  async function handle(msg: any, sock: net.Socket) {
    switch (msg.op) {
      case "input":  return void term.write(msg.data);
      case "resize": return void term.resize(Math.max(1, msg.cols|0), Math.max(1, msg.rows|0));
      case "attach": {
        attached.add(sock);
        const tail = await readTail(id, 4096);
        sock.write(JSON.stringify({ type: "out", data: tail }) + "\n");
        return;
      }
      case "detach": return void attached.delete(sock);
      case "tail": {
        const data = await readTailLines(id, msg.lines ?? 100);
        return void sock.write(JSON.stringify({ type: "tail", data }) + "\n");
      }
      case "meta": return void sock.write(JSON.stringify({ type: "meta", ...meta }) + "\n");
      case "wait_idle": {
        const quiet = msg.quiet_ms ?? 5000;
        const deadline = Date.now() + (msg.timeout_ms ?? 120000);
        const tick = () => {
          const idleFor = Date.now() - meta.last_byte_at;
          if (idleFor >= quiet) sock.write(JSON.stringify({ type: "idle", idle_ms: idleFor }) + "\n");
          else if (Date.now() > deadline) sock.write(JSON.stringify({ type: "idle", idle_ms: idleFor, timeout: true }) + "\n");
          else setTimeout(tick, Math.min(500, quiet - idleFor));
        };
        return void tick();
      }
      case "kill": return void term.kill();

      // ── inbox ops (agent-facing) ─────────────────────────────────────
      case "inbox_read": {
        // return all undelivered messages and mark them delivered
        const all = await inboxList(id);
        const pending = all.filter(m => !m.delivered_at);
        const touched = await inboxMarkDelivered(id, pending.map(m => m.id));
        sock.write(JSON.stringify({ type: "inbox", msgs: touched }) + "\n");
        // notify any web clients via the HTTP server (handled in shmerm.ts integration)
        return;
      }
      case "inbox_watch": {
        inboxSubs.add(sock);
        // also flush anything already pending
        const all = await inboxList(id);
        const pending = all.filter(m => !m.delivered_at);
        if (pending.length) {
          const touched = await inboxMarkDelivered(id, pending.map(m => m.id));
          sock.write(JSON.stringify({ type: "inbox", msgs: touched }) + "\n");
        }
        return;
      }
      case "inbox_reply": {
        const m = await inboxAddReply(id, msg.msg_id, msg.text);
        sock.write(JSON.stringify({ type: "inbox_replied", msg: m }) + "\n");
        return;
      }
      // called by the HTTP server when a web client posts a new message,
      // so any agent watching gets push-delivered:
      case "inbox_notify_new": {
        const all = await inboxList(id);
        const pending = all.filter(m => !m.delivered_at);
        if (!pending.length || !inboxSubs.size) return;
        const touched = await inboxMarkDelivered(id, pending.map(m => m.id));
        const frame = JSON.stringify({ type: "inbox", msgs: touched }) + "\n";
        for (const s of inboxSubs) { try { s.write(frame); } catch {} }
        return;
      }
    }
  }
}

async function writeMeta(m: Meta) { await fsp.writeFile(metaOf(m.id), JSON.stringify(m, null, 2)); }
async function readMeta(id: string): Promise<Meta> { return JSON.parse(await fsp.readFile(metaOf(id), "utf8")); }

async function readTail(id: string, bytes: number): Promise<string> {
  const fd = await fsp.open(logOf(id), "r");
  try {
    const stat = await fd.stat();
    const start = Math.max(0, stat.size - bytes);
    const buf = Buffer.alloc(stat.size - start);
    await fd.read(buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally { await fd.close(); }
}
async function readTailLines(id: string, lines: number): Promise<string> {
  const text = await readTail(id, lines * 200);
  return text.split("\n").slice(-lines).join("\n");
}
async function rotateIfNeeded(id: string) {
  const stat = await fsp.stat(logOf(id)).catch(() => null);
  if (!stat || stat.size < SCROLLBACK_MAX * 2) return;
  const tail = await readTail(id, SCROLLBACK_MAX);
  await fsp.writeFile(logOf(id), tail);
}

// ─────────────────────────────────────────────────────────────────────────
// CLIENT primitives — used by `shmerm run/attach/send/inbox/reply/...`
// ─────────────────────────────────────────────────────────────────────────
export async function startSession(cmd: string, args: string[]): Promise<Meta> {
  const id = newId();
  await fsp.mkdir(dirOf(id), { recursive: true });
  const child = spawn(process.execPath, [__filename, "__host__", id, cmd, ...args], {
    detached: true, stdio: "ignore", cwd: process.cwd(), env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return await readMeta(id); } catch { await sleep(50); }
  }
  throw new Error(`session ${id} failed to start`);
}

export async function call(id: string, op: object, expectFrames = 1): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockOf(id));
    const frames: any[] = [];
    let buf = "";
    sock.on("connect", () => sock.write(JSON.stringify(op) + "\n"));
    sock.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try { frames.push(JSON.parse(line)); } catch {}
        if (frames.length >= expectFrames) { sock.end(); resolve(frames); return; }
      }
    });
    sock.on("error", reject);
    sock.on("close", () => resolve(frames));
  });
}

export async function listSessions(): Promise<Meta[]> {
  const ids = await fsp.readdir(ROOT).catch(() => []);
  const out: Meta[] = [];
  for (const id of ids) { try { out.push(await readMeta(id)); } catch {} }
  return out.sort((a, b) => b.started_at - a.started_at);
}

export const send     = (id: string, data: string) => call(id, { op: "input", data }, 0);
export const tail     = (id: string, lines = 100)  => call(id, { op: "tail", lines }, 1).then(f => f[0].data as string);
export const kill     = (id: string)               => call(id, { op: "kill" }, 0);
export const waitIdle = (id: string, quiet_ms = 5000, timeout_ms = 120_000) =>
  call(id, { op: "wait_idle", quiet_ms, timeout_ms }, 1).then(f => f[0]);

// agent-facing inbox commands
export const readInbox  = (id: string)                          => call(id, { op: "inbox_read" }, 1).then(f => f[0].msgs as InboxMsg[]);
export const replyInbox = (id: string, msgId: string, text: string) => call(id, { op: "inbox_reply", msg_id: msgId, text }, 1).then(f => f[0].msg as InboxMsg);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── re-exec entrypoint ────────────────────────────────────────────────────
if (process.argv[2] === "__host__") {
  const [, , , id, cmd, ...args] = process.argv;
  runHost(id, cmd, args).catch((e) => { console.error(e); process.exit(1); });
}
