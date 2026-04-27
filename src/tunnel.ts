/**
 * tunnel.ts — start a public HTTPS tunnel for a local port.
 *
 *   primary:   cloudflared tunnel --url http://localhost:PORT  (free, no signup)
 *   fallback:  ssh -p 443 -R0:localhost:PORT a.pinggy.io       (no binary needed)
 *
 * Returns { url, close } once the upstream prints its public URL.
 * Rejects if no tunnel can be established within `timeoutMs`.
 */

import { spawn, ChildProcess } from "node:child_process";

export type Tunnel = { url: string; provider: "cloudflared" | "pinggy"; close: () => void };

const CF_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const PINGGY_URL_RE = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.pinggy\.link/i;

function which(bin: string): boolean {
  try {
    const r = spawn("which", [bin], { stdio: "ignore" });
    return new Promise<boolean>((res) => r.on("exit", (c) => res(c === 0))) as unknown as boolean;
  } catch { return false; }
}
async function whichAsync(bin: string): Promise<boolean> {
  return new Promise((res) => {
    const r = spawn("which", [bin], { stdio: "ignore" });
    r.on("exit", (c) => res(c === 0));
    r.on("error", () => res(false));
  });
}

/** Spawn cloudflared and resolve with the trycloudflare.com URL. */
function startCloudflared(port: number, timeoutMs: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const proc = spawn("cloudflared", [
      "tunnel",
      "--no-autoupdate",
      "--url", `http://localhost:${port}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let settled = false;
    const close = () => { try { proc.kill("SIGTERM"); } catch {} };

    const onChunk = (buf: Buffer) => {
      const m = buf.toString().match(CF_URL_RE);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: m[0], provider: "cloudflared", close });
      }
    };
    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);

    proc.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    proc.on("exit", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`cloudflared exited (${code}) before printing URL`)); }
    });

    const timer = setTimeout(() => {
      if (!settled) { settled = true; close(); reject(new Error("cloudflared timeout")); }
    }, timeoutMs);
  });
}

/** Spawn an SSH session to Pinggy and resolve with the pinggy.link URL. */
function startPinggy(port: number, timeoutMs: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ssh", [
      "-p", "443",
      "-o", "StrictHostKeyChecking=no",
      "-o", "ServerAliveInterval=30",
      "-R", `0:localhost:${port}`,
      "a.pinggy.io",
      "-T",                         // no remote pty
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let settled = false;
    const close = () => { try { proc.kill("SIGTERM"); } catch {} };

    const onChunk = (buf: Buffer) => {
      const m = buf.toString().match(PINGGY_URL_RE);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: m[0], provider: "pinggy", close });
      }
    };
    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);
    proc.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    proc.on("exit", (c) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`ssh exited (${c}) before printing URL`)); }
    });

    const timer = setTimeout(() => {
      if (!settled) { settled = true; close(); reject(new Error("pinggy timeout")); }
    }, timeoutMs);
  });
}

/** Try cloudflared, fall back to Pinggy. */
export async function startTunnel(port: number, timeoutMs = 15_000): Promise<Tunnel> {
  if (await whichAsync("cloudflared")) {
    try { return await startCloudflared(port, timeoutMs); }
    catch (e) { /* fall through */ }
  }
  if (await whichAsync("ssh")) {
    return startPinggy(port, timeoutMs);
  }
  throw new Error("No tunnel runner available — install cloudflared or ensure ssh is on PATH");
}
