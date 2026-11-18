// tterm-connect: the machine-side agent. Runs on the machine you want to reach.
// Holds one WebSocket to the tterm hub (a Cloudflare Worker + Durable Object),
// authenticated by the sha256 of its device token. The hub pushes `sync`
// snapshots (live sessions + browser signals); the agent answers WebRTC offers
// and bridges the data channel to a real PTY (ConPTY on Windows, forkpty
// elsewhere). Terminal bytes flow only over the P2P data channel, never
// through the hub.
//
// Sessions survive disconnects: when the browser goes away (tab close, network
// drop) the shell stays alive with recent output buffered, and a reattach
// replays that buffer into the new connection.
//
// Sessions also survive a connector restart (service restart, crash, reboot),
// but only in part: the buffered output and the shell's start settings are
// saved to STATE_DIR. A running process cannot be saved, so on reattach the
// agent shows the saved output and starts a new shell with the same settings.
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import pty from 'node-pty';
import { createHash, randomBytes, randomUUID } from 'crypto';
import {
  existsSync, mkdirSync, openSync, writeSync, closeSync, rmSync, readdirSync, statSync,
  readFileSync, writeFileSync, renameSync, readlinkSync,
} from 'fs';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// node-pty older than 1.1 ignores useConptyDll (see spawnPty) without an
// error, so the start-up log shows the version: an old one needs `npm install`.
const PTY_VERSION = createRequire(import.meta.url)('node-pty/package.json').version;

// node-pty uses ConPTY only on Windows build 18309 and later; below that
// (Windows 10 1809 is 17763) it falls back to winpty, even with useConptyDll.
// winpty drops ESC[?2004h, so Claude Code got a large paste with no paste
// markers and kept only its end. The ConPTY that ships with node-pty does
// not depend on the Windows build, so with useConptyDll the check is lifted.
if (process.platform === 'win32') {
  const { WindowsPtyAgent } = createRequire(import.meta.url)('node-pty/lib/windowsPtyAgent.js');
  const buildNumber = WindowsPtyAgent.prototype._getWindowsBuildNumber;
  WindowsPtyAgent.prototype._getWindowsBuildNumber = function () {
    return this._useConptyDll ? Infinity : buildNumber.call(this);
  };
}

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

// A detached shell lives until the user closes it. Only hidden pre-warmed
// spares expire: their browser is gone, and nobody would ever close them.
const SPARE_GRACE_MS = 15 * 60 * 1000; // how long a detached spare survives
const HANDSHAKE_MS = 60 * 1000;    // how long a never-connected session may dangle
// Replay buffer per session: the output a reattach (page refresh, lost link)
// gets back. A preset can ask for more or less (`bufferBytes` in its spec).
const BUFFER_DEFAULT = 1024 * 1024;
const BUFFER_MIN = 64 * 1024;
const BUFFER_LIMIT = 32 * 1024 * 1024;
const bufferMaxFor = preset => {
  const n = Number(preset?.bufferBytes);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(BUFFER_LIMIT, Math.max(BUFFER_MIN, n)) : BUFFER_DEFAULT;
};
const CHUNK = 16 * 1024;           // replay chunk size over the data channel
// Saved sessions: <id>.json (start settings) + <id>.log (output buffer). Next
// to index.js, not in the home folder: a service account's home is a system path.
const STATE_DIR = process.env.TTERM_STATE_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'state');
const FLUSH_MS = 2000;             // how often changed buffers go to disk

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
        log(`tterm-connect online as "${msg.deviceName}" (${os.hostname()}, ${process.platform}), shell: ${pickShell()}, node-pty ${PTY_VERSION}`);
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

  // Reap sessions that never completed a handshake, and detached spares whose
  // grace period expired.
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, conn] of conns) {
      // A restored session waits for its browser as long as a live one would.
      if (!conn.pty && !conn.restored && conn.pc?.connectionState !== 'connected'
          && now - conn.openedAt > HANDSHAKE_MS) {
        closeConn(sessionId, 'handshake timeout');
      } else if (conn.hidden && conn.pty && conn.detachedAt && now - conn.detachedAt > SPARE_GRACE_MS) {
        closeConn(sessionId, 'detached spare expired');
      }
    }
  }, 15000);

  setInterval(flushState, FLUSH_MS);
}

