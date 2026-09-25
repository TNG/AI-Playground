import type {
  AgentCapabilityInfo,
  AgentModeTurnConfig,
  AgentToolExecuteRequest,
  AgentToolSpec,
  ArcadeCatalogEntry,
  GameLibraryEntry,
} from './agentIpc'
import type { AgentSessionBootstrap, AgentSessionRecordWire } from './agentSessionIpc'
import type { AgentWorkspaceState } from './agentWorkspaceIpc'
import type { ArtifactRunRequest, ArtifactRunResult } from './artifactIpc'
import type {
  ChatModelConfig,
  ChatSummarizeRequest,
  ChatTurnRequest,
  ChatTurnResumeResult,
} from './chatIpc'
import type { ChatAnswerPayload, ChatAskPayload } from './chatRequests'
import type { ComfyUICustomNodeRepoId } from './comfyuiIpc'
import type { ConversationBootstrap, ConversationSaveRequest } from './conversationIpc'
import type { MediaItemsBootstrap } from './mediaItemIpc'
import type { MediaRequestPayload, MediaResponsePayload } from './mediaRequests'
import type {
  PermissionGrant,
  PermissionGrantOrigin,
  PermissionsPromptPayload,
  PermissionsPromptResponse,
} from './permissionsIpc'
import type { RagDocumentSection } from './ragDocumentIpc'
import type { BackendLaunchSettings, BackendVersionWire } from './preferencesIpc'
import type { SpeechSynthesisRequest } from './speechIpc'
import type {
  McpServerConfig,
  McpServerInfo,
  McpStatus,
  McpToolCallResult,
  McpToolInfo,
} from './mcpIpc'
import type { ModelLibraryScan } from '@/assets/js/models/types'
import type { ModelLists, ModelPaths } from '@/assets/js/store/models'
import type { EmbedInquiry, IndexedDocument } from '@/assets/js/store/textInference'
import type { PhisonKmIngestConfig, WarmupRequest } from './phisonKmRag'

export type IpcOwner = 'main' | 'homeAgent'
export type IpcKind = 'invoke' | 'send' | 'push'

export type InvokeRow<A extends readonly unknown[] = readonly unknown[], R = unknown> = {
  kind: 'invoke'
  owner: IpcOwner
  args: A
  result: R
  /** Optional bridge member-name override when the naming convention does not fit. */
  member?: string
}

export type SendRow<A extends readonly unknown[] = readonly unknown[]> = {
  kind: 'send'
  owner: IpcOwner
  args: A
  member?: string
}

export type PushRow<P = unknown> = {
  kind: 'push'
  owner: IpcOwner
  payload: P
  /** `true` for the five raw `ipcRenderer.on` listeners that return void instead of an unsubscribe. */
  raw?: boolean
  member?: string
}

/** An M→R ask is two rows — a push for the question, an invoke for the answer (`chat:ask`/`chat:answer`). */
export type IpcRow = InvokeRow | SendRow | PushRow

export type IpcOk = { success: true }
export type IpcFail = { success: false; error: string }
export type IpcMutationResult = IpcOk | IpcFail
export type IpcDataResult<T> = { success: true; data: T } | IpcFail
export type IpcStatusError = { status: 'error'; error: string }

// Structural mirrors of the Electron dialog option/result shapes the rows below
// carry — stated literally so this file never imports from the 'electron' package.
export type OpenDialogOptions = {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: Array<{ name: string; extensions: string[] }>
  properties?: Array<
    | 'openFile'
    | 'openDirectory'
    | 'multiSelections'
    | 'showHiddenFiles'
    | 'createDirectory'
    | 'promptToCreate'
    | 'noResolveAliases'
    | 'treatPackageAsDirectory'
    | 'dontAddToRecent'
  >
}
export type OpenDialogResult = { canceled: boolean; filePaths: string[] }
export type SaveDialogOptions = {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
}
export type SaveDialogResult = { canceled: boolean; filePath?: string }
export type MessageBoxOptions = {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  buttons?: string[]
  defaultId?: number
  title?: string
  message: string
  detail?: string
  checkboxLabel?: string
  checkboxChecked?: boolean
}
export type MessageBoxResult = { response: number; checkboxChecked: boolean }

