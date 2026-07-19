// tterm-connect: the machine-side agent. Runs on the machine you want to reach.
// Registers with Convex using a device token, waits for sessions, answers WebRTC
// offers and bridges the data channel to a real PTY (ConPTY on Windows, forkpty
// elsewhere). Terminal bytes flow only over the P2P data channel, never through
// Convex.
//
// Sessions survive disconnects: when the browser goes away (tab close, network
// drop) the shell stays alive for GRACE_MS with recent output buffered, and a
// reattach replays that buffer into the new connection.
import { ConvexClient } from 'convex/browser';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import pty from 'node-pty';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import os from 'os';
import { api } from './api.js';

// ---------- config ----------
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const CONVEX_URL = arg('convex') || process.env.TTERM_CONVEX_URL;
const TOKEN = arg('token') || process.env.TTERM_TOKEN;
const SHELL_OVERRIDE = arg('shell') || process.env.TTERM_SHELL;
if (!CONVEX_URL || !TOKEN) {
  console.error('usage: node index.js --convex <convex-url> --token <device-token> [--shell <path>]');
  console.error('   or: TTERM_CONVEX_URL=… TTERM_TOKEN=… node index.js');
  process.exit(1);
}
const tokenHash = createHash('sha256').update(TOKEN).digest('hex');

const GRACE_MS = 15 * 60 * 1000;   // how long a detached shell survives
const HANDSHAKE_MS = 60 * 1000;    // how long a never-connected session may dangle
const BUFFER_MAX = 256 * 1024;     // replay buffer per session (bytes)
const CHUNK = 16 * 1024;           // replay chunk size over the data channel

function pickShell() {
  if (SHELL_OVERRIDE) return SHELL_OVERRIDE;
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const sid = id => id.slice(-6);

// ---------- convex link ----------
const convex = new ConvexClient(CONVEX_URL);
const STUN = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

// sessionId -> { pc, dc, pty, buffer:[Buffer], bufferSize, openedAt, detachedAt, pcUsed, resetting }
const conns = new Map();
const seenSignals = new Set();

// Default folder for new shells, configured per-device in the web UI and
// delivered via sync. Falls back to the home directory if unset or missing.
let deviceCwd = null;
function resolveCwd() {
  if (deviceCwd) {
    if (existsSync(deviceCwd)) return deviceCwd;
    log(`default folder "${deviceCwd}" does not exist, using home directory`);
  }
  return os.homedir();
}

async function main() {
  let name;
  try {
    ({ name } = await convex.mutation(api.agent.heartbeat, { tokenHash }));
  } catch {
    console.error('registration failed: invalid token or unreachable Convex deployment');
    process.exit(1);
  }
  log(`tterm-connect online as "${name}" (${os.hostname()}, ${process.platform}), shell: ${pickShell()}`);

  setInterval(() => {
    convex.mutation(api.agent.heartbeat, { tokenHash }).catch(err => log('heartbeat failed:', err.message));
  }, 20000);

  convex.onUpdate(api.agent.sync, { tokenHash }, onSync);

  // Reap sessions that never completed a handshake, and detached shells whose
  // grace period expired.
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, conn] of conns) {
      if (!conn.pty && conn.pc?.connectionState !== 'connected' && now - conn.openedAt > HANDSHAKE_MS) {
        closeConn(sessionId, 'handshake timeout');
      } else if (conn.pty && conn.detachedAt && now - conn.detachedAt > GRACE_MS) {
        closeConn(sessionId, 'detach grace expired');
      }
    }
  }, 15000);
}

async function onSync({ sessions, signals, cwd }) {
  deviceCwd = cwd ?? null;
  const liveIds = new Set(sessions.map(s => s.id));

  // Sessions that vanished from sync were closed (browser teardown or UI ✕).
  for (const sessionId of conns.keys()) {
    if (!liveIds.has(sessionId)) closeConn(sessionId, 'closed remotely');
  }

  for (const session of sessions) {
    if (!conns.has(session.id)) openConn(session.id);
  }

  for (const signal of signals) {
    if (seenSignals.has(signal.id)) continue;
    seenSignals.add(signal.id);
    const conn = conns.get(signal.sessionId);
    if (conn) await handleSignal(conn, signal.sessionId, signal.payload);
  }
}

function openConn(sessionId) {
  log(`session ${sid(sessionId)}: incoming`);
  const conn = {
    pc: null, dc: null, pty: null,
    buffer: [], bufferSize: 0,
    openedAt: Date.now(), detachedAt: null,
    pcUsed: false, resetting: false,
  };
  conns.set(sessionId, conn);
  makePc(conn, sessionId);
  convex.mutation(api.agent.accept, { tokenHash, sessionId }).catch(() => {});
}

