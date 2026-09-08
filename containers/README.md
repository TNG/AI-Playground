# AI Playground — Containerization

This document covers everything about running AI Playground in Docker on Linux: how it works, why
it's built this way, how to use it, and what's still outstanding. It replaces what used to be three
separate documents (`containers/README.md`, `containers/CHANGES_JUSTIFICATION.md`,
`docs/containerization-architecture.md`) — this is the only one.

---

## 1. What this is

AI Playground is an **Electron desktop app** that manages five Python backend services as child
processes. Containerization wraps the entire stack — Electron shell and all backends — in a single
Docker image, unchanged, and supports it in two modes:

- **Desktop mode** (default) — the Electron window is forwarded to the host's X11 display. The app
  looks and behaves exactly as it does on a bare-metal install.
- **Headless mode** — for hosts with no display at all (servers, VMs, remote workstations reachable
  only over SSH). The same built Vue.js frontend is served over HTTP instead of forwarding a window.

```
┌─────────────────────────────────────────────────────────────┐
│  Docker container  (ai-playground)                          │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Electron (PID 1)  ←  X11 socket → Host Desktop     │   │
│  │    │              (or: HTTP :8080, headless mode)    │   │
│  │    ├── service/     Flask API  :59000  (uv venv)     │   │
│  │    ├── home-agent/  Flask API  :58000  (uv venv)     │   │
│  │    ├── ComfyUI/     Python server :49xxx (uv venv)   │   │
│  │    ├── LlamaCPP/    llama-server  :8xxx  (binary)    │   │
│  │    └── OpenVINO/    OVMS server   :9xxx  (binary)    │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ aipg-data   │  │  aipg-media  │  │ aipg-electron-    │  │
│  │ (volume)    │  │  (volume)    │  │ config (volume)   │  │
│  │ venvs+models│  │ images+videos│  │ window state      │  │
│  └─────────────┘  └──────────────┘  └───────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │                                       │
    /dev/dri (Intel GPU passthrough)    /tmp/.X11-unix (display)
```

### What is containerized

| What | Where it runs |
|---|---|
| Electron shell | Inside container |
| Python service backend, home agent, ComfyUI, llama.cpp, OpenVINO/OVMS | Inside container (Docker volume venvs/binaries) |
| AI models, generated media, app settings & logs | Docker volumes (`aipg-data`, `aipg-media`) |

The only host resources touched are `/tmp/.X11-unix` and `~/.Xauthority` (read-only, desktop mode
only) and `/dev/dri` (GPU device passthrough). Nothing is installed on the host.

---

## 2. Why it's built this way

The goal was to run AI Playground on machines with no native install — CI runners, shared dev boxes,
remote Intel workstations — **without changing how the app behaves for the Windows desktop users it
primarily ships to.** That produced three constraints that shaped every decision below:

1. The app is not modified to suit the container — the container adapts to the app.
2. Intel GPU/NPU acceleration must keep working through to the Python backends.
3. Windows desktop is the shipping target and must be provably unaffected (see
   ["Desktop safety"](#desktop-safety) below).

### Image build: installs the real `.deb`, not a copied source tree

[`Dockerfile`](Dockerfile) is a two-stage build. Stage 1 (`node:22-bookworm`) runs the repo's own
build (`npm ci`, `npm run build:linux`) to produce the same `.deb` electron-builder already ships.
Stage 2 (`ubuntu:24.04`) installs that `.deb` plus Intel GPU/NPU userspace libraries and Chromium/X11
runtime deps. Building the real artifact means there's no container-specific packaging path that
could drift from the released one, and `build/build-config.json` stays the single source of truth
(this branch changes none of it). The trade-off is a heavier build (full `npm ci` + electron-builder
inside Docker) — accepted because a divergent second packaging path is a more expensive problem than
a slow build.

ComfyUI's clone/venv, the llama.cpp binary, the OpenVINO/OVMS tarball, and all AI models are **not**
baked into the image — they download into a Docker volume on first use, same as bare metal. This
keeps the image around 1 GB instead of tens of GB, and — more importantly — exercises the real setup
wizard and install code paths rather than bypassing them.

### GPU compute-runtime version pinning — the single most consequential decision in the image

The kernel driver stays on the host; the container ships only matching **userspace** libraries
(Level Zero, Vulkan) through bind-mounted `/dev/dri`. The obvious approach — installing
`level-zero`/`libze-intel-gpu1`/`intel-opencl-icd` from Intel's "unified" apt repo — only ever carries
the repo's current latest build, with no way to pin against it. That produced **version skew**
against the host's kernel driver: a reproducible `SIGSEGV` inside
`torch.nn.Module.load_state_dict` → `comfy/sd.py:load_checkpoint_guess_config`, killing the ComfyUI
backend on every XPU checkpoint load. It looked like an application bug; it wasn't.

The fix installs exact-version `.deb`s directly from the upstream GitHub releases of
[level-zero](https://github.com/oneapi-src/level-zero),
[intel-graphics-compiler](https://github.com/intel/intel-graphics-compiler), and
[compute-runtime](https://github.com/intel/compute-runtime), exposed as build args
(`GPU_LEVEL_ZERO_VERSION`, `GPU_COMPUTE_RUNTIME_TAG`, `GPU_COMPUTE_RUNTIME_BUILD`, `GPU_IGC_VERSION`,
`GPU_IGC_BUILD`, `GPU_GMMLIB_VERSION`) so they can be matched to the host. Defaults match a
verified-working host (kernel `6.18-intel`); check `dpkg -l | grep -E 'libze1|libze-intel-gpu1|intel-opencl-icd'`
on the host and override if different. When bumping `GPU_COMPUTE_RUNTIME_TAG`, IGC and GMMLIB must
bump together — they're a matched set per the release's "Additional components" list. This is worth
the manual-maintenance cost because a future failure of this kind is now diagnosable by comparing six
build args against `dpkg -l`, instead of bisecting a segfault inside PyTorch.

### `AIPG_CONTAINER=1` — overriding the install-path writability probe

[`aipgRoot.ts`](../WebUI/electron/aipgRoot.ts) decides where installs/models live by probing whether
`process.resourcesPath` is writable — correct on Windows (detects UAC-virtualized installs), wrong
inside the container, which **runs as root**. Root can write into the image's ephemeral layer, so the
probe returned "writable", the app used it directly, and **every backend install and downloaded model
was silently discarded on the next image rebuild.** `AIPG_CONTAINER=1`, set only in the Dockerfile,
short-circuits the probe to `false`, inserted above the original body so the desktop path is
byte-identical. An explicit env signal was chosen over teaching the probe about container-layer
semantics, which it has no business knowing.

### Two modes, and why headless exists

X11 forwarding needs a display to forward to, which servers/VMs frequently don't have, and is
unpleasant over a slow link even when possible. Headless mode
(`AIPG_HEADLESS=1`, `--headless`) skips `BrowserWindow` and serves the built Vue bundle over HTTP via
[`headlessServer.ts`](../WebUI/electron/headlessServer.ts) instead — a far better fit for remote use
than Xvfb + VNC, which ships pixels instead of the app, is bandwidth-hungry, and has worse input
latency than serving the web app that's already sitting inside the Electron bundle.

### The headless bridge

The Vue frontend normally talks to Electron's main process via `window.electronAPI` (injected by
`preload.ts` over `ipcRenderer`). A plain browser has neither, so four gaps are bridged, each a
distinct mechanism:

- **Control plane (REST mirror).** [`electron-api-polyfill.js`](../WebUI/public/electron-api-polyfill.js)
  reimplements `window.electronAPI` over `fetch`; `registerAllApiHandlers()` in `main.ts` mirrors each
  `ipcMain.handle(...)` as an `/api/<handlerName>` endpoint. **This mirror is the main maintenance
  liability of this design**: cherry-picking the original headless commit produced *zero* merge
  conflicts here while being substantially broken, because the surrounding lines hadn't changed —
  only the APIs being called had (renamed `PathsManager` methods, reshaped response payloads, changed
  arities). `vue-tsc` caught the type-level breaks; the rest only surfaced by running the app. The
  mitigation: whenever a handler's body is non-trivial, **extract a shared `resolve*()` implementation**
  so the desktop handler and the REST mirror can't diverge (see `resolveInitialPage()`,
  `resolveEnsureOvmsImageReady()`, `resolveGetOvmsImageServerUrl()` in `main.ts`).
- **Push events (SSE).** Backend progress (`serviceInfoUpdate`, `serviceSetUpProgress`) normally goes
  through `win.webContents.send(...)`. Headless mode builds a duck-typed `BrowserWindow` stub whose
  `webContents.send` routes to `broadcastSSE()`; the browser subscribes via `/api/events`. SSE was
  chosen over WebSockets because the traffic is one-directional and SSE reconnects on its own — but
  it's lossier than IPC: a dropped terminal event used to hang the setup wizard forever on an install
  that had actually finished. `backendServices.ts` now polls real service status as a backstop,
  **gated behind `isHeadlessBridge`** because Electron's IPC cannot lose the event and racing it on
  desktop would be harmful.
- **Direct backend calls (reverse proxy).** Chat completions fetch a backend's `baseUrl`
  (`http://127.0.0.1:39000`, etc.) directly from the renderer — which means the *browser's* loopback
  in headless mode, breaking over an SSH tunnel. `/api/proxy/<serviceName>/<path>` resolves the
  service's real `baseUrl` server-side and streams through; `toHeadlessSafeBaseUrl()` in
  [`loopbackAuth.ts`](../WebUI/src/lib/loopbackAuth.ts) does the rewrite (no-op when not headless).
  ComfyUI additionally needs a WebSocket relay, implemented as a raw TCP relay on the HTTP server's
  `upgrade` event.
- **Media.** The `aipg-media://` custom protocol only exists inside Electron; headless mode serves the
  same files over `/api/media/<path>`. `mediaUrl()` / `isAipgMediaUrl()` in
  [`utils.ts`](../WebUI/src/lib/utils.ts) pick the right form and reuse
  `getLocalPathFromAipgMediaUrl()` for path-traversal safety, so both transports share one guarantee
  instead of two that can disagree.

### Desktop safety

Every change outside `containers/` was audited against: *does this alter behaviour on a normal
Windows desktop launch?*

**Guards that never reach desktop:** `AIPG_CONTAINER=1` (set only by the Dockerfile), `--headless` /
`AIPG_HEADLESS` (set only by `entrypoint.sh`), `isHeadlessBridge` (`preload.ts` always sets `false`;
only the browser polyfill sets `true`).

**Confirmed unchanged for a normal Windows launch:** `aipgRoot.ts`'s probe body, `main.ts`'s lifecycle
handlers (`requestSingleInstanceLock`, `second-instance`, `activate`, `before-quit`, `quit`,
`registerSchemesAsPrivileged`) and the `aipg-media://` protocol handler are untouched; the extracted
`resolve*` helpers are verbatim copies of the previous inline bodies; `build/build-config.json` is
byte-identical to `dev` (the only Windows-artifact effect is an inert ~17 KB polyfill file now shipping
inside the asar, referenced by nothing in the packaged desktop app).

**Shared changes narrowed to avoid reaching desktop:**
- `comfyUIBackendService.ts`'s `restrictPyprojectToHostPlatform()` is now Linux-only — its regex
  matched Windows too, which would have let `uv` resolve different dependency versions for Windows
  users since the bundled lockfile is deleted and re-resolved fresh.
- `backendServices.ts`'s setup-status poll (the SSE backstop above) is gated on `isHeadlessBridge` —
  several backends transit a `stopped` state mid-install, and sampling that on desktop could report
  success on a half-finished install.
- `main.ts`'s `safeStorage` plaintext fallback is gated on `isHeadless` — `isEncryptionAvailable()` can
  read `false` transiently on real desktop Linux (e.g. autostart before the keyring is up); acting on
  that would silently and permanently downgrade saved chat tokens/passwords.

**Shared fixes kept as genuine cross-platform improvements** (affect desktop, intentionally):
`openVINOBackendService.ts`'s `waitForChatRouteServable()` (OVMS's readiness endpoint reports ready
up to ~20s before `/v3/chat/completions` actually stops 404ing) and its TTS spawn env
(now built via `buildOvmsEnv()` like every other OVMS call site); `comfyUiPresets.ts`'s WebSocket URL
provider (fixes a dead-token infinite-reconnect loop after a ComfyUI restart) and closed-socket
handling (was a silent no-op, now reconnects/surfaces an error); `chatModel.ts`'s (the shared chat
model factory, formerly inline in `openAiCompatibleChat.ts`) mid-turn model-id restamping and
connection-refused retries; `setupWizard.ts`'s `readyToStart` (an interrupted install
could get stuck permanently); `clientAPI.ts`/`env.d.ts` making `window.chrome` optional.

