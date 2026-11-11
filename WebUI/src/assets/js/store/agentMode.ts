import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import type { UIMessage } from 'ai'
import { backendToAipgBackendName, useTextInference } from './textInference'
import { useModels } from './models'
import { useCloudMode } from './cloudMode'
import { usePresets, type ChatPreset } from './presets'
import { usePresetSwitching } from './presetSwitching'
import { useConfirmations } from './confirmations'
import { useOemBranding } from './oemBranding'
import { useErrors } from './errors'
import { useI18N } from './i18n'
import { useMcp } from './mcp'
import { useSessions } from './sessions'
import { unregisterAgentModeIpc } from './agentModeIpc'
import { demoAwareStorage } from '../demoAwareStorage'
import { makeForwardPersist } from '@/lib/ipcPersist'
import { settleStreamingParts } from '@/lib/agentTranscript'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { resolveMountedFolders } from '@/lib/mountedFolders'
import {
  makeFileBackedPreference,
  type FileBackedPreferencesApi,
} from '@/lib/fileBackedPreferences'
import {
  LegacyAgentSessionStateSchema,
  type AgentFollowUpTag,
  type AgentSessionBootstrap,
  type AgentSessionSettings,
  type AgentTaskStep,
  type MountedFolder,
  type LegacyAgentSessionState,
  type AgentRunTag,
} from '@/types/agentSessionIpc'
import {
  type BagDerivedSetting,
  DEFAULT_CAPABILITIES_KEY,
  DEFAULT_MOUNTED_FOLDERS_KEY,
  DEFAULT_PLANNING_THINKING_ONLY_KEY,
  fillMissingSessionSettings,
  keepUneditedSettings,
  presetNameUsesSessionSettings,
  sessionSettingsFromBag,
  sessionSettingsToBag,
  updateSessionSettingsFromBag,
  usesSessionSettings,
} from '@/lib/agentSessionSettings'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
import { hasChatAffordances } from '@/lib/chatAffordances'
import { harnessInstructions } from '@/lib/presetPrompt'
import {
  describeSettingsProblems,
  sessionSettingsProblems,
  type SessionSettingsProblem,
} from '@/lib/sessionSettingsProblems'
import { createAppError, createCancellation, extractMessage } from '@/assets/js/errors/appError'
import { registerSessionPromptPort } from '@/assets/js/permissions/sessionPromptPort'
import * as toast from '@/assets/js/toast'
import { withResponseLanguage } from '@/lib/responseLanguage'
import { ragEmbeddingPrepFailure } from '@/lib/ragEmbeddingPrep'
import { requestDownload } from '@/assets/js/permissions/permissions'
import {
  DEFAULT_CAPABILITY_IDS,
  MCP_CAPABILITY_PREFIX,
  WEB_CAPABILITY_ID,
  GAME_STUDIO_QUICK_ID,
  PLANNING_PHASE_CAPABILITY_IDS,
  OFFER_GAME_AGENT_TOOL,
  RAG_PREPARE_EMBEDDING_MODEL,
  SCREENSHOT_WINDOW_QUERY,
} from '@/types/agentCapabilities'
import { harnessTurnRefusal, type AgentAnswerOrigin, type GameLibraryEntry } from '@/types/agentIpc'
import type { AgentTurnState, PauseReason } from '@/types/kernelEvents'
import type { HarnessTurnRef, LiveAgentTurn } from '@/lib/turnTypes'
import type { ChannelKind } from './channels/types'
import type { HeldAnswerView, SessionTurnEnd } from './channels/answerRouter'
import {
  applySessionPresetNames,
  computedPresetSessions,
  ensureSessionId,
  GAME_AGENT_PRESET,
  gameAgentHandoffPrompt,
  migrateMcpServerIdsIntoCapabilities,
  mintSessionId,
  snapshotSession,
  takeLegacyPlanningThinkingOnly,
  toggleCapabilityIds,
  turnLabelOf,
  type AgentSessionRecord,
} from './agentModeSessions'
import {
  buildTurnConfig,
  createAgentTurnRuntimes,
  latestTurnMetadata,
  type AgentSessionRuntime,
  type RegenerateBody,
} from './agentModeTurn'
import {
  createUnsandboxedWorkspaces,
  createSessionDocuments,
  createWorkspaceAttachments,
  isDocumentName,
  isGameFolder,
  reconcileGamesWorkspace,
} from './agentModeWorkspace'

export type { AgentSessionRecord }

export type SessionTurnInfo = {
  state: AgentTurnState
  queuePosition: number | null
  /** What the user is asked, only while paused. */
  pauseReason?: PauseReason
}

/** How a turn that ended out of sight went. */
export type UnseenTurn = 'done' | 'failed'

/** How a session's turn ended, as the settled-turn hook reports it. */
export type TurnOutcome =
  { kind: 'completed' } | { kind: 'error'; message: string } | { kind: 'stopped' }

/** Stored with a user message; `origin` is the channel an Answer arrived on. */
export type AgentMessageMetadata = { origin?: ChannelKind; followUp?: AgentFollowUpTag }

/** The Task run holding a session; its Steps are sent with `signal`, which is how it is let in. */
export type SessionTaskLock = { taskName: string; signal: AbortSignal | undefined }

export type SendToSessionResult =
  | { ok: true }
  | {
      ok: false
      reason:
        'no-session' | 'busy' | 'task-locked' | 'missing-folder' | 'settings-problems' | 'aborted'
      message: string
      problems?: SessionSettingsProblem[]
    }

// ── Agent Mode: renderer side of the Pi coding-agent integration ─────────────
//
// The Pi session runs in the Electron main process
// (electron/agent/piAgentManager.ts). This store owns the UI state
// (workspace folder, sandbox consent) and a custom ChatTransport whose
// sendMessages() triggers `agentMode:startTurn` over IPC and reconstructs the UI
// message chunk stream from kernel `agent-chunk` events — feeding a standard
// @ai-sdk/vue Chat instance so the existing part renderers work unchanged.
// The model controls are Chat's (textInference + cloudMode); for the Agent preset
// they are bound to the open Harness Session's Session Settings (docs/adr/0001).
//
// Each Harness Session gets its own turn runtime (Chat instance, busy state, tool
// progress and images), and kernel events reach only the runtime of the Harness
// Session they carry. The open Harness Session only selects which runtime Agent
// Mode renders. Every sent turn waits in main's Turn Queue, so any number of
// Harness Sessions can hold a queued turn while one runs. For the Agent preset,
// switching Harness Session or workspace (newSession, switchSession, adoptWorkspace)
// leaves turns running, as does leaving any agent turn of a Session; outside a
// Session, Game Agent and Quick Coder still stop the open Harness Session's turn
// when left.
// Nothing is re-queued after a restart: a message whose turn never ran is marked
// "not run" and waits for the user to resend it.

/**
 * Capabilities a new session starts with. Same list as DEFAULT_CAPABILITY_IDS;
 * persisted from then on as the user's own selection.
 */
const DEFAULT_CAPABILITIES = [...DEFAULT_CAPABILITY_IDS]

/** The Pinia persistence key this store wrote before session records moved to files. */
const LEGACY_AGENT_MODE_KEY = 'agentMode'