// ---------- saved sessions (survive a connector restart) ----------
// Only real sessions are saved; a hidden spare has no history worth keeping.
function statePath(sessionId, ext) {
  return path.join(STATE_DIR, `${sessionId.replace(/[^\w.-]/g, '_')}.${ext}`);
}

function writeAtomic(file, data) {
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

function flushState() {
  for (const [sessionId, conn] of conns) {
    if (!conn.pty || conn.hidden || !conn.spawnInfo) continue;
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      if (!conn.metaSaved) {
        writeAtomic(statePath(sessionId, 'json'), JSON.stringify(conn.spawnInfo));
        conn.metaSaved = true;
      }
      if (conn.dirty) {
        writeAtomic(statePath(sessionId, 'log'), Buffer.concat(conn.buffer));
        conn.dirty = false;
      }
    } catch (err) {
      log(`session ${sid(sessionId)}: could not save state: ${err.message}`);
    }
  }
}

function loadState(sessionId) {
  try {
    const spawnInfo = JSON.parse(readFileSync(statePath(sessionId, 'json'), 'utf8'));
    let output = Buffer.alloc(0);
    try { output = readFileSync(statePath(sessionId, 'log')); } catch { /* no output yet */ }
    return { spawnInfo, output };
  } catch {
    return null;
  }
}

function dropState(sessionId) {
  rmSync(statePath(sessionId, 'json'), { force: true });
  rmSync(statePath(sessionId, 'log'), { force: true });
}

// Saved state of sessions the hub no longer has (closed while we were down).
function sweepState(liveIds) {
  let names;
  try { names = readdirSync(STATE_DIR); } catch { return; } // no folder yet
  for (const name of names) {
    const id = name.replace(/\.(json|log)(\.tmp)?$/, '');
    if (!liveIds.has(id)) rmSync(path.join(STATE_DIR, name), { force: true });
  }
}

async function onSync({ sessions, signals, cwd }) {
  deviceCwd = cwd ?? null;
  const liveIds = new Set(sessions.map(s => s.id));

  // Sessions that vanished from sync were closed (browser teardown or UI ✕).
  for (const sessionId of conns.keys()) {
    if (!liveIds.has(sessionId)) closeConn(sessionId, 'closed remotely');
  }

  sweepState(liveIds);

  for (const session of sessions) {
    if (!conns.has(session.id)) {
      // An accepted session we don't hold lost its shell when this process
      // restarted. Restore it from disk, or close it so the UI does not show
      // a dead shell as live.
      const restored = session.status === 'pending' ? null : loadState(session.id);
      if (session.status !== 'pending' && !restored) {
        log(`session ${sid(session.id)}: shell lost in a restart, nothing saved — closing`);
        hubSend({ type: 'closeSession', sessionId: session.id });
        continue;
      }
      openConn(session.id, restored);
    }
    // An older hub sends no `hidden`: treat the session as real (never expires).
    conns.get(session.id).hidden = session.hidden === true;
  }

  for (const signal of signals) {
    if (seenSignals.has(signal.id)) continue;
    seenSignals.add(signal.id);
    const conn = conns.get(signal.sessionId);
    if (conn) await handleSignal(conn, signal.sessionId, signal.payload);
  }
}

