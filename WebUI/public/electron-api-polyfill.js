/**
 * electron-api-polyfill.js
 *
 * Injected into index.html by headlessServer.ts when AI Playground runs in
 * --headless mode. Defines window.electronAPI using fetch (REST) and
 * EventSource (SSE) so the Vue.js frontend works identically whether it
 * runs inside Electron or in a plain web browser.
 *
 * The REST base URL defaults to the origin that served index.html, so the
 * same file works on localhost:8080, behind a reverse proxy, or remotely.
 *
 * No Vue/TypeScript tooling needed — this is plain JS injected as-is.
 */
;(function () {
  'use strict'

  // Already in Electron — preload.ts provides the real window.electronAPI.
  if (typeof window !== 'undefined' && window.electronAPI) return

  const BASE = window.location.origin

  // ── REST helper ─────────────────────────────────────────────────────────────
  function api(name, body) {
    const url =
      body && body._pathParam
        ? `${BASE}/api/${name}/${encodeURIComponent(body._pathParam)}`
        : `${BASE}/api/${name}`
    const isGet = body === undefined || body === null
    return fetch(url, {
      method: isGet ? 'GET' : 'POST',
      headers: isGet ? undefined : { 'Content-Type': 'application/json' },
      body: isGet ? undefined : JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error('API ' + name + ' failed: ' + r.status)
      return r.json()
    })
  }

  // ── SSE push events ──────────────────────────────────────────────────────────
  // Subscribers registered by onServiceInfoUpdate / onServiceSetUpProgress etc.
  var listeners = {}
  var sseSource = null

  function ensureSSE() {
    if (sseSource) return
    sseSource = new EventSource(BASE + '/api/events')
    sseSource.onmessage = function (e) {
      try {
        var msg = JSON.parse(e.data)
        var cbs = listeners[msg.channel]
        if (cbs)
          cbs.forEach(function (cb) {
            cb(msg.data)
          })
      } catch (_) {}
    }
    sseSource.onerror = function () {
      // Auto-reconnect after 3 s (server sends retry: 3000)
    }
  }

  function onChannel(channel, callback) {
    ensureSSE()
    if (!listeners[channel]) listeners[channel] = []
    listeners[channel].push(callback)
    // Return an unsubscribe function (mirrors ipcRenderer.on return)
    return function () {
      listeners[channel] = (listeners[channel] || []).filter(function (c) {
        return c !== callback
      })
    }
  }

  // ── window.electronAPI polyfill ─────────────────────────────────────────────
  window.electronAPI = {
    isHeadlessBridge: true,
    // ── Service management ──────────────────────────────────────────────────
    getServices: function () {
      return api('getServices')
    },
    startService: function (n) {
      return api('startService', { _pathParam: n })
    },
    stopService: function (n) {
      return api('stopService', { _pathParam: n })
    },
    setUpService: function (n) {
      return api('setUpService', { _pathParam: n })
    },
    uninstall: function (n) {
      return api('uninstall', { _pathParam: n })
    },
    detectDevices: function (n) {
      return api('detectDevices', { _pathParam: n })
    },
    selectDevice: function (n, id) {
      return api('selectDevice', { name: n, deviceId: id })
    },
    selectSttDevice: function (n, id) {
      return api('selectSttDevice', { name: n, deviceId: id })
    },
    updateServiceSettings: function (s) {
      return api('updateServiceSettings', s)
    },
    getBackendAuthToken: function (n) {
      return api('getBackendAuthToken', { _pathParam: n })
    },
    resolveBackendVersion: function (n) {
      return api('resolveBackendVersion', { _pathParam: n })
    },
    getInstalledBackendVersion: function (n) {
      return api('getInstalledBackendVersion', { _pathParam: n })
    },

    // ── Backend-specific ────────────────────────────────────────────────────
    // Real signature (preload.ts) is 4 positional args, not (name, opts) — the
    // previous Object.assign({name:n}, opts) silently mangled the payload
    // whenever opts was a string (llmModelName), dropping embeddingModelName
    // and contextSize entirely.
    ensureBackendReadiness: function (n, llmModelName, embeddingModelName, contextSize) {
      return api('ensureBackendReadiness', {
        name: n,
        llmModelName: llmModelName,
        embeddingModelName: embeddingModelName,
        contextSize: contextSize,
      })
    },
    ensureComfyUIBackendRunning: function () {
      return api('ensureComfyUIBackendRunning')
    },
    getComfyUiDefaultParameters: function () {
      return api('getComfyUiDefaultParameters')
    },
    getLlamaCppDefaultParameters: function () {
      return api('getLlamaCppDefaultParameters')
    },
    detectPhisonSsd: function () {
      return api('detectPhisonSsd')
    },
    detectHardwareForModeRecommendation: function () {
      return api('detectHardwareForModeRecommendation')
    },

    // ── Model management ────────────────────────────────────────────────────
    loadModels: function () {
      return api('loadModels')
    },
    updateModelPaths: function (p) {
      return api('updateModelPaths', p)
    },
    getDownloadedGGUFLLMs: function () {
      return api('getDownloadedGGUFLLMs')
    },
    getDownloadedOpenVINOLLMModels: function () {
      return api('getDownloadedOpenVINOLLMModels')
    },
    getDownloadedEmbeddingModels: function () {
      return api('getDownloadedEmbeddingModels')
    },
    getComfyUIModels: function (t) {
      return api('getComfyUIModels', { modelType: t })
    },

    // ── Settings & config ────────────────────────────────────────────────────
    getLocalSettings: function () {
      return api('getLocalSettings')
    },
    updateLocalSettings: function (u) {
      return api('updateLocalSettings', u)
    },
    getLocaleSettings: function () {
      return api('getLocaleSettings')
    },
    getInitSetting: function () {
      return api('getInitSetting')
    },
    getInitialPage: function () {
      return api('getInitialPage')
    },
    getDemoModeSettings: function () {
      return api('getDemoModeSettings')
    },
    getPlatform: function () {
      return api('getPlatform')
    },
    getGitHubRepoUrl: function () {
      return api('getGitHubRepoUrl')
    },

    // ── Presets ──────────────────────────────────────────────────────────────
    loadUserPresets: function () {
      return api('loadUserPresets')
    },
    saveUserPreset: function (c) {
      return api('saveUserPreset', { content: c })
    },
    updatePresetsFromIntelRepo: function () {
      return api('updatePresetsFromIntelRepo')
    },
    reloadPresets: function () {
      return api('reloadPresets')
    },
    getUserPresetsPath: function () {
      return api('getUserPresetsPath')
    },

    // ── Transcription / Speech / Image servers ───────────────────────────────
    startTranscriptionServer: function (m) {
      return api('startTranscriptionServer', { modelName: m })
    },
    stopTranscriptionServer: function () {
      return api('stopTranscriptionServer')
    },
    getTranscriptionServerUrl: function () {
      return api('getTranscriptionServerUrl')
    },
    startSpeechServer: function (m) {
      return api('startSpeechServer', { modelName: m })
    },
    stopSpeechServer: function () {
      return api('stopSpeechServer')
    },
    getSpeechServerUrl: function () {
      return api('getSpeechServerUrl')
    },
    stopOvmsChatServers: function () {
      return api('stopOvmsChatServers')
    },
    getEmbeddingServerUrl: function () {
      return api('getEmbeddingServerUrl')
    },
    // Real signature (preload.ts) is 4 positional args, not (name, opts) — see
    // the ensureBackendReadiness comment above for why that matters.
    ensureOvmsImageReady: function (serviceName, modelName, keepModelsLoaded, resolution) {
      return api('ensureOvmsImageReady', {
        serviceName: serviceName,
        modelName: modelName,
        keepModelsLoaded: keepModelsLoaded,
        resolution: resolution,
      })
    },
    stopOvmsImageServer: function () {
      return api('stopOvmsImageServer')
    },
    getOvmsImageServerUrl: function () {
      return api('getOvmsImageServerUrl')
    },

    // ── RAG / embeddings ─────────────────────────────────────────────────────
    addDocumentToRAGList: function (d) {
      return api('addDocumentToRAGList', d)
    },
    embedInputUsingRag: function (e) {
      return api('embedInputUsingRag', e)
    },

    // ── ComfyUI tools ────────────────────────────────────────────────────────
    // isCustomNodeInstalled/downloadCustomNode take a ComfyUICustomNodeRepoId
    // object as their whole payload (matching preload.ts) — the registerApiHandler
    // side reads it as the body itself, not nested under a wrapper key.
    comfyui: {
      openInBrowser: function () {
        return api('comfyui:openInBrowser')
      },
      isCustomNodeInstalled: function (n) {
        return api('comfyui:isCustomNodeInstalled', n)
      },
      downloadCustomNode: function (n) {
        return api('comfyui:downloadCustomNode', n)
      },
      isPackageInstalled: function (p) {
        return api('comfyui:isPackageInstalled', { packageSpecifier: p })
      },
      installPypiPackage: function (p) {
        return api('comfyui:installPypiPackage', { packageSpecifier: p })
      },
    },

    // ── MCP ──────────────────────────────────────────────────────────────────
    mcp: {
      listServers: function () {
        return api('mcp:listServers')
      },
      startServer: function (id) {
        return api('mcp:startServer', { serverId: id })
      },
      stopServer: function (id) {
        return api('mcp:stopServer', { serverId: id })
      },
      getServerStatus: function (id) {
        return api('mcp:getServerStatus', { serverId: id })
      },
      listServerTools: function (id) {
        return api('mcp:listServerTools', { serverId: id })
      },
      invokeServerTool: function (id, t, a) {
        return api('mcp:invokeServerTool', { serverId: id, toolName: t, args: a })
      },
      getServerConfig: function (id) {
        return api('mcp:getServerConfig', { serverId: id })
      },
      openConfig: function () {
        return Promise.resolve()
      }, // desktop-only no-op
      openConfigInFolder: function () {
        return Promise.resolve()
      },
    },

    // ── Home agent ───────────────────────────────────────────────────────────
    // Channel names and argument shapes here must match electron/preload.ts —
    // they were previously wrong (wrong channel prefix, wrong arg shapes,
    // savePrefs missing entirely), which 404'd every home-agent call in headless mode.
    homeAgent: {
      saveDocument: function (filename, base64) {
        return api('saveHomeAgentDocument', { filename: filename, base64: base64 })
      },
      localWeb: {
        getUrls: function (port, allowLan) {
          return api('homeAgent:localWeb:getUrls', { port: port, allowLan: allowLan })
        },
      },
      channel: {
        saveConfig: function (kind, config) {
          return api('channel:saveConfig', { kind: kind, config: config })
        },
        loadConfig: function (kind) {
          return api('channel:loadConfig', { kind: kind })
        },
        clearConfig: function (kind) {
          return api('channel:clearConfig', { kind: kind })
        },
        savePrefs: function (kind, prefs) {
          return api('channel:savePrefs', { kind: kind, prefs: prefs })
        },
        loadPrefs: function (kind) {
          return api('channel:loadPrefs', { kind: kind })
        },
        test: function (kind) {
          return api('channel:test', { kind: kind })
        },
        inject: function (kind, config) {
          return api('channel:inject', { kind: kind, config: config })
        },
        detectIdentity: function (kind, config) {
          return api('channel:detectIdentity', { kind: kind, config: config })
        },
        detectIdentityFromSaved: function (kind) {
          return api('channel:detectIdentityFromSaved', { kind: kind })
        },
        poll: function (kind) {
          return api('channel:poll', { kind: kind })
        },
        flushPending: function (kind) {
          return api('channel:flushPending', { kind: kind })
        },
        send: function (kind, action, payload) {
          return api('channel:send', { kind: kind, action: action, payload: payload })
        },
      },
    },

    // ── Web browser (embedded, desktop-only) — graceful no-ops in headless ──
    webBrowser: {
      navigate: function (_u) {
        return Promise.resolve()
      },
      readPage: function () {
        return Promise.resolve(null)
      },
      search: function (_q) {
        return Promise.resolve([])
      },
      interact: function (_i) {
        return Promise.resolve(null)
      },
      screenshot: function () {
        return Promise.resolve(null)
      },
      show: function () {
        return Promise.resolve()
      },
      hide: function () {
        return Promise.resolve()
      },
      close: function () {
        return Promise.resolve()
      },
      getState: function () {
        return Promise.resolve({ isOpen: false })
      },
      onStateChanged: function (_cb) {
        return function () {}
      },
    },

    // ── Screenshot (desktop-only) — no-ops in headless ──────────────────────
    screenshot: {
      getPermissionStatus: function () {
        return Promise.resolve({ status: 'unavailable' })
      },
      listWindows: function () {
        return Promise.resolve([])
      },
      captureWindow: function () {
        return Promise.resolve(null)
      },
      openPermissionSettings: function () {
        return Promise.resolve()
      },
    },

    // ── File dialogs — basic browser fallbacks ───────────────────────────────
    showOpenDialog: function (_opts) {
      // In browser, return null (caller must handle null = cancelled)
      return Promise.resolve({ canceled: true, filePaths: [] })
    },
    showSaveDialog: function (_opts) {
      return Promise.resolve({ canceled: true, filePath: undefined })
    },
    getFilePath: function (file) {
      // In browser, File objects have a .name but no local path
      return file ? file.name : ''
    },
    saveImage: function () {
      return Promise.resolve()
    },
    saveImageToMediaInput: function () {
      return Promise.resolve(null)
    },

    // ── Window management — browser no-ops ───────────────────────────────────
    getWinSize: function () {
      return Promise.resolve({ width: window.innerWidth, height: window.innerHeight })
    },
    setWinSize: function () {
      return Promise.resolve()
    },
    setFullScreen: function (e) {
      if (e) document.documentElement.requestFullscreen?.()
    },
    zoomIn: function () {
      return Promise.resolve()
    },
    zoomOut: function () {
      return Promise.resolve()
    },
    exitApp: function () {
      window.close()
    },
    startDrag: function () {},
    dragWinToMoveStart: function () {},
    dragWinToMove: function () {},
    dragWinToMoveStop: function () {},
    setIgnoreMouseEvents: function () {},

    // ── Push event subscriptions (backed by SSE) ─────────────────────────────
    onServiceInfoUpdate: function (cb) {
      return onChannel('serviceInfoUpdate', cb)
    },
    onServiceSetUpProgress: function (cb) {
      return onChannel('serviceSetUpProgress', cb)
    },
    onDebugLog: function (cb) {
      return onChannel('debugLog', cb)
    },
    onShowToast: function (cb) {
      return onChannel('show-toast', cb)
    },
  }

  // Also expose envVars that Electron normally injects via preload
  window.envVars = window.envVars || {
    platformTitle: 'from Intel\u00ae',
    debugToolsEnabled: false,
    productVersion: 'unknown',
  }
})()
