#!/usr/bin/env bash
set -e

# ── AI Playground container entrypoint ────────────────────────────────────────
#
# Responsibilities:
#   1. Validate required bind-mounts are present (X11, data volume)
#   2. Set up XAUTHORITY so Electron can authenticate to the host X server
#   3. Start a session D-Bus daemon so Electron has notification/tray support
#   4. Dynamically resolve /dev/dri group membership (avoids hardcoded GIDs)
#   5. Exec the AIPG Electron binary with the correct environment

# ── 1. Validate display ────────────────────────────────────────────────────────
# In headless mode (AIPG_HEADLESS=1) there is no X11 display — the app runs as
# an HTTP server accessed via browser. Skip all X11 checks.
if [ "${AIPG_HEADLESS:-0}" != "1" ]; then
    if [ -z "${DISPLAY:-}" ]; then
        echo "[entrypoint] ERROR: DISPLAY is not set. Pass it from the host:"
        echo "  -e DISPLAY=\$DISPLAY  (or set DISPLAY in containers/.env)"
        exit 1
    fi
    if [ ! -d /tmp/.X11-unix ]; then
        echo "[entrypoint] ERROR: /tmp/.X11-unix is not mounted."
        echo "  Add to volumes: /tmp/.X11-unix:/tmp/.X11-unix:ro"
        exit 1
    fi
fi

# ── 2. X authority cookie ──────────────────────────────────────────────────────
if [ "${AIPG_HEADLESS:-0}" != "1" ]; then
    if [ -n "${XAUTH_PATH:-}" ] && [ -f "$XAUTH_PATH" ]; then
        export XAUTHORITY="$XAUTH_PATH"
        echo "[entrypoint] Using XAUTHORITY: $XAUTHORITY"
    fi
fi

# ── 3. D-Bus session bus ───────────────────────────────────────────────────────
# Electron/Chromium connects to the D-Bus session bus for desktop notifications,
# tray icons, and theme detection. Without it, Electron emits a constant stream
# of "Failed to connect to bus" errors. We use dbus-daemon directly because
# dbus-launch (from the dbus-x11 package) is not installed in this image.
if command -v dbus-daemon > /dev/null 2>&1; then
    _DBUS_ADDR=$(dbus-daemon --session --fork --print-address 1 2>/dev/null) || true
    if [ -n "${_DBUS_ADDR:-}" ]; then
        export DBUS_SESSION_BUS_ADDRESS="$_DBUS_ADDR"
        echo "[entrypoint] D-Bus session bus started: $DBUS_SESSION_BUS_ADDRESS"
    else
        echo "[entrypoint] WARNING: dbus-daemon failed to start — dbus errors expected in logs"
    fi
fi

# ── 4. GPU device group membership ────────────────────────────────────────────
# /dev/dri/* nodes are owned by the 'video' and 'render' groups on the host.
# GIDs differ across distros, so we resolve them at runtime from the mounted
# device nodes rather than hardcoding in docker-compose.yml group_add.
for dev in /dev/dri/renderD128 /dev/dri/card0; do
    if [ -e "$dev" ]; then
        DEV_GID=$(stat -c '%g' "$dev")
        if ! id -G | tr ' ' '\n' | grep -qx "$DEV_GID"; then
            getent group "$DEV_GID" > /dev/null 2>&1 \
                || groupadd --gid "$DEV_GID" "hostgpu_$DEV_GID" 2>/dev/null || true
            usermod -aG "$DEV_GID" "$(whoami)" 2>/dev/null || true
        fi
    fi
done

# Intel NPU device
if [ -e /dev/accel/accel0 ]; then
    NPU_GID=$(stat -c '%g' /dev/accel/accel0)
    if ! id -G | tr ' ' '\n' | grep -qx "$NPU_GID"; then
        getent group "$NPU_GID" > /dev/null 2>&1 \
            || groupadd --gid "$NPU_GID" "hostnpu_$NPU_GID" 2>/dev/null || true
        usermod -aG "$NPU_GID" "$(whoami)" 2>/dev/null || true
    fi
fi

# ── 5. Ensure data directory exists ───────────────────────────────────────────
mkdir -p /aipg-data

# ── 6. Find the AIPG executable ───────────────────────────────────────────────
# electron-builder productName="AI Playground" → installed to /opt/AI Playground/
# The packaged binary is ai-playground (the main Electron entry point).
AIPG_BIN=""
for candidate in \
    "/opt/AI Playground/ai-playground" \
    "/usr/lib/ai-playground/ai-playground" \
    "/usr/bin/ai-playground"; do
    if [ -f "$candidate" ]; then
        AIPG_BIN="$candidate"
        break
    fi
done
# Fallback: search under /opt and /usr/lib
if [ -z "$AIPG_BIN" ]; then
    AIPG_BIN=$(find /opt /usr/lib -maxdepth 3 -name "ai-playground" -type f 2>/dev/null | head -1)
fi
if [ -z "$AIPG_BIN" ]; then
    echo "[entrypoint] ERROR: Could not find ai-playground executable."
    echo "  Checked: /opt/AI Playground, /usr/lib/ai-playground, /usr/bin"
    exit 1
fi

echo "[entrypoint] Starting AI Playground: $AIPG_BIN"
echo "[entrypoint] Mode: ${AIPG_HEADLESS:+headless}${AIPG_HEADLESS:-desktop}"
echo "[entrypoint] DISPLAY=${DISPLAY:-<not set>}"
echo "[entrypoint] XDG_DATA_HOME=${XDG_DATA_HOME:-/aipg-data}"

# ── 7. Launch ──────────────────────────────────────────────────────────────────
# --no-sandbox:  required — Electron cannot use the SUID sandbox inside Docker
# --disable-gpu: software rasterizer for the Electron/Chromium UI chrome only;
#                does NOT affect Intel GPU AI compute via /dev/dri (Level Zero /
#                Vulkan are accessed through Python backends, not Chromium GPU).
# --headless:    skip BrowserWindow, serve Vue.js on http://0.0.0.0:8080 instead.
if [ "${AIPG_HEADLESS:-0}" = "1" ]; then
    echo "[entrypoint] Headless mode — open http://localhost:8080 in your browser"
    exec "$AIPG_BIN" \
        --no-sandbox \
        --disable-gpu \
        --headless \
        "$@"
else
    exec "$AIPG_BIN" \
        --no-sandbox \
        --disable-gpu \
        "$@"
fi
