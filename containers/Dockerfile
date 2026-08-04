# AI Playground — Multi-stage container image
#
# Stage 1 (builder): builds the .deb from source inside Docker using Node.js 22.
# Stage 2 (runtime): lean Ubuntu 24.04 image that installs the .deb + GPU libs.
#
# What this image contains (~800 MB – 1.1 GB compressed):
#   • Ubuntu 24.04 runtime + Intel GPU/NPU userspace libs + X11 display deps
#   • dbus (session bus) for Electron notifications
#   • The AIPG .deb built from source (Electron shell + Python backend configs)
#
# What is NOT baked in (installed at runtime into Docker named volumes):
#   • ComfyUI git clone + Python venv  — installed by app on first use
#   • llama.cpp binary                 — downloaded from GitHub on first use
#   • OpenVINO / OVMS tarball          — downloaded on first use
#   • AI models                        — downloaded from HuggingFace on first use
#
# If you already have a baremetal AIPG data directory you can reuse it:
#   set AIPG_DATA_DIR in .env to that path and nothing re-downloads.
#
# Build:   docker compose -f containers/docker-compose.yml build
# Launch:  ./containers/run.sh              (detects display, proxy, GPU)
# Or:      docker compose -f containers/docker-compose.yml up -d  (if .env is set)

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
# Using node:22-bookworm image — Node 22 LTS + npm are pre-installed.
# This is more reliable than installing Node via NodeSource curl|bash, which is
# fragile behind corporate proxies and caused build failures on first attempt.
FROM node:22-bookworm AS builder

ENV DEBIAN_FRONTEND=noninteractive

# Proxy args — forwarded from host environment during `docker compose build`.
# Required for apt-get, npm install, and git clone inside RUN steps.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG http_proxy
ARG https_proxy
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    http_proxy=${http_proxy} \
    https_proxy=${https_proxy} \
    NO_PROXY=${NO_PROXY}

# Extra build tools needed by electron-builder for .deb packaging.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 python3-venv \
    gcc g++ build-essential \
    rpm \
    fakeroot \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# .dockerignore (repo root) excludes node_modules, build outputs, runtime data
# directories (ComfyUI/, LlamaCPP/, models/, python-interpreter/) and .env.
# OpenVINO/ SOURCE FILES (*.py, pyproject.toml, uv.lock) ARE included because
# electron-builder bundles them as extraResources in build-config.json.
COPY . .

# npm ci   — installs exact versions from package-lock.json
# fetch-external-resources — downloads uv binary, 7-Zip, Electron binaries
# build:linux — runs electron-builder → produces .deb at build/electron/*.deb
RUN cd WebUI \
    && npm ci \
    && npm run fetch-external-resources \
    && npm run build:linux

# Copy .deb to a predictable name for Stage 2 to pick up
RUN find /build/build/electron -name "*.deb" | head -1 | xargs -I{} cp {} /build/aipg.deb

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM ubuntu:24.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# Proxy args forwarded for apt-get / curl during image build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG http_proxy
ARG https_proxy
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    http_proxy=${http_proxy} \
    https_proxy=${https_proxy} \
    NO_PROXY=${NO_PROXY}

# ── 1. System packages ────────────────────────────────────────────────────────
# Electron / Chromium runtime deps (match build-config.json deb.depends).
# X11 libs enable window forwarding to the host display via Unix socket.
# python3-dev + build-essential allow uv to compile source-only wheels (e.g.
# insightface) without needing extra system package installs at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libdbus-1-3 \
    libgtk-3-0 \
    libnss3 \
    libasound2t64 \
    pciutils \
    python3-dev \
    libnuma1 \
    libpython3.12t64 \
    libx11-6 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libxkbcommon0 \
    x11-utils \
    xauth \
    libcap2 \
    git \
    python3 \
    python3-venv \
    gcc \
    g++ \
    build-essential \
    curl \
    ca-certificates \
    gnupg \
    gpg-agent \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Intel GPU userspace libraries + D-Bus ─────────────────────────────────
# Level Zero (ComfyUI XPU, OpenVINO GPU), OpenCL (OpenVINO fallback),
# Vulkan (llama.cpp GPU build). GPU kernel driver stays on the HOST;
# container accesses via /dev/dri bind-mount.
# D-Bus (session bus) is started by the entrypoint so Electron can use
# notifications and system integration without constant error-log spam.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gpg-agent curl ca-certificates \
    dbus \
    && curl -fsSL https://repositories.intel.com/gpu/intel-graphics.key \
       | gpg --dearmor --output /usr/share/keyrings/intel-graphics.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] \
       https://repositories.intel.com/gpu/ubuntu noble unified" \
       > /etc/apt/sources.list.d/intel-gpu-noble.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    level-zero \
    libze-intel-gpu1 \
    intel-opencl-icd \
    libvulkan1 \
    mesa-vulkan-drivers \
    && rm -rf /var/lib/apt/lists/*

# ── 3. Intel NPU userspace driver ─────────────────────────────────────────────
# The intel_vpu kernel module stays on the HOST. This installs the matching
# userspace libraries so OpenVINO can enumerate the NPU device.
# Default versions match ENIB (kernel 6.18-intel). Override via build args if
# your host kernel uses a different intel_vpu version.
# Check installed version on host: dpkg -l | grep intel-level-zero-npu
ARG NPU_VERSION=v1.32.0
ARG NPU_BUILD=v1.32.0.20260402-23905121947
RUN apt-get update \
    && cd /tmp \
    && curl -fL \
       "https://github.com/intel/linux-npu-driver/releases/download/${NPU_VERSION}/linux-npu-driver-${NPU_BUILD}-ubuntu2404.tar.gz" \
       -o linux-npu-driver.tar.gz \
    && mkdir -p linux-npu-driver \
    && tar -xzf linux-npu-driver.tar.gz -C linux-npu-driver \
    && apt-get install -y --no-install-recommends \
       ./linux-npu-driver/intel-driver-compiler-npu_*.deb \
       ./linux-npu-driver/intel-fw-npu_*.deb \
       ./linux-npu-driver/intel-level-zero-npu_*.deb \
    && rm -rf /tmp/linux-npu-driver* \
    && rm -rf /var/lib/apt/lists/*

# ── 4. Install AIPG .deb (built in Stage 1) ───────────────────────────────────
COPY --from=builder /build/aipg.deb /tmp/aipg.deb
RUN apt-get update \
    && apt-get install -y --no-install-recommends /tmp/aipg.deb \
    && rm /tmp/aipg.deb \
    && rm -rf /var/lib/apt/lists/*

# ── 5. Runtime environment ────────────────────────────────────────────────────
# /aipg-data is a Docker named volume bind-mounted at runtime.
# XDG_DATA_HOME redirects writableLinuxRoot() (aipgRoot.ts) into the volume:
#   /aipg-data/ai-playground/resources/  ← Python venvs, models, logs, config
ENV XDG_DATA_HOME=/aipg-data
VOLUME /aipg-data

ENV PYTHONIOENCODING=utf-8
ENV PYTHONNOUSERSITE=true
# Disable Chromium GPU compositor for the UI chrome (does not affect AI compute
# via /dev/dri — Level Zero / Vulkan are unaffected by this flag).
ENV ELECTRON_DISABLE_GPU=1

# ── 6. Entrypoint ─────────────────────────────────────────────────────────────
COPY containers/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