function openConn(sessionId, restored = null) {
  log(`session ${sid(sessionId)}: ${restored ? 'restored from disk, waiting for browser' : 'incoming'}`);
  const conn = {
    pc: null, dc: null, pty: null,
    buffer: [], bufferSize: 0, bufferMax: BUFFER_DEFAULT,
    openedAt: Date.now(), detachedAt: null,
    pcUsed: false, resetting: false,
    restored, spawnInfo: null, metaSaved: false, dirty: false,
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
    channel.uploads = new Map(); // in-flight file uploads on this channel (see onUpload)
    channel.onmessage = e => onChannelMessage(conn, sessionId, e.data, channel);
    channel.onclose = () => {
      abortUploads(channel);
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

function onChannelMessage(conn, sessionId, data, channel) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'upload-where') {
      const id = String(msg.id ?? '').slice(0, 64);
      shellCwd(conn).then(dir => sendJson(channel, { type: 'upload-where', id, dir }));
      return;
    }
    if (typeof msg.type === 'string' && msg.type.startsWith('upload-')) {
      onUpload(channel, sessionId, msg);
      return;
    }
    if (msg.type === 'start') {
      if (conn.pty) {
        // Reattach: bring the browser up to date, then adopt its size.
        replayBuffer(conn, sessionId);
        try { conn.pty.resize(msg.cols, msg.rows); } catch { /* racing exit */ }
        log(`session ${sid(sessionId)}: replayed ${conn.bufferSize} buffered bytes`);
      } else if (conn.restored) {
        // After a connector restart: show the saved output, push it into
        // scrollback (a new ConPTY clears the screen), then start a new shell
        // with the old settings. The browser's own preset is ignored here.
        const { spawnInfo, output } = conn.restored;
        conn.restored = null;
        conn.bufferMax = bufferMaxFor(spawnInfo.preset);
        bufferOutput(conn, output);
        bufferOutput(conn, Buffer.from(
          '\r\n\x1b[0;2m[tterm: the connector restarted — this is a new shell; the output above is saved history]\x1b[0m'
          + '\r\n'.repeat(Math.max(1, msg.rows | 0))));
        replayBuffer(conn, sessionId);
        log(`session ${sid(sessionId)}: replayed ${conn.bufferSize} saved bytes, starting a new shell`);
        spawnPty(conn, sessionId, msg.cols, msg.rows, { ...spawnInfo.preset, cwd: spawnInfo.cwd });
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

// ---------- file uploads (a file pasted or dropped in the browser) ----------
// The browser can't hand its clipboard to a program on this machine, so it
// sends the file over the data channel — JSON messages with base64 chunks:
//   upload-where {id}              →  upload-where {id, dir}  (the shell's folder)
//   upload-start {id, name, size, dir?}  →  upload-ready {id}
//   upload-chunk {id, data}        (repeated)
//   upload-end   {id}              →  upload-done {id, path}
// Any failure answers upload-error {id, error}. Without `dir` we save the file
// to a temp folder (files expire after a day); with `dir` (the folder that
// upload-where gave) we save it there under its own name. The browser pastes
// the saved path into the terminal: Claude Code, for one, attaches an image
// when it sees its path.
const UPLOAD_DIR = path.join(os.tmpdir(), 'tterm-uploads');
const UPLOAD_MAX = 100 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 3600 * 1000;

function sendJson(channel, msg) {
  if (channel?.readyState !== 'open') return;
  try { channel.send(JSON.stringify(msg)); } catch { /* channel dying; onclose detaches */ }
}

// Send on a session's data channel. A dying channel can still report 'open'
// and then throw (libdatachannel errno=108); before this guard, that uncaught
// throw killed the agent and every shell with it. Treat it as a lost link.
function safeSend(conn, sessionId, data) {
  if (conn.dc?.readyState !== 'open') return false;
  try {
    conn.dc.send(data);
    return true;
  } catch (err) {
    log(`session ${sid(sessionId)}: send failed (${err.message})`);
    detachConn(sessionId, 'send failed');
    return false;
  }
}

// The browser's file name, made safe for a path: no folders, no odd characters.
function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
  return base.slice(-80) || 'file';
}

// A file saved into the user's own folder keeps its name (Cyrillic, spaces):
// remove only what no file name can hold.
function plainName(name) {
  const base = String(name || '').split(/[\\/]/).pop()
    .replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  return base.slice(-120) || 'file';
}

// Open dir/name for writing, never over an existing file: photo.png, then
// photo-1.png, photo-2.png…
function openFree(dir, name) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) {
    const file = path.join(dir, n ? `${stem}-${n}${ext}` : name);
    try { return { file, fd: openSync(file, 'wx') }; }
    catch (err) { if (err.code !== 'EEXIST' || n >= 999) throw err; }
  }
}

function onUpload(channel, sessionId, msg) {
  const id = String(msg.id ?? '').slice(0, 64);
  const fail = err => {
    abortUpload(channel, id);
    sendJson(channel, { type: 'upload-error', id, error: err });
  };
  if (msg.type === 'upload-start') {
    const size = Number(msg.size);
    if (!id || channel.uploads.has(id)) return fail('bad upload id');
    if (!Number.isSafeInteger(size) || size < 0 || size > UPLOAD_MAX) return fail('file is too large');
    try {
      let file, fd;
      if (msg.dir != null) {
        const dir = String(msg.dir);
        if (!path.isAbsolute(dir) || !statSync(dir).isDirectory()) return fail(`no folder ${dir}`);
        ({ file, fd } = openFree(dir, plainName(msg.name)));
      } else {
        mkdirSync(UPLOAD_DIR, { recursive: true });
        file = path.join(UPLOAD_DIR, `${Date.now()}-${randomBytes(3).toString('hex')}-${safeName(msg.name)}`);
        fd = openSync(file, 'wx');
      }
      channel.uploads.set(id, { file, fd, size, received: 0 });
    } catch (err) {
      return fail(err.message);
    }
    sendJson(channel, { type: 'upload-ready', id });
    return;
  }
  const up = channel.uploads.get(id);
  if (!up) return;
  if (msg.type === 'upload-chunk') {
    const buf = Buffer.from(String(msg.data ?? ''), 'base64');
    if (up.received + buf.length > up.size) return fail('more data than announced');
    try { writeSync(up.fd, buf); } catch (err) { return fail(err.message); }
    up.received += buf.length;
  } else if (msg.type === 'upload-end') {
    if (up.received !== up.size) return fail('upload is incomplete');
    channel.uploads.delete(id);
    try { closeSync(up.fd); } catch (err) {
      rmSync(up.file, { force: true });
      return sendJson(channel, { type: 'upload-error', id, error: err.message });
    }
    log(`session ${sid(sessionId)}: saved upload ${up.file} (${up.size} bytes)`);
    sendJson(channel, { type: 'upload-done', id, path: up.file });
  } else if (msg.type === 'upload-abort') {
    abortUpload(channel, id);
  }
}

// Drop a partial upload: close and delete its file.
function abortUpload(channel, id) {
  const up = channel?.uploads?.get(id);
  if (!up) return;
  channel.uploads.delete(id);
  try { closeSync(up.fd); } catch { /* already closed */ }
  rmSync(up.file, { force: true });
}

function abortUploads(channel) {
  for (const id of [...(channel?.uploads?.keys() ?? [])]) abortUpload(channel, id);
}

// Delete uploads older than UPLOAD_TTL_MS (at start, then hourly).
function sweepUploads() {
  let names;
  try { names = readdirSync(UPLOAD_DIR); } catch { return; } // no folder yet
  for (const name of names) {
    const file = path.join(UPLOAD_DIR, name);
    try {
      if (Date.now() - statSync(file).mtimeMs > UPLOAD_TTL_MS) rmSync(file, { force: true });
    } catch { /* gone or busy: next sweep */ }
  }
}
sweepUploads();
setInterval(sweepUploads, 3600 * 1000).unref();

// ---------- the shell's current folder (for "save the file here") ----------
// The program the user works in is usually the shell's newest child (Claude
// Code started from the prompt), and its working folder is where it was
// started. With no child, the folder the shell itself reported (OSC 7 or
// OSC 9;9 from its prompt), then the shell's own working folder. PowerShell's
// cd does not change its process folder, so a bare pwsh prompt without OSC
// reporting gives the folder it started in.
async function shellCwd(conn) {
  const pid = conn.pty?.pid;
  let procs = [];
  if (pid) {
    try { procs = await procCwds(pid); }
    catch (err) { log(`could not read the shell's folder: ${err.message}`); }
  }
  const [shell, ...children] = procs;
  const child = children.filter(p => p.cwd).sort((a, b) => b.start - a.start)[0];
  return child?.cwd || conn.reportedCwd || shell?.cwd || conn.spawnInfo?.cwd || os.homedir();
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

// [{pid, start, cwd}] for the shell first, then its direct children.
async function procCwds(pid) {
  if (process.platform === 'win32') {
    const out = await run(await cwdHelper(), [String(pid)]);
    return out.split(/\r?\n/).filter(Boolean).map(line => {
      const [p, start, cwd = ''] = line.split('\t');
      return { pid: Number(p), start: Number(start), cwd };
    });
  }
  if (process.platform === 'linux') {
    const info = p => {
      try {
        const stat = readFileSync(`/proc/${p}/stat`, 'utf8');
        const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
        return { pid: p, start, cwd: readlinkSync(`/proc/${p}/cwd`) };
      } catch { return { pid: p, start: 0, cwd: '' }; }
    };
    let kids = [];
    try { kids = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); }
    catch { /* kernel without the children file */ }
    return [info(pid), ...kids.map(info)];
  }
  // macOS and others: pgrep for the children, lsof for the folders. A higher
  // pid stands in for "started later".
  const kids = (await run('pgrep', ['-P', String(pid)]).catch(() => '')).split(/\s+/).filter(Boolean).map(Number);
  const out = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', [pid, ...kids].join(',')]).catch(() => '');
  const cwds = new Map();
  let cur = 0;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') cur = Number(line.slice(1));
    else if (line[0] === 'n') cwds.set(cur, line.slice(1));
  }
  return [pid, ...kids].map(p => ({ pid: p, start: p, cwd: cwds.get(p) || '' }));
}

