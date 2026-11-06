// Generates the winsw daemon files for the tterm-connect Windows service into
// ./daemon: the wrapper executable, its .NET runtime config, and the service
// descriptor XML.
//
// Registration is left to scripts/service-setup.ps1, which has to be elevated
// anyway and also sets the logon account. node-windows is used only as the
// source of the winsw binary; its own Service class is deliberately not used —
// it emits a <serviceaccount> block naming a nonexistent <host>\LocalSystem
// account, and an extra supervising node process that adds a failure mode
// without buying anything the SCM's own restart actions don't already give us.
//
// The endpoint URL and token go in as <env> entries rather than command-line
// arguments so the token never appears in the process list (see README
// "Configuration").
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'service.config.json');
const daemonDir = path.join(root, 'daemon');
const winswDir = path.join(root, 'node_modules', 'node-windows', 'bin', 'winsw');

if (!existsSync(configPath)) {
  console.error(`missing ${configPath}`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
if (!cfg.endpointUrl || !cfg.token) {
  console.error(`${configPath} needs both "endpointUrl" and "token"`);
  process.exit(1);
}

const displayName = cfg.serviceName || 'tterm-connect';
// Service id / wrapper basename: winsw looks for <basename>.xml next to itself.
const id = displayName.replace(/[^\w]/g, '').toLowerCase();

const script = path.join(root, 'index.js');
if (!existsSync(script)) {
  console.error(`missing ${script}`);
  process.exit(1);
}

// Pin the interpreter. nvm4w's C:\nvm4w\nodejs shim retargets on `nvm use`, and
// node-pty / node-datachannel are native modules built against one ABI.
const nodeExe = path.resolve(cfg.nodePath || process.execPath);
if (!existsSync(nodeExe)) {
  console.error(`node interpreter not found: ${nodeExe}`);
  process.exit(1);
}

const esc = s => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// winsw 1.17 schema. <onfailure> entries become the SCM's failure actions;
// service-setup.ps1 additionally sets failureflag so they also fire when the
// process exits cleanly.
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<service>
\t<id>${esc(id)}</id>
\t<name>${esc(displayName)}</name>
\t<description>tterm connector - bridges a browser terminal to a real shell over WebRTC.</description>
\t<executable>${esc(nodeExe)}</executable>
\t<argument>${esc(script)}</argument>
\t<workingdirectory>${esc(root)}</workingdirectory>
\t<startmode>Automatic</startmode>
\t<env name="TTERM_ENDPOINT_URL" value="${esc(cfg.endpointUrl)}"/>
\t<env name="TTERM_TOKEN" value="${esc(cfg.token)}"/>
\t<logmode>roll</logmode>
\t<onfailure action="restart" delay="5 sec"/>
\t<onfailure action="restart" delay="20 sec"/>
\t<onfailure action="restart" delay="60 sec"/>
\t<resetfailure>1 hour</resetfailure>
\t<stoptimeout>15 sec</stoptimeout>
</service>
`;

mkdirSync(daemonDir, { recursive: true });

const wrapperExe = path.join(daemonDir, `${id}.exe`);
copyFileSync(path.join(winswDir, 'winsw.exe'), wrapperExe);
copyFileSync(path.join(winswDir, 'winsw.exe.config'), `${wrapperExe}.config`);

const xmlPath = path.join(daemonDir, `${id}.xml`);
writeFileSync(xmlPath, xml, 'utf8');

// Machine-readable tail for service-setup.ps1.
console.log(`wrapper: ${wrapperExe}`);
console.log(`config : ${xmlPath}`);
console.log(`SERVICE_ID=${id}`);
