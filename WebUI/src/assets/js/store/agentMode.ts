import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
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
import { unregisterAgentModeIpc } from './agentModeIpc'
import { demoAwareStorage } from '../demoAwareStorage'
import { makeForwardPersist } from '@/lib/ipcPersist'
import { cloneForIpc } from '@/lib/cloneForIpc'
import {
  makeFileBackedPreference,
  type FileBackedPreferencesApi,
} from '@/lib/fileBackedPreferences'
import {
  LegacyAgentSessionStateSchema,
  type AgentSessionBootstrap,
  type AgentSessionSettings,
  type LegacyAgentSessionState,
} from '@/types/agentSessionIpc'
import {
  DEFAULT_CAPABILITIES_KEY,
  DEFAULT_PLANNING_THINKING_ONLY_KEY,
  fillMissingSessionSettings,
  keepUneditedSettings,
  presetNameUsesSessionSettings,
  sessionSettingsFromBag,
  sessionSettingsToBag,
  updateSessionSettingsFromBag,
  usesSessionSettings,
} from '@/lib/agentSessionSettings'
import { sessionSettingsProblems, type SessionSettingsProblem } from '@/lib/sessionSettingsProblems'
import { createAppError } from '@/assets/js/errors/appError'
import { withResponseLanguage } from '@/lib/responseLanguage'
import { ragEmbeddingPrepFailure } from '@/lib/ragEmbeddingPrep'
import { requestDownload } from '@/assets/js/permissions/permissions'
import {
  DEFAULT_CAPABILITY_IDS,
  WEB_CAPABILITY_ID,
  GAME_STUDIO_QUICK_ID,
  OFFER_GAME_AGENT_TOOL,
  RAG_PREPARE_EMBEDDING_MODEL,
} from '@/types/agentCapabilities'
import type { GameLibraryEntry } from '@/types/agentIpc'
import {
  AGENT_PRESET,
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
  type AgentSessionRecord,
} from './agentModeSessions'
import { buildTurnConfig, createAgentTurnRuntimes, latestTurnMetadata } from './agentModeTurn'
import {
  createUnsandboxedWorkspaces,
  createWorkspaceAttachments,
  isGameFolder,
  reconcileGamesWorkspace,
} from './agentModeWorkspace'

export type { AgentSessionRecord }