// Windows has no command that prints another process's folder, so a small C#
// helper (scripts/cwd-helper.cs) does it. It is compiled on first use with the
// csc.exe that ships with .NET Framework 4 (in every Windows 10/11), into the
// temp folder, under a name that changes when the source changes.
let cwdHelperExe = null;
function cwdHelper() {
  cwdHelperExe ??= (async () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'cwd-helper.cs');
    const hash = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 8);
    const exe = path.join(os.tmpdir(), 'tterm-connect', `cwd-helper-${hash}.exe`);
    if (existsSync(exe)) return exe;
    mkdirSync(path.dirname(exe), { recursive: true });
    const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const tmp = `${exe}.${process.pid}.tmp`;
    await run(csc, ['-nologo', '-optimize', '-platform:x64', `-out:${tmp}`, src]);
    renameSync(tmp, exe);
    log(`compiled ${exe}`);
    return exe;
  })();
  cwdHelperExe.catch(() => { cwdHelperExe = null; }); // try again next time
  return cwdHelperExe;
}

// The folder a shell's prompt reports: OSC 7 (file://host/path, from bash,
// zsh, fish, starship) or OSC 9;9 ("C:\path", from Windows Terminal setups,
// oh-my-posh). The last one in this output chunk wins.
const OSC_CWD = /\x1b\](?:7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]*)|9;9;"?([^"\x07\x1b]*)"?)(?:\x07|\x1b\\)/g;
function trackReportedCwd(conn, text) {
  if (!text.includes('\x1b]')) return;
  for (const m of text.matchAll(OSC_CWD)) {
    let dir = m[2];
    if (m[1] != null) {
      try { dir = decodeURIComponent(m[1]); } catch { dir = m[1]; }
      if (process.platform === 'win32') dir = dir.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
    }
    if (dir) conn.reportedCwd = dir;
  }
}

