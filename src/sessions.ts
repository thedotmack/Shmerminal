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
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { startTunnel, type Tunnel } from "./tunnel.js";

// __filename equivalent for ESM — used by startSession to re-exec this file
// in __host__ mode as a detached background process.
const __filename = fileURLToPath(import.meta.url);

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

// ── inbox helpers ────────────────────────────────────────────────────────
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

// ── LAN IP helper ────────────────────────────────────────────────────────
// Used by the CLI's `urls` subcommand to print a phone-friendly URL —
// 127.0.0.1 isn't reachable from the user's phone on the same wifi.
export function lanIp(): string {
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  return "localhost";
}

// ── web UI HTML ──────────────────────────────────────────────────────────
// The page is served from the host process. Token is in the path; the
// browser connects to /stream/<token> via WS for the live PTY feed.
// Three tabs: Watch (read-only stream), Type (raw PTY input), Message
// agent (writes to inbox.json without touching the PTY).
function pageHtml(cmd: string, streamPath: string, killPath: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>shmerm — ${cmd}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css">
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0b0b0c;color:#e6e6e6;font:14px ui-monospace,Menlo,monospace;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
  header{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #222;flex-shrink:0}
  header .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;flex-shrink:0}
  header .brand{font-weight:700}
  header .tag{font-size:11px;opacity:.55;font-style:italic}
  header .spacer{flex:1}
  header button{background:#7a1f1f;color:#fff;border:0;padding:6px 12px;border-radius:6px;cursor:pointer;font:inherit}
  header button:hover{background:#9a2a2a}
  #term{flex:1;padding:6px;overflow:hidden;min-height:120px}
  /* drawer */
  .tabs{display:flex;border-top:1px solid #222;flex-shrink:0}
  .tab{flex:1;padding:10px;text-align:center;background:#111;color:#999;border:0;border-right:1px solid #222;cursor:pointer;font:inherit}
  .tab:last-child{border-right:0}
  .tab.active{background:#1a1a1c;color:#fff}
  .tab .badge{display:inline-block;min-width:18px;padding:1px 6px;margin-left:6px;border-radius:9px;background:#3fb950;color:#000;font-size:11px;font-weight:700}
  .panel{display:none;padding:10px;background:#111;border-top:1px solid #222;flex-shrink:0;max-height:45dvh;overflow-y:auto}
  .panel.active{display:block}
  .row{display:flex;gap:8px;align-items:flex-end}
  textarea,input{flex:1;background:#0b0b0c;color:#fff;border:1px solid #333;border-radius:6px;padding:10px;font:inherit;resize:none}
  textarea:focus,input:focus{outline:0;border-color:#3fb950}
  .send{background:#1f5a2e;color:#fff;border:0;padding:10px 16px;border-radius:6px;cursor:pointer;font:inherit;font-weight:600}
  .send:hover{background:#2a7a3e}
  .hint{font-size:11px;opacity:.6;margin-top:6px}
  /* messages */
  .msgs{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
  .msg{padding:8px 10px;border-radius:8px;background:#1a1a1c;border-left:3px solid #555;font-size:13px}
  .msg.pending{border-left-color:#888;opacity:.7}
  .msg.delivered{border-left-color:#3fb950}
  .msg .meta{font-size:10px;opacity:.5;margin-top:4px}
  .reply{margin-top:6px;padding:6px 8px;background:#0b0b0c;border-radius:6px;font-size:12px;border-left:2px solid #4a90d9}
</style></head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <span class="brand">shmerm</span>
  <span class="tag">terminal shmerminal! we got this</span>
  <span class="spacer"></span>
  <button id="kill">Kill</button>
</header>

<div id="term"></div>

<div class="tabs">
  <button class="tab active" data-panel="watch">Watch</button>
  <button class="tab" data-panel="type">Type</button>
  <button class="tab" data-panel="agent">Message agent <span class="badge" id="badge" style="display:none">0</span></button>
</div>

<div class="panel" id="panel-watch">
  <div class="hint">Read-only stream. Switch tabs to interact.</div>
</div>

<div class="panel" id="panel-type">
  <div class="row">
    <input id="cmd-input" placeholder="type a command and press send (sends &lt;Enter&gt; for you)" autocomplete="off">
    <button class="send" id="cmd-send">Send</button>
  </div>
  <div class="hint">⚠️  Goes straight into the terminal. Bypasses any agent driving the session.</div>
</div>

<div class="panel" id="panel-agent">
  <div class="msgs" id="msgs"></div>
  <div class="row">
    <textarea id="agent-input" rows="2" placeholder="message the agent — they'll see it on their next check-in"></textarea>
    <button class="send" id="agent-send">Send</button>
  </div>
  <div class="hint">Doesn't touch the terminal. Lands in the agent's inbox.</div>
</div>

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
<script>
  const term = new Terminal({ cursorBlink:true, fontFamily:"ui-monospace, Menlo, monospace", theme:{background:"#0b0b0c"} });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit); term.open(document.getElementById("term"));
  setTimeout(() => fit.fit(), 0);

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(proto + "//" + location.host + ${JSON.stringify(streamPath)});
  const dot = document.getElementById("dot");
  const msgs = new Map(); // id → state

  ws.onopen = () => {
    dot.style.background = "#3fb950";
    ws.send(JSON.stringify({ t: "r", cols: term.cols, rows: term.rows }));
    ws.send(JSON.stringify({ t: "inbox_sync" }));
  };
  ws.onclose = () => { dot.style.background = "#777"; term.write("\\r\\n[session closed]\\r\\n"); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "d") term.write(m.d);
    else if (m.t === "x") term.write("\\r\\n[exit " + m.c + "]\\r\\n");
    else if (m.t === "inbox") { for (const msg of m.msgs) upsertMsg(msg); }
    else if (m.t === "inbox_one") upsertMsg(m.msg);
  };

  // tab switching
  document.querySelectorAll(".tab").forEach(t => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
      const name = t.dataset.panel;
      document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + name));
      setTimeout(() => fit.fit(), 0);
    };
  });

  // direct terminal input
  document.getElementById("cmd-send").onclick = sendCmd;
  document.getElementById("cmd-input").onkeydown = (e) => { if (e.key === "Enter") sendCmd(); };
  function sendCmd() {
    const el = document.getElementById("cmd-input");
    if (!el.value || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ t: "i", d: el.value + "\\r" }));
    el.value = "";
  }

  // agent inbox
  document.getElementById("agent-send").onclick = sendAgent;
  document.getElementById("agent-input").onkeydown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendAgent();
  };
  function sendAgent() {
    const el = document.getElementById("agent-input");
    const text = el.value.trim();
    if (!text || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ t: "inbox_send", text }));
    el.value = "";
  }

  function upsertMsg(msg) {
    msgs.set(msg.id, msg);
    render();
  }
  function render() {
    const list = [...msgs.values()].sort((a,b) => a.ts - b.ts);
    const root = document.getElementById("msgs");
    root.innerHTML = "";
    let pending = 0;
    for (const m of list) {
      if (!m.delivered_at) pending++;
      const el = document.createElement("div");
      el.className = "msg " + (m.delivered_at ? "delivered" : "pending");
      const ts = new Date(m.ts).toLocaleTimeString();
      const status = m.delivered_at ? "agent saw this" : "waiting for agent...";
      el.innerHTML = '<div>' + escapeHtml(m.text) + '</div>' +
        '<div class="meta">' + ts + ' · ' + status + '</div>' +
        (m.reply ? '<div class="reply">↪ ' + escapeHtml(m.reply) + '</div>' : '');
      root.appendChild(el);
    }
    const badge = document.getElementById("badge");
    badge.textContent = pending;
    badge.style.display = pending ? "inline-block" : "none";
  }
  function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }

  window.addEventListener("resize", () => {
    fit.fit();
    if (ws.readyState === 1) ws.send(JSON.stringify({t:"r",cols:term.cols,rows:term.rows}));
  });

  document.getElementById("kill").onclick = () => {
    if (!confirm("Kill the running session?")) return;
    fetch(${JSON.stringify(killPath)}, { method: "POST" });
  };
</script></body></html>`;
}

const KILL_CONFIRM_HTML = `<!doctype html><meta charset=utf-8><title>kill session</title>
<style>body{font:16px system-ui;background:#0b0b0c;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
button{background:#7a1f1f;color:#fff;border:0;padding:14px 22px;border-radius:8px;font:inherit;cursor:pointer}
button:hover{background:#9a2a2a}</style>
<form method="POST"><button>Kill session</button></form>`;

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

  // ── HTTP + WebSocket server ────────────────────────────────────────────
  // Bound to 0.0.0.0 so the LAN URL is reachable from a phone on the same
  // wifi. The token in the path is the only access control; that's the
  // entire point of the shmerm "phone-friendly" model. If the user wants
  // local-only, they should not advertise the LAN URL or use --tunnel.
  const VIEW = `/view/${meta.token}`;
  const KILL = `/kill/${meta.token}`;
  const STREAM = `/stream/${meta.token}`;

  const clients = new Set<WebSocket>();
  let tunnel: Tunnel | null = null;

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === VIEW && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(pageHtml(cmd, STREAM, KILL));
    }
    if (url.pathname === KILL && req.method === "POST") {
      term.kill();
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("killed");
    }
    if (url.pathname === KILL && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(KILL_CONFIRM_HTML);
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname !== STREAM) return socket.destroy();
    wss.handleUpgrade(req, socket, head, async (ws) => {
      clients.add(ws);
      // Send scrollback tail so the new client sees recent history,
      // not just whatever happens after they connect.
      const tail = await readTail(id, 4096).catch(() => "");
      if (tail) ws.send(JSON.stringify({ t: "d", d: tail }));

      ws.on("message", async (raw) => {
        let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
        // Wrap the awaited inbox/file ops so a transient fs failure doesn't
        // bubble up as an unhandled promise rejection and crash the host.
        try {
          if (m.t === "i" && typeof m.d === "string") term.write(m.d);
          else if (m.t === "r") term.resize(Math.max(1, m.cols | 0), Math.max(1, m.rows | 0));
          else if (m.t === "k") term.kill();
          else if (m.t === "inbox_sync") {
            const all = await inboxList(id);
            ws.send(JSON.stringify({ t: "inbox", msgs: all }));
          } else if (m.t === "inbox_send" && typeof m.text === "string") {
            const msg = await inboxAppend(id, { text: m.text, source: "web" });
            // broadcast the new message to every connected web client
            const frame = JSON.stringify({ t: "inbox_one", msg });
            for (const c of clients) if (c.readyState === c.OPEN) c.send(frame);
            // and push-deliver to any agent watching via the unix socket
            await notifyInboxSubsOfNew();
          }
        } catch (e) {
          process.stderr.write(`ws message handler error: ${(e as any)?.message ?? e}\n`);
        }
      });
      ws.on("close", () => clients.delete(ws));
    });
  });

  // Listen on an ephemeral port and persist it to meta.json so clients
  // (CLI, agent, the human's phone) can find the URL without scraping logs.
  await new Promise<void>((resolve) => httpServer.listen(0, "0.0.0.0", () => resolve()));
  const addr = httpServer.address();
  meta.port = typeof addr === "object" && addr ? addr.port : 0;
  await writeMeta(meta);

  // ── tunnel ─────────────────────────────────────────────────────────────
  // Opt-in. Wrapper passes SHMERM_TUNNEL=1 in env when --tunnel is set.
  if (process.env.SHMERM_TUNNEL === "1") {
    try {
      tunnel = await startTunnel(meta.port);
      meta.public_url = tunnel.url;
      await writeMeta(meta);
    } catch (e: any) {
      // Host has stdio:"ignore"; a stderr line is still useful when
      // running the host directly via `node dist/sessions.js __host__ ...`.
      process.stderr.write(`tunnel failed: ${e?.message ?? e}\n`);
    }
  }

  // Boot banner — visible only when running the host in the foreground
  // for debugging. The detached spawn discards stdio.
  process.stderr.write(`shmerm host ${id} listening\n`);
  process.stderr.write(`  local  http://127.0.0.1:${meta.port}${VIEW}\n`);
  const lan = lanIp();
  if (lan !== "localhost") process.stderr.write(`  lan    http://${lan}:${meta.port}${VIEW}\n`);
  process.stderr.write(`  kill   http://127.0.0.1:${meta.port}${KILL}\n`);
  if (meta.public_url) process.stderr.write(`  public ${meta.public_url}${VIEW}\n`);

  const log = fs.createWriteStream(logOf(id), { flags: "a" });
  const attached = new Set<net.Socket>();
  const inboxSubs = new Set<net.Socket>();   // sockets in `inbox --watch` mode

  // DRY: both the WS path and the unix socket `inbox_notify_new` op need
  // to flush newly-arrived messages to any agent in `inbox --watch` mode.
  async function notifyInboxSubsOfNew() {
    const all = await inboxList(id);
    const pending = all.filter(m => !m.delivered_at);
    if (!pending.length || !inboxSubs.size) return;
    const touched = await inboxMarkDelivered(id, pending.map(m => m.id));
    const frame = JSON.stringify({ type: "inbox", msgs: touched }) + "\n";
    for (const s of inboxSubs) { try { s.write(frame); } catch {} }
  }

  term.onData((data) => {
    meta.last_byte_at = Date.now();
    log.write(data);
    rotateIfNeeded(id).catch(() => {});
    const frame = JSON.stringify({ type: "out", data }) + "\n";
    for (const s of attached) s.write(frame);
    // also fan out to any browser watching via WS
    const wsFrame = JSON.stringify({ t: "d", d: data });
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(wsFrame);
  });

  term.onExit(({ exitCode }) => {
    meta.status = "exited"; meta.exit_code = exitCode ?? 0;
    writeMeta(meta).finally(() => {
      const f = JSON.stringify({ type: "exit", code: exitCode ?? 0 }) + "\n";
      for (const s of attached) { try { s.write(f); s.end(); } catch {} }
      // tell browsers the session ended, then close the HTTP server +
      // tunnel before exiting so resources don't linger.
      const wsExit = JSON.stringify({ t: "x", c: exitCode ?? 0 });
      for (const ws of clients) {
        try { if (ws.readyState === ws.OPEN) ws.send(wsExit); ws.close(); } catch {}
      }
      try { httpServer.close(); } catch {}
      try { tunnel?.close(); } catch {}
      // Keep the host process alive for an hour after PTY exit so the
      // session directory is recoverable (logs, inbox), then clean up.
      // Putting process.exit inside the timer is load-bearing: a bare
      // process.exit(0) here would kill the timer before it fired, and
      // session dirs would accumulate forever.
      setTimeout(() => {
        fsp.rm(dir, { recursive: true, force: true })
          .catch(() => {})
          .finally(() => process.exit(0));
      }, 60 * 60 * 1000);
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
        // Push the updated msg to any connected browsers so the reply
        // appears in real time, matching the inbox_send broadcast path.
        if (m) {
          const frame = JSON.stringify({ t: "inbox_one", msg: m });
          for (const ws of clients) {
            try { if (ws.readyState === ws.OPEN) ws.send(frame); } catch {}
          }
        }
        return;
      }
      // called by anything that wants to push-deliver newly-arrived
      // inbox messages to agents in `inbox --watch` mode. The host's own
      // WS handler also calls notifyInboxSubsOfNew directly.
      case "inbox_notify_new": {
        await notifyInboxSubsOfNew();
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
  // Wait for the host to bind its HTTP port before returning. The host
  // writes meta.json multiple times: once with port=0 immediately after
  // spawn, again with the real port after listen() resolves, and a
  // third time with public_url after the tunnel comes up. Returning
  // before those writes hands callers a useless :0 URL or a Meta with
  // no public_url even though --tunnel was requested.
  const wantTunnel = process.env.SHMERM_TUNNEL === "1";
  const portDeadline = Date.now() + 5_000;
  // Tunnels can take 5-15s to come up; wait longer when one is requested.
  const tunnelDeadline = Date.now() + 20_000;
  let lastMeta: Meta | undefined;
  while (Date.now() < tunnelDeadline) {
    try {
      const m = await readMeta(id);
      lastMeta = m;
      if (m.port > 0) {
        if (!wantTunnel) return m;
        if (m.public_url) return m;
        // Tunnel was requested but hasn't reported yet. Keep waiting,
        // unless the host already exited (e.g. tunnel hard-failed).
        if (m.status === "exited") return m;
      }
    } catch {}
    if (Date.now() > portDeadline && (!wantTunnel || !lastMeta || lastMeta.port === 0)) break;
    await sleep(50);
  }
  if (lastMeta && lastMeta.port > 0) return lastMeta; // tunnel never came up — caller can warn
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