// ── Agent Mode: renderer side of the Pi coding-agent integration ─────────────
//
// The Pi session runs in the Electron main process
// (electron/agent/piAgentManager.ts). This store owns the UI state
// (workspace folder, sandbox consent) and a custom ChatTransport whose
// sendMessages() triggers `agentMode:startTurn` over IPC and reconstructs the UI
// message chunk stream from `agentMode:streamChunk` pushes — feeding a standard
// @ai-sdk/vue Chat instance so the existing part renderers work unchanged.
// The model controls are Chat's (textInference + cloudMode); for the Agent preset
// they are bound to the Open Session's Session Settings (docs/adr/0001).
//
// Each Agent Session gets its own turn runtime (Chat instance, busy state, tool
// progress and images), and kernel events reach only the runtime of the session
// they carry. The Open Session only selects which runtime Agent Mode renders.
// Every sent turn waits in main's Turn Queue, so any number of sessions can hold
// a queued turn while one runs. For the Agent preset, switching conversation or
// workspace (newSession, switchSession, adoptWorkspace) leaves turns running;
// Game Agent and Quick Coder still stop the open session's turn when left.

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

    const { unsandboxedWorkspaces, unsandboxed, setUnsandboxed } =
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
     * The Open Session's Session Settings (Agent preset only). Null until a Draft
     * Session has taken the Default Settings; the chat store's next load fills it.
     */
    const openSettings = ref<AgentSessionSettings | null>(null)

    const sessionScoped = computed(() => usesSessionSettings(activeAgentPreset.value))

    /** The Open Session has been sent: its stored settings are its own and are checked. */
    const sessionSent = computed(
      () => sessionScoped.value && (sessions.value[openSessionId.value]?.messages.length ?? 0) > 0,
    )

    /** Live values right after a sent session loaded; fields still equal to them were not edited. */
    let loadedBaseline: AgentSessionSettings | null = null

    /** Stored settings of the sent session that can no longer be used. Drafts are never blocked. */
    const settingsProblems = computed<SessionSettingsProblem[]>(() => {
      if (!sessionSent.value || !openSettings.value) return []
      return sessionSettingsProblems(
        { ...openSettings.value, capabilities: capabilities.value },
        {
          ...textInference.settingsAvailability,
          mcpServerIds: mcp.serversLoaded ? mcp.allServers.map((server) => server.id) : null,
        },
      )
    })

    /** Refuse a turn while a stored setting is unusable; the prompt bar names the field. */
    async function blockedBySettingsProblems(): Promise<boolean> {
      if (!sessionSent.value) return false
      if (!mcp.serversLoaded && capabilities.value.some((id) => id.startsWith('mcp:'))) {
        await mcp.refreshAvailableServers()
      }
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

    type AgentDefaults = { capabilities: string[]; planningThinkingOnly: boolean }

    /**
     * The capability and planning half of the Agent preset's Default Settings. Until the
     * preset's bag holds them, the former global values stand in (`migrate` copies them in).
     */
    function readAgentDefaults(): AgentDefaults {
      const bag = textInference.settingsPerPreset?.[AGENT_PRESET] ?? {}
      const capabilities = bag[DEFAULT_CAPABILITIES_KEY]
      const planning = bag[DEFAULT_PLANNING_THINKING_ONLY_KEY]
      return {
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
      const bag = bags[AGENT_PRESET] ?? {}
      if (DEFAULT_CAPABILITIES_KEY in bag && DEFAULT_PLANNING_THINKING_ONLY_KEY in bag) {
        return defaults
      }
      textInference.settingsPerPreset = {
        ...bags,
        [AGENT_PRESET]: {
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
        // A Draft Session's first save also takes the capability and planning defaults.
        const next = updateSessionSettingsFromBag(
          stored ?? migrateAgentDefaults(),
          bag,
          embeddingBackend,
        )
        openSettings.value =
          stored && loadedBaseline ? keepUneditedSettings(stored, next, loadedBaseline) : next
      },
      pinned: () => sessionSent.value,
      loaded: (bag, embeddingBackend) => {
        loadedBaseline = updateSessionSettingsFromBag(null, bag, embeddingBackend)
      },
    })

    /** "Save as default": the Open Session's settings become the Agent preset's defaults. */
    function saveAsDefault(): void {
      const settings = openSettings.value
      if (!sessionScoped.value || !settings) return
      const bags = textInference.settingsPerPreset ?? {}
      const base = bags[AGENT_PRESET] ?? {}
      textInference.settingsPerPreset = {
        ...bags,
        [AGENT_PRESET]: {
          ...sessionSettingsToBag(settings, base, textInference.embeddingBackend),
          [DEFAULT_CAPABILITIES_KEY]: [...capabilities.value],
          [DEFAULT_PLANNING_THINKING_ONLY_KEY]: effectivePlanningThinkingOnly.value,
        },
      }
    }

    /**
     * "Reset to default": the Open Session takes the Default Settings again, repaired the
     * way a new Draft Session is. Other sessions and the stored defaults stay as they are.
     */
    function resetToDefault(): void {
      if (!sessionScoped.value) return
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
      if (!record || record.messages.length === 0 || !sessionsHydrated.value) return
      const fromDefaults: AgentSessionSettings = {
        ...sessionSettingsFromBag(defaults, embeddingBackend),
        ...readAgentDefaults(),
      }
      const filled = fillMissingSessionSettings(openSettings.value ?? {}, fromDefaults)
      if (!filled.changed) return
      openSettings.value = filled.settings
      rewriteSession(openSessionId.value, { ...record, settings: { ...filled.settings } })
    }

    /** What a record contributes on activation: a sent Agent session always has settings. */
    function settingsOfRecord(
      record: AgentSessionRecord | undefined,
    ): AgentSessionSettings | undefined {
      if (!record || record.messages.length === 0) return record?.settings
      if (!presetNameUsesSessionSettings(record.presetName)) return record.settings
      return record.settings ?? {}
    }

    function presetUsesSessionSettings(presetName: string): boolean {
      const preset = presetsStore.presets.find((entry) => entry.name === presetName)
      return preset?.type === 'chat' && usesSessionSettings(preset as ChatPreset)
    }

    /**
     * Put the Open Session's settings into the live controls. Nothing starts here: the
     * backend and model are made ready by the next send.
     */
    function applyOpenSessionSettings(settings: AgentSessionSettings | undefined): void {
      openSettings.value = settings ? { ...settings } : null
      loadedBaseline = null
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

    /** Change the Open Session's own settings and keep its record (if any) in step. */
    function updateOpenSettings(change: AgentSessionSettings): void {
      openSettings.value = { ...openSettings.value, ...change }
      const session = sessions.value[openSessionId.value]
      if (!session) return
      rewriteSession(openSessionId.value, { ...session, settings: { ...openSettings.value } })
    }

    function setCapabilityEnabled(id: string, enabled: boolean): void {
      const next = toggleCapabilityIds(capabilities.value, id, enabled)
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
        updateOpenSettings(migrateAgentDefaults())
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
        if (!presetNameUsesSessionSettings(record.presetName)) continue
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

    function setPlanningThinkingOnly(value: boolean): void {
      if (sessionScoped.value) updateOpenSettings({ planningThinkingOnly: value })
      else planningThinkingOnly.value = value
    }

    function migratePlanningThinkingOnly(): void {
      const bags = textInference.settingsPerPreset
      if (!bags) return
      const { value, bags: next } = takeLegacyPlanningThinkingOnly(
        bags,
        agentPresetName.value || AGENT_PRESET,
      )
      if (typeof value === 'boolean') planningThinkingOnly.value = value
      if (next !== bags) textInference.settingsPerPreset = next
    }

    // Frozen per session so a later turn does not rebuild Pi (instructions are
    // part of the session key) or pick up a Language-selector change mid-run.
    const pendingResponseLocales: Record<string, string> = {}

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

    /** What a turn was sent with, for saving its session should it end while another is open. */
    type TurnContext = {
      workspaceDir: string
      presetName: string
      capabilities: string[]
      settings?: AgentSessionSettings
    }
    const turnContexts: Record<string, TurnContext> = {}

    const turns = createAgentTurnRuntimes({
      errors,
      storeTools: {
        [OFFER_GAME_AGENT_TOOL]: (input, sessionId) => offerGameAgent(input, sessionId),
        [RAG_PREPARE_EMBEDDING_MODEL]: (input) => prepareRagEmbeddingModel(input),
      },
      // Sending only ever happens from the Open Session, whose Session Settings
      // are bound to the live controls (ADR 0001).
      buildTurnConfig: (sessionId) =>
        buildTurnConfig({
          sessionId,
          workspaceDir: workspaceDir.value,
          // The remembered agent preset, not the active one: a media call
          // switches the active preset to an image-gen one mid-turn.
          presetName: agentPresetName.value,
          instructions: withResponseLanguage(
            activeAgentPreset.value?.systemPrompt?.trim() ?? '',
            sessionResponseLocale(sessionId),
          ),
          capabilities: [...capabilities.value],
          unsandboxed: unsandboxed.value,
          planningThinkingOnly: effectivePlanningThinkingOnly.value,
          textInference,
          cloudMode,
        }),
      initialMessages: (sessionId) => [...(sessions.value[sessionId]?.messages ?? [])],
      // The sent message is on the record at once, so the session is in the history
      // even when the user moves on before the turn has run.
      onTurnSubmitted: (sessionId) => snapshotSessionById(sessionId),
      onTurnSettled: (sessionId) => onTurnSettled(sessionId),
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
    /** Where the Open Session's turn stands in the Turn Queue; null while it has none. */
    const turnState = computed(() => openRuntime.value.turnState.value)
    const toolProgress = computed(() => openRuntime.value.toolProgress.value)
    const toolImages = computed(() => openRuntime.value.toolImages.value)
    /** Any Agent Session holds a turn, open or not. */
    const anyTurnOpen = turns.anyTurnOpen

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
    function onTurnSettled(sessionId: string): void {
      confirmations.cancelForConversation(sessionId, false)
      const handoff = pendingHandoffs[sessionId]
      if (handoff) {
        delete pendingHandoffs[sessionId]
        void startGameAgentHandoff(handoff)
      }
      if (sessionId !== openSessionId.value) turns.release(sessionId)
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
     * Save a session's transcript from its runtime. The Open Session takes the live
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
      const open = id === openSessionId.value
      const context = turnContexts[id]
      const heldWith =
        presetName ?? (open ? agentPresetName.value : (existing?.presetName ?? context?.presetName))
      const dir = open ? workspaceDir.value : (existing?.workspaceDir ?? context?.workspaceDir)
      if (!dir || !heldWith) return
      const settings = open ? openSettings.value : existing ? undefined : context?.settings
      const record = snapshotSession({
        id,
        workspaceDir: dir,
        messages: runtime.chat.messages as UIMessage[],
        existing,
        capabilities: open ? capabilities.value : (context?.capabilities ?? []),
        presetName: heldWith,
        responseLocale: existing?.responseLocale ?? pendingResponseLocales[id],
        settings: presetUsesSessionSettings(heldWith) && settings ? settings : undefined,
      })
      if (!record) return
      if (record.settings) delete record.capabilities
      rewriteSession(id, record)
    }

    function snapshotOpenSession(presetName?: string): void {
      snapshotSessionById(openSessionId.value, presetName)
    }

    /** Show the open session's record, unless its runtime is streaming a turn of its own. */
    function restoreOpenSession(): void {
      const record = sessions.value[openSessionId.value]
      const runtime = openRuntime.value
      if (!runtime.hasTurn()) runtime.chat.messages = (record?.messages ?? []) as UIMessage[]
      applyOpenSessionSettings(settingsOfRecord(record))
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

    /**
     * Agent preset sessions run concurrently, so leaving one leaves its turn
     * running. Game Agent and Quick Coder sessions keep stop-on-switch.
     */
    async function leaveOpenSession(heldWith = agentPresetName.value): Promise<void> {
      if (presetNameUsesSessionSettings(heldWith)) return
      await stop()
    }

    function blankSession(): void {
      openSessionId.value = mintSessionId()
      sessionCapabilities.value = null
      applyOpenSessionSettings(undefined)
    }

    async function newSession(): Promise<void> {
      await leaveOpenSession()
      blankSession()
    }

    async function switchSession(id: string): Promise<void> {
      if (id === openSessionId.value) return
      const target = sessions.value[id]
      if (!target) return
      await leaveOpenSession()
      movingSession = true
      try {
        if (target.presetName && target.presetName !== agentPresetName.value) {
          await presetSwitching.switchPreset(target.presetName)
        }
        openSessionId.value = id
        sessionCapabilities.value = null
        if (target.workspaceDir) {
          workspaceDir.value = target.workspaceDir
          lastWorkspaceByKind.value = {
            ...lastWorkspaceByKind.value,
            [agentWorkspaceKind.value]: target.workspaceDir,
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
      await newSession()
      await generate(
        gameAgentHandoffPrompt({
          ...handoff,
          gameName: currentGame.value?.name,
          gameDescription: currentGame.value?.description,
        }),
      )
    }

    async function deleteSession(id: string): Promise<void> {
      // Stop first so Pi teardown in the same IPC is not racing a live turn,
      // then wait for the kernel: dropping the row before that would make a
      // failed delete vanish from the panel and come back on the next boot.
      if (id === openSessionId.value || turns.runtimeOf(id)?.hasTurn()) await stopSession(id)
      const result = await window.electronAPI.agentMode.deleteSession(id)
      if (!result.success) {
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
      if (id === openSessionId.value) {
        openSessionId.value = mintSessionId()
        sessionCapabilities.value = null
        applyOpenSessionSettings(undefined)
      } else {
        turns.release(id)
      }
    }

    async function adoptWorkspace(dir: string): Promise<void> {
      await leaveOpenSession()
      workspaceDir.value = dir
      const latest = Object.values(sessions.value)
        .filter((s) => s.workspaceDir === dir)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      openSessionId.value = latest?.id ?? ''
      sessionCapabilities.value = null
      restoreOpenSession()
      await refreshCurrentGame()
    }

    async function pickWorkspaceFolder(): Promise<void> {
      const result = await window.electronAPI.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select the agent workspace folder',
      })
      if (result.canceled || result.filePaths.length === 0) return
      const next = result.filePaths[0]
      if (workspaceDir.value === next) return
      await adoptWorkspace(next)
    }

    async function refreshCurrentGame(): Promise<void> {
      const dir = workspaceDir.value
      currentGame.value = dir ? await window.electronAPI.games.read(dir) : null
    }

    const { attachments, attachFiles, removeAttachment, clearAttachments, importAttachments } =
      createWorkspaceAttachments(errors)

    function blankGame(): void {
      workspaceDir.value = ''
      openSessionId.value = ''
      sessionCapabilities.value = null
      currentGame.value = null
      if (!openRuntime.value.hasTurn()) openRuntime.value.chat.messages = []
      openSettings.value = null
    }

    async function newGame(): Promise<void> {
      await leaveOpenSession()
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
      lastWorkspaceByKind.value = {
        ...lastWorkspaceByKind.value,
        pick: reconciled.pickDir ?? lastWorkspaceByKind.value.pick,
      }
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

    /**
     * Switching agent preset by hand always starts a blank session for the new
     * preset. A session's capabilities are frozen on its record while the
     * instructions are read live off the active preset, so continuing one under
     * another preset runs that preset's prompt against the wrong toolbox. The
     * `offer_game_agent` hand-over is the one way a game crosses over, and it
     * sets `movingSession` to keep its folder.
     */
    watch(agentPresetName, async (name, previous) => {
      if (!previous || name === previous || movingSession) return
      snapshotOpenSession(previous)
      lastWorkspaceByKind.value = {
        ...lastWorkspaceByKind.value,
        [workspaceKindOf(previous)]: workspaceDir.value,
      }
      await leaveOpenSession(previous)
      if (agentWorkspaceKind.value === 'games') {
        blankGame()
        return
      }
      workspaceDir.value = lastWorkspaceByKind.value.pick ?? ''
      blankSession()
      await refreshCurrentGame()
    })

    async function generate(prompt: string): Promise<void> {
      if (await blockedBySettingsProblems()) return
      // Game Agent never asks for a folder: the first turn of a game mints one.
      if (agentWorkspaceKind.value === 'games' && !(await isGameFolder(workspaceDir.value))) {
        const game = await window.electronAPI.games.create(prompt, {
          scaffold: !capabilities.value.includes(GAME_STUDIO_QUICK_ID),
          backend: textInference.backend,
          startingModel: textInference.activeModel,
          initialPrompt: prompt,
        })
        workspaceDir.value = game.dir
        lastWorkspaceByKind.value = { ...lastWorkspaceByKind.value, games: game.dir }
        currentGame.value = game
      }
      if (!workspaceDir.value) {
        errors.report(new Error('Select a workspace folder before starting the agent.'), {
          category: 'validation',
          code: 'agent/no-workspace',
          userMessage: 'Select a workspace folder before starting the agent.',
          surface: 'toast',
        })
        return
      }
      const attached = await importAttachments(workspaceDir.value)
      const sessionId = ensureSessionId(openSessionId)
      const runtime = turns.runtimeFor(sessionId)
      turnContexts[sessionId] = {
        workspaceDir: workspaceDir.value,
        presetName: agentPresetName.value,
        capabilities: [...capabilities.value],
        settings: openSettings.value ? { ...openSettings.value } : undefined,
      }
      runtime.toolProgress.value = {}
      runtime.processing.value = true
      try {
        await runtime.chat.sendMessage({ text: `${prompt}${attached}` })
      } finally {
        runtime.processing.value = false
        snapshotSessionById(sessionId)
        await refreshGameAfterTurn(sessionId)
      }
    }

    /** Stop one session's turn and save its transcript as it stands. */
    async function stopSession(sessionId: string): Promise<void> {
      const runtime = turns.runtimeOf(sessionId)
      if (!runtime) {
        if (sessionId) await window.electronAPI.agentMode.cancel(sessionId)
        return
      }
      await runtime.cancel()
      turns.abortRunningTools(sessionId)
      await runtime.chat.stop()
      runtime.processing.value = false
      snapshotSessionById(sessionId)
    }

    async function stop(): Promise<void> {
      await stopSession(openSessionId.value)
    }

    return {
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
      setCapabilityEnabled,
      resetPresetSettings,
      migrateMcpServerIds,
      adoptWebCapability,
      webCapabilityAdopted,
      migrateSessionPresets,
      init,
      sessionsHydrated,
      migratePlanningThinkingOnly,
      planningThinkingOnly,
      effectivePlanningThinkingOnly,
      setPlanningThinkingOnly,
      sessionScoped,
      settingsProblems,
      saveAsDefault,
      resetToDefault,
      migrateAgentDefaults,
      unsandboxedWorkspaces,
      unsandboxed,
      setUnsandboxed,
      attachments,
      attachFiles,
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
      sessions,
      presetSessions,
      openSessionId,
      pickWorkspaceFolder,
      refreshCurrentGame,
      newGame,
      startNew,
      reconcileWorkspaceKind,
      generate,
      stop,
      newSession,
      switchSession,
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