function bufferOutput(conn, buf) {
  conn.buffer.push(buf);
  conn.bufferSize += buf.length;
  conn.dirty = true;
  while (conn.bufferSize > conn.bufferMax && conn.buffer.length > 1) {
    conn.bufferSize -= conn.buffer.shift().length;
  }
}

function replayBuffer(conn, sessionId) {
  if (conn.dc?.readyState !== 'open' || conn.bufferSize === 0) return;
  const all = Buffer.concat(conn.buffer);
  for (let i = 0; i < all.length; i += CHUNK) {
    if (!safeSend(conn, sessionId, all.subarray(i, Math.min(i + CHUNK, all.length)))) return;
  }
}

// The browser may send a `preset` alongside `start`: { shell, args, cwd, env, bufferBytes }
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
  const env = { ...process.env };
  // Windows apps send ESC[3J (clear scrollback) only to a terminal they know
  // handles VT, and Windows Terminal is the one they look for: Claude Code's
  // /rewind and /clear wipe the screen but left the old chat in scrollback.
  // The browser's xterm handles ESC[3J, and ConPTY passes it through.
  if (process.platform === 'win32' && !env.WT_SESSION) env.WT_SESSION = randomUUID();
  if (preset?.env && typeof preset.env === 'object') {
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
      // Windows: use the ConPTY that ships with node-pty, not the one built
      // into Windows (or winpty on old builds, see the top of this file), so
      // every Windows version passes a large paste whole.
      useConptyDll: process.platform === 'win32',
    });
  } catch (err) {
    log(`session ${sid(sessionId)}: spawn failed for ${shell}: ${err.message}`);
    safeSend(conn, sessionId, JSON.stringify({ type: 'exit', code: -1, error: `couldn't start ${shell}: ${err.message}` }));
    closeConn(sessionId, 'spawn failed');
    return;
  }
  conn.bufferMax = bufferMaxFor(preset);
  // What a restore after a connector restart needs to start the same shell.
  conn.spawnInfo = { preset: { shell, args, env: preset?.env ?? null, bufferBytes: conn.bufferMax }, cwd };
  conn.metaSaved = false;
  log(`session ${sid(sessionId)}: spawned ${shell}${args.length ? ' ' + args.join(' ') : ''} (${cols}x${rows}) in ${cwd}`);
  conn.pty.onData(data => {
    trackReportedCwd(conn, data);
    const buf = Buffer.from(data, 'utf8');
    bufferOutput(conn, buf);
    safeSend(conn, sessionId, buf);
  });
  conn.pty.onExit(({ exitCode }) => {
    log(`session ${sid(sessionId)}: shell exited (${exitCode})`);
    safeSend(conn, sessionId, JSON.stringify({ type: 'exit', code: exitCode }));
    conn.pty = null;
    closeConn(sessionId, 'shell exit');
  });
}

