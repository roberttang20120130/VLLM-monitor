# vLLM Monitor

A cross-platform desktop app (Linux / Windows / macOS) for monitoring **multiple vLLM inference servers at once** from a single window.

For each server it shows, live:

- **Generation tokens/sec** and **Prompt tokens/sec** (computed from vLLM's token counters)
- **Running / Waiting (queue) / Swapped** request counts
- **GPU KV-cache usage** percentage
- **TTFT** (time-to-first-token) and **TPOT** (time-per-output-token) histogram means

Add a server by entering its **address + API key** once; the list and keys are **persisted locally** (encrypted at rest via the OS keychain) so you never re-enter them.

---

## Requirements

- [Node.js](https://nodejs.org) 18+ (Node 22 LTS recommended; the app uses the built-in `fetch`).

No Python, no GPU, no vLLM install needed on the monitoring machine — the app only *talks to* vLLM over HTTP.

## Install dependencies


for linux:
```terminal
sudo dpkg -i vllm-monitor_1.0.0_amd64_ubuntu_debian.deb
```


> **China / slow registry:** use the npmmirror mirror:
> ```bash
> npm config set registry https://registry.npmmirror.com
> export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
> npm install
> ```

## Run (dev)

```bash
npm start
```

Then click **+ Add server** and enter:
- **Name** — anything, e.g. `prod-gpu-01`
- **vLLM server URL** — e.g. `http://10.0.0.5:8000`
- **API key** — the value passed to vLLM's `--api-key`. Leave empty if your server has no key.
- **Poll interval** — seconds (default 2)

Your vLLM server must expose:
- `GET /get_server_info` (JSON; queue lengths + vLLM-reported throughput)
- `GET /metrics` (Prometheus exposition text)

Both are on by default on the API port. If you run vLLM with a **separate metrics port** (`--metrics-port`), set the optional **Metrics URL** field to that host:port.

### Try it without a real vLLM server

A mock server ships in `mock/`:

```bash
npm run mock
```

This starts two fake vLLM servers:
- `http://localhost:9001` — no auth
- `http://localhost:9002` — API key `test-secret-key`

Add both in the app to see multi-server monitoring, live tok/s, queue counts, and the scrolling chart.

## Build installers

```bash
npm run dist:linux   # AppImage + .deb
npm run dist:win     # NSIS .exe installer
npm run dist:mac     # .zip containing the .app bundle
npm run dist         # build for the current OS
```

Artifacts land in `dist/`.

### Linux: the app won't open when I click it?

#### Recommended: install the `.deb` (this works by click)

Ubuntu 24.04+ blocks unprivileged user namespaces by default (AppArmor's
`apparmor_restrict_unprivileged_userns=1`), which forces Chromium/Electron to
use the **setuid sandbox** via a bundled `chrome-sandbox` helper. That helper
must be owned by root and have the SUID bit (mode `4755`). The `.deb`'s install
script does exactly this — it detects that user namespaces are unavailable and
runs `chmod 4755` on `chrome-sandbox`. So after a normal install, the app
launches from your application menu by click:

```bash
sudo dpkg -i dist/vllm-monitor_1.0.0_amd64.deb
```

Then open it from your app menu (search "vLLM Monitor"). The relevant postinst
logic (verified) is:
```bash
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '/opt/vLLM Monitor/chrome-sandbox' || true   # your case
fi
```

#### AppImage: SUID is impossible inside an AppImage

An AppImage mounts itself **read-only as your user**, so `chrome-sandbox` can
never be SUID there. With user namespaces also blocked (Ubuntu 24.04 default),
Chromium aborts at startup:

```
The SUID sandbox helper binary was found, but is not configured correctly.
Rather than run without sandboxing I'm aborting now.
```

This is **expected** for the AppImage on a default Ubuntu 24.04 box. Pick one:

1. **Run from terminal with the sandbox disabled** (simplest):
   ```bash
   ./"vLLM Monitor-1.0.0.AppImage" --no-sandbox
   ```

2. **Make AppImage double-click work** by enabling unprivileged user namespaces
   (one-time, system-wide — then Chromium uses the namespace sandbox and no
   longer needs the SUID helper):
   ```bash
   sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
   # persist across reboots:
   echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/99-userns.conf
   ```

3. **Use the `.deb` instead** (see above) — it handles the SUID bit for you.

#### Run from terminal to see the real error

```bash
./"vLLM Monitor-1.0.0.AppImage"            # AppImage (add --no-sandbox if it aborts)
"/opt/vLLM Monitor/vllm-monitor"           # deb install path
```
Any startup error prints to that terminal.


### macOS note (important)

The macOS build produces a `.zip` containing the `vLLM Monitor.app` bundle. (A `.dmg` requires the `dmg-license`/`iconv-corefoundation` modules, which are macOS-only and cannot be installed on Linux/Windows.)

Apps built on Linux or Windows are **unsigned**. macOS Gatekeeper will block them ("can't be opened" / "damaged"). To run on a Mac:

```bash
xattr -dr com.apple.quarantine "vLLM Monitor.app"
```

Or — recommended — run `npm run dist:mac` **on a Mac** (change the `mac.target` back to `"dmg"` in `package.json` for a proper installer). For distribution to others, sign + notarize the app with an Apple Developer ID.

## Security: how API keys are stored

Keys are encrypted at rest with Electron's `safeStorage`:
- **macOS** — Keychain
- **Windows** — DPAPI
- **Linux** — libsecret / GNOME Keyring

If no keyring is available (e.g. a headless Linux box without `gnome-keyring`/`libsecret`), the app **falls back to plaintext** storage and shows a yellow warning in the sidebar. To enable encryption on Linux, install and run a keyring service.

Keys are encrypted **per machine** — they are not portable across machines, and an exported config file will not decrypt elsewhere.

## How tokens/sec is computed

vLLM exposes `vllm:generation_tokens_total` and `vllm:prompt_tokens_total` as monotonically increasing **counters**. The app computes the live rate as:

```
tok/s = (counter_now - counter_prev) / (time_now - time_prev)
```

On the first poll (no previous sample) the rate is 0; on a counter reset (server restart) it re-baselines to 0 rather than producing a negative spike. The app also surfaces vLLM's own `avg_generation_throughput` / `avg_prompt_throughput` from `/get_server_info` as a cross-check.

## Project layout

```
src/
  main.js          Electron main: window, per-server polling, IPC
  preload.js       contextBridge IPC API (sandboxed renderer)
  store.js         persistent server list + encrypted keys
  vllm-client.js   HTTP client: /get_server_info + /metrics, Bearer auth
  metrics.js       Prometheus parser + tokens/sec computation
renderer/
  index.html       dashboard markup
  styles.css       dark theme
  renderer.js      sidebar, cards, canvas chart, add/edit modal
mock/
  mock-vllm.js     fake vLLM servers for testing
```