function makePc(conn, sessionId) {
  const pc = new RTCPeerConnection(STUN);
  conn.pc = pc;
  pc.onicecandidate = e => {
    if (e.candidate) postSignal(sessionId, { kind: 'candidate', candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (conn.resetting || conn.pc !== pc) return;
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      detachConn(sessionId, `webrtc ${pc.connectionState}`);
    }
  };
  pc.ondatachannel = ({ channel }) => {
    conn.dc = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = e => onChannelMessage(conn, sessionId, e.data);
    channel.onclose = () => {
      if (!conn.resetting && conn.dc === channel) detachConn(sessionId, 'channel closed');
    };
    conn.detachedAt = null;
    convex.mutation(api.agent.setAttached, { tokenHash, sessionId, attached: true }).catch(() => {});
    log(`session ${sid(sessionId)}: data channel open — P2P established`);
  };
}

// A second offer on a used peer connection means the browser is reattaching:
// stand up a fresh RTCPeerConnection for the same shell.
function resetPc(conn, sessionId) {
  conn.resetting = true;
  try { conn.dc?.close(); } catch { /* already closed */ }
  try { conn.pc?.close(); } catch { /* already closed */ }
  conn.dc = null;
  makePc(conn, sessionId);
  conn.resetting = false;
  conn.openedAt = Date.now();
  log(`session ${sid(sessionId)}: reattach — new peer connection`);
}

async function handleSignal(conn, sessionId, payload) {
  try {
    if (payload.kind === 'description') {
      if (payload.description.type === 'offer' && conn.pcUsed) resetPc(conn, sessionId);
      await conn.pc.setRemoteDescription(payload.description);
      if (payload.description.type === 'offer') {
        conn.pcUsed = true;
        await conn.pc.setLocalDescription(await conn.pc.createAnswer());
        postSignal(sessionId, { kind: 'description', description: conn.pc.localDescription.toJSON() });
      }
    } else if (payload.kind === 'candidate' && payload.candidate) {
      await conn.pc.addIceCandidate(payload.candidate);
    }
  } catch (err) {
    log(`session ${sid(sessionId)}: signal error:`, err.message);
  }
}

function postSignal(sessionId, payload) {
  convex.mutation(api.agent.post, { tokenHash, sessionId, payload }).catch(() => {});
}

function onChannelMessage(conn, sessionId, data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'start') {
      if (conn.pty) {
        // Reattach: bring the browser up to date, then adopt its size.
        replayBuffer(conn);
        try { conn.pty.resize(msg.cols, msg.rows); } catch { /* racing exit */ }
        log(`session ${sid(sessionId)}: replayed ${conn.bufferSize} buffered bytes`);
      } else {
        spawnPty(conn, sessionId, msg.cols, msg.rows);
      }
    }
    if (msg.type === 'resize' && conn.pty) {
      try { conn.pty.resize(msg.cols, msg.rows); } catch { /* racing exit */ }
    }
    return;
  }
  if (conn.pty) conn.pty.write(Buffer.from(data).toString('utf8'));
}

function bufferOutput(conn, buf) {
  conn.buffer.push(buf);
  conn.bufferSize += buf.length;
  while (conn.bufferSize > BUFFER_MAX && conn.buffer.length > 1) {
    conn.bufferSize -= conn.buffer.shift().length;
  }
}

function replayBuffer(conn) {
  if (conn.dc?.readyState !== 'open' || conn.bufferSize === 0) return;
  const all = Buffer.concat(conn.buffer);
  for (let i = 0; i < all.length; i += CHUNK) {
    conn.dc.send(all.subarray(i, Math.min(i + CHUNK, all.length)));
  }
}

function spawnPty(conn, sessionId, cols = 80, rows = 24) {
  const shell = pickShell();
  const cwd = resolveCwd();
  conn.pty = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols, rows,
    cwd,
    env: process.env,
  });
  log(`session ${sid(sessionId)}: spawned ${shell} (${cols}x${rows}) in ${cwd}`);
  conn.pty.onData(data => {
    const buf = Buffer.from(data, 'utf8');
    bufferOutput(conn, buf);
    if (conn.dc?.readyState === 'open') conn.dc.send(buf);
  });
  conn.pty.onExit(({ exitCode }) => {
    log(`session ${sid(sessionId)}: shell exited (${exitCode})`);
    if (conn.dc?.readyState === 'open') conn.dc.send(JSON.stringify({ type: 'exit', code: exitCode }));
    conn.pty = null;
    closeConn(sessionId, 'shell exit');
  });
}

// Connection lost but shell (if any) stays alive for GRACE_MS awaiting reattach.
function detachConn(sessionId, reason) {
  const conn = conns.get(sessionId);
  if (!conn) return;
  if (!conn.pty) return closeConn(sessionId, reason);
  if (conn.detachedAt) return; // already detached
  conn.detachedAt = Date.now();
  try { conn.dc?.close(); } catch { /* already closed */ }
  try { conn.pc?.close(); } catch { /* already closed */ }
  conn.dc = null;
  convex.mutation(api.agent.setAttached, { tokenHash, sessionId, attached: false }).catch(() => {});
  log(`session ${sid(sessionId)}: detached (${reason}) — shell kept for ${GRACE_MS / 60000} min`);
}

function closeConn(sessionId, reason) {
  const conn = conns.get(sessionId);
  if (!conn) return;
  conns.delete(sessionId);
  log(`session ${sid(sessionId)}: closed (${reason})`);
  try { conn.pty?.kill(); } catch { /* already dead */ }
  try { conn.dc?.close(); } catch { /* already closed */ }
  try { conn.pc?.close(); } catch { /* already closed */ }
  convex.mutation(api.agent.closeSession, { tokenHash, sessionId }).catch(() => {});
}

process.on('SIGINT', () => {
  log('shutting down…');
  for (const sessionId of [...conns.keys()]) closeConn(sessionId, 'agent shutdown');
  process.exit(0);
});

main();
