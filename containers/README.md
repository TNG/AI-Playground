# AI Playground — Container

This directory contains files to run AI Playground as a Docker container on Linux. The app window appears on desktop exactly as it does on a baremetal install.

---

## How it works (architecture)

AI Playground is an **Electron desktop app** that manages five Python backend services as child processes. The containerization approach wraps the entire stack — Electron shell and all backends — in a single Docker container, then forwards the Electron window to the host desktop via the X11 Unix socket.

```
┌─────────────────────────────────────────────────────────────┐
│  Docker container  (ai-playground)                          │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Electron (PID 1)  ←  X11 socket → Host Desktop     │   │
│  │    │                                                 │   │
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
| Python service backend | Inside container (Docker volume venv) |
| Home agent | Inside container (Docker volume venv) |
| ComfyUI + Python venv | Inside container (Docker volume venv) |
| llama.cpp server binary | Inside container (Docker volume) |
| OpenVINO / OVMS binary | Inside container (Docker volume) |
| AI models | Docker volume `aipg-data` |
| Generated images/videos | Docker volume `aipg-media` |
| App settings & logs | Docker volume `aipg-data` |

The only host resources accessed are:
- `/tmp/.X11-unix` — display socket (read-only, no install)
- `~/.Xauthority` — display cookie (read-only, no install)
- `/dev/dri` — GPU device node (passthrough, no install)

### How data paths work

| Default (baremetal) | Container |
|---|---|
| `$XDG_DATA_HOME/ai-playground/resources` | Same — we set `XDG_DATA_HOME=/aipg-data` in container env |
| `$HOME/AI-Playground/media` | Same — we mount Docker volume at `/root/AI-Playground/media` |
| Bind to `127.0.0.1` | Same — `network_mode: host` makes loopback identical |
| Calls `pkexec apt-get` for missing GPU libs | All libs pre-installed in image → `getMissingPackages()` returns `[]` → pkexec never called |

---

## Prerequisites

- Linux host with Docker installed (Docker Engine 24+ or Docker Desktop)
- An X11 desktop session (GNOME, KDE, XFCE, etc.)
- For Intel GPU acceleration: Intel Arc / Xe GPU with `/dev/dri/renderD*` nodes

### Install Docker (if needed)
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker   # or log out and back in
```

---

## Quick start

```bash
# From the repo root — detects display, proxy, GPU, generates .env, builds image on first run
./containers/run.sh
```

That's it. On first run the image builds (~10 min). On subsequent runs it starts in seconds. The app window appears on desktop and the setup wizard runs exactly as on a baremetal install.

### What `run.sh` does
1. Checks Docker is running
2. Auto-detects `DISPLAY`, `XAUTHORITY`, proxy settings, and GPU group IDs
3. Writes `containers/.env` (used by docker compose)
4. Builds the image if it doesn't exist (or if `--build` is passed)
5. Ensures the `aipg-data` Docker volume exists
6. Runs `docker compose up --detach`

---

## All commands

### Via `run.sh` (recommended)
```bash
# Launch (auto-build on first run, instant on subsequent runs)
./containers/run.sh

# Force rebuild image (after source code changes)
./containers/run.sh --build

# Follow live logs
./containers/run.sh --logs

# Stop the container
./containers/run.sh --stop

# Full uninstall: stops container, removes image AND all data volumes
# WARNING: this deletes all downloaded backends, models, and logs
./containers/run.sh --uninstall
```

### Via `docker compose` directly (after `run.sh` has generated `.env`)
```bash
# Start
docker compose -f containers/docker-compose.yml up -d

# Stop
docker compose -f containers/docker-compose.yml down

# Live logs
docker compose -f containers/docker-compose.yml logs -f

# Container status
docker compose -f containers/docker-compose.yml ps

# Rebuild image
docker compose -f containers/docker-compose.yml build
```

---

## Data persistence

All runtime data lives in Docker named volumes that survive container restarts and image rebuilds.