---

## 3. Using it

### Prerequisites
- Linux host with Docker installed (Docker Engine 24+ or Docker Desktop)
- An X11 desktop session (GNOME, KDE, XFCE, etc.) for desktop mode
- For Intel GPU acceleration: Intel Arc / Xe GPU with `/dev/dri/renderD*` nodes

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker   # or log out and back in
```

### Quick start
```bash
# From the repo root — detects display, proxy, GPU, generates .env, builds image on first run
./containers/run.sh
```
On first run the image builds (~10 min); subsequent runs start in seconds. `run.sh`: checks Docker is
running, auto-detects `DISPLAY`/`XAUTHORITY`/proxy/GPU group IDs, writes `containers/.env`, builds the
image if needed, ensures the `aipg-data` volume exists, and runs `docker compose up --detach`.

### All commands
```bash
./containers/run.sh              # launch (auto-build on first run)
./containers/run.sh --build      # force rebuild image (after source changes)
./containers/run.sh --logs       # follow live logs
./containers/run.sh --stop       # stop the container
./containers/run.sh --uninstall  # stop + remove image AND all data volumes (destructive)

# Or via docker compose directly, once run.sh has generated .env:
docker compose -f containers/docker-compose.yml {up -d|down|logs -f|ps|build}
```

### Data persistence

| Volume | Mount point | Contents |
|---|---|---|
| `aipg-data` | `/aipg-data` | Python venvs, backend installs, models, app settings, logs |
| `aipg-media` | `/root/AI-Playground/media` | Generated images/videos |
| `aipg-electron-config` | `/root/.config/ai-playground` | Electron window state, UI prefs |

`aipg-data` is declared `external: true` so Compose never tries to create or warn about it — including
when pointed at an existing bare-metal data directory, in which case nothing re-downloads:
```bash
docker volume create aipg-data
docker run --rm -v ~/.local/share/ai-playground:/src:ro -v aipg-data:/dst \
  ubuntu:24.04 cp -a /src/. /dst/