export const useAgentMode = defineStore(
  'agentMode',
  () => {
    const textInference = useTextInference()
    const models = useModels()
    const cloudMode = useCloudMode()
    const presetsStore = usePresets()
    const presetSwitching = usePresetSwitching()
    const confirmations = useConfirmations()
    const oemBranding = useOemBranding()
    const errors = useErrors()
    const i18n = useI18N()
    const mcp = useMcp()
    const sessionsStore = useSessions()
    /** The Session each Harness Session of this app run belongs to. */
    const harnessSessionRefs: Record<string, string> = {}

    const workspaceDir = ref<string>('')

    /**
     * The agent preset driving the session, if any. Agent Mode is entered by
     * selecting a chat preset marked `agentPreset` (Agent, Game Agent), and that
     * preset supplies the extra instructions and the capability set.
     *
     * Remembered rather than read live, because the active preset can change
     * under a running turn — the user clicking another preset mid-turn must
     * not swap the session's capabilities, instructions and workspace policy
     * while the agent is working, and the workspace watcher below would stop
     * the very turn that was interrupted.
     */
    const agentPresetName = ref<string>('')

    const activeAgentPreset = computed<ChatPreset | null>(() => {
      const active = presetsStore.activePresetWithVariant
      if (active?.type === 'chat' && active.name === agentPresetName.value) {
        return active as ChatPreset
      }
      const remembered = presetsStore.presets.find((p) => p.name === agentPresetName.value)
      return remembered?.type === 'chat' ? (remembered as ChatPreset) : null
    })

    watch(
      () => presetsStore.activePresetWithVariant,
      (preset) => {
        if (preset?.type === 'chat' && (preset as ChatPreset).agentPreset) {
          agentPresetName.value = preset.name
        }
      },
      { immediate: true },
    )

    /** The active preset is the remembered agent preset, so Agent Mode is what the user sees. */
    const agentActive = computed(() => {
      const active = presetsStore.activePresetWithVariant
      return (
        active?.type === 'chat' &&
        !!(active as ChatPreset).agentPreset &&
        active.name === agentPresetName.value
      )
    })

    const presetCapabilities = computed<string[] | null>(() => {
      const declared = activeAgentPreset.value?.agentCapabilities
      return declared && declared.length > 0 ? declared : null
    })

    const agentWorkspaceKind = computed<'pick' | 'games'>(
      () => activeAgentPreset.value?.agentWorkspace ?? 'pick',
    )

    function workspaceKindOf(presetName: string): 'pick' | 'games' {
      const preset = presetsStore.presets.find((entry) => entry.name === presetName)
      return preset?.type === 'chat' ? ((preset as ChatPreset).agentWorkspace ?? 'pick') : 'pick'
    }

    const currentGame = ref<GameLibraryEntry | null>(null)
    const lastWorkspaceByKind = ref<Record<string, string>>({})
    const defaultCapabilities = ref<string[]>([...DEFAULT_CAPABILITIES])
    const mcpServerIds = ref<string[]>([])
    /** Set once `web` has been added to a default list saved before it existed. */
    const webCapabilityAdopted = ref(false)
    /** Set once saved defaults were replaced by the current default set; renamed when that set changes. */
    const defaultCapabilitiesAdopted = ref(false)

    const { unsandboxedWorkspaces, unsandboxed, isUnsandboxed, setUnsandboxed } =
      createUnsandboxedWorkspaces(workspaceDir)

    const sessions = ref<Record<string, AgentSessionRecord>>({})
    const openSessionId = ref<string>('')
    /** Set once `init()` has hydrated (or migrated) — gates every write-through. */
    const sessionsHydrated = ref(false)

    // Step 8 (§6.1): the last-used workspace pointers are app data — their
    // own kernel-owned file (agent-workspace.json), not the preferences file.
    // The pinia key keeps the user preferences, so this half only slims its
    // fields out of it.
    const workspaceApi: FileBackedPreferencesApi = {
      read: async () => {
        const r = await window.electronAPI.agentMode.readWorkspaceState()
        if (!r.success) return { success: false as const, error: r.error }
        // An absent file is the "never migrated" state; a failed read
        // (success false) never is.
        return r.section === null
          ? { success: true as const, sections: {} }
          : { success: true as const, sections: { agentWorkspace: r.section } }
      },
      migrate: (_section, payload) => window.electronAPI.agentMode.migrateWorkspaceState(payload),
      write: (_section, value) => window.electronAPI.agentMode.writeWorkspaceState(value),
    }
    const workspacePrefs = makeFileBackedPreference({
      section: 'agentWorkspace',
      refs: { workspaceDir, lastWorkspaceByKind },
      legacyKey: 'agentMode',
      legacySlim: true,
      api: workspaceApi,
      errorScope: 'agent-workspace',
    })
    if (import.meta.hot) import.meta.hot.dispose(() => workspacePrefs.dispose())
    let agentSessionsInitPromise: Promise<void> | null = null
    /** Set while a session is deliberately moved between presets, so the watcher below leaves it. */
    let movingSession = false

    const presetSessions = computedPresetSessions(sessions, agentPresetName)

    /**
     * The open Harness Session's Session Settings (Agent preset only). Null until a draft
     * has taken the Default Settings; the chat store's next load fills it.
     */
    const openSettings = ref<AgentSessionSettings | null>(null)

    const sessionScoped = computed(() => usesSessionSettings(activeAgentPreset.value))

    /** Where a Session keeps the Agent preset's Session Settings (`session.json`, ADR-0004). */
    type AgentSettingsPort = {
      /** The open Session's copy; undefined until its settings are read or the preset ran there. */
      read: (presetName: string) => { settings: AgentSessionSettings; sent: boolean } | undefined
      write: (presetName: string, settings: AgentSessionSettings, sent: boolean) => void
      drop: (presetName: string) => void
      /** Another Session's copy, for a turn sent to a Harness Session that is not open. */
      readStored: (sessionRef: string, presetName: string) => Promise<AgentSessionSettings | null>
      whenLoaded: () => Promise<void>
    }
    const settingsPort = shallowRef<AgentSettingsPort | null>(null)

    function bindSessionSettingsPort(port: AgentSettingsPort | null): void {
      settingsPort.value = port
      if (!port || !heldBySession()) return
      void port.whenLoaded().then(() => {
        if (heldBySession()) applyOpenSessionSettings(port.read(agentPresetName.value)?.settings)
      })
    }

    /** Main changed the open Session's stored settings: take them into the live controls. */
    function reloadOpenSessionSettings(): void {
      const port = settingsPort.value
      if (port && heldBySession())
        applyOpenSessionSettings(port.read(agentPresetName.value)?.settings)
    }

    /** The open Harness Session's settings live in its Session, not on its own record. */
    function heldBySession(): boolean {
      const id = openSessionId.value
      const sessionRef = sessions.value[id]?.sessionRef ?? harnessSessionRefs[id]
      return (
        !!settingsPort.value &&
        sessionScoped.value &&
        !!sessionRef &&
        sessionRef === sessionsStore.openSessionId
      )
    }

    function writeSessionSettings(sent: boolean): void {
      if (!openSettings.value) return
      settingsPort.value?.write(agentPresetName.value, cloneForIpc(openSettings.value), sent)
    }

    /** The open Harness Session has been sent: its stored settings are its own and are checked. */
    const sessionSent = computed(() => {
      if (heldBySession()) return settingsPort.value?.read(agentPresetName.value)?.sent === true
      return sessionScoped.value && (sessions.value[openSessionId.value]?.messages.length ?? 0) > 0
    })

    /** Live values right after a sent session loaded; fields still equal to them were not edited. */
    let loadedBaseline: AgentSessionSettings | null = null
    let editedSinceLoad: ReadonlySet<BagDerivedSetting> = new Set()

    /** What in these settings can no longer be used; missing MCP servers only once they are listed. */
    function problemsOf(settings: AgentSessionSettings): SessionSettingsProblem[] {
      return sessionSettingsProblems(settings, {
        ...textInference.settingsAvailability,
        mcpServerIds: mcp.serversLoaded ? mcp.allServers.map((server) => server.id) : null,
      })
    }

    async function loadMcpServersFor(capabilityIds: readonly string[]): Promise<void> {
      if (!mcp.serversLoaded && capabilityIds.some((id) => id.startsWith('mcp:'))) {
        await mcp.refreshAvailableServers()
      }
    }

    /** Stored settings of the sent session that can no longer be used. Drafts are never blocked. */
    const settingsProblems = computed<SessionSettingsProblem[]>(() => {
      if (!sessionSent.value || !openSettings.value) return []
      return problemsOf({ ...openSettings.value, capabilities: capabilities.value })
    })

    /** Refuse a turn while a stored setting is unusable; the prompt bar names the field. */
    async function blockedBySettingsProblems(): Promise<boolean> {
      if (!sessionSent.value) return false
      await loadMcpServersFor(capabilities.value)
      const problems = settingsProblems.value
      if (problems.length === 0) return false
      errors.report(
        createAppError({
          category: 'validation',
          code: 'agent/session-settings-unusable',
          userMessage: i18n.state.AGENT_SETTINGS_UNUSABLE,
          technicalMessage: problems.map((p) => `${p.field}: ${p.value}`).join(', '),
          surface: 'inline',
          severity: 'warning',
        }),
      )
      return true
    }

    type AgentDefaults = {
      capabilities: string[]
      planningThinkingOnly: boolean
      mountedFolders?: MountedFolder[]
    }

    /**
     * The capability and planning half of the Agent preset's Default Settings. Until the
     * preset's bag holds them, the former global values stand in (`migrate` copies them in).
     */
    function readAgentDefaults(): AgentDefaults {
      const bag = textInference.settingsPerPreset?.[HARNESS_CHAT_PRESET] ?? {}
      const capabilities = bag[DEFAULT_CAPABILITIES_KEY]
      const planning = bag[DEFAULT_PLANNING_THINKING_ONLY_KEY]
      const mountedFolders = bag[DEFAULT_MOUNTED_FOLDERS_KEY]
      return {
        ...(Array.isArray(mountedFolders)
          ? { mountedFolders: (mountedFolders as MountedFolder[]).map((folder) => ({ ...folder })) }
          : {}),
        capabilities: Array.isArray(capabilities)
          ? [...(capabilities as string[])]
          : [...defaultCapabilities.value],
        planningThinkingOnly: typeof planning === 'boolean' ? planning : planningThinkingOnly.value,
      }
    }

    /** Copy the former global defaults into the Agent preset's Default Settings once. */
    function migrateAgentDefaults(): AgentDefaults {
      const defaults = readAgentDefaults()
      const bags = textInference.settingsPerPreset
      if (!bags) return defaults
      const bag = bags[HARNESS_CHAT_PRESET] ?? {}
      if (DEFAULT_CAPABILITIES_KEY in bag && DEFAULT_PLANNING_THINKING_ONLY_KEY in bag) {
        return defaults
      }
      textInference.settingsPerPreset = {
        ...bags,
        [HARNESS_CHAT_PRESET]: {
          ...bag,
          [DEFAULT_CAPABILITIES_KEY]: defaults.capabilities,
          [DEFAULT_PLANNING_THINKING_ONLY_KEY]: defaults.planningThinkingOnly,
        },
      }
      return defaults
    }

    textInference.bindSessionSettings({
      load: (defaults, embeddingBackend) => {
        if (!openSettings.value) return null
        fillFromDefaults(defaults, embeddingBackend)
        return sessionSettingsToBag(openSettings.value, defaults, embeddingBackend)
      },
      save: (bag, embeddingBackend) => {
        const stored = openSettings.value
        // A draft Harness Session's first save also takes the capability and planning defaults.
        const next = updateSessionSettingsFromBag(
          stored ?? migrateAgentDefaults(),
          bag,
          embeddingBackend,
        )
        if (!stored || !loadedBaseline) {
          openSettings.value = next
        } else {
          const kept = keepUneditedSettings(stored, next, loadedBaseline, editedSinceLoad)
          editedSinceLoad = kept.edited
          openSettings.value = kept.settings
        }
        if (heldBySession()) writeSessionSettings(sessionSent.value)
      },
      pinned: () => sessionSent.value,
      loaded: (bag, embeddingBackend) => {
        loadedBaseline = updateSessionSettingsFromBag(null, bag, embeddingBackend)
        editedSinceLoad = new Set()
      },
    })

    /** "Save as default": the open Harness Session's settings become the preset's defaults. */
    function saveAsDefault(): void {
      const settings = openSettings.value
      if (!sessionScoped.value || !settings) return
      const bags = textInference.settingsPerPreset ?? {}
      const base = bags[HARNESS_CHAT_PRESET] ?? {}
      textInference.settingsPerPreset = {
        ...bags,
        [HARNESS_CHAT_PRESET]: {
          ...sessionSettingsToBag(settings, base, textInference.embeddingBackend),
          [DEFAULT_CAPABILITIES_KEY]: [...capabilities.value],
          [DEFAULT_PLANNING_THINKING_ONLY_KEY]: effectivePlanningThinkingOnly.value,
          [DEFAULT_MOUNTED_FOLDERS_KEY]: cloneForIpc(mountedFolders.value),
        },
      }
    }

    /**
     * "Reset to default": the open Harness Session takes the Default Settings again, repaired
     * the way a new draft is. Other sessions and the stored defaults stay as they are.
     */
    function resetToDefault(): void {
      if (!sessionScoped.value) return
      if (heldBySession()) {
        settingsPort.value?.drop(agentPresetName.value)
        openSettings.value = null
        textInference.loadSettingsForActivePreset()
        return
      }
      openSettings.value = null
      // The load hands the repaired defaults back through the binding's save.
      textInference.loadSettingsForActivePreset()
      const reset = openSettings.value as AgentSessionSettings | null
      const session = sessions.value[openSessionId.value]
      if (!session || !reset) return
      rewriteSession(openSessionId.value, { ...session, settings: { ...reset } })
    }

    /**
     * A sent session whose file predates a field takes it from the current Default Settings
     * (unrepaired) and stores it, so it does not follow later changes to the defaults.
     */
    function fillFromDefaults(
      defaults: Record<string, unknown>,
      embeddingBackend: 'llamaCPP' | 'openVINO',
    ): void {
      const record = sessions.value[openSessionId.value]
      const inSession = heldBySession()
      if (inSession ? !sessionSent.value : !record || record.messages.length === 0) return
      if (!sessionsHydrated.value) return
      const fromDefaults: AgentSessionSettings = {
        ...sessionSettingsFromBag(defaults, embeddingBackend),
        ...readAgentDefaults(),
      }
      const filled = fillMissingSessionSettings(openSettings.value ?? {}, fromDefaults)
      if (!filled.changed) return
      openSettings.value = filled.settings
      if (inSession) writeSessionSettings(true)
      else if (record)
        rewriteSession(openSessionId.value, { ...record, settings: { ...filled.settings } })
    }

    /** What a record contributes on activation: a sent Agent session always has settings. */
    function settingsOfRecord(
      record: AgentSessionRecord | undefined,
    ): AgentSessionSettings | undefined {
      if (!record || record.messages.length === 0) return record?.settings
      if (!nameUsesSessionSettings(record.presetName)) return record.settings
      return record.settings ?? {}
    }

    function presetUsesSessionSettings(presetName: string): boolean {
      const preset = presetsStore.presets.find((entry) => entry.name === presetName)
      return preset?.type === 'chat' && usesSessionSettings(preset as ChatPreset)
    }

    /** By name, also before the preset catalog has loaded (the Agent preset's records). */
    function nameUsesSessionSettings(presetName: string | undefined): boolean {
      return (
        presetNameUsesSessionSettings(presetName) ||
        (presetName !== undefined && presetUsesSessionSettings(presetName))
      )
    }

    /**
     * Put the open Harness Session's settings into the live controls. Nothing starts here: the
     * backend and model are made ready by the next send.
     */
    function applyOpenSessionSettings(settings: AgentSessionSettings | undefined): void {
      openSettings.value = settings ? { ...settings } : null
      loadedBaseline = null
      editedSinceLoad = new Set()
      const live = presetsStore.activePresetWithVariant
      if (live?.type !== 'chat' || !usesSessionSettings(live as ChatPreset)) return
      textInference.loadSettingsForActivePreset()
    }
    const sessionCapabilities = ref<string[] | null>(null)

    /** Accepted `offer_game_agent`s by session, each waiting for the turn that offered it to end. */
    const pendingHandoffs: Record<string, { summary: string; request: string }> = {}

    const capabilities = computed<string[]>(() => {
      if (sessionScoped.value) {
        return openSettings.value?.capabilities ?? readAgentDefaults().capabilities
      }
      return (
        sessions.value[openSessionId.value]?.capabilities ??
        sessionCapabilities.value ??
        presetCapabilities.value ??
        defaultCapabilities.value
      )
    })

    function isCapabilityEnabled(id: string): boolean {
      return capabilities.value.includes(id)
    }

    /** Only the folder-picking Agent preset and the Agents saved from it reach folders beyond their own. */
    const mountedFoldersSupported = computed(() => sessionScoped.value)

    const mountedFolders = computed<MountedFolder[]>(() =>
      sessionScoped.value
        ? (openSettings.value?.mountedFolders ?? readAgentDefaults().mountedFolders ?? [])
        : [],
    )

    function setMountedFolders(next: MountedFolder[]): void {
      if (sessionScoped.value) updateOpenSettings({ mountedFolders: next })
    }

    const planningPhaseSupported = computed(() =>
      capabilities.value.some((id) => PLANNING_PHASE_CAPABILITY_IDS.includes(id)),
    )

    /** Change the open Harness Session's own settings and keep its record (if any) in step. */
    function updateOpenSettings(change: AgentSessionSettings): void {
      openSettings.value = { ...openSettings.value, ...change }
      if (heldBySession()) {
        writeSessionSettings(sessionSent.value)
        return
      }
      const session = sessions.value[openSessionId.value]
      if (!session) return
      rewriteSession(openSessionId.value, { ...session, settings: { ...openSettings.value } })
    }

    function setCapabilityEnabled(id: string, enabled: boolean): void {
      setCapabilities(toggleCapabilityIds(capabilities.value, id, enabled))
    }

    function setCapabilities(next: string[]): void {
      if (sessionScoped.value) {
        updateOpenSettings({ capabilities: next })
        return
      }
      if (presetCapabilities.value) sessionCapabilities.value = next
      else defaultCapabilities.value = next
      const session = sessions.value[openSessionId.value]
      if (!session) return
      rewriteSession(openSessionId.value, { ...session, capabilities: next })
    }

    /**
     * "Reset Preset Settings" for Agent Mode: put the settings this panel owns
     * back to what the preset (or the built-in default) asks for. The active
     * session carries its own capability copy, so it is re-stamped too —
     * otherwise the checkboxes would snap straight back on the next read.
     *
     * Workspace folder, sandbox consent and the sessions themselves are
     * user-owned state, not preset settings, and are left alone. The shared
     * model settings are reset by textInference's own reset.
     */
    function resetPresetSettings(): void {
      planningThinkingOnly.value = true
      sessionCapabilities.value = null
      defaultCapabilities.value = [...DEFAULT_CAPABILITIES]
      if (sessionScoped.value) {
        updateOpenSettings({ mountedFolders: [], ...migrateAgentDefaults() })
        return
      }
      const session = sessions.value[openSessionId.value]
      if (!session) return
      // Not `capabilities.value`: that still reads the session's own copy, which
      // is the very override being cleared here.
      const restored = presetCapabilities.value ?? defaultCapabilities.value
      rewriteSession(openSessionId.value, { ...session, capabilities: [...restored] })
    }

    /** An Agent session saved before Session Settings keeps its capabilities at the top level. */
    function adoptLegacySessionCapabilities(): void {
      const next = { ...sessions.value }
      let changed = false
      for (const [id, record] of Object.entries(next)) {
        if (!nameUsesSessionSettings(record.presetName)) continue
        if (!record.capabilities || record.settings?.capabilities) continue
        const { capabilities: legacy, ...rest } = record
        next[id] = { ...rest, settings: { ...record.settings, capabilities: legacy } }
        changed = true
      }
      if (changed) sessions.value = next
    }

    async function migrateSessionPresets(): Promise<void> {
      const legacy = Object.values(sessions.value).filter((session) => !session.presetName)
      const gameFolders = new Set<string>()
      if (legacy.length > 0) {
        const games = await window.electronAPI.games.list()
        for (const game of games) gameFolders.add(game.dir)
      }
      sessions.value = applySessionPresetNames(sessions.value, gameFolders)
    }

    // ── Hydration (step 8, architecture-target §6.1) ─────────────────────────────
    //
    // Session records — transcripts included — live as kernel-owned files
    // (`AI-Playground/agent-sessions/`); this store is the live projection.
    // `init()` runs once before the app mounts, so the Sessions panel and a
    // resumed turn never see a half-hydrated map.

    /** The pre-step-8 Pinia-persisted payload, read once for the legacy upload. */
    function readLegacyAgentSessions(): LegacyAgentSessionState | null {
      const raw = demoAwareStorage.getItem(LEGACY_AGENT_MODE_KEY)
      if (!raw) return null
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        return LegacyAgentSessionStateSchema.parse({
          sessions: parsed.sessions ?? {},
          activeSessionId:
            typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null,
        })
      } catch {
        return null
      }
    }

    /**
     * Files own the records now, so the legacy copies leave the Pinia key —
     * including a leftover empty payload, which would otherwise linger (and
     * keep the multi-megabyte transcripts in localStorage) forever. Kept when
     * the upload failed, so the next boot can retry it.
     */
    function stripLegacyAgentSessions(): void {
      const raw = demoAwareStorage.getItem(LEGACY_AGENT_MODE_KEY)
      if (!raw) return
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        delete parsed.sessions
        delete parsed.activeSessionId
        demoAwareStorage.setItem(LEGACY_AGENT_MODE_KEY, JSON.stringify(parsed))
      } catch {
        // Unreadable leftover: the persist plugin's next write replaces the
        // key wholesale with only the picked fields, so it heals itself.
      }
    }

    async function init(): Promise<void> {
      if (agentSessionsInitPromise) return agentSessionsInitPromise
      agentSessionsInitPromise = (async () => {
        let bootstrap: AgentSessionBootstrap | { status: 'error'; error: string } | null = null
        let bootstrapError: unknown = null
        try {
          bootstrap = await window.electronAPI.agentMode.bootstrapSessions()
          // One-shot legacy upload (§6.1: "localStorage migrates once"): a
          // first boot with no index uploads whatever the old persisted state
          // held, then the key is slimmed so it never runs or dual-writes
          // again.
          if (
            bootstrap.status === 'empty' ||
            (bootstrap.status === 'ok' && bootstrap.sessions.length === 0)
          ) {
            const legacy = readLegacyAgentSessions()
            if (legacy && Object.keys(legacy.sessions).length > 0) {
              bootstrap = await window.electronAPI.agentMode.migrateSessions(legacy)
            }
          }
          if (
            bootstrap.status === 'ok' ||
            (bootstrap.status === 'empty' && demoAwareStorage.getItem(LEGACY_AGENT_MODE_KEY))
          ) {
            stripLegacyAgentSessions()
          }
        } catch (error) {
          bootstrap = null
          bootstrapError = error
        }
        if (!bootstrap) {
          errors.report(bootstrapError ?? new Error('agent session bootstrap IPC failed'), {
            code: 'agent-sessions/bootstrap-failed',
            category: 'backend',
            severity: 'warning',
            surface: 'silent',
            technicalMessage:
              'the session file store did not answer; the session list may be empty this session',
          })
        } else if (bootstrap.status === 'error') {
          errors.report(new Error(bootstrap.error), {
            code: 'agent-sessions/bootstrap-failed',
            category: 'backend',
            severity: 'warning',
            surface: 'silent',
            technicalMessage: 'the session file store rejected the boot hydration',
          })
          bootstrap = null
        }
        if (bootstrap && bootstrap.status === 'ok') {
          const hydrated: Record<string, AgentSessionRecord> = {}
          for (const record of bootstrap.sessions) {
            hydrated[record.id] = { ...record, messages: record.messages as UIMessage[] }
          }
          sessions.value = hydrated
          // A missing id is not adopted. A corrupt file hydrates as a
          // placeholder (empty transcript) so the list keeps it.
          const activeId = bootstrap.activeSessionId
          if (activeId && hydrated[activeId]) openSessionId.value = activeId
          mergeHydratedTranscripts()
          markNotRunMessages()
          restoreOpenSession()
          // Ran from the persist plugin's afterHydrate before the records moved
          // to files; it needs the hydrated records (and the games library).
          // Renamed records persist with their next snapshot, so legacy
          // sessions may re-run this once per boot — idempotent and bounded.
          await migrateSessionPresets()
          adoptLegacySessionCapabilities()
        }
        sessionsHydrated.value = true
        // Re-apply now that writes are allowed: the open record may only now carry its
        // capabilities, and missing fields can be filled and stored.
        if (bootstrap?.status === 'ok') {
          applyOpenSessionSettings(settingsOfRecord(sessions.value[openSessionId.value]))
        }
        // The workspace half of the same shared legacy key runs strictly
        // after the sessions half: interleaved read-modify-write slims can
        // resurrect what the other removed (§8.2).
        await workspacePrefs.init()
        // The agentWorkspaceKind watch can have fired before this hydrate
        // (preset files load during conversations/media init): a games-kind
        // flip against an empty workspace no-ops inside
        // reconcileGamesWorkspace, so the reconciliation the pinia
        // afterHydrate used to run repeats here against hydrated pointers.
        await reconcileWorkspaceKind()
        await refreshCurrentGame()
      })()
      return agentSessionsInitPromise
    }

    function adoptWebCapability(): void {
      if (webCapabilityAdopted.value) return
      webCapabilityAdopted.value = true
      if (!defaultCapabilities.value.includes(WEB_CAPABILITY_ID)) {
        defaultCapabilities.value = [...defaultCapabilities.value, WEB_CAPABILITY_ID]
      }
    }

    function adoptDefaultCapabilities(): void {
      if (defaultCapabilitiesAdopted.value) return
      defaultCapabilitiesAdopted.value = true
      const adopted = (ids: string[]) => [
        ...DEFAULT_CAPABILITY_IDS,
        ...ids.filter((id) => id.startsWith(MCP_CAPABILITY_PREFIX)),
      ]
      defaultCapabilities.value = adopted(defaultCapabilities.value)
      const bags = textInference.settingsPerPreset
      const bag = bags?.[HARNESS_CHAT_PRESET]
      const stored = bag?.[DEFAULT_CAPABILITIES_KEY]
      if (!bag || !Array.isArray(stored)) return
      textInference.settingsPerPreset = {
        ...bags,
        [HARNESS_CHAT_PRESET]: { ...bag, [DEFAULT_CAPABILITIES_KEY]: adopted(stored as string[]) },
      }
    }

    function migrateMcpServerIds(): void {
      const migrated = migrateMcpServerIdsIntoCapabilities(
        mcpServerIds.value,
        defaultCapabilities.value,
      )
      mcpServerIds.value = migrated.mcpServerIds
      defaultCapabilities.value = migrated.defaultCapabilities
    }

    // Agent Mode only: think through the plan, then stop thinking. Previously
    // persisted inside chat `settingsPerPreset`; copied from there on first
    // hydrate if this store has not stored it yet.
    const planningThinkingOnly = ref(true)

    const effectivePlanningThinkingOnly = computed<boolean>(() =>
      sessionScoped.value
        ? (openSettings.value?.planningThinkingOnly ?? readAgentDefaults().planningThinkingOnly)
        : planningThinkingOnly.value,
    )

    /** The Session Settings the panel holds for the open Harness Session right now. */
    const openSessionSettings = computed<AgentSessionSettings>(() => ({
      ...openSettings.value,
      capabilities: [...capabilities.value],
      planningThinkingOnly: effectivePlanningThinkingOnly.value,
      ...(mountedFolders.value.length > 0 ? { mountedFolders: [...mountedFolders.value] } : {}),
    }))

    function setPlanningThinkingOnly(value: boolean): void {
      if (sessionScoped.value) updateOpenSettings({ planningThinkingOnly: value })
      else planningThinkingOnly.value = value
    }

    function migratePlanningThinkingOnly(): void {
      const bags = textInference.settingsPerPreset
      if (!bags) return
      const { value, bags: next } = takeLegacyPlanningThinkingOnly(
        bags,
        agentPresetName.value || HARNESS_CHAT_PRESET,
      )
      if (typeof value === 'boolean') planningThinkingOnly.value = value
      if (next !== bags) textInference.settingsPerPreset = next
    }

    // Frozen per session so a later turn does not rebuild Pi (instructions are
    // part of the session key) or pick up a Language-selector change mid-run.
    const pendingResponseLocales: Record<string, string> = {}
    const pendingTitles: Record<string, string> = {}

    function sessionResponseLocale(sessionId: string): string {
      const stored = sessions.value[sessionId]?.responseLocale ?? pendingResponseLocales[sessionId]
      if (stored) return stored
      pendingResponseLocales[sessionId] = i18n.langName
      return pendingResponseLocales[sessionId]
    }

    // The rag capability (main process) asks for this before its first index:
    // the session-frozen embedding model may not be on disk yet, and the
    // renderer owns the download policy (shared dialog) plus the models store.
    async function prepareRagEmbeddingModel(input: Record<string, unknown>): Promise<unknown> {
      const model = typeof input.model === 'string' ? input.model : ''
      const backend = input.backend === 'openVINO' ? 'openVINO' : 'llamaCPP'
      if (!model) return { status: 'ready' }
      const checked = await models.checkModelAlreadyLoaded([
        { repo_id: model, type: 'embedding', backend: backendToAipgBackendName[backend] },
      ])
      const missing = checked.filter((m) => !m.already_loaded)
      if (missing.length === 0) return { status: 'ready' }
      // The permissions layer owns the prompt (the shared download modal, or
      // the in-channel question on a remote Home Agent turn), so the agent
      // store does not touch the dialog store directly — the same seam chat
      // and media use (AGENTS.md: "Report through the sink, not directly").
      try {
        await requestDownload(missing)
        return { status: 'ready' }
      } catch (error) {
        return ragEmbeddingPrepFailure(error)
      }
    }

    /**
     * What a turn was sent with, for saving its session should it end while another is open.
     * `stored` turns run on these settings instead of the live controls.
     */
    type TurnContext = {
      workspaceDir: string
      presetName: string
      capabilities: string[]
      settings?: AgentSessionSettings
      stored: boolean
      quietErrors?: boolean
      /** Set for the one turn a channel Answer started. */
      answer?: AgentAnswerOrigin
      taskRun?: AgentModeTurnConfig['taskRun']
      followUp?: AgentFollowUpTag
    }
    const turnContexts: Record<string, TurnContext> = {}

    /** The open Harness Session's Session Settings are bound to the live controls (ADR 0001). */
    function liveTurnContext(): TurnContext {
      return {
        workspaceDir: workspaceDir.value,
        presetName: agentPresetName.value,
        capabilities: [...capabilities.value],
        settings: openSettings.value ? { ...openSettings.value } : undefined,
        stored: false,
      }
    }

    function storedTurnContext(
      record: AgentSessionRecord,
      settingsOverride?: AgentSessionSettings,
    ): TurnContext {
      const settings = settingsOverride ?? record.settings ?? {}
      return {
        workspaceDir: record.workspaceDir,
        presetName: record.presetName ?? HARNESS_CHAT_PRESET,
        capabilities: [
          ...(settings.capabilities ?? record.capabilities ?? readAgentDefaults().capabilities),
        ],
        settings: { ...settings },
        stored: true,
      }
    }

    function sessionRefOf(harnessSessionId: string): string | undefined {
      return harnessSessionRefs[harnessSessionId] ?? sessions.value[harnessSessionId]?.sessionRef
    }

    function requestTurnDeletion(
      harnessSessionId: string,
      turnIds: string[],
      messageIds: string[],
    ) {
      const sessionRef = sessionRefOf(harnessSessionId)
      return window.electronAPI.agentMode.deleteTurns({
        ...(sessionRef ? { sessionRef } : {}),
        harnessSessionId,
        turnIds,
        messageIds,
      })
    }

    function liveTurnConfig(sessionId: string) {
      return buildTurnConfig({
        sessionId,
        sessionRef: sessionRefOf(sessionId),
        workspaceDir: workspaceDir.value,
        // The remembered agent preset, not the active one: a media call
        // switches the active preset to an image-gen one mid-turn.
        presetName: agentPresetName.value,
        instructions: withResponseLanguage(
          harnessInstructions(activeAgentPreset.value, textInference.systemPrompt),
          sessionResponseLocale(sessionId),
        ),
        ownsPrompt: activeAgentPreset.value?.agentOwnsPrompt === true,
        userSampling: hasChatAffordances(activeAgentPreset.value),
        capabilities: [...capabilities.value],
        unsandboxed: unsandboxed.value,
        mountedFolders: resolveMountedFolders(mountedFolders.value),
        planningThinkingOnly: effectivePlanningThinkingOnly.value,
        textInference,
        cloudMode,
        answer: turnContexts[sessionId]?.answer,
      })
    }

    function followedRunOf(record: AgentSessionRecord | undefined) {
      const run = record?.taskRun
      return run ? { taskName: run.taskName, startedAt: run.startedAt } : undefined
    }

    function storedTurnConfig(sessionId: string, context: TurnContext) {
      const preset = presetsStore.presets.find((entry) => entry.name === context.presetName)
      const chatPreset = preset?.type === 'chat' ? (preset as ChatPreset) : undefined
      const settings = context.settings ?? {}
      const stored = textInference.inferenceForSettings(context.presetName, settings)
      return buildTurnConfig({
        sessionId,
        sessionRef: sessionRefOf(sessionId),
        workspaceDir: context.workspaceDir,
        presetName: context.presetName,
        instructions: withResponseLanguage(
          harnessInstructions(chatPreset, stored.systemPrompt),
          sessionResponseLocale(sessionId),
        ),
        ownsPrompt: chatPreset?.agentOwnsPrompt === true,
        userSampling: hasChatAffordances(chatPreset),
        capabilities: [...context.capabilities],
        unsandboxed: isUnsandboxed(context.workspaceDir),
        mountedFolders: resolveMountedFolders(settings.mountedFolders ?? []),
        planningThinkingOnly:
          settings.planningThinkingOnly ?? readAgentDefaults().planningThinkingOnly,
        textInference: stored.inference,
        cloudMode: stored.cloud,
        tools: stored.tools,
        answer: context.answer,
        taskRun: context.taskRun,
        followUp: context.followUp,
        followedRun: context.followUp ? followedRunOf(sessions.value[sessionId]) : undefined,
      })
    }

    const turns = createAgentTurnRuntimes({
      errors,
      describeTurnError: (message) => {
        const refusal = harnessTurnRefusal(message)
        return refusal ? i18n.state[refusal] : undefined
      },
      storeTools: {
        [OFFER_GAME_AGENT_TOOL]: (input, sessionId) => offerGameAgent(input, sessionId),
        [RAG_PREPARE_EMBEDDING_MODEL]: (input) => prepareRagEmbeddingModel(input),
        [SCREENSHOT_WINDOW_QUERY]: async () => textInference.screenshotWindow ?? null,
      },
      buildTurnConfig: (sessionId) => {
        const context = turnContexts[sessionId]
        return context?.stored ? storedTurnConfig(sessionId, context) : liveTurnConfig(sessionId)
      },
      initialMessages: (sessionId) => [...(sessions.value[sessionId]?.messages ?? [])],
      // The sent message is on the record at once, so the session is in the history
      // even when the user moves on before the turn has run.
      onTurnSubmitted: (sessionId) => {
        stoppedByUser.delete(sessionId)
        forgetUnseen(sessionId)
        // A resend runs the "not run" message itself; a new prompt leaves it marked.
        const lastUser = turns
          .runtimeOf(sessionId)
          ?.chat.messages.findLast((message) => message.role === 'user')
        if (lastUser && notRunMessages.value[sessionId] === lastUser.id) forgetNotRun(sessionId)
        snapshotSessionById(sessionId)
      },
      onTurnAdopted: (sessionId) => forgetNotRun(sessionId),
      onTurnSettled: (sessionId) => settleTurn(sessionId),
      onTurnPaused: (sessionId) => onTurnPaused(sessionId),
      quietTurnErrors: (sessionId) => turnContexts[sessionId]?.quietErrors === true,
      onAdoptedTurnDone: (sessionId) => {
        snapshotSessionById(sessionId)
        void refreshGameAfterTurn(sessionId)
      },
    })

    const openRuntime = computed(() => turns.runtimeFor(openSessionId.value))

    // Every session that can be shown has a runtime the moment it is opened;
    // the one left behind is dropped unless it still holds a turn.
    watch(
      openSessionId,
      (id, previous) => {
        turns.runtimeFor(id)
        if (previous !== undefined && previous !== id) turns.release(previous)
      },
      { flush: 'sync', immediate: true },
    )

    const chat = computed(() => openRuntime.value.chat)
    const processing = computed<boolean>({
      get: () => openRuntime.value.processing.value,
      set: (value) => {
        openRuntime.value.processing.value = value
      },
    })
    /** Where the open Harness Session's turn stands in the Turn Queue; null while it has none. */
    const turnState = computed(() => openRuntime.value.turnState.value)
    const toolProgress = computed(() => openRuntime.value.toolProgress.value)
    const toolImages = computed(() => openRuntime.value.toolImages.value)
    /** Any Harness Session holds a turn, open or not. */
    const anyTurnOpen = turns.anyTurnOpen

    /** Where each session with a turn in flight stands in the Turn Queue. */
    const sessionTurns = computed<Record<string, SessionTurnInfo>>(() => {
      const result: Record<string, SessionTurnInfo> = {}
      for (const [id, runtime] of Object.entries(turns.runtimes.value)) {
        if (!runtime.processing.value) continue
        const pauseReason = runtime.pauseReason.value
        result[id] = {
          state: runtime.turnState.value ?? 'running',
          queuePosition: runtime.queuePosition.value,
          ...(pauseReason ? { pauseReason } : {}),
        }
      }
      return result
    })

    /**
     * Turns that ended while their session was not open, by outcome. Memory only:
     * a restart starts clean. Cleared when the session is opened.
     */
    const unseenTurns = ref<Record<string, UnseenTurn>>({})
    // A turn the user stopped is not news when it settles.
    const stoppedByUser = new Set<string>()

    function forgetUnseen(id: string): void {
      if (!(id in unseenTurns.value)) return
      const next = { ...unseenTurns.value }
      delete next[id]
      unseenTurns.value = next
    }

    watch(openSessionId, (id) => forgetUnseen(id), { flush: 'sync' })

    /**
     * The last message of each session whose turn never ran before the app last quit,
     * by session. Found once at boot and never re-queued; memory only.
     */
    const notRunMessages = ref<Record<string, string>>({})

    function forgetNotRun(id: string): void {
      if (!(id in notRunMessages.value)) return
      const next = { ...notRunMessages.value }
      delete next[id]
      notRunMessages.value = next
    }

    function markNotRunMessages(): void {
      const found: Record<string, string> = {}
      for (const [id, record] of Object.entries(sessions.value)) {
        const last = record.messages.at(-1)
        if (last?.role !== 'user' || turns.runtimeOf(id)?.hasTurn()) continue
        found[id] = last.id
      }
      notRunMessages.value = found
    }

    /** The open Harness Session ends on a "not run" message that can be sent again. */
    const canResendNotRun = computed(() => {
      const messageId = notRunMessages.value[openSessionId.value]
      return !!messageId && !processing.value && messages.value.at(-1)?.id === messageId
    })

    /**
     * The Harness Sessions of a Session that the timeline streams: the open one, with
     * its queued / not-run markers, and every other one running a turn (Task Runs).
     */
    function liveTurnsIn(sessionRef: string): LiveAgentTurn[] {
      const live: LiveAgentTurn[] = []
      for (const [id, runtime] of Object.entries(turns.runtimes.value)) {
        if (sessionRefOf(id) !== sessionRef) continue
        const open = id === openSessionId.value
        if (!open && !runtime.processing.value) continue
        const record = sessions.value[id]
        const tag = {
          presetName: open ? agentPresetName.value : turnLabelOf(record),
          harnessSessionId: id,
          ...(record?.taskRun ? { taskRun: record.taskRun } : {}),
        }
        if (!open) {
          live.push({ tag, messages: runtime.chat.messages, live: true })
          continue
        }
        live.push({
          tag,
          messages: messages.value,
          live: processing.value,
          queuedMessageId:
            turnState.value === 'queued'
              ? messages.value.findLast((entry) => entry.role === 'user')?.id
              : undefined,
          notRunMessageId: notRunMessages.value[id],
          canResend: canResendNotRun.value,
          open: true,
          ...(heldAnswers.value[id]
            ? { heldAnswer: { channel: heldAnswers.value[id].channel } }
            : {}),
          ...(chat.value.error ? { error: chat.value.error.message } : {}),
        })
      }
      return live
    }

    /** A Harness Session's messages while its turn streams; undefined once it has none. */
    function streamingMessagesOf(id: string): readonly UIMessage[] | undefined {
      const runtime = turns.runtimes.value[id]
      return runtime?.processing.value ? (runtime.chat.messages as UIMessage[]) : undefined
    }

    /** Agent Mode is on screen; a session is in view only while it is, and open. */
    const viewShown = ref(false)
    function setViewShown(shown: boolean): void {
      viewShown.value = shown
    }
    function inView(sessionId: string): boolean {
      return viewShown.value && openSessionId.value === sessionId
    }

    // A download or VRAM prompt a turn raised out of sight waits here until its
    // session is in view, so a Paused Session never pops up over other work.
    const heldPrompts: Record<string, Array<{ show: () => void; drop: () => void }>> = {}
    const turnEndWaiters: Record<string, Array<() => void>> = {}

    registerSessionPromptPort({
      whenInView: (sessionId) => {
        if (inView(sessionId) || !turns.runtimeOf(sessionId)?.hasTurn()) return Promise.resolve()
        return new Promise<void>((resolve, reject) => {
          ;(heldPrompts[sessionId] ??= []).push({
            show: resolve,
            drop: () =>
              reject(createCancellation({ technicalMessage: 'The turn that asked has ended.' })),
          })
        })
      },
      isAgentTurn: (sessionId) => !!turns.runtimeOf(sessionId)?.hasTurn(),
      whenTurnEnds: (sessionId) => {
        if (!turns.runtimeOf(sessionId)?.hasTurn()) return Promise.resolve()
        return new Promise<void>((resolve) => (turnEndWaiters[sessionId] ??= []).push(resolve))
      },
      answerOrigin: (sessionId) => turnContexts[sessionId]?.answer,
    })

    function settleHeldPrompts(sessionId: string, how: 'show' | 'drop'): void {
      const held = heldPrompts[sessionId]
      if (!held) return
      delete heldPrompts[sessionId]
      for (const prompt of held) prompt[how]()
    }

    watch([viewShown, openSessionId], () => {
      if (viewShown.value) settleHeldPrompts(openSessionId.value, 'show')
    })

    /** One toast per pause of a session the user is not looking at. */
    function onTurnPaused(sessionId: string): void {
      if (inView(sessionId)) return
      const title = sessions.value[sessionId]?.title ?? ''
      toast.show((i18n.state.AGENT_SESSION_NEEDS_INPUT ?? '').replace('{title}', title), {
        settings: { duration: 8000 },
        action: {
          label: i18n.state.AGENT_SESSION_OPEN ?? '',
          run: () => void openSession(sessionId),
        },
      })
    }

    /** Bring a session on screen: into Agent Mode if the app is elsewhere, then open it. */
    async function openSession(id: string): Promise<void> {
      const sessionRef = sessions.value[id]?.sessionRef
      if (sessionRef) {
        const presetName = sessions.value[id]?.presetName ?? HARNESS_CHAT_PRESET
        if (presetName !== presetsStore.activePresetWithVariant?.name) {
          await presetSwitching.switchPreset(presetName)
        }
        await sessionsStore.open(sessionRef)
        return
      }
      const presetName = sessions.value[id]?.presetName ?? agentPresetName.value
      if (!viewShown.value && presetName === agentPresetName.value) {
        await presetSwitching.switchPreset(presetName)
      }
      await switchSession(id)
    }

    // Records persist on turn lifecycle (step 11): a generate/stop snapshot,
    // capability rewrite, or explicit delete — not a map watch. The Chat
    // still owns the UIMessage list; main writes the file.
    const persistSessionMutation = makeForwardPersist({
      code: 'agent-sessions/persist-failed',
      technicalMessage: 'saving an agent session file failed',
    })

    function persistSessionRecord(record: AgentSessionRecord): void {
      if (!sessionsHydrated.value) return
      persistSessionMutation(() => window.electronAPI.agentMode.saveSession(cloneForIpc(record)))
    }

    function rewriteSession(id: string, record: AgentSessionRecord): void {
      sessions.value = { ...sessions.value, [id]: record }
      persistSessionRecord(record)
    }

    watch(openSessionId, (id) => {
      if (!sessionsHydrated.value) return
      persistSessionMutation(() => window.electronAPI.agentMode.saveActiveSessionId(id || null))
    })

    /**
     * A tool can be waiting on a confirmation card when the turn ends, errors or
     * is aborted. Settling it as declined keeps a question the user can no longer
     * answer from lingering, and unblocks the tool if it is still listening
     * (mirrors the chat store). Everything here is the ending turn's own session's.
     */
    function settleTurn(sessionId: string): void {
      // Only an in-flight stored turn keeps the record's settings over the live controls,
      // and an Answer's reply rule holds for its one turn.
      const ended = turnContexts[sessionId]
      if (ended) {
        ended.stored = false
        delete ended.answer
      }
      const stopped = stoppedByUser.delete(sessionId)
      const chat = turns.runtimeOf(sessionId)?.chat
      const failed = chat?.status === 'error'
      if (!stopped && sessionId !== openSessionId.value && sessions.value[sessionId]) {
        unseenTurns.value = { ...unseenTurns.value, [sessionId]: failed ? 'failed' : 'done' }
      }
      confirmations.cancelForConversation(sessionId, false)
      settleHeldPrompts(sessionId, 'drop')
      const waiters = turnEndWaiters[sessionId] ?? []
      delete turnEndWaiters[sessionId]
      for (const resolve of waiters) resolve()
      const handoff = pendingHandoffs[sessionId]
      if (handoff) {
        delete pendingHandoffs[sessionId]
        void startGameAgentHandoff(handoff)
      }
      if (sessionId !== openSessionId.value) turns.release(sessionId)
      const outcome: TurnOutcome = stopped
        ? { kind: 'stopped' }
        : failed
          ? { kind: 'error', message: extractMessage(chat?.error) }
          : { kind: 'completed' }
      for (const listener of [...turnSettledListeners]) listener(sessionId, outcome)
      // After the Tasks store has heard it, so a finished run no longer holds the session.
      if (!deletingSessions.has(sessionId)) {
        settleHeldAnswer(
          sessionId,
          outcome.kind === 'completed'
            ? 'completed'
            : outcome.kind === 'error'
              ? 'failed'
              : 'stopped',
        )
      }
    }

    const heldAnswers = ref<Record<string, HeldAnswerView>>({})
    type HeldAnswerListener = (sessionId: string, end: SessionTurnEnd) => void
    const heldAnswerListeners = new Set<HeldAnswerListener>()
    const deletingSessions = new Set<string>()

    /** The Answer router keeps the Held Answer; the store only shows it. */
    function setHeldAnswer(sessionId: string, answer: HeldAnswerView | null): void {
      const { [sessionId]: _previous, ...rest } = heldAnswers.value
      heldAnswers.value = answer ? { ...rest, [sessionId]: answer } : rest
    }

    function discardHeldAnswer(sessionId: string): void {
      if (!heldAnswers.value[sessionId]) return
      setHeldAnswer(sessionId, null)
      settleHeldAnswer(sessionId, 'discarded')
    }

    /** A Steps run ended on a Step it could not send, so no turn settles to let the Answer go. */
    function releaseHeldAnswer(sessionId: string): void {
      if (!deletingSessions.has(sessionId)) settleHeldAnswer(sessionId, 'failed')
    }

    function settleHeldAnswer(sessionId: string, end: SessionTurnEnd): void {
      for (const listener of [...heldAnswerListeners]) listener(sessionId, end)
    }

    /** Hear what decides each session's Held Answer; returns the unsubscribe. */
    function onHeldAnswerSettled(listener: HeldAnswerListener): () => void {
      heldAnswerListeners.add(listener)
      return () => heldAnswerListeners.delete(listener)
    }

    type TurnSettledListener = (sessionId: string, outcome: TurnOutcome) => void
    const turnSettledListeners = new Set<TurnSettledListener>()

    /** Hear how every session's turn ends; returns the unsubscribe. */
    function onTurnSettled(listener: TurnSettledListener): () => void {
      turnSettledListeners.add(listener)
      return () => turnSettledListeners.delete(listener)
    }

    /** The game card shows the open workspace, so only a turn in that folder can change it. */
    async function refreshGameAfterTurn(sessionId: string): Promise<void> {
      const dir = sessions.value[sessionId]?.workspaceDir ?? turnContexts[sessionId]?.workspaceDir
      if (sessionId === openSessionId.value || (dir && dir === workspaceDir.value)) {
        await refreshCurrentGame()
      }
    }

    const messages = computed(() => chat.value.messages)

    const sessionUsage = computed(() => latestTurnMetadata(messages.value, 'usage'))
    const sessionTokens = computed(
      () => (sessionUsage.value?.inputTokens ?? 0) + (sessionUsage.value?.outputTokens ?? 0),
    )
    const contextUsage = computed(() => latestTurnMetadata(messages.value, 'contextUsage'))
    const lastStepUsage = computed(() => latestTurnMetadata(messages.value, 'lastStep'))

    /**
     * Save a session's transcript from its runtime. The open Harness Session takes the live
     * controls; any other keeps what its record (or the turn that was sent) holds.
     *
     * `presetName` is the preset that held the session, which is the current one
     * except while leaving it: a turn that was still running has no record yet,
     * and would otherwise be filed under the preset it is moving to.
     */
    function snapshotSessionById(id: string, presetName?: string): void {
      const runtime = turns.runtimeOf(id)
      if (!id || !runtime) return
      const existing = sessions.value[id]
      const context = turnContexts[id]
      // A session sent on its stored settings keeps them, even while open.
      const open = id === openSessionId.value && !context?.stored
      const heldWith =
        presetName ?? (open ? agentPresetName.value : (existing?.presetName ?? context?.presetName))
      const dir =
        id === openSessionId.value
          ? workspaceDir.value
          : (existing?.workspaceDir ?? context?.workspaceDir)
      if (!dir || !heldWith) return
      const inSession = !!harnessSessionRefs[id] && !!settingsPort.value
      const settings = inSession
        ? undefined
        : open
          ? openSettings.value
          : existing
            ? undefined
            : context?.settings
      const record = snapshotSession({
        id,
        workspaceDir: dir,
        messages: runtime.chat.messages as UIMessage[],
        existing,
        capabilities: open ? capabilities.value : (context?.capabilities ?? []),
        presetName: heldWith,
        responseLocale: existing?.responseLocale ?? pendingResponseLocales[id],
        title: pendingTitles[id],
        settings: presetUsesSessionSettings(heldWith) && settings ? settings : undefined,
        sessionRef: harnessSessionRefs[id],
      })
      if (!record) return
      delete pendingTitles[id]
      if (record.settings) delete record.capabilities
      rewriteSession(id, record)
      saveToSessionTimeline(record)
    }

    /** A Harness Session's turns are the Session's too: its display messages join the timeline. */
    function saveToSessionTimeline(record: AgentSessionRecord): void {
      if (!record.sessionRef || record.messages.length === 0) return
      const agentTurn = {
        presetName: turnLabelOf(record),
        harnessSessionId: record.id,
        ...(record.taskRun ? { taskRun: record.taskRun } : {}),
      }
      const messages = settleStreamingParts(record.messages).map((message) => ({
        ...message,
        metadata: { ...(message.metadata as object | undefined), agentTurn },
      }))
      void sessionsStore.saveTimelineMessages(record.sessionRef, messages)
    }

    /** How an Agent Run ended short, kept on its tag so its timeline Turn can show it. */
    function endAgentRun(id: string, end: NonNullable<AgentRunTag['end']>): void {
      const record = sessions.value[id]
      if (!record?.taskRun) return
      const ended = { ...record, taskRun: { ...record.taskRun, end } }
      rewriteSession(id, ended)
      saveToSessionTimeline(ended)
    }

    function snapshotOpenSession(presetName?: string): void {
      snapshotSessionById(openSessionId.value, presetName)
    }

    /** Show the open session's record, unless its runtime is streaming a turn of its own. */
    function restoreOpenSession(): void {
      const record = sessions.value[openSessionId.value]
      const runtime = openRuntime.value
      if (!runtime.hasTurn()) {
        runtime.chat.messages = settleStreamingParts((record?.messages ?? []) as UIMessage[])
      }
      applyOpenSessionSettings(
        heldBySession()
          ? settingsPort.value?.read(agentPresetName.value)?.settings
          : settingsOfRecord(record),
      )
    }

    function ensureOpenSessionId(): string {
      return ensureSessionId(openSessionId)
    }

    /**
     * A turn adopted from the kernel snapshot can reach a runtime before the records
     * hydrate; its earlier transcript is put back in front of what it streamed.
     */
    function mergeHydratedTranscripts(): void {
      for (const [id, record] of Object.entries(sessions.value)) {
        const runtime = turns.runtimeOf(id)
        if (!runtime || !runtime.hasTurn()) continue
        const live = runtime.chat.messages
        const known = new Set(live.map((message) => message.id))
        const earlier = record.messages.filter((message) => !known.has(message.id))
        if (earlier.length > 0) runtime.chat.messages = [...earlier, ...live]
      }
    }

    // Leaving a session never stops its turn: its runtime is kept until the turn settles.
    function blankSession(): void {
      openSessionId.value = mintSessionId()
      sessionCapabilities.value = null
      applyOpenSessionSettings(undefined)
    }

    async function newSession(): Promise<void> {
      if (sessionsStore.openSessionId && agentWorkspaceKind.value === 'pick') {
        // "+" always means a new Session; the watcher below opens its Harness Session.
        await sessionsStore.create()
        return
      }
      blankSession()
    }

    /** Show the open Session's Harness Session for the agent preset, minting it on first use. */
    async function enterSessionHarness(game?: { gameDir: string; fresh?: boolean }): Promise<void> {
      const sessionRef = sessionsStore.openSessionId
      const presetName = agentPresetName.value
      if (!sessionRef || !presetName) return
      const workspace =
        workspaceKindOf(presetName) === 'games' ? { kind: 'game' as const, ...game } : undefined
      let result: Awaited<ReturnType<typeof window.electronAPI.sessions.harnessSession>>
      try {
        result = workspace
          ? await window.electronAPI.sessions.harnessSession(sessionRef, presetName, workspace)
          : await window.electronAPI.sessions.harnessSession(sessionRef, presetName)
      } catch (error) {
        result = { success: false, error: extractMessage(error) }
      }
      if (!result.success) {
        errors.report(new Error(result.error), {
          category: 'backend',
          code: 'agent/harness-session-failed',
          surface: 'toast',
        })
        return
      }
      await settingsPort.value?.whenLoaded()
      if (sessionRef !== sessionsStore.openSessionId || presetName !== agentPresetName.value) return
      const { harnessSessionId, workspaceDir: dir } = result.harness
      harnessSessionRefs[harnessSessionId] = sessionRef
      if (openSessionId.value === harnessSessionId && workspaceDir.value === dir) return
      if (openSessionId.value && openSessionId.value !== harnessSessionId) snapshotOpenSession()
      openSessionId.value = harnessSessionId
      workspaceDir.value = dir
      sessionCapabilities.value = null
      restoreOpenSession()
      await refreshCurrentGame()
    }

    watch(
      [() => sessionsStore.openSessionId, agentActive, sessionsHydrated],
      ([sessionRef, active, hydrated]) => {
        if (!sessionRef || !active || !hydrated || movingSession) return
        void enterSessionHarness()
      },
      { immediate: true },
    )

    // Main deletes a Session's Harness Sessions with it; their records leave the map too.
    watch(
      () => sessionsStore.sessions,
      (known) => {
        const gone = Object.values(sessions.value).filter(
          (record) => record.sessionRef && !known[record.sessionRef],
        )
        if (gone.length === 0) return
        const next = { ...sessions.value }
        for (const record of gone) {
          delete next[record.id]
          delete turnContexts[record.id]
          if (record.id !== openSessionId.value) turns.release(record.id)
        }
        sessions.value = next
      },
    )

    async function switchSession(id: string): Promise<void> {
      if (id === openSessionId.value) return
      const target = sessions.value[id]
      if (!target) return
      movingSession = true
      try {
        if (target.presetName && target.presetName !== agentPresetName.value) {
          await presetSwitching.switchPreset(target.presetName)
        }
        openSessionId.value = id
        sessionCapabilities.value = null
        if (target.workspaceDir) {
          workspaceDir.value = target.workspaceDir
          if (agentWorkspaceKind.value === 'games') {
            lastWorkspaceByKind.value = { ...lastWorkspaceByKind.value, games: target.workspaceDir }
          }
        }
        restoreOpenSession()
        await refreshCurrentGame()
      } finally {
        movingSession = false
      }
    }

    /**
     * Quick Coder's `offer_game_agent` tool (see the `game-studio-quick`
     * capability): put the switch to the user as a card in the transcript, and
     * on a yes note what the agent taking over needs to know. Nothing happens
     * here beyond that note — the switch runs once this turn has ended.
     */
    async function offerGameAgent(
      input: Record<string, unknown>,
      sessionId: string,
    ): Promise<unknown> {
      const label = oemBranding.presetLabel(GAME_AGENT_PRESET)
      const request = typeof input.reason === 'string' ? input.reason.trim() : ''
      const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
      const accepted = await confirmations.request({
        conversationKey: sessionId,
        title: `Continue in ${label}?`,
        summaryMarkdown:
          (request ? `${request}\n\n` : '') +
          `That is more than this mode can do. **${label}** picks the game up from here — same ` +
          'folder, a fresh conversation — and can read and edit the code, play-test it in a ' +
          'browser and generate art for it. It starts on this straight away, and works step by ' +
          'step, so it takes longer.',
        origin: 'desktop',
      })
      if (!accepted) {
        return {
          accepted: false,
          message:
            'The user declined and stays here. If the change is small, write the whole ' +
            'index.html again with it applied; otherwise tell them plainly what this mode ' +
            'cannot do.',
        }
      }
      pendingHandoffs[sessionId] = { summary, request }
      return {
        accepted: true,
        message:
          `${label} takes the game from here and starts on this itself as soon as you stop. ` +
          'Say so in one line — no code, no further tool calls.',
      }
    }

    /**
     * Start the session Game Agent takes the game over in: same folder, empty
     * transcript, one hand-over message which it is then answering. A fresh
     * session rather than this one re-tagged, because a Quick Coder transcript
     * is written under instructions that are wrong for the agent inheriting it —
     * the game folder is the artifact, and both sessions stay in the panel.
     *
     * Runs after the offering turn ended, never from inside the tool: a
     * `generate()` there would nest a second turn inside the open one, and
     * moving the preset mid-turn would file the one-shot run itself under Game
     * Agent (`snapshotSession` only freezes a record that already exists).
     */
    async function startGameAgentHandoff(handoff: {
      summary: string
      request: string
    }): Promise<void> {
      // No agent preset is memory-gated, and this switch answers a card the
      // user already said yes to — a modal here would only stall it.
      // `movingSession` keeps the preset watcher from blanking the very folder
      // being handed over before `newSession()` below reaches it.
      const gameDir = workspaceDir.value
      movingSession = true
      let switched: { success: boolean; error?: string }
      try {
        switched = await presetSwitching.switchPreset(GAME_AGENT_PRESET, {
          skipMemoryAlert: true,
        })
      } finally {
        movingSession = false
      }
      if (!switched.success) {
        errors.report(new Error(switched.error ?? 'Could not switch preset.'), {
          category: 'unknown',
          code: 'agent/handoff-failed',
          userMessage: `Could not hand the game to ${oemBranding.presetLabel(GAME_AGENT_PRESET)}.`,
          surface: 'toast',
        })
        return
      }
      // In a Session, Game Agent's Harness Session there starts over on this game.
      if (sessionsStore.openSessionId && gameDir)
        await enterSessionHarness({ gameDir, fresh: true })
      else await newSession()
      await generate(
        gameAgentHandoffPrompt({
          ...handoff,
          gameName: currentGame.value?.name,
          gameDescription: currentGame.value?.description,
        }),
      )
    }

    /** Delete takes a turn out of what the model sees next, not only out of the timeline. */
    async function deleteTurns(ref: HarnessTurnRef): Promise<void> {
      const id = ref.harnessSessionId
      const sessionRef = sessionRefOf(id)
      const result = await requestTurnDeletion(id, ref.turnIds, ref.messageIds)
      if (!result.success) {
        errors.report(new Error(result.error), {
          category: 'unknown',
          code: 'agent/delete-turn-failed',
          userMessage: i18n.state[harnessTurnRefusal(result.error) ?? 'AGENT_DELETE_TURN_FAILED'],
        })
        return
      }
      const removed = new Set(ref.messageIds)
      const runtime = turns.runtimeOf(id)
      if (runtime) {
        runtime.chat.messages = runtime.chat.messages.filter((message) => !removed.has(message.id))
      }
      const record = sessions.value[id]
      if (record) {
        rewriteSession(id, {
          ...record,
          messages: record.messages.filter((message) => !removed.has(message.id)),
        })
      }
      if (sessionRef) sessionsStore.forgetTimelineMessages(sessionRef, ref.messageIds)
    }

    async function deleteSession(id: string): Promise<void> {
      // The stop below is the delete's, not the desktop taking over a Held Answer.
      deletingSessions.add(id)
      try {
        await removeSession(id)
      } finally {
        deletingSessions.delete(id)
      }
    }

    async function removeSession(id: string): Promise<void> {
      // Stop first so Pi teardown in the same IPC is not racing a live turn,
      // then wait for the kernel: dropping the row before that would make a
      // failed delete vanish from the panel and come back on the next boot.
      const stopping = id === openSessionId.value || turns.runtimeOf(id)?.hasTurn()
      if (stopping) await stopSession(id)
      const result = await window.electronAPI.agentMode.deleteSession(id)
      if (!result.success) {
        if (stopping) settleHeldAnswer(id, 'stopped')
        errors.report(new Error(result.error ?? 'Failed to delete session.'), {
          category: 'unknown',
          code: 'agent/delete-session-failed',
          userMessage: result.error ?? 'Failed to delete the agent session.',
          surface: 'silent',
        })
        return
      }
      const next = { ...sessions.value }
      delete next[id]
      sessions.value = next
      delete turnContexts[id]
      forgetUnseen(id)
      forgetNotRun(id)
      if (id === openSessionId.value) {
        openSessionId.value = mintSessionId()
        sessionCapabilities.value = null
        applyOpenSessionSettings(undefined)
      } else {
        turns.release(id)
      }
      settleHeldAnswer(id, 'deleted')
    }

    async function adoptWorkspace(dir: string): Promise<void> {
      // A draft Harness Session set up before its folder was picked keeps what was set up.
      const draftSettings =
        sessionScoped.value && !sessions.value[openSessionId.value] ? openSettings.value : null
      workspaceDir.value = dir
      const latest = Object.values(sessions.value)
        .filter((s) => s.workspaceDir === dir)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      openSessionId.value = latest?.id ?? ''
      sessionCapabilities.value = null
      restoreOpenSession()
      if (!latest && draftSettings) applyOpenSessionSettings(draftSettings)
      await refreshCurrentGame()
    }

    async function refreshCurrentGame(): Promise<void> {
      const dir = workspaceDir.value
      currentGame.value = dir ? await window.electronAPI.games.read(dir) : null
    }

    const {
      attachments,
      attachFiles: holdAttachments,
      removeAttachment,
      clearAttachments,
      importAttachments,
    } = createWorkspaceAttachments(errors, i18n.state)

    const {
      sessionDocuments,
      indexingDocuments,
      attachDocuments,
      removeDocument: removeSessionDocument,
    } = createSessionDocuments({
      workspaceDir,
      languages: i18n.state,
      workspaceReady,
      embedding: () => {
        const model = textInference.activeEmbeddingModel
        if (!model || !capabilities.value.includes('rag')) return null
        return { model, backend: textInference.embeddingBackend }
      },
      prepareEmbedding: async ({ model, backend }) =>
        ((await prepareRagEmbeddingModel({ model, backend })) as { status?: string }).status ===
        'ready',
      errors,
    })

    /** A Session's documents go into its folder at once; a game's files wait for its folder. */
    async function attachFiles(files: File[]): Promise<void> {
      if (agentWorkspaceKind.value !== 'pick') return holdAttachments(files)
      const documents = files.filter((file) => isDocumentName(file.name))
      const others = files.filter((file) => !isDocumentName(file.name))
      if (others.length > 0) await holdAttachments(others)
      if (documents.length > 0) await attachDocuments(documents)
    }

    function blankGame(): void {
      workspaceDir.value = ''
      openSessionId.value = ''
      sessionCapabilities.value = null
      currentGame.value = null
      if (!openRuntime.value.hasTurn()) openRuntime.value.chat.messages = []
      openSettings.value = null
    }

    /** In a Session, a games preset holds one game, so a new game is a new Session. */
    async function newGame(): Promise<void> {
      if (sessionsStore.openSessionId) {
        await sessionsStore.create()
        return
      }
      blankGame()
    }

    async function startNew(): Promise<void> {
      if (agentWorkspaceKind.value === 'games') await newGame()
      else await newSession()
    }

    async function reconcileWorkspaceKind(): Promise<void> {
      const reconciled = await reconcileGamesWorkspace({
        kind: agentWorkspaceKind.value,
        workspaceDir: workspaceDir.value,
        lastGamesDir: lastWorkspaceByKind.value.games ?? '',
      })
      if (!reconciled) return
      await adoptWorkspace(reconciled.workspaceDir)
    }

    watch(
      agentWorkspaceKind,
      async (_kind, previous) => {
        if (movingSession) return
        if (previous === undefined) await reconcileWorkspaceKind()
      },
      { immediate: true },
    )

    // A Harness Session never crosses agent presets (its capabilities are frozen on its record);
    // only the `offer_game_agent` hand-over moves a game, under `movingSession`.
    watch(agentPresetName, async (name, previous) => {
      if (!previous || name === previous || movingSession) return
      snapshotOpenSession(previous)
      if (workspaceKindOf(previous) === 'games') {
        lastWorkspaceByKind.value = { ...lastWorkspaceByKind.value, games: workspaceDir.value }
      }
      if (sessionsStore.openSessionId) {
        await enterSessionHarness()
        return
      }
      if (agentWorkspaceKind.value === 'games') {
        blankGame()
        return
      }
      workspaceDir.value = ''
      blankSession()
      await refreshCurrentGame()
    })

    /**
     * Resolves once the turn ended, with whether one was started at all. `title` names a session
     * this turn opens, when the message sent is not what the user typed.
     */
    async function generate(prompt: string, options: { title?: string } = {}): Promise<boolean> {
      if (await blockedBySettingsProblems()) return false
      // Game Agent never asks for a folder: the first turn of a game mints one.
      if (agentWorkspaceKind.value === 'games') {
        if (await sessionsStore.ensureOpenSession()) await enterSessionHarness()
        if (!(await isGameFolder(workspaceDir.value))) await mintGame(prompt)
      }
      if (!(await workspaceReady())) return false
      const attached = await importAttachments(workspaceDir.value)
      const sessionId = ensureSessionId(openSessionId)
      if (options.title && !sessions.value[sessionId]) pendingTitles[sessionId] = options.title
      await runTurn(sessionId, liveTurnContext(), (chat) =>
        chat.sendMessage({ text: `${prompt}${attached}` }),
      )
      return true
    }

    async function mintGame(prompt: string): Promise<void> {
      // A Harness Session whose game has left the library starts over on the new one.
      const fresh = !!workspaceDir.value
      const game = await window.electronAPI.games.create(prompt, {
        scaffold: !capabilities.value.includes(GAME_STUDIO_QUICK_ID),
        backend: textInference.backend,
        startingModel: textInference.activeModel,
        initialPrompt: prompt,
      })
      lastWorkspaceByKind.value = { ...lastWorkspaceByKind.value, games: game.dir }
      if (sessionsStore.openSessionId) {
        await enterSessionHarness({ gameDir: game.dir, fresh })
        if (workspaceDir.value === game.dir) return
      }
      workspaceDir.value = game.dir
      currentGame.value = game
    }

    /** Send the open Harness Session's "not run" message again, as a new turn. */
    async function resendNotRun(): Promise<void> {
      if (!canResendNotRun.value) return
      if (await blockedBySettingsProblems()) return
      if (!(await workspaceReady())) return
      await runTurn(openSessionId.value, liveTurnContext(), (chat) => chat.regenerate())
    }

    /** The Agent preset works in the open Session's folder; a Session is opened if none is. */
    async function workspaceReady(): Promise<boolean> {
      if (agentWorkspaceKind.value === 'pick') {
        if (!sessionsStore.openSessionId) await sessionsStore.create()
        await enterSessionHarness()
      }
      if (workspaceDir.value) return true
      errors.report(new Error('The agent has no workspace folder.'), {
        category: 'validation',
        code: 'agent/no-workspace',
        userMessage: 'The agent has no workspace folder yet. Open a Session and try again.',
        surface: 'toast',
      })
      return false
    }

    async function runTurn(
      sessionId: string,
      context: TurnContext,
      send: (chat: AgentSessionRuntime['chat']) => Promise<void>,
    ): Promise<void> {
      const runtime = turns.runtimeFor(sessionId)
      turnContexts[sessionId] = context
      // Sending makes the Session's copy its own: from now on it is checked, never re-defaulted.
      if (!context.stored && sessionId === openSessionId.value && heldBySession()) {
        openSettings.value = { ...openSessionSettings.value }
        writeSessionSettings(true)
      }
      runtime.toolProgress.value = {}
      runtime.processing.value = true
      try {
        await send(runtime.chat)
      } finally {
        runtime.processing.value = false
        snapshotSessionById(sessionId)
        await refreshGameAfterTurn(sessionId)
      }
    }

    /**
     * Mint and store a session without opening it, so it is listed in the history. An
     * explicit title is kept when the session's first message arrives.
     */
    function createSession(input: {
      /** A Harness Session main minted; a new id otherwise. */
      id?: string
      sessionRef?: string
      workspaceDir: string
      settings: AgentSessionSettings
      capabilities?: string[]
      presetName?: string
      title: string
      taskId?: string
      taskRun?: AgentSessionRecord['taskRun']
      steps?: AgentTaskStep[]
    }): string {
      const id = input.id ?? mintSessionId()
      const now = Date.now()
      const settings = input.capabilities
        ? { ...input.settings, capabilities: [...input.capabilities] }
        : { ...input.settings }
      rewriteSession(id, {
        id,
        workspaceDir: input.workspaceDir,
        title: input.title,
        messages: [],
        createdAt: now,
        updatedAt: now,
        presetName: input.presetName ?? HARNESS_CHAT_PRESET,
        settings,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.steps ? { steps: cloneForIpc(input.steps) } : {}),
        ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
        ...(input.taskRun ? { taskRun: input.taskRun } : {}),
      })
      return id
    }

    function refuseSend(
      reason: Exclude<SendToSessionResult, { ok: true }>['reason'],
      message: string,
      problems?: SessionSettingsProblem[],
    ): SendToSessionResult {
      return { ok: false, reason, message, ...(problems ? { problems } : {}) }
    }

    let taskLockOf: (sessionId: string) => SessionTaskLock | undefined = () => undefined

    /** The Tasks store names the run holding a session; it cannot be imported here (cycle). */
    function setTaskLockLookup(lookup: (sessionId: string) => SessionTaskLock | undefined): void {
      taskLockOf = lookup
    }

    function taskLockRefusal(
      sessionId: string,
      signal: AbortSignal | undefined,
    ): SendToSessionResult | undefined {
      const lock = taskLockOf(sessionId)
      if (!lock || (lock.signal && lock.signal === signal)) return undefined
      // A sender holds on this reason and retries, so the message only reaches the log.
      return refuseSend('task-locked', `Agent “${lock.taskName}” is running.`)
    }

    /**
     * Send to any session; one not open (or `useStoredSettings`) runs on its record, not the
     * live controls. Resolves once handed off or refused; the end comes via `onTurnSettled`.
     * `settings` replaces the record's, which the panel rewrites while the session is open.
     * `signal` aborted before the hand-off refuses the send; once handed off, stop the session.
     * `quietErrors` is for a caller that records a failed turn itself instead of a toast.
     */
    async function sendToSession(
      sessionId: string,
      prompt: string,
      options: {
        useStoredSettings?: boolean
        settings?: AgentSessionSettings
        signal?: AbortSignal
        quietErrors?: boolean
        /** A channel Answer: the turn's result is replied under it. */
        answer?: AgentAnswerOrigin
        /** A Task Run's Step. */
        taskRun?: AgentModeTurnConfig['taskRun']
        /** A Follow-up to a saved Agent's run, the Agent named as it is now. */
        followUp?: AgentFollowUpTag
        /** Regenerate this latest Turn: its prompt is sent again and `prompt` is unused. */
        regenerate?: HarnessTurnRef
      } = {},
    ): Promise<SendToSessionResult> {
      const record = sessions.value[sessionId]
      const live =
        sessionId === openSessionId.value && !options.useStoredSettings && !options.settings
      if (!record && !live) return refuseSend('no-session', `No agent session ${sessionId}.`)
      const locked = taskLockRefusal(sessionId, options.signal)
      if (locked) return locked
      if (turns.runtimeOf(sessionId)?.hasTurn()) {
        return refuseSend('busy', 'This session already has a turn in flight.')
      }
      let context: TurnContext
      if (live) {
        if (await blockedBySettingsProblems()) {
          return refuseSend(
            'settings-problems',
            i18n.state.AGENT_SETTINGS_UNUSABLE ?? '',
            settingsProblems.value,
          )
        }
        context = liveTurnContext()
      } else {
        const inSession =
          !options.settings && record?.sessionRef && settingsPort.value
            ? await settingsPort.value.readStored(
                record.sessionRef,
                record.presetName ?? HARNESS_CHAT_PRESET,
              )
            : null
        context = storedTurnContext(record!, options.settings ?? inSession ?? undefined)
        await loadMcpServersFor(context.capabilities)
        const problems = problemsOf({ ...context.settings, capabilities: context.capabilities })
        if (problems.length > 0) {
          return refuseSend(
            'settings-problems',
            describeSettingsProblems(problems, i18n.state),
            problems,
          )
        }
      }
      if (!context.workspaceDir || !(await window.electronAPI.existsPath(context.workspaceDir))) {
        return refuseSend(
          'missing-folder',
          (
            i18n.state.AGENT_WORKSPACE_FOLDER_MISSING ?? 'The workspace folder is missing: {path}'
          ).replace('{path}', context.workspaceDir),
        )
      }
      const folders = context.stored
        ? (context.settings?.mountedFolders ?? [])
        : mountedFolders.value
      for (const folder of resolveMountedFolders(folders)) {
        if (await window.electronAPI.isFolderPath(folder.hostPath)) continue
        return refuseSend(
          'missing-folder',
          (
            i18n.state.AGENT_MOUNTED_FOLDER_MISSING ??
            'The Mounted Folder “{name}” is missing: {path}'
          )
            .replace('{name}', folder.name)
            .replace('{path}', folder.hostPath),
        )
      }
      const lockedSince = taskLockRefusal(sessionId, options.signal)
      if (lockedSince) return lockedSince
      if (turns.runtimeOf(sessionId)?.hasTurn()) {
        return refuseSend('busy', 'This session already has a turn in flight.')
      }
      if (options.signal?.aborted) return refuseSend('aborted', 'The send was cancelled.')
      if (options.quietErrors) context.quietErrors = true
      if (options.answer) context.answer = options.answer
      if (options.taskRun) context.taskRun = options.taskRun
      if (options.followUp) context.followUp = options.followUp
      const metadata: AgentMessageMetadata | undefined =
        options.answer || options.followUp
          ? {
              ...(options.answer ? { origin: options.answer.channel } : {}),
              ...(options.followUp ? { followUp: options.followUp } : {}),
            }
          : undefined
      const redo = options.regenerate
      runTurn(sessionId, context, (chat) =>
        redo?.promptId
          ? regenerateIn(chat, redo.promptId, redo)
          : chat.sendMessage({ text: prompt, metadata }),
      ).catch((error) =>
        errors.report(error, {
          category: 'inference',
          code: 'agent/turn-failed',
          surface: 'silent',
        }),
      )
      return { ok: true }
    }

    /** Whether a turn sent with `useStoredSettings` would run on a model that sees images. */
    async function storedTurnSeesImages(sessionId: string): Promise<boolean> {
      const record = sessions.value[sessionId]
      if (!record) return false
      const inSession =
        record.sessionRef && settingsPort.value
          ? await settingsPort.value.readStored(
              record.sessionRef,
              record.presetName ?? HARNESS_CHAT_PRESET,
            )
          : null
      const context = storedTurnContext(record, inSession ?? undefined)
      const stored = textInference.inferenceForSettings(context.presetName, context.settings ?? {})
      return stored.inference.modelSupportsVision
    }

    /** Main rewinds before the new answer streams, so until then the old one stays. */
    async function regenerateIn(
      chat: AgentSessionRuntime['chat'],
      promptId: string,
      redo: HarnessTurnRef,
    ): Promise<void> {
      const before = chat.messages
      const known = new Set(before.map((message) => message.id))
      let forgotten: Promise<void> | undefined
      const stop = watch(
        () => chat.messages.at(-1),
        (last) => {
          if (forgotten || last?.role !== 'assistant' || known.has(last.id)) return
          forgotten = forgetAnswers(redo)
        },
        { flush: 'sync' },
      )
      try {
        await chat.regenerate({
          messageId: promptId,
          body: { rewindTurnId: redo.turnIds[0] } satisfies RegenerateBody,
        })
      } finally {
        stop()
        if (forgotten) await forgotten
        else chat.messages = before
      }
    }

    /** The answers Regenerate replaces leave the Session's timeline; the new turn takes their place. */
    async function forgetAnswers(ref: HarnessTurnRef): Promise<void> {
      const id = ref.harnessSessionId
      const sessionRef = sessionRefOf(id)
      const answerIds = ref.messageIds.filter((messageId) => messageId !== ref.promptId)
      if (!sessionRef || answerIds.length === 0) return
      const result = await requestTurnDeletion(id, [], answerIds)
      if (!result.success) {
        errors.report(new Error(result.error), {
          category: 'unknown',
          code: 'agent/regenerate-forget-failed',
          surface: 'silent',
        })
        return
      }
      sessionsStore.forgetTimelineMessages(sessionRef, answerIds)
    }

    function isSessionProcessing(id: string): boolean {
      return !!turns.runtimeOf(id)?.processing.value
    }

    /** Regenerate the latest Assistant Turn from its Harness Session as it was before it. */
    async function regenerateTurn(ref: HarnessTurnRef): Promise<void> {
      if (!ref.promptId || ref.turnIds.length === 0) return
      const result = await sendToSession(ref.harnessSessionId, '', { regenerate: ref })
      if (result.ok) return
      errors.report(new Error(result.message), {
        category: 'inference',
        code: 'agent/regenerate-failed',
        userMessage: result.message,
      })
    }

    /**
     * A task run records its own failure. The in-flight step adopted after a reload
     * never went through `sendToSession`, so it would otherwise toast twice.
     */
    function quietSessionErrors(sessionId: string): void {
      const existing = turnContexts[sessionId]
      if (existing) {
        existing.quietErrors = true
        return
      }
      const record = sessions.value[sessionId]
      turnContexts[sessionId] = {
        workspaceDir: record?.workspaceDir ?? '',
        presetName: record?.presetName ?? HARNESS_CHAT_PRESET,
        capabilities: [...(record?.settings?.capabilities ?? [])],
        settings: record?.settings ? { ...record.settings } : undefined,
        stored: true,
        quietErrors: true,
      }
    }

    /** Stop one session's turn and save its transcript as it stands. */
    async function stopSession(sessionId: string): Promise<void> {
      const runtime = turns.runtimeOf(sessionId)
      if (!runtime) {
        if (sessionId) await window.electronAPI.agentMode.cancel(sessionId)
        return
      }
      if (runtime.hasTurn()) stoppedByUser.add(sessionId)
      await runtime.cancel()
      turns.abortRunningTools(sessionId)
      await runtime.chat.stop()
      runtime.chat.messages = settleStreamingParts(runtime.chat.messages, Date.now())
      runtime.processing.value = false
      snapshotSessionById(sessionId)
    }

    async function stop(): Promise<void> {
      await stopSession(openSessionId.value)
    }

    return {
      deleteTurns,
      regenerateTurn,
      isSessionProcessing,
      workspaceDir,
      agentPresetName,
      activeAgentPreset,
      agentWorkspaceKind,
      currentGame,
      lastWorkspaceByKind,
      mcpServerIds,
      defaultCapabilities,
      capabilities,
      isCapabilityEnabled,
      planningPhaseSupported,
      setCapabilityEnabled,
      setCapabilities,
      mountedFoldersSupported,
      mountedFolders,
      setMountedFolders,
      resetPresetSettings,
      migrateMcpServerIds,
      adoptWebCapability,
      webCapabilityAdopted,
      defaultCapabilitiesAdopted,
      migrateSessionPresets,
      init,
      sessionsHydrated,
      migratePlanningThinkingOnly,
      adoptDefaultCapabilities,
      planningThinkingOnly,
      effectivePlanningThinkingOnly,
      setPlanningThinkingOnly,
      openSessionSettings,
      bindSessionSettingsPort,
      reloadOpenSessionSettings,
      ensureOpenSessionId,
      sessionScoped,
      settingsProblems,
      problemsOf,
      loadMcpServersFor,
      agentDefaults: readAgentDefaults,
      saveAsDefault,
      resetToDefault,
      migrateAgentDefaults,
      unsandboxedWorkspaces,
      unsandboxed,
      isUnsandboxed,
      setUnsandboxed,
      attachments,
      sessionDocuments,
      indexingDocuments,
      removeSessionDocument,
      attachFiles,
      storedTurnSeesImages,
      removeAttachment,
      clearAttachments,
      processing,
      turnState,
      messages,
      toolProgress,
      toolImages,
      sessionUsage,
      sessionTokens,
      contextUsage,
      lastStepUsage,
      chat,
      anyTurnOpen,
      sessionTurns,
      unseenTurns,
      notRunMessages,
      canResendNotRun,
      resendNotRun,
      sessions,
      presetSessions,
      openSessionId,
      refreshCurrentGame,
      newGame,
      startNew,
      reconcileWorkspaceKind,
      generate,
      createSession,
      endAgentRun,
      sendToSession,
      setTaskLockLookup,
      quietSessionErrors,
      onTurnSettled,
      heldAnswers,
      setHeldAnswer,
      discardHeldAnswer,
      releaseHeldAnswer,
      onHeldAnswerSettled,
      stopSession,
      stop,
      newSession,
      switchSession,
      openSession,
      setViewShown,
      liveTurnsIn,
      streamingMessagesOf,
      deleteSession,
      restoreOpenSession,
    }
  },
  {
    persist: {
      // Session records, the open session id and the last-used workspace pointers
      // live in the kernel's files (step 8, §6.1); everything here is user
      // preference.
      pick: [
        'mcpServerIds',
        'webCapabilityAdopted',
        'defaultCapabilitiesAdopted',
        'defaultCapabilities',
        'unsandboxedWorkspaces',
        'planningThinkingOnly',
      ],
      afterHydrate: (ctx) => {
        ctx.store.migrateMcpServerIds()
        ctx.store.adoptWebCapability()
        ctx.store.migratePlanningThinkingOnly()
      },
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => unregisterAgentModeIpc())
  import.meta.hot.accept(acceptHMRUpdate(useAgentMode, import.meta.hot))
}
