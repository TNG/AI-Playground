#!/usr/bin/env bash
# AI Playground — Container Launcher
#
# Usage (from repo root or containers/ directory):
#   ./containers/run.sh              Launch (auto-build image on first run)
#   ./containers/run.sh --build      Force rebuild image, then launch
#   ./containers/run.sh --logs       Follow live container logs
#   ./containers/run.sh --stop       Stop the running container
#   ./containers/run.sh --uninstall  Stop + remove container, image, ALL data volumes
#
# Under the hood this is a thin wrapper around `docker compose`.
# All AIPG runtime data (Python venvs, backends, models, logs) lives in
# Docker named volumes and survives container restarts and image rebuilds.
#
# To use docker compose directly (after run.sh has generated .env once):
#   docker compose -f containers/docker-compose.yml up -d
#   docker compose -f containers/docker-compose.yml down
#   docker compose -f containers/docker-compose.yml logs -f

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
IMAGE="ai-playground:latest"
FORCE_BUILD=false

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# ── Subcommands ────────────────────────────────────────────────────────────────
case "${1:-}" in
  --logs)
    exec docker logs -f ai-playground
    ;;
  --stop)
    compose stop && ok "Stopped." || warn "Container not running."
    exit 0
    ;;
  --uninstall)
    echo "Stopping and removing container..."
    compose down 2>/dev/null || true
    echo "Removing image..."
    docker rmi "$IMAGE" 2>/dev/null || true
    echo "Removing ALL data volumes (backends, models, logs will be deleted)..."
    docker volume rm aipg-data aipg-media aipg-electron-config 2>/dev/null || true
    ok "AI Playground fully uninstalled."
    exit 0
    ;;
  --build)
    FORCE_BUILD=true
    ;;
  -h|--help)
    sed -n '3,13p' "$0" | sed 's/^# \?//'
    exit 0
    ;;
  "")
    ;;
  *)
    fail "Unknown argument: $1. Use --help for usage."
    ;;
