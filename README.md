# tterm-connect

The **tterm** connector. Install it on any machine you want to reach, and that
machine shows up in your [tterm.dev](https://tterm.dev) server list — ready to
open a real terminal in your browser.

- **No open ports.** The connector only makes outbound connections.
- **Peer-to-peer.** Your keystrokes and terminal output travel directly between
  your browser and this machine over WebRTC — never through tterm's servers.
- **Real shell.** PowerShell on Windows (via ConPTY), your login shell on
  Linux/macOS. Full-screen apps like `vim`, `htop`, and `top` just work.

---

## 1. Prerequisites

- **[Node.js 20+](https://nodejs.org/)** and **git**. That's it — the native
  bits (`node-pty`, `node-datachannel`) install as prebuilt binaries, so no
  compiler or build tools are needed on most systems.

Check you have them:

```sh
node -v   # v20 or newer
git --version
```

## 2. Get your connect details

In the tterm web app: **sign in → Add server → copy the command.** It contains
two values you'll paste below:

- `<TTERM_ENDPOINT_URL>` — the deployment URL
- `<TOKEN>` — a one-time device token (64 hex characters, shown once)

## 3. Install & run — one line

Replace `<TTERM_ENDPOINT_URL>` and `<TOKEN>` with the values from step 2. (Also replace
the clone URL with wherever you host this repo.)

### 🐧 Linux

```bash
git clone https://github.com/YOUR-ORG/tterm-connect.git && cd tterm-connect && npm install && node index.js --endpointUrl <TTERM_ENDPOINT_URL> --token <TOKEN>
```

### 🍎 macOS

```bash
git clone https://github.com/YOUR-ORG/tterm-connect.git && cd tterm-connect && npm install && node index.js --endpointUrl <TTERM_ENDPOINT_URL> --token <TOKEN>
```

### 🪟 Windows (PowerShell)

```powershell
git clone https://github.com/YOUR-ORG/tterm-connect.git; cd tterm-connect; npm install; node index.js --endpointUrl <TTERM_ENDPOINT_URL> --token <TOKEN>
```

Within a few seconds the machine turns **online** in your tterm server list.
Select it, press **Enter**, and you're in.

> **Already have the folder?** Skip the clone:
> `npm install && node index.js --endpointUrl <TTERM_ENDPOINT_URL> --token <TOKEN>`

## 4. Keep it running (optional)

The commands above run in the foreground. To keep the connector alive across
reboots and logouts, the easiest cross-platform option is
[pm2](https://pm2.keymetrics.io/):

```sh
npm install -g pm2
pm2 start index.js --name tterm -- --endpointUrl <TTERM_ENDPOINT_URL> --token <TOKEN>
pm2 save && pm2 startup    # follow the printed instructions to enable at boot
```

Native alternatives: **systemd** service on Linux, **launchd** agent on macOS,
or **Task Scheduler / NSSM** on Windows.

## Configuration

Flags can also be supplied as environment variables — **preferred for the
token**, since a command-line argument is visible to other users on the machine
via the process list.

| Flag | Env var | Meaning |
|------|---------|---------|
| `--endpointUrl <url>` | `TTERM_ENDPOINT_URL` | Your tterm deployment URL |
| `--token <token>` | `TTERM_TOKEN` | Device token from **Add server** (only its sha256 is ever sent) |
| `--shell <path>` | `TTERM_SHELL` | Override the shell. Default: `powershell.exe` on Windows, `$SHELL` (or `/bin/bash`) elsewhere |

Environment-variable form:

```bash
# Linux / macOS
TTERM_ENDPOINT_URL=<TTERM_ENDPOINT_URL> TTERM_TOKEN=<TOKEN> node index.js
```

```powershell
# Windows (PowerShell)
$env:TTERM_ENDPOINT_URL="<TTERM_ENDPOINT_URL>"; $env:TTERM_TOKEN="<TOKEN>"; node index.js
```

## Good to know

- **The token is the key to a shell on this machine** — anyone who has it can
  open a terminal here as your user. Treat it like an SSH private key. If it
  leaks, remove the server in the web app (that revokes the token) and add it
  again for a fresh one.
- Shells **survive brief disconnects**: close the browser tab and the shell
  stays alive for 15 minutes with recent output buffered, so reconnecting drops
  you right back where you were.
- The connector inherits the environment and permissions of whoever runs it.
  Run it as the user (and with the privileges) you actually want the remote
  terminal to have.

## License

MIT.