export const CHANNELS = {
  /** Hydrate the conversation store once before mount: thread files, metadata, last main key. */
  'conversations:bootstrap': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as ConversationBootstrap | IpcStatusError,
  },
  /** One-shot upload of the legacy localStorage Pinia state; same result shape as bootstrap. */
  'conversations:migrate': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as ConversationBootstrap | IpcStatusError,
  },
  /** Upsert one thread file (user mutations; the turn engine has its own writer). */
  'conversations:save': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ConversationSaveRequest],
    result: null as unknown as IpcMutationResult,
  },
  /** Delete one thread file by conversation id. */
  'conversations:delete': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as IpcMutationResult,
  },
  /** Persist the last-used main-thread key. */
  'conversations:saveLastMainKey': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string | null],
    result: null as unknown as IpcMutationResult,
  },
  /** Hydrate the media-gallery records once before mount: item files plus the ordered index. */
  'mediaItems:bootstrap': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as MediaItemsBootstrap | IpcStatusError,
  },
  /** One-shot legacy upload of the localStorage gallery; same result shape as bootstrap. */
  'mediaItems:migrate': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown[]],
    result: null as unknown as MediaItemsBootstrap | IpcStatusError,
  },
  /** Upsert gallery record files plus their index entries (user mutations only). */
  'mediaItems:save': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown[]],
    result: null as unknown as IpcMutationResult,
  },
  /** Delete gallery record files and their index entries by id. */
  'mediaItems:delete': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string[]],
    result: null as unknown as IpcMutationResult,
  },
  /** All preference sections at once; the file is small, so every store picks its own. */
  'preferences:read': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: true; sections: Record<string, unknown> } | IpcFail,
  },
  /** One-shot legacy upload of one section; writes only when the section is absent. */
  'preferences:migrate': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** Replace one store's section in the kernel-owned preferences file. */
  'preferences:write': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** The indexed RAG document list; `section: null` means never-migrated, not failed. */
  'ragDocuments:read': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: true; section: RagDocumentSection | null } | IpcFail,
  },
  /** One-shot legacy upload of the document list; writes only when the file is absent. */
  'ragDocuments:migrate': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** Replace the whole indexed document list. */
  'ragDocuments:write': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** Run one agent turn on the Pi harness; the stream crosses the kernel bus. */
  'agentMode:startTurn': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string, AgentModeTurnConfig],
    result: null as unknown as { success: boolean; error?: string },
  },
  /** Abort the running agent turn, if any. */
  'agentMode:cancel': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as void,
  },
  /** Hard-reset the live Pi session and its workspace runtime. */
  'agentMode:resetSession': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as void,
  },
  /** Delete one session's record file and main-side Pi state. */
  'agentMode:deleteSession': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as IpcMutationResult,
  },
  /** Hydrate the session-panel records once before mount: session files plus the active id. */
  'agentMode:bootstrapSessions': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as AgentSessionBootstrap | IpcStatusError,
  },
  /** One-shot upload of the legacy persisted sessions; same result shape as bootstrap. */
  'agentMode:migrateSessions': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as AgentSessionBootstrap | IpcStatusError,
  },
  /** Upsert one session record file plus its index entry. */
  'agentMode:saveSession': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [AgentSessionRecordWire],
    result: null as unknown as IpcMutationResult,
  },
  /** Persist the active session id (null clears it). */
  'agentMode:saveActiveSessionId': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string | null],
    result: null as unknown as IpcMutationResult,
  },
  /** The last-used workspace pointers; `section: null` means never-migrated, not failed. */
  'agentMode:readWorkspaceState': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: true; section: AgentWorkspaceState | null } | IpcFail,
  },
  /** One-shot legacy upload of the workspace pointers; writes only when absent. */
  'agentMode:migrateWorkspaceState': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** Replace the whole workspace-pointer section. */
  'agentMode:writeWorkspaceState': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** Copy an attached file into the workspace; the answer carries its relative path. */
  'agentMode:importAttachment': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string, Uint8Array],
    result: null as unknown as { success: true; path: string } | IpcFail,
  },
  /** What the agent could be equipped with, for the Capabilities checkboxes. */
  'agentMode:listCapabilities': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [
      { workspaceDir?: string; toolSpecs?: AgentToolSpec[]; mcpServerIds?: string[] },
    ],
    result: null as unknown as AgentCapabilityInfo[],
  },
  /** Main hands a renderer-implemented tool call to the window to run. */
  'agentMode:executeTool': {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as AgentToolExecuteRequest,
  },
  /** The renderer's answer to an executeTool dispatch, keyed by requestId. */
  'agentMode:toolResult': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, unknown, string?],
    result: null as unknown as void,
    // `as const` keeps the override a literal: the row type's `member?: string`
    // context would widen it to string, collapsing the bridge's key remap.
    member: 'submitToolResult' as const,
  },

  // ── Chat turns (step 6): the engine runs in main, the stream is kernel events ──

  /** Submit one resolved chat turn; the engine streams chunks on the kernel bus. */
  'chat:submitTurn': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ChatTurnRequest],
    result: null as unknown as { success: true; turnId: string } | IpcFail,
  },
  /** Rehydrate a (re)connecting renderer's live turn from the bus snapshot. */
  'chat:resumeTurn': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as ChatTurnResumeResult,
  },
  /** Abort the running turn for a conversation, if any. */
  'chat:cancelTurn': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string],
    result: null as unknown as { success: true },
  },
  /** One-shot conversation-title summarization; occupies as `text`, `remember: false`. */
  'chat:summarize': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ChatSummarizeRequest],
    result: null as unknown as IpcDataResult<string>,
  },
  /** The renderer's answer to a `chat:ask` question, keyed by requestId. */
  'chat:answer': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ChatAnswerPayload],
    result: null as unknown as void,
  },
  /** Main asks the window for the one answer a chat tool needs (speech seam, confirm cards). */
  'chat:ask': {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as ChatAskPayload,
  },

  // ── Artifact pipeline (step 5): resolved runs in, settled results out ──

  /** Submit one resolved artifact run; the runner owns readiness and settlement. */
  'artifact:run': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ArtifactRunRequest, { queue?: 'fail-fast' | 'queue' }?],
    result: null as unknown as ArtifactRunResult,
  },
  /** Cancel the active run, or one in-flight run by id. */
  'artifact:cancel': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string?],
    result: null as unknown as void,
  },
  /** The renderer's answer to an `artifact:request`, keyed by requestId. */
  'artifact:respond': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [MediaResponsePayload],
    result: null as unknown as void,
  },
  /** Main asks the renderer for the model pre-flight and download consent. */
  'artifact:request': {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as MediaRequestPayload,
  },

  // ── Permissions (step 13): policy in main, dialogs in the renderer ──

  /** Desktop download modal / Home Agent in-channel consent for model downloads. */
  'permissions:requestDownload': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown[]],
    result: null as unknown as
      { success: true } | { success: false; error: string; cancelled?: boolean },
  },
  /** The high-memory / video-VRAM gate; a confirmed "do not show again" records a grant. */
  'permissions:requestVramWarning': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [{ presetName: string; message: string }],
    result: null as unknown as { success: true; confirmed: boolean } | IpcFail,
  },
  /** Every recorded consent grant (Settings → Permissions). */
  'permissions:list': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: true; grants: PermissionGrant[] } | IpcFail,
  },
  /** Record a grant (a remember tick or a Settings pre-grant). */
  'permissions:grant': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, PermissionGrantOrigin],
    result: null as unknown as { success: true; grant: PermissionGrant } | IpcFail,
  },
  /** Remove one grant by key. */
  'permissions:revoke': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as IpcMutationResult,
  },
  /** One-shot upload of the legacy persisted grants. */
  'permissions:migrate': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [Record<string, PermissionGrant>],
    result: null as unknown as IpcMutationResult,
  },
  /** The renderer's answer to a `permissions:prompt`, keyed by requestId. */
  'permissions:respond': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [PermissionsPromptResponse],
    result: null as unknown as void,
  },
  /** Main asks the window to show a consent dialog (download modal, VRAM warning). */
  'permissions:prompt': {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as PermissionsPromptPayload,
  },

  // ── Flat members (no `prefix:` — these sit at the top level of electronAPI) ──
  // Service lifecycle, machine-level settings and hardware probing. Many return
  // raw data rather than envelopes; the rows state what each handler really answers.

  /** All registered backend services with status, devices and installed versions. */
  getServices: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as ApiServiceInformation[],
  },
  /** Loopback auth token for a service's HTTP API; '' for services without one. */
  getBackendAuthToken: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as string,
  },
  /** Apply launch flags / version pins to a service; it relaunches on the next start. */
  updateServiceSettings: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ServiceSettings],
    result: null as unknown as void,
  },
  /** Remove a service's installed files; ignored when the service is unknown. */
  uninstall: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as void,
  },
  /** Persist and apply the selected inference device for a service. */
  selectDevice: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string],
    result: null as unknown as void,
  },
  /** Persist and apply the selected STT device (the OpenVINO whisper sub-device). */
  selectSttDevice: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string],
    result: null as unknown as void,
  },
  /** Re-probe a service's available devices. */
  detectDevices: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as void,
  },
  /** Start a service; 'failed' when it is unknown or the registry is not up yet. */
  startService: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as BackendStatus,
  },
  /** Stop a service; 'failed' when it is unknown or the registry is not up yet. */
  stopService: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as BackendStatus,
  },
  /** Install/update a service; progress streams as `serviceSetUpProgress` events. */
  setUpService: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [BackendServiceName],
    result: null as unknown as void,
  },
  /** The pinned release for a service: remote versions file, local fallback. */
  resolveBackendVersion: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [BackendServiceName],
    result: null as unknown as BackendVersionWire | undefined,
  },
  /** The version actually installed for a service, if any. */
  getInstalledBackendVersion: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [BackendServiceName],
    result: null as unknown as { releaseTag?: string; version?: string } | undefined,
  },
  /** The GitHub repository this build was produced from (settings footer link). */
  getGitHubRepoUrl: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as string,
  },
  /** Load the chat backend (LLM + embedding) for a model and admit the GPU window. */
  ensureBackendReadiness: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [
      string,
      string,
      string?,
      number?,
      string?,
      boolean?,
      { remember?: boolean }?,
    ],
    result: null as unknown as IpcMutationResult,
  },
  /** Arm/disarm the last-load snapshot (cloud turns disarm it for the duration). */
  setLastChatBackendLoadActive: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [boolean],
    result: null as unknown as IpcOk,
  },
  /** Persist the last successful chat-backend load for swap-back reloads. */
  rememberChatBackendLoad: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [NonNullable<ChatModelConfig['readiness']>],
    result: null as unknown as IpcMutationResult,
  },
  /** App locale plus the settings.json language override. */
  getLocaleSettings: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as LocaleSettings,
  },
  /** Merge updates into the machine-level settings.json and persist it. */
  updateLocalSettings: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [Partial<LocalSettings>],
    result: null as unknown as IpcOk,
  },
  /** The whole machine-level settings object. */
  getLocalSettings: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as LocalSettings,
  },
  /** The `--start-page=` launch value, or null to leave the persisted mode untouched. */
  getInitialPage: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as ModeType | null,
  },
  /** Demo-mode flags and profile. */
  getDemoModeSettings: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as DemoModeSettings,
  },
  /** Boot handshake: model paths/lists, app version, model-folder writability. */
  getInitSetting: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as SetupData | undefined,
  },
  /** The backendServices store's settings.json slice: launch flags, version pins, device map. */
  getBackendLaunchSettings: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as BackendLaunchSettings,
  },
  /** One-shot upload of the pre-step-8 renderer launch flags; only defaults are written. */
  migrateBackendLaunchSettings: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** Hardware probe plus product-mode recommendation for the setup wizard. */
  detectHardwareForModeRecommendation: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as HardwareRecommendationResult,
  },
  /** Whether a Phison SSD is installed (Windows probe; a settings flag can force it). */
  detectPhisonSsd: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { detected: boolean },
  },
  /** Which OEM this machine came from, for partner co-branding. */
  detectOem: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { vendor: string; manufacturer: string; overridden: boolean },
  },
  /** Pull preset updates from the configured remote repository into the install. */
  updatePresetsFromIntelRepo: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as UpdatePresetsFromIntelResult,
  },
  /** Reload the preset catalog (base + mode files, partner-filtered); [] on read failure. */
  reloadPresets: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { content: string; image: string | null }[],
  },
  /** The user's presets directory under Documents, created when missing. */
  getUserPresetsPath: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as string,
  },
  /** The user's saved presets with content and cover image; [] on read failure. */
  loadUserPresets: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { content: string; image: string | null }[],
  },
  /** Write one user preset file (its `name` field names it); false on failure. */
  saveUserPreset: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as boolean,
  },
  /** The resolved model catalog — remote models.json when reachable, local fallback. */
  loadModels: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as Model[],
  },
  /** Point the model directories somewhere new; the fresh scan comes back. */
  updateModelPaths: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ModelPaths],
    result: null as unknown as ModelLists,
  },
  /** Reset the model directories to the install defaults. */
  restorePathsSettings: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as void,
  },
  /** Downloaded GGUF LLM names, `---`-normalized to `owner/repo` paths. */
  getDownloadedGGUFLLMs: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as string[],
  },
  /** Downloaded OpenVINO LLM model names. */
  getDownloadedOpenVINOLLMModels: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as string[],
  },
  /** Downloaded embedding models across the local backends. */
  getDownloadedEmbeddingModels: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as Model[],
  },
  /** Available ComfyUI weights of one type, as relative paths under its directory. */
  getComfyUIModels: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as string[],
  },
  /** Whole-library scan: every model with absolute path, size and mtime. */
  scanModelLibrary: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as ModelLibraryScan,
  },
  /** Reveal a model file in the OS file manager (path validated first). */
  showModelInFolder: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as { success: boolean; error?: string },
  },
  /** Permanently delete a model and its mirrored copies (path validated first). */
  deleteModelPath: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as { success: boolean; error?: string },
  },
  /** Split and index one document in the langchain utility process. */
  addDocumentToRAGList: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [IndexedDocument, PhisonKmIngestConfig?],
    result: null as unknown as IndexedDocument,
  },
  /** Embed a prompt against the checked documents for retrieval. */
  embedInputUsingRag: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [EmbedInquiry],
    result: null as unknown as LangchainDocument[],
  },
  /** Prefill the KV cache with a document's merged groups (Phison KM warmup). */
  warmupKVCacheForDocument: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [WarmupRequest],
    result: null as unknown as { success: boolean },
  },
  /** The embedding sub-server URL for a backend, or the service's base URL. */
  getEmbeddingServerUrl: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as { success: boolean; url?: string; error?: string },
  },
  /** Start the embedding sub-server for a model if it is not up yet. */
  ensureEmbeddingServerReady: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string],
    result: null as unknown as { success: boolean; error?: string },
  },
  /** Laminar tracing settings (external/laminar.dev.json), or null when tracing is off. */
  getLaminarConfig: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as LaminarConfig | null,
  },
  /** Default ComfyUI launch flags for the backend-settings box. */
  getComfyUiDefaultParameters: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as string,
  },
  /** Default llama-server launch flags for the backend-settings box. */
  getLlamaCppDefaultParameters: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as string,
  },
  /** The OS platform (`process.platform`). */
  getPlatform: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as NodeJS.Platform,
  },
  /** Whether a path exists; undefined when the caller's window is already gone. */
  existsPath: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as boolean | undefined,
  },

  // ── Media files: app-owned media dirs, renderer-supplied payloads ──

  /** Persist an attached image into the media input dir; answers `input/<file>`. */
  saveImageToMediaInput: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as string,
  },
  /** Persist an attached audio clip into the media input dir; answers `input/<file>`. */
  saveAudioToMediaInput: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as string,
  },
  /** Write one generated audio clip under the app's audio dir (suffix on name clash). */
  saveGeneratedAudio: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string, { overwrite?: boolean }?],
    result: null as unknown as { success: boolean; filePath?: string; error?: string },
  },
  /** Read an audio file under the app's audio dir back as a data URI (path-confined). */
  readLocalAudioAsDataUri: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as { success: boolean; dataUri?: string; error?: string },
  },
  /** Delete a generated audio file, confined to the app's audio dir. */
  deleteGeneratedAudio: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as { success: boolean; error?: string },
  },
  /** Read any `aipg-media://` file back as base64 (path-validated by the scheme root). */
  readAipgMediaAsBase64: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as { success: true; data: string } | { success: false; error: string },
  },

  // ── Speech servers: STT/TTS sub-servers inside the OpenVINO backend ──

  /** Start the OpenVINO whisper (STT) sub-server for a model. */
  startTranscriptionServer: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as { success: boolean; error?: string },
  },
  /** Stop the whisper (STT) sub-server. */
  stopTranscriptionServer: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: boolean; error?: string },
  },
  /** The whisper (STT) sub-server's URL, when it is running. */
  getTranscriptionServerUrl: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: boolean; url?: string; error?: string },
  },
  /** Start the OpenVINO speech (TTS) sub-server for a model. */
  startSpeechServer: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as { success: boolean; error?: string },
  },
  /** Stop the speech (TTS) sub-server. */
  stopSpeechServer: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: boolean; error?: string },
  },
  /** The speech (TTS) sub-server's URL, when it is running. */
  getSpeechServerUrl: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: boolean; url?: string; error?: string },
  },
  /** Proxy one `/audio/speech` POST through main, dodging the renderer's CORS. */
  synthesizeSpeech: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [SpeechSynthesisRequest],
    result: null as unknown as
      { success: true; dataBase64: string; mediaType: string } | { success: false; error: string },
  },
  /** Start (or confirm) the OVMS image-gen server and answer its URL. */
  ensureOvmsImageReady: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string, boolean?, string?],
    result: null as unknown as { success: boolean; url?: string; error?: string },
  },
  /** Stop the OpenVINO backend's chat sub-servers. */
  stopOvmsChatServers: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: boolean; error?: string },
  },
  /** The OVMS image-gen server's URL, when it is running. */
  getOvmsImageServerUrl: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: boolean; url?: string; error?: string },
  },

  // ── Window chrome, dialogs, one-way sends and raw pushes (batch 8 flats) ──

  /** The main window's current size plus the chat content height budget. */
  getWinSize: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { width: number; height: number; maxChatContentHeight: number },
  },
  /** Resize the main window, keeping its bottom edge anchored. */
  setWinSize: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [number, number],
    result: null as unknown as void,
  },
  /** Bump the main window's zoom level one step in. */
  zoomIn: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as void,
  },
  /** Bump the main window's zoom level one step out. */
  zoomOut: {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as void,
  },
  /** The OS open-file/folder dialog over the caller's window. */
  showOpenDialog: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [OpenDialogOptions],
    result: null as unknown as OpenDialogResult,
  },
  /** The OS save dialog; resolves undefined when the dialog itself errors out. */
  showSaveDialog: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [SaveDialogOptions],
    result: null as unknown as SaveDialogResult | undefined,
  },
  /** The OS message box over the caller's window; `response` is the button index. */
  showMessageBox: {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [MessageBoxOptions],
    result: null as unknown as MessageBoxResult,
  },
  /** Start an OS drag of a generated file (history rows, image results). */
  ondragstart: {
    kind: 'send',
    owner: 'main',
    args: [] as unknown as readonly [string],
    member: 'startDrag' as const,
  },
  /** Detach the main window's DevTools window. */
  openDevTools: {
    kind: 'send',
    owner: 'main',
    args: [] as const,
  },
  /** Flip the Pi harness's verbose agent log switch. */
  setVerboseAgentLogging: {
    kind: 'send',
    owner: 'main',
    args: [] as unknown as readonly [boolean],
  },
  /** Open an external URL in the OS browser. */
  openUrl: {
    kind: 'send',
    owner: 'main',
    args: [] as unknown as readonly [string],
  },
  /** Minimize the main window. */
  miniWindow: {
    kind: 'send',
    owner: 'main',
    args: [] as const,
  },
  /** Quit the app outright (reaches the gated teardown in `before-quit`). */
  exitApp: {
    kind: 'send',
    owner: 'main',
    args: [] as const,
  },
  /** Save a generated image to a file the user picks in a save dialog. */
  saveImage: {
    kind: 'send',
    owner: 'main',
    args: [] as unknown as readonly [string],
  },
  /** Open a generated image in its own viewer window. */
  openImageWin: {
    kind: 'send',
    owner: 'main',
    args: [] as unknown as readonly [string, string, number, number],
  },
  /** Open a media URL's file with the OS default image viewer. */
  openImageWithSystem: {
    kind: 'send',
    owner: 'main',
    args: [] as unknown as readonly [string],
  },
  /** Reveal a media URL's file in the OS file manager. */
  openImageInFolder: {
    kind: 'send',
    owner: 'main',
    args: [] as unknown as readonly [string],
  },
  /** Enter or leave full screen on the main window. */
  setFullScreen: {
    kind: 'send',
    owner: 'main',
    args: [] as unknown as readonly [boolean],
  },
  /** Forward one serialized Laminar telemetry event to main's tracing half. */
  laminarTelemetryEvent: {
    kind: 'send',
    owner: 'main',
    args: [] as unknown as readonly [string, string],
  },
  /** The renderer's busy flag for the close policy; fire-and-forget. */
  'lifecycle:busy': {
    kind: 'send',
    owner: 'main',
    args: [] as unknown as readonly [boolean],
    member: 'setLifecycleBusy' as const,
  },
  /** The primary display's new work-area size, right after it changed. */
  'display-metrics-changed': {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as { width: number; height: number },
    raw: true as const,
    member: 'screenChange' as const,
  },
  /** A mirrored log line for the renderer's debug console. */
  debugLog: {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as {
      level: 'error' | 'warn' | 'info'
      source: string
      message: string
    },
    raw: true as const,
  },
  /** Install/update progress for the setup wizard's progress list. */
  serviceSetUpProgress: {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as SetupProgress,
    raw: true as const,
  },
  /** A toast a backend wants shown (ComfyUI setup errors and friends). */
  'show-toast': {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as { type: string; message: string },
    raw: true as const,
    member: 'onShowToast' as const,
  },

  // ── ComfyUI tooling, screenshots, safeStorage, cloud-provider keys (batch 9) ──

  /** Whether the bundled git binary (win32) or the system git is available. */
  'comfyui:isGitInstalled': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as boolean,
  },
  /** Whether the ComfyUI install root exists; rejects when the service is unknown. */
  'comfyui:isComfyUIInstalled': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as boolean,
  },
  /** The commit checked out in a repo dir; undefined when git cannot resolve it. */
  'comfyui:getGitRef': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as string | undefined,
  },
  /** Whether a Python package is installed in the ComfyUI venv. */
  'comfyui:isPackageInstalled': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as boolean,
  },
  /** Install a Python package into the ComfyUI venv via uv; rejects on failure. */
  'comfyui:installPypiPackage': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as void,
  },
  /** Whether a custom-node repo is present under custom_nodes/. */
  'comfyui:isCustomNodeInstalled': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ComfyUICustomNodeRepoId],
    result: null as unknown as boolean,
  },
  /** Clone a custom node, check out its ref, install its requirements; false on failure. */
  'comfyui:downloadCustomNode': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ComfyUICustomNodeRepoId],
    result: null as unknown as boolean,
  },
  /** Remove a custom node's folder; false when it was never installed. */
  'comfyui:uninstallCustomNode': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ComfyUICustomNodeRepoId],
    result: null as unknown as boolean,
  },
  /** Names of the folders under custom_nodes/; [] when the directory is absent. */
  'comfyui:listInstalledCustomNodes': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as string[],
  },
  /** Open ComfyUI in the OS browser via the loopback launch token. */
  'comfyui:openInBrowser': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as IpcMutationResult,
  },
  /** Capturable desktop windows with thumbnails, for the settings window picker. */
  'screenshot:listWindows': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as ScreenshotWindowSource[],
  },
  /** Capture one window as a PNG data URI; rejects when it is gone or hidden. */
  'screenshot:captureWindow': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ScreenshotWindow],
    result: null as unknown as string,
  },
  /** OS screen-capture permission state plus the platform that decided it. */
  'screenshot:getPermissionStatus': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as {
      platform: NodeJS.Platform
      status: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
    },
  },
  /** Open the OS screen-capture privacy settings page (no-op off macOS). */
  'screenshot:openPermissionSettings': {
    kind: 'send',
    owner: 'main',
    args: [] as const,
  },
  /** Whether the OS keyring can encrypt secrets on this machine. */
  'safeStorage:isEncryptionAvailable': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as boolean,
  },
  /** Opt into obfuscated-on-disk secrets where no OS keyring is available. */
  'safeStorage:enablePlainTextEncryption': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as IpcMutationResult,
  },
  /** Store one provider's API key encrypted at rest; an empty key clears it. */
  'cloudProvider:saveKey': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string],
    result: null as unknown as IpcMutationResult,
  },
  /** One provider's decrypted API key, or null when none is stored. */
  'cloudProvider:getKey': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as string | null,
  },
  /** Remove one provider's stored key file. */
  'cloudProvider:deleteKey': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as IpcOk,
  },
  /** Loopback URL of the Cloud Mode proxy the renderer points its client at. */
  'cloudProvider:getProxyUrl': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as string,
  },

  // ── MCP registry and game library (batch 9b) ──

  /** Every configured MCP server, read from the mcp.json config. */
  'mcp:listServers': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as McpServerInfo[],
  },
  /** Start one MCP server; answers its status once the start settles. */
  'mcp:startServer': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as McpStatus,
  },
  /** Stop one MCP server and answer its status. */
  'mcp:stopServer': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as McpStatus,
  },
  /** One MCP server's current connection status. */
  'mcp:getServerStatus': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as McpStatus,
  },
  /** The tools one running MCP server exposes. */
  'mcp:listServerTools': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as McpToolInfo[],
  },
  /** Call one tool on a running MCP server; content comes back verbatim. */
  'mcp:invokeServerTool': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string, Record<string, unknown>],
    result: null as unknown as McpToolCallResult,
  },
  /** Open the mcp.json config file with the OS default editor. */
  'mcp:openConfig': {
    kind: 'send',
    owner: 'main',
    args: [] as const,
  },
  /** Reveal the mcp.json config file in the OS file manager. */
  'mcp:openConfigInFolder': {
    kind: 'send',
    owner: 'main',
    args: [] as const,
  },
  /** Stop every MCP server and re-read mcp.json; answers the fresh server list. */
  'mcp:reloadConfig': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as McpServerInfo[],
  },
  /** Add a server to mcp.json; rejects when the id already exists. */
  'mcp:addServer': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, McpServerConfig],
    result: null as unknown as void,
  },
  /** One server's mcp.json entry; rejects when the id is unknown. */
  'mcp:getServerConfig': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as McpServerConfig,
  },
  /** Stop a server, then replace its mcp.json entry. */
  'mcp:updateServer': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, McpServerConfig],
    result: null as unknown as void,
  },
  /** Stop and delete a server; auto-detected ids are dismissed so they stay gone. */
  'mcp:removeServer': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as void,
  },
  /** Every game in the library, most recently worked on first. */
  'games:list': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as GameLibraryEntry[],
  },
  /** The game a folder holds, or null when it is not a game folder. */
  'games:read': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as GameLibraryEntry | null,
  },
  /** Mint a folder for a new game (scaffolded unless told otherwise). */
  'games:create': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [
      string?,
      { scaffold?: boolean; backend?: string; startingModel?: string; initialPrompt?: string }?,
    ],
    result: null as unknown as GameLibraryEntry,
  },
  /** Flip a game's `published` flag and regenerate the arcade page. */
  'games:publish': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, { name?: string; description?: string }],
    result: null as unknown as { success: true; game: GameLibraryEntry } | IpcFail,
  },
  /** Open a game's own folder, or the library root when none is given. */
  'games:openFolder': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string?],
    result: null as unknown as void,
  },
  /** Open a game's entry file in the OS browser; a game is the user's to keep. */
  'games:play': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as { success: true } | IpcFail,
  },
  /** Regenerate the arcade gallery and open it in the OS browser. */
  'games:openArcade': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: true; path: string } | IpcFail,
  },
  /** Everything the arcade page could list; samples only on an Acer machine. */
  'games:arcadeCatalog': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as ArcadeCatalogEntry[],
  },
  /** Show or hide one catalog row on the arcade page. */
  'games:setArcadeShown': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [{ kind: 'user' | 'sample'; id: string; shown: boolean }],
    result: null as unknown as { success: true } | IpcFail,
  },
} satisfies Record<string, IpcRow>