./containers/run.sh   # nothing re-downloads
```
Backup/restore:
```bash
docker run --rm -v aipg-data:/data -v $(pwd):/backup ubuntu:24.04 tar czf /backup/aipg-data-backup.tar.gz -C /data .
docker run --rm -v aipg-data:/data -v $(pwd):/backup ubuntu:24.04 tar xzf /backup/aipg-data-backup.tar.gz -C /data
```

### Intel GPU acceleration
The container auto-selects GPU-accelerated backend variants (ComfyUI XPU, llama.cpp Vulkan) when an
Intel Arc/Xe GPU is present.
```bash
docker exec ai-playground ls /dev/dri/   # expect: card0  renderD128
```
If not detected, install `intel-gpu-tools` on the **host** (container only needs userspace libs,
already in the image). See [`docs/linux-intel-gpu-setup.md`](../docs/linux-intel-gpu-setup.md).

Intel NPU is optional and off by default — uncomment `/dev/accel/accel0` under `devices:` in
`docker-compose.yml` to enable it.

### Behind a corporate proxy
`run.sh` auto-detects `http_proxy`/`https_proxy`/`no_proxy` and forwards them into both the image
build and the running container. If `no_proxy` excludes `.intel.com` (common on Intel corporate
networks), `run.sh` strips that pattern for the image build only, so the build reaches
`repositories.intel.com` through the proxy instead of hanging trying to reach it directly.

For TLS-intercepting proxies (re-signed HTTPS), point at the corporate CA:
```bash
export AIPG_EXTRA_CA_CERT="/path/to/corp-ca.pem"
./containers/run.sh --build
```
(`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` are also checked, in
that order, as fallbacks.)

### Troubleshooting

- **App window doesn't appear:** `xhost +local:docker`, confirm `echo $DISPLAY`, or run
  `DISPLAY=:0 ./containers/run.sh` explicitly.
- **`Failed to connect to socket /run/dbus/system_bus_socket` in logs:** harmless — Chromium probing
  for a system D-Bus that doesn't exist in a container without systemd. A session D-Bus (started by
  the entrypoint) handles Electron's actual needs.
- **Logs:** `./containers/run.sh --logs` or
  `docker exec ai-playground cat /aipg-data/ai-playground/resources/aip-$(date +%Y-%m-%d).log`.
- **Reset everything:** `./containers/run.sh --uninstall && docker volume create aipg-data && ./containers/run.sh`.

---

## 4. Verification performed

Static checks, run against this branch **after** the rebase onto current `dev` (via `node:22-bookworm`,
matching the Dockerfile's builder stage, since this sandbox has no local Node):

| Check | Result |
|---|---|
| `npm run type-check` (`vue-tsc` + `tsc -p tsconfig.node.json`) | clean |
| `npm run lint:ci` (`eslint .`) | clean |
| `npm run format:ci` (`prettier --check .`) | clean, except one pre-existing violation in `SetupWizardGroup.vue` — untouched by this branch, already present on `dev` |
| `npm test` (`vitest run`) | 1019/1021 passing. The 2 failures (`piToolOperations.test.ts`, `workspacePreviewServer.test.ts`) reproduce identically on plain `dev` run the same way — they assume a non-root user can be denied a filesystem write via `chmod`, which doesn't hold running as root inside the verification container; not a regression from this branch |
| Merge-conflict marker scan | none |

The rebase itself surfaced and fixed one real instance of API-mirror drift (see "The headless
bridge" in §2): the REST
mirror's `getInitSetting` still returned a removed `isAdminExec` field, and `getThemeSettings` mirrored
a handler that no longer exists on the desktop side at all (theming is now client-side only) — both
were caught by `type-check`, not by the rebase producing a conflict.

Runtime verification against a live container (headless mode, performed on the pre-rebase branch
state — the container/headless-bridge code paths touched by the rebase's conflict resolutions were
re-read line-by-line above but not re-run in a live container after rebasing):

| Check | Result |
|---|---|
| Backend services | all six `running`, `isSetUp=true` |
| ComfyUI image generation on `xpu:0` | succeeds, ~20s for 512×512 / 6 steps |
| `SIGSEGV` / `Fatal Python error` in 48h of logs | none |
| Container GPU driver versions vs host | exact match on all three packages |
| Reverse proxy | ComfyUI `/queue`, `/prompt`, `/history`, `/object_info`; `ai-backend` health, all OK |
| `/api/media/` | 200 for percent-encoded/nested paths; 404 on all path-traversal attempts (`../`, `%2e%2e%2f`, unencoded) |
| Persistence | `AIPG_CONTAINER=1` + `XDG_DATA_HOME=/aipg-data` active; installs survive an image rebuild |

**A fresh container boot (both desktop and headless) against the current rebased tree should still
gate merge** — see §5.

---

## 5. What's missing / not yet done

- **Neither mode has been booted in a live container against the current, rebased tree.** Static
  checks (§4) ran clean post-rebase, and the merge itself was reviewed line-by-line, but the last
  actual container boot (backend startup, ComfyUI generation, reverse proxy, media serving) predates
  the rebase. A fresh headless boot, an X11 desktop run, and ideally a Windows build/launch should all
  gate merge.
- **`waitForChatRouteServable()` adds a real inference round-trip to every OVMS LLM launch.** OVMS is
  the default LLM backend on Intel Windows hardware, so this latency lands there too, not just in the
  container. Worth confirming against the renderer's existing readiness/retry budgets before release
  — it was added to fix the container but is not container-gated (see §2, "kept on purpose").
- **Intel NPU passthrough is opt-in and untested in this pass.** The `/dev/accel/accel0` device line
  in `docker-compose.yml` is commented out by default; enabling it has not been verified end-to-end.
- **electron-builder's native-packaging step was not exercised end-to-end.** The Linux image build
  succeeded through all Vite bundles; the final electron-builder step hit an unrelated network 504
  through the sandbox's proxy. Should be confirmed once outside that sandbox.
- **GPU compute-runtime version pins require manual maintenance.** They're matched to one verified host
  (kernel `6.18-intel`) and must be bumped by hand — as a set — when either the host driver or the
  upstream releases move. There's no automated check that the pinned versions still match a given
  host; `dpkg -l` on the host is the manual source of truth (§2).
- **The REST/SSE mirror (`registerAllApiHandlers()`) is a standing maintenance liability**, not a
  one-time fix. It can drift silently from the real `ipcMain` handlers with zero merge conflicts,
  because a text diff can't see "the API this call site depends on changed shape." The `resolve*()`
  shared-implementation pattern (§2) mitigates new drift but doesn't retroactively guarantee the
  ~74 currently-mirrored handlers (of 129 total `ipcMain.handle` registrations) stay correct as the
  app evolves.

---

## 6. Working on this

- **Adding an `ipcMain.handle`?** Add the matching `registerApiHandler` mirror in `main.ts`, and if the
  body is non-trivial, extract a shared `resolve*()` function rather than copying it — the two sides
  have drifted before without producing a single merge conflict.
- **Fetching a backend's `baseUrl` from the renderer?** Route it through `toHeadlessSafeBaseUrl()`.
  Every direct-call site found so far was a separate bug.
- **Referencing generated media?** Use `mediaUrl()` to build URLs and `isAipgMediaUrl()` to test them.
  Don't compare against `'aipg-media://'` directly.
- **Adding a container-motivated change to shared code?** Gate it, or justify it as a genuine
  cross-platform improvement in the PR description. `isHeadlessBridge` (renderer), `isHeadless` (main),
  and `AIPG_CONTAINER` (env) are the three available guards.
- **ComfyUI segfaulting on checkpoint load?** Compare the six `GPU_*` build args in the Dockerfile
  against `dpkg -l | grep -E 'libze1|libze-intel-gpu1|intel-opencl-icd'` on the host before looking at
  application code.