| Volume | Mount point in container | Contents |
|---|---|---|
| `aipg-data` | `/aipg-data` | Python venvs (ComfyUI, llama.cpp, service, home-agent, OpenVINO), AI models, app settings, logs |
| `aipg-media` | `/root/AI-Playground/media` | Generated images and videos from ComfyUI |
| `aipg-electron-config` | `/root/.config/ai-playground` | Electron window state, UI preferences |

### Reuse an existing baremetal install
If you already have AIPG installed on the same machine and want to avoid re-downloading backends and models:
```bash
# Copy your existing data into the Docker volume (one-time)
docker volume create aipg-data
docker run --rm \
  -v ~/.local/share/ai-playground:/src:ro \
  -v aipg-data:/dst \
  ubuntu:24.04 cp -a /src/. /dst/
```
Then launch normally with `./containers/run.sh` — nothing re-downloads.

### Backup and restore
```bash
# Backup
docker run --rm -v aipg-data:/data -v $(pwd):/backup ubuntu:24.04 \
  tar czf /backup/aipg-data-backup.tar.gz -C /data .

# Restore
docker run --rm -v aipg-data:/data -v $(pwd):/backup ubuntu:24.04 \
  tar xzf /backup/aipg-data-backup.tar.gz -C /data
```

---

## Intel GPU acceleration

On machines with an Intel Arc or Xe GPU the container automatically selects GPU-accelerated backend variants (ComfyUI XPU, llama.cpp Vulkan). The kernel driver stays on the host; only the userspace libraries (Level Zero, Vulkan) are installed inside the image.

### Verify GPU is visible inside the container
```bash
docker exec ai-playground ls /dev/dri/
# Should show: card0  renderD128  (renderD128 is required for compute)
```

### If GPU is not detected
Install the Intel GPU compute runtime on the **host** (the container only needs the userspace libs, which are already in the image):
```bash
# Ubuntu 24.04 host
sudo apt-get install -y intel-gpu-tools
# Then verify: sudo intel_gpu_top
```
See [docs/linux-intel-gpu-setup.md](../docs/linux-intel-gpu-setup.md) for full instructions.

### Intel NPU (optional)
Uncomment the NPU device line in `docker-compose.yml`:
```yaml
devices:
  - /dev/dri:/dev/dri
  - /dev/accel/accel0:/dev/accel/accel0   # ← uncomment
```

---

## Behind a corporate proxy

`run.sh` auto-detects proxy settings from `http_proxy`/`https_proxy` environment variables and forwards them into both the image build and the running container (for model downloads and backend installation). No manual configuration needed if your shell proxy vars are already set.

To set them permanently:
```bash
export http_proxy="http://proxy.example.com:port"
export https_proxy="http://proxy.example.com:port"
export no_proxy="localhost,127.0.0.1"  # hosts to reach directly
./containers/run.sh
```

---

## Baremetal vs container — switching modes

Both modes are fully supported and share the same base. No flag or code change is needed to switch:

| Mode | How to run | Data location |
|---|---|---|
| **Baremetal** | Launch the installed `AI Playground` app or `.deb` | `~/.local/share/ai-playground` |
| **Container** | `./containers/run.sh` | Docker volume `aipg-data` |

To share models between both modes (avoid double downloads), point the container at the baremetal data directory as described in the "**Reuse an existing baremetal install**" section above.

---

## Troubleshooting

### App window does not appear
```bash
# Allow local Docker containers to connect to your X display
xhost +local:docker

# Verify the display variable
echo $DISPLAY   # should be :0, :1, :1024, etc.

# Run with explicit display
DISPLAY=:0 ./containers/run.sh
```

### "Failed to connect to socket /run/dbus/system_bus_socket"
These errors in `docker logs ai-playground` are harmless. They come from Chromium's C++ startup code probing for the system D-Bus (which doesn't exist in a container without systemd). A session D-Bus is started by the entrypoint — Electron's application features work correctly. The system bus errors do not affect any functionality.

### View detailed logs
```bash
./containers/run.sh --logs
# or
docker exec ai-playground cat /aipg-data/ai-playground/resources/aip-$(date +%Y-%m-%d).log
```

### Reset everything and start fresh
```bash
./containers/run.sh --uninstall
docker volume create aipg-data   # re-create empty volume
./containers/run.sh               # fresh install
```