export type ChannelManifest = typeof CHANNELS
export type ChannelName = keyof ChannelManifest

export type InvokeChannelName = {
  [K in ChannelName]: ChannelManifest[K]['kind'] extends 'invoke' ? K : never
}[ChannelName]
export type SendChannelName = {
  [K in ChannelName]: ChannelManifest[K]['kind'] extends 'send' ? K : never
}[ChannelName]
export type PushChannelName = {
  [K in ChannelName]: ChannelManifest[K]['kind'] extends 'push' ? K : never
}[ChannelName]
/** Push channels whose renderer listener returns no unsubscribe (raw `ipcRenderer.on`). */
export type RawPushChannelName = {
  [K in ChannelName]: ChannelManifest[K] extends PushRow & { raw: true } ? K : never
}[ChannelName]

export type ChannelArgs<N extends ChannelName> = ChannelManifest[N] extends {
  args: infer A extends readonly unknown[]
}
  ? A
  : never
export type ChannelResult<N extends ChannelName> = ChannelManifest[N] extends { result: infer R }
  ? R
  : never
export type PushPayload<N extends ChannelName> = ChannelManifest[N] extends { payload: infer P }
  ? P
  : never

export type BridgeMemberFor<N extends ChannelName> =
  ChannelManifest[N] extends InvokeRow<infer A, infer R>
    ? (...args: A) => Promise<R>
    : ChannelManifest[N] extends SendRow<infer A>
      ? (...args: A) => void
      : ChannelManifest[N] extends PushRow<infer P> & { raw: true }
        ? (callback: (payload: P) => void) => void
        : ChannelManifest[N] extends PushRow<infer P>
          ? (callback: (payload: P) => void) => () => void
          : never

