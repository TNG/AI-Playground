import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import pkg from '../package.json'
import type { LocalSettings } from './kernel/localSettings.ts'
import { ModelPaths } from '@/assets/js/store/models'
import { cloneForIpc } from '@/lib/cloneForIpc'
import {
  EmbedInquiry,
  IndexedDocument,
  WarmupRequest,
  PhisonKmIngestConfig,
} from '@/assets/js/store/textInference'
import type { AgentModeTurnConfig, AgentToolExecuteRequest, AgentToolSpec } from '@/types/agentIpc'
import type { AgentSessionRecordWire } from '@/types/agentSessionIpc'
import type { ArtifactRunRequest } from '@/types/artifactIpc'
import type { ChatSummarizeRequest, ChatTurnRequest } from '@/types/chatIpc'
import type { ChatAnswerPayload, ChatAskPayload } from '@/types/chatRequests'
import type { ConversationSaveRequest } from '@/types/conversationIpc'
import type { MediaRequestPayload, MediaResponsePayload } from '@/types/mediaRequests'
import type {
  PermissionGrant,
  PermissionGrantOrigin,
  PermissionsPromptPayload,
  PermissionsPromptResponse,
} from '@/types/permissionsIpc'
import type {
  ChannelArgs,
  ChannelResult,
  InvokeChannelName,
  NamespaceBridge,
  PushChannelName,
  PushPayload,
} from '@/types/ipcChannels'

