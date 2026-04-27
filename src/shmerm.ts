/**
 * shmerm — terminal shmerminal! we got this.
 *
 * Wraps an interactive command and exposes:
 *   • a mobile-friendly web viewer with three modes (watch / type / message agent)
 *   • a kill URL
 *   • optional public tunnel (cloudflared / pinggy)
 *   • an agent-readable inbox so a human watching from their phone can
 *     interject into an agent's autonomous loop without stomping the PTY
 *
 *   bun shmerm.ts [--tunnel] <cmd> [args...]
 */

import * as pty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { startTunnel, type Tunnel } from "./tunnel.js";
import { inboxAppend, inboxList, inboxMarkDelivered, inboxAddReply, type InboxMsg } from "./sessions.js";

// ── args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const wantTunnel = argv.includes("--tunnel") || process.env.SHMERM_TUNNEL === "1";
const sessionId = process.env.SHMERM_SESSION_ID || crypto.randomBytes(4).toString("hex");
const rest = argv.filter((a) => a !== "--tunnel");
const cmd = rest[0] || process.env.SHELL || "/bin/bash";
const args = rest.slice(1);
const READ_ONLY = process.env.SHMERM_READONLY === "1";
const RING_MAX = 500;

// ── session state ────────────────────────────────────────────────────────
const token = crypto.randomBytes(16).toString("hex");
const ring: string[] = [];
const clients = new Set<WebSocket>();
let tunnel: Tunnel | null = null;

const term = pty.spawn(cmd, args, {
  name: "xterm-256color",
  cols: process.stdout.columns || 120,
  rows: process.stdout.rows || 30,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
});

term.onData((data) => {
  process.stdout.write(data);
  ring.push(data);
  if (ring.length > RING_MAX) ring.shift();
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "d", d: data }));
});

term.onExit(({ exitCode }) => {
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "x", c: exitCode }));
    ws.close();
  }
  tunnel?.close();
  setTimeout(() => process.exit(exitCode ?? 0), 150);
});

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (d) => term.write(d.toString()));
}
process.stdout.on("resize", () => term.resize(process.stdout.columns, process.stdout.rows));

// ── routes ───────────────────────────────────────────────────────────────
const VIEW = `/view/${token}`;
const KILL = `/kill/${token}`;
const STREAM = `/stream/${token}`;

// All inbox interaction happens over WS; helpers below broadcast events to clients.
function broadcast(evt: object) {
  const f = JSON.stringify(evt);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(f);
}

const PAGE = () => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
  const ws = new WebSocket(proto + "//" + location.host + ${JSON.stringify(STREAM)});
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

  ${READ_ONLY ? "" : `// terminal direct typing (when on Watch tab via on-screen keyboard? rare on mobile but supported)`}

  window.addEventListener("resize", () => {
    fit.fit();
    if (ws.readyState === 1) ws.send(JSON.stringify({t:"r",cols:term.cols,rows:term.rows}));
  });

  document.getElementById("kill").onclick = () => {
    if (!confirm("Kill the running session?")) return;
    fetch(${JSON.stringify(KILL)}, { method: "POST" });
  };
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === VIEW && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE());
  }
  if (url.pathname === KILL && req.method === "POST") {
    term.kill();
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("killed");
  }
  if (url.pathname === KILL && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta charset=utf-8><title>kill session</title>
<style>body{font:16px system-ui;background:#0b0b0c;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
button{background:#7a1f1f;color:#fff;border:0;padding:14px 22px;border-radius:8px;font:inherit;cursor:pointer}
button:hover{background:#9a2a2a}</style>
<form method="POST"><button>Kill session</button></form>`);
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname !== STREAM) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    if (ring.length) ws.send(JSON.stringify({ t: "d", d: ring.join("") }));

    ws.on("message", async (raw) => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === "i" && !READ_ONLY) term.write(m.d);
      else if (m.t === "r") term.resize(Math.max(1, m.cols | 0), Math.max(1, m.rows | 0));
      else if (m.t === "k") term.kill();
      else if (m.t === "inbox_sync") {
        const all = await inboxList(sessionId);
        ws.send(JSON.stringify({ t: "inbox", msgs: all }));
      }
      else if (m.t === "inbox_send" && typeof m.text === "string") {
        const msg = await inboxAppend(sessionId, { text: m.text, source: "web" });
        broadcast({ t: "inbox_one", msg });
      }
    });
    ws.on("close", () => clients.delete(ws));
  });
});

// expose hooks for the agent-side CLI to notify connected clients
// when it reads/replies. The CLI calls these via the host control socket
// in the stateful design; for the simple wrapper they're invoked directly.
export function notifyDelivered(msg: InboxMsg) { broadcast({ t: "inbox_one", msg }); }
export function notifyReply(msg: InboxMsg)     { broadcast({ t: "inbox_one", msg }); }

// ── boot ─────────────────────────────────────────────────────────────────
function lanIP(): string {
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  return "localhost";
}

server.listen(0, async () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const lan = `${lanIP()}:${port}`;

  process.stderr.write(`\n  shmerm — terminal shmerminal! we got this\n`);
  process.stderr.write(`\n  🔗 view  http://${lan}${VIEW}`);
  process.stderr.write(`\n  💀 kill  http://${lan}${KILL}\n`);

  if (wantTunnel) {
    process.stderr.write(`\n  🌐 starting public tunnel...`);
    try {
      tunnel = await startTunnel(port);
      process.stderr.write(`\r  🌐 ${tunnel.provider} view: ${tunnel.url}${VIEW}\n`);
      process.stderr.write(`  💀 ${tunnel.provider} kill: ${tunnel.url}${KILL}\n\n`);
    } catch (e: any) {
      process.stderr.write(`\r  🌐 tunnel failed: ${e.message}\n\n`);
    }
  } else {
    process.stderr.write(`\n`);
  }
});

const cleanup = () => {
  try { tunnel?.close(); } catch {}
  try { term.kill(); } catch {}
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
