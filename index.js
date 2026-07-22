// tterm-connect: the machine-side agent. Runs on the machine you want to reach.
// Holds one WebSocket to the tterm hub (a Cloudflare Worker + Durable Object),
// authenticated by the sha256 of its device token. The hub pushes `sync`
// snapshots (live sessions + browser signals); the agent answers WebRTC offers
// and bridges the data channel to a real PTY (ConPTY on Windows, forkpty
// elsewhere). Terminal bytes flow only over the P2P data channel, never
// through the hub.
//
// Sessions survive disconnects: when the browser goes away (tab close, network
// drop) the shell stays alive for GRACE_MS with recent output buffered, and a
// reattach replays that buffer into the new connection.
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import pty from 'node-pty';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import os from 'os';

// Browser-style WebSocket: global on Node >= 22, the `ws` package elsewhere
// (it exposes the same onopen/onmessage/onclose/onerror surface).
let WebSocketImpl = globalThis.WebSocket;
if (!WebSocketImpl) ({ WebSocket: WebSocketImpl } = await import('ws'));

// ---------- config ----------
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const ENDPOINT_URL = arg('endpointUrl') || process.env.TTERM_ENDPOINT_URL;
const TOKEN = arg('token') || process.env.TTERM_TOKEN;
const SHELL_OVERRIDE = arg('shell') || process.env.TTERM_SHELL;
if (!ENDPOINT_URL || !TOKEN) {
  console.error('usage: node index.js --endpointUrl <tterm-url> --token <device-token> [--shell <path>]');
  console.error('   or: TTERM_ENDPOINT_URL=… TTERM_TOKEN=… node index.js');
  process.exit(1);
}
const tokenHash = createHash('sha256').update(TOKEN).digest('hex');
// --endpointUrl is the app origin (e.g. https://tterm.dev); the agent link is
// its /agent/ws WebSocket.
const WS_URL = (() => {
  const origin = new URL(ENDPOINT_URL).origin.replace(/^http/, 'ws');
  return `${origin}/agent/ws?tokenHash=${tokenHash}`;
})();

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

// ---------- hub link ----------
// One WebSocket to the hub, reconnecting with backoff. Outbound messages are
// queued while the link is down (except heartbeats, which are only meaningful
// live); the hub re-pushes a full sync on every reconnect.
let hubWs = null;
let hubQueue = [];
let hubRetryMs = 1000;
let announced = false; // greeting logged once, on the first sync

function hubSend(msg) {
  const data = JSON.stringify(msg);
  if (hubWs?.readyState === 1) hubWs.send(data);
  else if (msg.type !== 'heartbeat') hubQueue.push(data);
}

function connectHub() {
  const ws = new WebSocketImpl(WS_URL);
  hubWs = ws;
  ws.onopen = () => {
    hubRetryMs = 1000;
    for (const data of hubQueue.splice(0)) ws.send(data);
  };
  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'sync') {
      if (!announced) {
        announced = true;
        log(`tterm-connect online as "${msg.deviceName}" (${os.hostname()}, ${process.platform}), shell: ${pickShell()}`);
      }
      onSync(msg);
    }
  };
  ws.onerror = err => {
    // A rejected upgrade (bad token, deleted device) surfaces as an error
    // mentioning the HTTP status — no point retrying those.
    if (/401|403/.test(String(err?.message))) {
      console.error('registration failed: invalid device token (or device was removed)');
      process.exit(1);
    }
  };
  ws.onclose = e => {
    if (hubWs !== ws) return;
    if (e.code === 4004) {
      console.error('device was removed in the web UI — shutting down');
      process.exit(1);
    }
    log(`hub link lost, retrying in ${Math.round(hubRetryMs / 1000)}s`);
    setTimeout(connectHub, hubRetryMs);
    hubRetryMs = Math.min(hubRetryMs * 2, 30000);
  };
}

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
  connectHub();

  // Presence: the UI treats the device as online while heartbeats are recent.
  setInterval(() => hubSend({ type: 'heartbeat' }), 20000);

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
  hubSend({ type: 'accept', sessionId });
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
    hubSend({ type: 'setAttached', sessionId, attached: true });
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
  hubSend({ type: 'signal', sessionId, payload });
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
        spawnPty(conn, sessionId, msg.cols, msg.rows, msg.preset);
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

// The browser may send a `preset` alongside `start`: { shell, args, cwd, env }
// chosen from the user's preset library. Anything the preset omits falls back
// to the device defaults (the --shell override / platform shell, the device
// cwd). The browser is already trusted with a full shell here, so an arbitrary
// shell+args is within bounds — but a bad path (a Windows preset on a Linux
// box) must not crash the agent, so the spawn is guarded.
function spawnPty(conn, sessionId, cols = 80, rows = 24, preset = null) {
  const shell = (typeof preset?.shell === 'string' && preset.shell.trim()) || pickShell();
  const args = Array.isArray(preset?.args) ? preset.args.filter(a => typeof a === 'string') : [];
  let cwd = resolveCwd();
  if (typeof preset?.cwd === 'string' && preset.cwd) {
    if (existsSync(preset.cwd)) cwd = preset.cwd;
    else log(`preset folder "${preset.cwd}" does not exist, using ${cwd}`);
  }
  let env = process.env;
  if (preset?.env && typeof preset.env === 'object') {
    env = { ...process.env };
    for (const [k, val] of Object.entries(preset.env)) {
      if (typeof k === 'string' && k) env[k] = String(val);
    }
  }
  try {
    conn.pty = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols, rows,
      cwd,
      env,
    });
  } catch (err) {
    log(`session ${sid(sessionId)}: spawn failed for ${shell}: ${err.message}`);
    if (conn.dc?.readyState === 'open') {
      conn.dc.send(JSON.stringify({ type: 'exit', code: -1, error: `couldn't start ${shell}: ${err.message}` }));
    }
    closeConn(sessionId, 'spawn failed');
    return;
  }
  log(`session ${sid(sessionId)}: spawned ${shell}${args.length ? ' ' + args.join(' ') : ''} (${cols}x${rows}) in ${cwd}`);
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
  hubSend({ type: 'setAttached', sessionId, attached: false });
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
  hubSend({ type: 'closeSession', sessionId });
}

process.on('SIGINT', () => {
  log('shutting down…');
  for (const sessionId of [...conns.keys()]) closeConn(sessionId, 'agent shutdown');
  process.exit(0);
});

main();