// Connection lost but the shell (or a restored session) stays, awaiting reattach.
function detachConn(sessionId, reason) {
  const conn = conns.get(sessionId);
  if (!conn) return;
  if (!conn.pty && !conn.restored) return closeConn(sessionId, reason);
  if (conn.detachedAt) return; // already detached
  conn.detachedAt = Date.now();
  try { conn.dc?.close(); } catch { /* already closed */ }
  try { conn.pc?.close(); } catch { /* already closed */ }
  conn.dc = null;
  hubSend({ type: 'setAttached', sessionId, attached: false });
  log(`session ${sid(sessionId)}: detached (${reason}) — ${conn.hidden
    ? `spare kept for ${SPARE_GRACE_MS / 60000} min` : 'shell kept until closed'}`);
}

function closeConn(sessionId, reason) {
  const conn = conns.get(sessionId);
  if (!conn) return;
  conns.delete(sessionId);
  log(`session ${sid(sessionId)}: closed (${reason})`);
  try { conn.pty?.kill(); } catch { /* already dead */ }
  try { conn.dc?.close(); } catch { /* already closed */ }
  try { conn.pc?.close(); } catch { /* already closed */ }
  dropState(sessionId);
  hubSend({ type: 'closeSession', sessionId });
}

// Shutdown keeps the sessions: save their output, kill the shells, and leave
// the hub rows in place so the next start can restore them.
process.on('SIGINT', () => {
  log('shutting down — sessions are saved for the next start');
  flushState();
  for (const conn of conns.values()) {
    try { conn.pty?.kill(); } catch { /* already dead */ }
  }
  process.exit(0);
});

// Last line of defence: one bad session must not take every shell down.
process.on('uncaughtException', err => {
  log('uncaught error (agent keeps running):', err?.stack || err);
});

main();
