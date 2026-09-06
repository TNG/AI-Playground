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
#
# libze1/libze-intel-gpu1/intel-opencl-icd are downloaded as exact-version .deb
# packages straight from their upstream GitHub releases, NOT the Intel "unified"
# apt repo — that repo only ever carries its current latest build, so a version
# pin against it isn't satisfiable (confirmed: repo's newest is 25.18.33578.15,
# it does not carry newer releases like the 26.27.x below at all). A
# compute-runtime userspace older than what the host's kernel driver expects
# reproducibly segfaults ComfyUI deep in torch's XPU load_state_dict path (seen
# as SIGSEGV loading a checkpoint) — version skew, not an app bug. Defaults
# below match a verified-working host (kernel 6.18-intel). Override via build
# args if your host runs different driver versions. Check installed versions on
# host: dpkg -l | grep -E 'libze1|libze-intel-gpu1|intel-opencl-icd'. When
# bumping GPU_COMPUTE_RUNTIME_TAG/BUILD, also update GPU_IGC_VERSION/BUILD and
# GPU_GMMLIB_VERSION to the "Additional components" listed on that
# compute-runtime release's GitHub page (github.com/intel/compute-runtime/releases).
ARG GPU_LEVEL_ZERO_VERSION=1.32.0
ARG GPU_COMPUTE_RUNTIME_TAG=26.27.39122.11
ARG GPU_COMPUTE_RUNTIME_BUILD=26.27.39122.11-0
ARG GPU_IGC_VERSION=v2.38.2
ARG GPU_IGC_BUILD=2.38.2+22051
ARG GPU_GMMLIB_VERSION=22.10.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus \
    libvulkan1 \
    mesa-vulkan-drivers \
    && mkdir -p /tmp/intel-gpu-runtime && cd /tmp/intel-gpu-runtime \
    && curl -fLO "https://github.com/oneapi-src/level-zero/releases/download/v${GPU_LEVEL_ZERO_VERSION}/libze1_${GPU_LEVEL_ZERO_VERSION}+u24.04_amd64.deb" \
    && curl -fLO "https://github.com/intel/intel-graphics-compiler/releases/download/${GPU_IGC_VERSION}/intel-igc-core-2_${GPU_IGC_BUILD}_amd64.deb" \
    && curl -fLO "https://github.com/intel/intel-graphics-compiler/releases/download/${GPU_IGC_VERSION}/intel-igc-opencl-2_${GPU_IGC_BUILD}_amd64.deb" \
    && curl -fLO "https://github.com/intel/compute-runtime/releases/download/${GPU_COMPUTE_RUNTIME_TAG}/libigdgmm12_${GPU_GMMLIB_VERSION}_amd64.deb" \
    && curl -fLO "https://github.com/intel/compute-runtime/releases/download/${GPU_COMPUTE_RUNTIME_TAG}/libze-intel-gpu1_${GPU_COMPUTE_RUNTIME_BUILD}_amd64.deb" \
    && curl -fLO "https://github.com/intel/compute-runtime/releases/download/${GPU_COMPUTE_RUNTIME_TAG}/intel-opencl-icd_${GPU_COMPUTE_RUNTIME_BUILD}_amd64.deb" \
    && apt-get install -y --no-install-recommends ./*.deb \
    && rm -rf /tmp/intel-gpu-runtime \
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

# ── 4b. Optional corporate CA certificate ─────────────────────────────────────
# Some corporate networks TLS-intercept outbound HTTPS (the proxy re-signs
# traffic with an internal CA). If so, the app's own downloads at runtime
# (e.g. the llama.cpp binary from GitHub) fail with ERR_CERT_AUTHORITY_INVALID
# because this image only trusts the public Mozilla CA bundle. run.sh copies a
# CA cert into containers/ca-certs/ when AIPG_EXTRA_CA_CERT (or the usual
# NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE env
# vars) point at one; the directory is empty otherwise, so this is a no-op for
# everyone else.
COPY containers/ca-certs/ /usr/local/share/ca-certificates/extra/
RUN update-ca-certificates

# ── 5. Runtime environment ────────────────────────────────────────────────────
# /aipg-data is a Docker named volume bind-mounted at runtime.
# XDG_DATA_HOME redirects packagedResourcesRoot()'s writable-user-root (aipgRoot.ts)
# into the volume: /aipg-data/ai-playground/resources/ ← Python venvs, models, logs, config
#
# AIPG_CONTAINER tells aipgRoot.ts to use that redirected root unconditionally.
# Without it, aipgRoot.ts's writability probe on process.resourcesPath (the
# /opt/AI Playground/resources install dir) succeeds — this container runs as
# root, which can write there even though it's baked into the image's ephemeral
# layer — so the app would use it directly instead of XDG_DATA_HOME, silently
# losing every backend install and downloaded model on the next image rebuild.
ENV XDG_DATA_HOME=/aipg-data
ENV AIPG_CONTAINER=1
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
