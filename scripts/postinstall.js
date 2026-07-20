// Ensure node-pty's `spawn-helper` is executable after install.
//
// On macOS/Linux, node-pty doesn't exec your shell directly — it execs a small
// bundled `spawn-helper` binary and passes the shell as an argument. If that
// helper has lost its executable bit (common when `node_modules` is copied or
// synced from Windows, which has no Unix permission bits), `posix_spawn` fails
// with EACCES and node-pty reports the opaque error "posix_spawnp failed." —
// making every session die at spawn. Restoring the bit here keeps installs that
// travel across machines from silently breaking.
//
// No-op on Windows (ConPTY, no helper) and harmless if the bit is already set.
import { chmodSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

if (process.platform === 'win32') process.exit(0);

const here = dirname(fileURLToPath(import.meta.url));
const nodePty = join(here, '..', 'node_modules', 'node-pty');

const candidates = [
  join(nodePty, 'build', 'Release', 'spawn-helper'),
  join(nodePty, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
];

for (const p of candidates) {
  if (!existsSync(p)) continue;
  try {
    const mode = statSync(p).mode;
    if ((mode & 0o111) === 0o111) continue; // already executable for all
    chmodSync(p, mode | 0o755);
    console.log(`tterm-connect: made ${p} executable`);
  } catch (err) {
    console.warn(`tterm-connect: could not chmod ${p}: ${err.message}`);
  }
}