type ChannelLeaf<S extends string> = S extends `${string}:${infer Leaf}` ? ChannelLeaf<Leaf> : S

type BridgeLeafName<N extends ChannelName> = ChannelManifest[N] extends {
  member: infer M extends string
}
  ? M
  : ChannelManifest[N] extends PushRow
    ? `on${Capitalize<ChannelLeaf<N>>}`
    : ChannelLeaf<N>

export type NamespaceBridge<NS extends string> = {
  [K in ChannelName as K extends `${NS}:${string}` ? BridgeLeafName<K> : never]: BridgeMemberFor<K>
}

type ChannelNamespace<S extends string> = S extends `${infer NS}:${string}` ? NS : never

type AllNamespaces = keyof {
  [K in ChannelName as K extends `${string}:${string}` ? ChannelNamespace<K> : never]: never
}

type ChannelGroupLeaves<NS extends string> = {
  [
    K in ChannelName as K extends `${NS}:${infer Rest}`
      ? Rest extends `${string}:${string}`
        ? never
        : BridgeLeafName<K>
      : never
  ]: BridgeMemberFor<K>
}

type SubNamespaces<NS extends string> = keyof {
  [K in ChannelName as K extends `${NS}:${infer Sub}:${string}` ? Sub : never]: never
}

type ChannelGroup<NS extends string> = ChannelGroupLeaves<NS> & {
  [Sub in SubNamespaces<NS>]: ChannelGroup<`${NS}:${Sub}`>
}

/** Bridge members that are not IPC channels (webUtils utilities) — the manifest's escape hatch. */
export type IpcExtraBridgeMembers = {
  getFilePath: (file: File) => string
}

export type ElectronApi = {
  [
    K in ChannelName as K extends `${string}:${string}` ? never : BridgeLeafName<K>
  ]: BridgeMemberFor<K>
} & {
  [NS in AllNamespaces]: ChannelGroup<NS>
} & IpcExtraBridgeMembers