function listen<T>(channel: string, callback: (data: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, data: T) => callback(data)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

function invoke<N extends InvokeChannelName>(
  channel: N,
  ...args: ChannelArgs<N>
): Promise<ChannelResult<N>> {
  return ipcRenderer.invoke(channel, ...args) as unknown as Promise<ChannelResult<N>>
}

function onPush<N extends PushChannelName>(
  channel: N,
  cb: (data: PushPayload<N>) => void,
): () => void {
  return listen(channel, cb)
}

contextBridge.exposeInMainWorld('envVars', {
  platformTitle: import.meta.env.VITE_PLATFORM_TITLE,
  debugToolsEnabled: import.meta.env.VITE_DEBUG_TOOLS === 'true',
  productVersion: pkg.version,
  // Which build this is, baked in by vite.config.mts. Empty when the source has
  // no git history (an exported tree), so the UI must treat them as optional.
  gitCommit: import.meta.env.VITE_GIT_COMMIT ?? '',
  gitTag: import.meta.env.VITE_GIT_TAG ?? '',
})
contextBridge.exposeInMainWorld('electronAPI', {
  startDrag: (fileName: string) => ipcRenderer.send('ondragstart', fileName),
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  getServices: () => invoke('getServices'),
  getBackendAuthToken: (serviceName: string) => invoke('getBackendAuthToken', serviceName),
  updateServiceSettings: (settings: ServiceSettings) => invoke('updateServiceSettings', settings),
  uninstall: (serviceName: string) => invoke('uninstall', serviceName),
  selectDevice: (serviceName: string, deviceId: string) =>
    invoke('selectDevice', serviceName, deviceId),
  selectSttDevice: (serviceName: string, deviceId: string) =>
    invoke('selectSttDevice', serviceName, deviceId),
  detectDevices: (serviceName: string) => invoke('detectDevices', serviceName),
  startService: (serviceName: string) => invoke('startService', serviceName),
  stopService: (serviceName: string) => invoke('stopService', serviceName),
  setUpService: (serviceName: BackendServiceName) => invoke('setUpService', serviceName),
  updatePresetsFromIntelRepo: () => invoke('updatePresetsFromIntelRepo'),
  reloadPresets: () => invoke('reloadPresets'),
  getUserPresetsPath: () => invoke('getUserPresetsPath'),
  loadUserPresets: () => invoke('loadUserPresets'),
  saveUserPreset: (presetContent: string) => invoke('saveUserPreset', presetContent),
  resolveBackendVersion: (serviceName: BackendServiceName) =>
    invoke('resolveBackendVersion', serviceName),
  getInstalledBackendVersion: (serviceName: BackendServiceName) =>
    invoke('getInstalledBackendVersion', serviceName),
  getGitHubRepoUrl: () => invoke('getGitHubRepoUrl'),
  openDevTools: () => ipcRenderer.send('openDevTools'),
  setVerboseAgentLogging: (enabled: boolean) => ipcRenderer.send('setVerboseAgentLogging', enabled),
  getDeveloperSettings: () => ipcRenderer.invoke('getDeveloperSettings'),
  openUrl: (url: string) => ipcRenderer.send('openUrl', url),
  getLocaleSettings: () => invoke('getLocaleSettings'),
  updateLocalSettings: (updates: Partial<LocalSettings>) => invoke('updateLocalSettings', updates),
  getLocalSettings: () => invoke('getLocalSettings'),
  detectHardwareForModeRecommendation: () => invoke('detectHardwareForModeRecommendation'),
  getWinSize: () => ipcRenderer.invoke('getWinSize'),
  setWinSize: (width: number, height: number) => ipcRenderer.invoke('setWinSize', width, height),
  showSaveDialog: (options: Electron.SaveDialogOptions) =>
    ipcRenderer.invoke('showSaveDialog', options),
  showMessageBox: (options: Electron.MessageBoxOptions) =>
    ipcRenderer.invoke('showMessageBox', options),
  showMessageBoxSync: (options: Electron.MessageBoxSyncOptions) =>
    ipcRenderer.invoke('showMessageBox', options),
  dragWinToMoveStart: (x: number, y: number) => ipcRenderer.send('dragWinToMoveStart', x, y),
  dragWinToMove: (x: number, y: number) => ipcRenderer.send('dragWinToMove', x, y),
  dragWinToMoveStop: () => ipcRenderer.send('dragWinToMoveStop'),
  setIgnoreMouseEvents: (igrnore: boolean) => ipcRenderer.send('setIgnoreMouseEvents', igrnore),
  miniWindow: () => ipcRenderer.send('miniWindow'),
  exitApp: () => ipcRenderer.send('exitApp'),
  getInitialPage: () => invoke('getInitialPage'),
  getDemoModeSettings: () => invoke('getDemoModeSettings'),
  showOpenDialog: (options: Electron.OpenDialogOptions) =>
    ipcRenderer.invoke('showOpenDialog', options),
  saveImage: (url: string) => ipcRenderer.send('saveImage', url),
  saveImageToMediaInput: (dataUri: string) => ipcRenderer.invoke('saveImageToMediaInput', dataUri),
  saveAudioToMediaInput: (dataUri: string) => ipcRenderer.invoke('saveAudioToMediaInput', dataUri),
  saveGeneratedAudio: (audioBase64: string, filename: string, options?: { overwrite?: boolean }) =>
    ipcRenderer.invoke('saveGeneratedAudio', audioBase64, filename, options),
  readLocalAudioAsDataUri: (filePath: string) =>
    ipcRenderer.invoke('readLocalAudioAsDataUri', filePath),
  deleteGeneratedAudio: (filePath: string) => ipcRenderer.invoke('deleteGeneratedAudio', filePath),
  readAipgMediaAsBase64: (url: string) => ipcRenderer.invoke('readAipgMediaAsBase64', url),
  openImageWin: (url: string, title: string, width: number, height: number) =>
    ipcRenderer.send('openImageWin', url, title, width, height),
  screenChange: (callback: (width: number, height: number) => void) =>
    ipcRenderer.on('display-metrics-changed', (_event, width: number, height: number) =>
      callback(width, height),
    ),
  existsPath: (path: string) => invoke('existsPath', path),
  addDocumentToRAGList: (doc: IndexedDocument, phisonKmConfig?: PhisonKmIngestConfig) =>
    invoke('addDocumentToRAGList', doc, phisonKmConfig),
  embedInputUsingRag: (embedInquiry: EmbedInquiry) => invoke('embedInputUsingRag', embedInquiry),
  warmupKVCacheForDocument: (request: WarmupRequest) => invoke('warmupKVCacheForDocument', request),
  getEmbeddingServerUrl: (serviceName: string) => invoke('getEmbeddingServerUrl', serviceName),
  ensureEmbeddingServerReady: (serviceName: string, embeddingModelName: string) =>
    invoke('ensureEmbeddingServerReady', serviceName, embeddingModelName),
  getInitSetting: () => invoke('getInitSetting'),
  updateModelPaths: (modelPaths: ModelPaths) => invoke('updateModelPaths', modelPaths),
  restorePathsSettings: () => invoke('restorePathsSettings'),
  loadModels: () => invoke('loadModels'),
  getLaminarConfig: () => invoke('getLaminarConfig'),
  laminarTelemetryEvent: (name: string, payload: string) =>
    ipcRenderer.send('laminarTelemetryEvent', name, payload),
  zoomIn: () => ipcRenderer.invoke('zoomIn'),
  zoomOut: () => ipcRenderer.invoke('zoomOut'),
  getDownloadedGGUFLLMs: () => invoke('getDownloadedGGUFLLMs'),
  getDownloadedOpenVINOLLMModels: () => invoke('getDownloadedOpenVINOLLMModels'),
  getDownloadedEmbeddingModels: () => invoke('getDownloadedEmbeddingModels'),
  getComfyUIModels: (modelType: string) => invoke('getComfyUIModels', modelType),
  scanModelLibrary: () => invoke('scanModelLibrary'),
  showModelInFolder: (modelPath: string) => invoke('showModelInFolder', modelPath),
  deleteModelPath: (modelPath: string) => invoke('deleteModelPath', modelPath),
  getPlatform: () => invoke('getPlatform'),
  safeStorage: {
    isEncryptionAvailable: () => ipcRenderer.invoke('safeStorage:isEncryptionAvailable'),
    enablePlainTextEncryption: () => ipcRenderer.invoke('safeStorage:enablePlainTextEncryption'),
  },
  openImageWithSystem: (url: string) => ipcRenderer.send('openImageWithSystem', url),
  openImageInFolder: (url: string) => ipcRenderer.send('openImageInFolder', url),
  setFullScreen: (enable: boolean) => ipcRenderer.send('setFullScreen', enable),
  onDebugLog: (callback: (data: { level: string; source: string; message: string }) => void) =>
    ipcRenderer.on('debugLog', (_event, value) => callback(value)),
  getComfyUiDefaultParameters: () => invoke('getComfyUiDefaultParameters'),
  getLlamaCppDefaultParameters: () => invoke('getLlamaCppDefaultParameters'),
  detectPhisonSsd: () => invoke('detectPhisonSsd'),
  detectOem: () => invoke('detectOem'),
  onServiceSetUpProgress: (callback: (data: SetupProgress) => void) =>
    ipcRenderer.on('serviceSetUpProgress', (_event, value) => callback(value)),
  onKernelEvent: (callback: (event: import('../src/types/kernelEvents').KernelEvent) => void) =>
    listen('kernel:event', callback),
  getKernelSnapshot: () =>
    ipcRenderer.invoke('kernel:getSnapshot') as Promise<
      import('../src/types/kernelEvents').KernelSnapshot
    >,
  setLifecycleBusy: (busy: boolean) => ipcRenderer.send('lifecycle:busy', busy),
  onShowToast: (callback: (data: { type: string; message: string }) => void) =>
    ipcRenderer.on('show-toast', (_event, data) => callback(data)),
  ensureBackendReadiness: (
    serviceName: string,
    llmModelName: string,
    embeddingModelName?: string,
    contextSize?: number,
    modelArgs?: string,
    skipGpuAdmission?: boolean,
    options?: { remember?: boolean },
  ) =>
    invoke(
      'ensureBackendReadiness',
      serviceName,
      llmModelName,
      embeddingModelName,
      contextSize,
      modelArgs,
      skipGpuAdmission,
      options,
    ),
  setLastChatBackendLoadActive: (active: boolean) => invoke('setLastChatBackendLoadActive', active),
  rememberChatBackendLoad: (
    args: NonNullable<import('../src/types/chatIpc').ChatModelConfig['readiness']>,
  ) => invoke('rememberChatBackendLoad', args),
  ensureComfyUIBackendRunning: () => invoke('ensureComfyUIBackendRunning'),
  artifact: {
    run: (request: ArtifactRunRequest, options?: { queue?: 'fail-fast' | 'queue' }) =>
      invoke('artifact:run', cloneForIpc(request), options),
    cancel: (runId?: string) => invoke('artifact:cancel', runId),
    respond: (payload: MediaResponsePayload) => invoke('artifact:respond', payload),
    onRequest: (callback: (payload: MediaRequestPayload) => void) =>
      onPush('artifact:request', callback),
  } satisfies NamespaceBridge<'artifact'>,
  permissions: {
    requestDownload: (models: unknown[]) =>
      invoke('permissions:requestDownload', cloneForIpc(models)),
    requestVramWarning: (req: { presetName: string; message: string }) =>
      invoke('permissions:requestVramWarning', req),
    list: () => invoke('permissions:list'),
    grant: (key: string, origin: PermissionGrantOrigin) => invoke('permissions:grant', key, origin),
    revoke: (key: string) => invoke('permissions:revoke', key),
    migrate: (incoming: Record<string, PermissionGrant>) =>
      invoke('permissions:migrate', cloneForIpc(incoming)),
    respond: (payload: PermissionsPromptResponse) => invoke('permissions:respond', payload),
    onPrompt: (callback: (payload: PermissionsPromptPayload) => void) =>
      onPush('permissions:prompt', callback),
  } satisfies NamespaceBridge<'permissions'>,
  chat: {
    submitTurn: (request: ChatTurnRequest) => invoke('chat:submitTurn', cloneForIpc(request)),
    resumeTurn: (conversationKey: string) => invoke('chat:resumeTurn', conversationKey),
    cancelTurn: (conversationKey: string, turnId: string) =>
      invoke('chat:cancelTurn', conversationKey, turnId),
    summarize: (request: ChatSummarizeRequest) => invoke('chat:summarize', request),
    answer: (payload: ChatAnswerPayload) => invoke('chat:answer', cloneForIpc(payload)),
    onAsk: (callback: (payload: ChatAskPayload) => void) => onPush('chat:ask', callback),
  } satisfies NamespaceBridge<'chat'>,
  conversations: {
    bootstrap: () => invoke('conversations:bootstrap'),
    migrate: (payload: unknown) => invoke('conversations:migrate', cloneForIpc(payload)),
    save: (request: ConversationSaveRequest) => invoke('conversations:save', cloneForIpc(request)),
    delete: (id: string) => invoke('conversations:delete', id),
    saveLastMainKey: (key: string | null) => invoke('conversations:saveLastMainKey', key),
  } satisfies NamespaceBridge<'conversations'>,
  mediaItems: {
    bootstrap: () => invoke('mediaItems:bootstrap'),
    migrate: (items: unknown[]) => invoke('mediaItems:migrate', cloneForIpc(items)),
    save: (items: unknown[]) => invoke('mediaItems:save', cloneForIpc(items)),
    delete: (ids: string[]) => invoke('mediaItems:delete', ids),
  } satisfies NamespaceBridge<'mediaItems'>,
  preferences: {
    read: () => invoke('preferences:read'),
    migrate: (section: string, payload: unknown) =>
      invoke('preferences:migrate', section, cloneForIpc(payload)),
    write: (section: string, value: unknown) =>
      invoke('preferences:write', section, cloneForIpc(value)),
  } satisfies NamespaceBridge<'preferences'>,
  ragDocuments: {
    read: () => invoke('ragDocuments:read'),
    migrate: (payload: unknown) => invoke('ragDocuments:migrate', cloneForIpc(payload)),
    write: (value: unknown) => invoke('ragDocuments:write', cloneForIpc(value)),
  } satisfies NamespaceBridge<'ragDocuments'>,
  getBackendLaunchSettings: () => invoke('getBackendLaunchSettings'),
  migrateBackendLaunchSettings: (payload: unknown) =>
    invoke('migrateBackendLaunchSettings', cloneForIpc(payload)),
  startTranscriptionServer: (modelName: string) =>
    ipcRenderer.invoke('startTranscriptionServer', modelName),
  stopTranscriptionServer: () => ipcRenderer.invoke('stopTranscriptionServer'),
  getTranscriptionServerUrl: () => ipcRenderer.invoke('getTranscriptionServerUrl'),
  startSpeechServer: (modelName: string) => ipcRenderer.invoke('startSpeechServer', modelName),
  stopSpeechServer: () => ipcRenderer.invoke('stopSpeechServer'),
  getSpeechServerUrl: () => ipcRenderer.invoke('getSpeechServerUrl'),
  synthesizeSpeech: (options: {
    baseURL: string
    model: string
    input: string
    voice?: string
    apiKey?: string
    format?: string
  }) => ipcRenderer.invoke('synthesizeSpeech', options),
  ensureOvmsImageReady: (
    serviceName: string,
    modelName: string,
    keepModelsLoaded?: boolean,
    resolution?: string,
  ) =>
    ipcRenderer.invoke(
      'ensureOvmsImageReady',
      serviceName,
      modelName,
      keepModelsLoaded,
      resolution,
    ),
  stopOvmsChatServers: () => ipcRenderer.invoke('stopOvmsChatServers'),
  getOvmsImageServerUrl: () => ipcRenderer.invoke('getOvmsImageServerUrl'),
  // ComfyUI Tools
  comfyui: {
    isGitInstalled: () => ipcRenderer.invoke('comfyui:isGitInstalled'),
    isComfyUIInstalled: () => ipcRenderer.invoke('comfyui:isComfyUIInstalled'),
    getGitRef: (repoDir: string) => ipcRenderer.invoke('comfyui:getGitRef', repoDir),
    isPackageInstalled: (packageSpecifier: string) =>
      ipcRenderer.invoke('comfyui:isPackageInstalled', packageSpecifier),
    installPypiPackage: (packageSpecifier: string) =>
      ipcRenderer.invoke('comfyui:installPypiPackage', packageSpecifier),
    isCustomNodeInstalled: (nodeRepoRef: ComfyUICustomNodeRepoId) =>
      ipcRenderer.invoke('comfyui:isCustomNodeInstalled', nodeRepoRef),
    downloadCustomNode: (nodeRepoData: ComfyUICustomNodeRepoId) =>
      ipcRenderer.invoke('comfyui:downloadCustomNode', nodeRepoData),
    uninstallCustomNode: (nodeRepoData: ComfyUICustomNodeRepoId) =>
      ipcRenderer.invoke('comfyui:uninstallCustomNode', nodeRepoData),
    listInstalledCustomNodes: () => ipcRenderer.invoke('comfyui:listInstalledCustomNodes'),
    openInBrowser: () => ipcRenderer.invoke('comfyui:openInBrowser'),
  },
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:listServers'),
    startServer: (serverId: string) => ipcRenderer.invoke('mcp:startServer', serverId),
    stopServer: (serverId: string) => ipcRenderer.invoke('mcp:stopServer', serverId),
    getServerStatus: (serverId: string) => ipcRenderer.invoke('mcp:getServerStatus', serverId),
    listServerTools: (serverId: string) => ipcRenderer.invoke('mcp:listServerTools', serverId),
    invokeServerTool: (serverId: string, toolName: string, args: Record<string, unknown>) =>
      ipcRenderer.invoke('mcp:invokeServerTool', serverId, toolName, args),
    openConfig: () => ipcRenderer.send('mcp:openConfig'),
    openConfigInFolder: () => ipcRenderer.send('mcp:openConfigInFolder'),
    reloadConfig: () => ipcRenderer.invoke('mcp:reloadConfig'),
    addServer: (
      serverId: string,
      config:
        | {
            type?: 'stdio'
            command: string
            args?: string[]
            displayName?: string
            instructions?: string
          }
        | {
            type: 'http'
            url: string
            headers?: Record<string, string>
            displayName?: string
            instructions?: string
          },
    ) => ipcRenderer.invoke('mcp:addServer', serverId, config),
    getServerConfig: (serverId: string) => ipcRenderer.invoke('mcp:getServerConfig', serverId),
    updateServer: (
      serverId: string,
      config:
        | {
            type?: 'stdio'
            command: string
            args?: string[]
            displayName?: string
            instructions?: string
          }
        | {
            type: 'http'
            url: string
            headers?: Record<string, string>
            displayName?: string
            instructions?: string
          },
    ) => ipcRenderer.invoke('mcp:updateServer', serverId, config),
    removeServer: (serverId: string) => ipcRenderer.invoke('mcp:removeServer', serverId),
  },
  agentMode: {
    startTurn: (turnId: string, prompt: string, config: AgentModeTurnConfig) =>
      invoke('agentMode:startTurn', turnId, prompt, cloneForIpc(config)),
    cancel: () => invoke('agentMode:cancel'),
    resetSession: () => invoke('agentMode:resetSession'),
    deleteSession: (sessionId: string) => invoke('agentMode:deleteSession', sessionId),
    bootstrapSessions: () => invoke('agentMode:bootstrapSessions'),
    migrateSessions: (legacy: unknown) => invoke('agentMode:migrateSessions', cloneForIpc(legacy)),
    saveSession: (record: AgentSessionRecordWire) =>
      invoke('agentMode:saveSession', cloneForIpc(record)),
    saveActiveSessionId: (id: string | null) => invoke('agentMode:saveActiveSessionId', id),
    readWorkspaceState: () => invoke('agentMode:readWorkspaceState'),
    migrateWorkspaceState: (payload: unknown) =>
      invoke('agentMode:migrateWorkspaceState', cloneForIpc(payload)),
    writeWorkspaceState: (value: unknown) =>
      invoke('agentMode:writeWorkspaceState', cloneForIpc(value)),
    importAttachment: (workspaceDir: string, name: string, bytes: Uint8Array) =>
      invoke('agentMode:importAttachment', workspaceDir, name, bytes),
    listCapabilities: (options: {
      workspaceDir?: string
      toolSpecs?: AgentToolSpec[]
      mcpServerIds?: string[]
    }) => invoke('agentMode:listCapabilities', options),
    onExecuteTool: (callback: (data: AgentToolExecuteRequest) => void) =>
      onPush('agentMode:executeTool', callback),
    submitToolResult: (requestId: string, result: unknown, error?: string) =>
      invoke('agentMode:toolResult', requestId, result, error),
  } satisfies NamespaceBridge<'agentMode'>,
  games: {
    list: () => ipcRenderer.invoke('games:list'),
    read: (dir: string) => ipcRenderer.invoke('games:read', dir),
    create: (
      name?: string,
      options?: {
        scaffold?: boolean
        backend?: string
        startingModel?: string
        initialPrompt?: string
      },
    ) => ipcRenderer.invoke('games:create', name, options),
    publish: (dir: string, fields: { name?: string; description?: string }) =>
      ipcRenderer.invoke('games:publish', dir, fields),
    openFolder: (dir?: string) => ipcRenderer.invoke('games:openFolder', dir),
    play: (dir: string) => ipcRenderer.invoke('games:play', dir),
    openArcade: () => ipcRenderer.invoke('games:openArcade'),
    arcadeCatalog: () => ipcRenderer.invoke('games:arcadeCatalog'),
    setArcadeShown: (target: { kind: 'user' | 'sample'; id: string; shown: boolean }) =>
      ipcRenderer.invoke('games:setArcadeShown', target),
  },
  webBrowser: {
    navigate: (url: string) => ipcRenderer.invoke('webBrowser:navigate', url),
    readPage: () => ipcRenderer.invoke('webBrowser:readPage'),
    search: (query: string, maxResults?: number) =>
      ipcRenderer.invoke('webBrowser:search', query, maxResults),
    interact: (interaction: WebBrowserInteraction) =>
      ipcRenderer.invoke('webBrowser:interact', interaction),
    screenshot: () => ipcRenderer.invoke('webBrowser:screenshot'),
    show: () => ipcRenderer.invoke('webBrowser:show'),
    hide: () => ipcRenderer.invoke('webBrowser:hide'),
    close: () => ipcRenderer.invoke('webBrowser:close'),
    getState: () => ipcRenderer.invoke('webBrowser:getState'),
    onStateChanged: (callback: (state: WebBrowserState) => void) =>
      ipcRenderer.on('webBrowser:stateChanged', (_event, state: WebBrowserState) =>
        callback(state),
      ),
  },
  screenshot: {
    listWindows: () => ipcRenderer.invoke('screenshot:listWindows'),
    captureWindow: (target: { id: string; name: string }) =>
      ipcRenderer.invoke('screenshot:captureWindow', target),
    getPermissionStatus: () => ipcRenderer.invoke('screenshot:getPermissionStatus'),
    openPermissionSettings: () => ipcRenderer.send('screenshot:openPermissionSettings'),
  },
  homeAgent: {
    // Persist an inbound document (base64) to disk for RAG ingestion.
    saveDocument: (filename: string, base64: string) =>
      ipcRenderer.invoke('saveHomeAgentDocument', filename, base64),
    // Local web chat — URL discovery (the chat server lives in the Python
    // backend; this only enumerates reachable addresses for the setup screen).
    // `allowLan` mirrors the bind: loopback only unless LAN access is on.
    localWeb: {
      getUrls: (port: number, allowLan: boolean): Promise<string[]> =>
        ipcRenderer.invoke('homeAgent:localWeb:getUrls', port, allowLan),
    },
    // Channel-agnostic dispatcher. Every method is keyed by ChannelKind
    // (`'telegram'` | `'slack'` | `'discord'` | `'local-web'`) so adding a new
    // platform requires zero edits here — only a new entry in the renderer-side
    // channel registry and a Python channel module.
    channel: {
      saveConfig: (kind: string, config: Record<string, string>) =>
        ipcRenderer.invoke('channel:saveConfig', kind, config),
      loadConfig: (kind: string) => ipcRenderer.invoke('channel:loadConfig', kind),
      clearConfig: (kind: string) => ipcRenderer.invoke('channel:clearConfig', kind),
      savePrefs: (kind: string, prefs: { verified?: boolean; enabled?: boolean }) =>
        ipcRenderer.invoke('channel:savePrefs', kind, prefs),
      loadPrefs: (kind: string) => ipcRenderer.invoke('channel:loadPrefs', kind),
      test: (kind: string) => ipcRenderer.invoke('channel:test', kind),
      inject: (kind: string, config: Record<string, string | undefined>) =>
        ipcRenderer.invoke('channel:inject', kind, config),
      detectIdentity: (kind: string, config: Record<string, string | undefined>) =>
        ipcRenderer.invoke('channel:detectIdentity', kind, config),
      detectIdentityFromSaved: (kind: string) =>
        ipcRenderer.invoke('channel:detectIdentityFromSaved', kind),
      poll: (kind: string) => ipcRenderer.invoke('channel:poll', kind),
      flushPending: (kind: string) => ipcRenderer.invoke('channel:flushPending', kind),
      send: (
        kind: string,
        action:
          | 'reply'
          | 'update'
          | 'photo'
          | 'video'
          | 'voice'
          | 'document'
          | 'typing'
          | 'keyboard'
          | 'editMessage'
          | 'history',
        payload: Record<string, unknown>,
      ) => ipcRenderer.invoke('channel:send', kind, action, payload),
    },
  },
  // Cloud Mode provider secrets, encrypted at rest via safeStorage in main.
  cloudProvider: {
    saveKey: (providerId: string, key: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('cloudProvider:saveKey', providerId, key),
    getKey: (providerId: string): Promise<string | null> =>
      ipcRenderer.invoke('cloudProvider:getKey', providerId),
    deleteKey: (providerId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('cloudProvider:deleteKey', providerId),
    getProxyUrl: (): Promise<string> => ipcRenderer.invoke('cloudProvider:getProxyUrl'),
  },
})