esac

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  AI Playground — Container Launcher${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── 1. Docker ──────────────────────────────────────────────────────────────────
command -v docker &>/dev/null || fail "Docker not installed.
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker \$USER && newgrp docker"

docker info &>/dev/null || fail "Docker daemon not running or no permission.
  sudo systemctl start docker
  sudo usermod -aG docker \$USER && newgrp docker"

ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

# ── 2. X11 display ─────────────────────────────────────────────────────────────
DETECTED_DISPLAY="${DISPLAY:-}"
if [ -z "$DETECTED_DISPLAY" ]; then
    DETECTED_DISPLAY=$(loginctl show-session \
        "$(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}' | head -1)" \
        2>/dev/null | grep -i "^Display=" | cut -d= -f2 || true)
fi
if [ -z "$DETECTED_DISPLAY" ]; then
    DETECTED_DISPLAY=$(ls /tmp/.X11-unix/X* 2>/dev/null | head -1 | sed 's|/tmp/.X11-unix/X|:|')
fi
[ -n "$DETECTED_DISPLAY" ] || fail "No X11 display found.
  Run from a desktop terminal, or: DISPLAY=:0 ./containers/run.sh"
ok "Display: $DETECTED_DISPLAY"

# ── 3. X authority ─────────────────────────────────────────────────────────────
DETECTED_XAUTH="${XAUTHORITY:-}"
if [ -z "$DETECTED_XAUTH" ] || [ ! -f "$DETECTED_XAUTH" ]; then
    [ -f "$HOME/.Xauthority" ] && DETECTED_XAUTH="$HOME/.Xauthority" || \
    DETECTED_XAUTH=$(ps -eo args 2>/dev/null | grep -oP -- '-auth \K\S+' | head -1 || true)
fi
if [ -n "$DETECTED_XAUTH" ] && [ -f "$DETECTED_XAUTH" ]; then
    ok "Xauthority: $DETECTED_XAUTH"
else
    warn "No .Xauthority found — relying on xhost only"
    DETECTED_XAUTH="$HOME/.Xauthority"   # compose needs a path even if absent
fi

# ── 4. Proxy ───────────────────────────────────────────────────────────────────
HTTP_PROXY_VAL="${http_proxy:-${HTTP_PROXY:-}}"
HTTPS_PROXY_VAL="${https_proxy:-${HTTPS_PROXY:-}}"
NO_PROXY_VAL="${no_proxy:-${NO_PROXY:-}}"
FTP_PROXY_VAL="${ftp_proxy:-}"
[ -n "$HTTP_PROXY_VAL" ] && ok "Proxy: $HTTP_PROXY_VAL"

# ── 5. GPU / NPU device groups ─────────────────────────────────────────────────
VIDEO_GID=""
RENDER_GID=""
if [ -d /dev/dri ]; then
    N=$(ls /dev/dri/renderD* 2>/dev/null | wc -l)
    ok "Intel GPU: $N render node(s) under /dev/dri"
    VIDEO_GID=$(getent group video  2>/dev/null | cut -d: -f3 || echo "44")
    RENDER_GID=$(getent group render 2>/dev/null | cut -d: -f3 || echo "992")
else
    warn "No /dev/dri — GPU unavailable (CPU-only mode). See docs/linux-intel-gpu-setup.md"
fi

NPU_DEVICE=""
if [ -e /dev/accel/accel0 ]; then
    ok "Intel NPU: /dev/accel/accel0 found"
    NPU_DEVICE="/dev/accel/accel0"
fi

# ── 6. Write .env (used by docker compose) ─────────────────────────────────────
# .env is re-generated on every launch so display/proxy/GPU values are always
# current. It is .gitignored — do not edit by hand; use .env.example as reference.
cat > "$ENV_FILE" <<EOF
# Auto-generated by run.sh — do not edit manually.
# Copy .env.example for manual overrides.
DISPLAY=${DETECTED_DISPLAY}
XAUTHORITY=${DETECTED_XAUTH}
http_proxy=${HTTP_PROXY_VAL}
https_proxy=${HTTPS_PROXY_VAL}
HTTP_PROXY=${HTTP_PROXY_VAL}
HTTPS_PROXY=${HTTPS_PROXY_VAL}
no_proxy=${NO_PROXY_VAL}
NO_PROXY=${NO_PROXY_VAL}
ftp_proxy=${FTP_PROXY_VAL}
UV_HTTP_PROXY=${HTTP_PROXY_VAL}
UV_HTTPS_PROXY=${HTTPS_PROXY_VAL}
VIDEO_GID=${VIDEO_GID:-44}
RENDER_GID=${RENDER_GID:-992}
EOF

# ── 7. Build image if needed ───────────────────────────────────────────────────
if $FORCE_BUILD || ! docker image inspect "$IMAGE" &>/dev/null; then
    echo ""
    echo "Building container image (first time: ~15–20 min on proxy networks)..."
    compose build
    ok "Image built: $IMAGE"
fi
# aipg-data is declared external in docker-compose.yml so Compose won't
# auto-create it. Ensure it exists before `compose up` runs.
docker volume inspect aipg-data &>/dev/null || docker volume create aipg-data
# ── 8. X11 access permission ───────────────────────────────────────────────────
xhost +local:docker &>/dev/null \
    && ok "X11: local Docker containers allowed" \
    || warn "xhost failed — display may not work (try: xhost +local:docker)"

# ── 9. Stop existing instance (clean restart) ──────────────────────────────────
compose down 2>/dev/null || true

# ── 10. Launch ─────────────────────────────────────────────────────────────────
echo ""
echo "Starting AI Playground..."
echo "  Image:       $IMAGE"
echo "  Display:     $DETECTED_DISPLAY"
echo "  Data volume: aipg-data  (backends + venvs + models)"
echo "  Media:       aipg-media (generated images/videos)"
echo ""

compose up --detach

echo ""
ok "AI Playground is running  (container: ai-playground)"
echo ""
echo "  Live logs:    ./containers/run.sh --logs"
echo "  Stop:         ./containers/run.sh --stop"
echo "  Uninstall:    ./containers/run.sh --uninstall"
echo ""
echo "  Or use docker compose directly (after .env is generated above):"
echo "    docker compose -f containers/docker-compose.yml logs -f"
echo "    docker compose -f containers/docker-compose.yml down"
echo ""
