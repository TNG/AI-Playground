import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, markRaw, ref, watch } from 'vue'
import { Chat } from '@ai-sdk/vue'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { useTextInference } from './textInference'
import { useCloudMode, CLOUD_DEFAULT_MODEL } from './cloudMode'
import { usePresets, type ChatPreset } from './presets'
import { usePresetSwitching } from './presetSwitching'
import { useErrors } from './errors'
import { extractMessage } from '../errors/appError'
import { executeAgentTool, getAgentToolSpecs } from '../tools/agentBridge'
import { chatTemplateKwargs } from '@/lib/samplingDefaults'
import { currentPresetName } from '@/lib/presetRenames'
import { registerAgentModeIpc, unregisterAgentModeIpc } from './agentModeIpc'
import {
  DEFAULT_CAPABILITY_IDS,
  GAME_STUDIO_QUICK_ID,
  MCP_CAPABILITY_PREFIX,
} from '@/types/agentCapabilities'
import type { AgentModeTurnConfig, GameLibraryEntry } from '@/types/agentIpc'

// ── Agent Mode: renderer side of the Pi coding-agent integration ─────────────
//
// The Pi session runs in the Electron main process
// (electron/agentMode/piAgentManager.ts). This store owns the UI state
// (workspace folder, sandbox consent) and a custom ChatTransport whose
// sendMessages() triggers `agentMode:startTurn` over IPC and reconstructs the UI
// message chunk stream from `agentMode:streamChunk` pushes — feeding a standard
// @ai-sdk/vue Chat instance so the existing part renderers work unchanged.
// Backend/model selection is fully shared with Chat (textInference + cloudMode)
// — no agent-specific model settings.

type ActiveTurn = {
  turnId: string
  controller: ReadableStreamDefaultController<UIMessageChunk>
  closed: boolean
}

export type AgentSessionRecord = {
  id: string
  workspaceDir: string
  /** Derived from the first user message (see deriveSessionTitle). */
  title: string
  messages: UIMessage[]
  createdAt: number
  updatedAt: number
  /**
   * Capability ids the session runs with. Frozen when the session starts, so
   * changing the defaults never re-equips an ongoing conversation behind the
   * user's back (it would also restart its Pi session).
   */
  capabilities?: string[]
  /**
   * The agent preset the conversation was held with (Agent, Game Agent). A
   * session only makes sense under it — the instructions, capabilities and
   * surrounding UI all come from the preset — so resuming one switches back to
   * it, and the Sessions panel only lists the active preset's own sessions.
   * Absent on sessions archived before presets drove Agent Mode.
   */
  presetName?: string
}

/**
 * Capabilities a new session starts with. Same list as DEFAULT_CAPABILITY_IDS;
 * persisted from then on as the user's own selection.
 */
const DEFAULT_CAPABILITIES = [...DEFAULT_CAPABILITY_IDS]

/**
 * The two agent presets sessions can predate `presetName` (see
 * `migrateSessionPresets`). Named rather than looked up, because the migration
 * runs on hydration, before the preset catalog is loaded.
 */
const GAME_AGENT_PRESET = 'Game Agent'
const AGENT_PRESET = 'Agent'

export const useAgentMode = defineStore(
  'agentMode',
  () => {
    const textInference = useTextInference()
    const cloudMode = useCloudMode()
    const presetsStore = usePresets()
    const presetSwitching = usePresetSwitching()
    const errors = useErrors()

    const workspaceDir = ref<string>('')

    /**
     * The agent preset driving the session, if any. Agent Mode is entered by
     * selecting a chat preset marked `agentPreset` (Agent, Game Agent), and that
     * preset supplies the extra instructions and the capability set.
     *
     * Remembered rather than read live, because the active preset is borrowed
     * mid-turn: a `media` call switches to an image-gen preset for the duration of
     * the generation. Following that would swap the session's capabilities,
     * instructions and workspace policy while the agent is working — and the
     * workspace watcher below would stop the very turn that made the call.
     */
    const agentPresetName = ref<string>('')

    const activeAgentPreset = computed<ChatPreset | null>(() => {
      const active = presetsStore.activePresetWithVariant
      // Prefer the live preset (variant merged in) while it is the remembered one.
      if (active?.type === 'chat' && active.name === agentPresetName.value) {
        return active as ChatPreset
      }
      const remembered = presetsStore.presets.find((p) => p.name === agentPresetName.value)
      return remembered?.type === 'chat' ? (remembered as ChatPreset) : null
    })

    watch(
      () => presetsStore.activePresetWithVariant,
      (preset) => {
        // Only agent presets are remembered: a plain chat preset becoming active
        // (whether the user picked it or a tool call borrowed it) leaves the last
        // agent preset in place, where it is inert until Agent Mode renders again.
        if (preset?.type === 'chat' && (preset as ChatPreset).agentPreset) {
          agentPresetName.value = preset.name
        }
      },
      { immediate: true },
    )

    /** Capabilities the active preset prescribes, or null when it has no opinion. */
    const presetCapabilities = computed<string[] | null>(() => {
      const declared = activeAgentPreset.value?.agentCapabilities
      return declared && declared.length > 0 ? declared : null
    })

    /**
     * How the workspace is chosen: 'pick' asks the user for any folder, 'games'
     * has the app mint one folder per game under the games library.
     */
    const agentWorkspaceKind = computed<'pick' | 'games'>(
      () => activeAgentPreset.value?.agentWorkspace ?? 'pick',
    )

    /** The game the workspace folder holds, when it is a game folder. */
    const currentGame = ref<GameLibraryEntry | null>(null)

    /**
     * Last workspace per kind. The two kinds mean unrelated folders (a game the app
     * created vs. a folder the user picked), so switching preset returns to the one
     * that belongs to it instead of pointing Game Agent at, say, a source checkout.
     */
    const lastWorkspaceByKind = ref<Record<string, string>>({})

    // What the agent is equipped with, as capability ids (see
    // electron/agentMode/capabilities): 'media', 'web-debug', 'memory',
    // 'game-studio', and one `mcp:<serverId>` per attached MCP server. The user
    // edits this list in Agent Settings; each new session freezes a copy of it.
    const defaultCapabilities = ref<string[]>([...DEFAULT_CAPABILITIES])
    /** Legacy field, migrated into `mcp:<id>` capabilities on hydration. */
    const mcpServerIds = ref<string[]>([])

    // Workspace folders the user explicitly allowed to run with the real host
    // shell instead of the emulated sandbox (node/npm/python/curl and live
    // network). Consent is per folder, so pointing the agent at a different
    // folder silently drops back to the sandboxed default until it is granted
    // again for that folder.
    const unsandboxedWorkspaces = ref<string[]>([])

    const unsandboxed = computed(
      () => !!workspaceDir.value && unsandboxedWorkspaces.value.includes(workspaceDir.value),
    )

    function setUnsandboxed(enabled: boolean): void {
      const folder = workspaceDir.value
      if (!folder) return
      const others = unsandboxedWorkspaces.value.filter((entry) => entry !== folder)
      unsandboxedWorkspaces.value = enabled ? [...others, folder] : others
    }

    // Multi-session persistence: each conversation is a session record keyed
    // by a minted session id (also the Pi sessionId on the main side, so both
    // sides of a conversation — visible transcript here, Pi context there —
    // share one key). Multiple sessions can live in the same workspace; the
    // History panel lists them grouped by workspace.
    const sessions = ref<Record<string, AgentSessionRecord>>({})
    const activeSessionId = ref<string>('')

    /** True while `switchSession` restores a session (see the watcher below). */
    let restoringSession = false

    /**
     * The sessions the Sessions panel lists: those of the active agent preset. A
     * preset supplies the instructions, capabilities and workspace policy a
     * conversation ran under, so listing the plain Agent's folders alongside Game
     * Agent's games would only offer conversations to resume under the wrong
     * rules. Sessions archived before presets drove Agent Mode name none, and
     * stay visible under every preset rather than disappearing.
     */
    const presetSessions = computed(() =>
      Object.values(sessions.value).filter(
        (session) => !session.presetName || session.presetName === agentPresetName.value,
      ),
    )

    /**
     * Toggles made for a preset-driven session that has not been archived yet
     * (an archived one carries its own frozen list). Dropped when the session is.
     */
    const sessionCapabilities = ref<string[] | null>(null)

    /** The capability set the next turn will run with. */
    const capabilities = computed<string[]>(
      () =>
        sessions.value[activeSessionId.value]?.capabilities ??
        sessionCapabilities.value ??
        presetCapabilities.value ??
        defaultCapabilities.value,
    )

    function isCapabilityEnabled(id: string): boolean {
      return capabilities.value.includes(id)
    }

    /**
     * Toggle a capability for the next turn. A session that has already started
     * carries its own frozen list, so the change is written there too — the main
     * process rebuilds its Pi session when the capability set changes.
     */
    function setCapabilityEnabled(id: string, enabled: boolean): void {
      const current = capabilities.value
      const next = enabled
        ? [...new Set([...current, id])]
        : current.filter((entry) => entry !== id)
      // A preset that prescribes its capabilities owns the starting point, so the
      // change belongs to this session instead of the user's stored default.
      if (presetCapabilities.value) sessionCapabilities.value = next
      else defaultCapabilities.value = next
      const session = sessions.value[activeSessionId.value]
      if (!session) return
      sessions.value = {
        ...sessions.value,
        [activeSessionId.value]: { ...session, capabilities: next },
      }
    }

    /**
     * Name every session the preset it was really held with, so it shows up in one
     * list rather than in every one — or, for a preset that has since been renamed,
     * under the name that preset ships with now.
     *
     * Sessions archived before presets drove Agent Mode name none; the workspace
     * folder says which they were: a folder in the game library was the game
     * preset's, anything else was the folder-picking Agent.
     */
    async function migrateSessionPresets(): Promise<void> {
      const renamed = Object.values(sessions.value).filter(
        (session) =>
          session.presetName && currentPresetName(session.presetName) !== session.presetName,
      )
      const legacy = Object.values(sessions.value).filter((session) => !session.presetName)
      if (legacy.length === 0 && renamed.length === 0) return
      const next = { ...sessions.value }
      for (const session of renamed) {
        next[session.id] = {
          ...session,
          presetName: currentPresetName(session.presetName!),
        }
      }
      if (legacy.length > 0) {
        const games = await window.electronAPI.games.list()
        const gameFolders = new Set(games.map((game) => game.dir))
        for (const session of legacy) {
          next[session.id] = {
            ...session,
            presetName: gameFolders.has(session.workspaceDir) ? GAME_AGENT_PRESET : AGENT_PRESET,
          }
        }
      }
      sessions.value = next
    }

    /** Fold the pre-capability `mcpServerIds` setting into the capability list. */
    function migrateMcpServerIds(): void {
      if (mcpServerIds.value.length === 0) return
      const migrated = mcpServerIds.value.map((serverId) => `${MCP_CAPABILITY_PREFIX}${serverId}`)
      defaultCapabilities.value = [...new Set([...defaultCapabilities.value, ...migrated])]
      mcpServerIds.value = []
    }

    const processing = ref(false)
    /** Latest streamed output per running tool call, keyed by toolCallId. */
    const toolProgress = ref<Record<string, string>>({})
    /** Images tools produced (e.g. browser screenshots), keyed by toolCallId. */
    const toolImages = ref<Record<string, AgentToolImage[]>>({})
    // Bridged tool implementations run HERE, not in the Pi session, so aborting
    // the turn in the main process only unblocks Pi — the renderer would keep
    // driving ComfyUI. Their abort controllers live here so stop() can settle
    // the work the user actually asked to stop.
    const runningTools = new Map<string, AbortController>()
    let turnCounter = 0
    let activeTurn: ActiveTurn | null = null

    registerAgentModeIpc({
      onStreamChunk: ({ turnId, chunk }) => {
        if (!activeTurn || activeTurn.turnId !== turnId || activeTurn.closed) return
        try {
          activeTurn.controller.enqueue(chunk as UIMessageChunk)
        } catch {
          // Stream already closed (e.g. user aborted) — drop the chunk.
        }
      },
      onToolProgress: ({ turnId, toolCallId, text }) => {
        if (!activeTurn || activeTurn.turnId !== turnId) return
        toolProgress.value = { ...toolProgress.value, [toolCallId]: text }
      },
      onToolImage: (image) => {
        const shown = toolImages.value[image.toolCallId] ?? []
        toolImages.value = { ...toolImages.value, [image.toolCallId]: [...shown, image] }
      },
      onTurnDone: ({ turnId }) => {
        if (!activeTurn || activeTurn.turnId !== turnId || activeTurn.closed) return
        activeTurn.closed = true
        try {
          activeTurn.controller.close()
        } catch {
          // Already closed.
        }
        activeTurn = null
      },
      onExecuteTool: async ({ requestId, toolCallId, toolName, input }) => {
        const abort = new AbortController()
        runningTools.set(requestId, abort)
        try {
          const result = await executeAgentTool(toolName, input, toolCallId, abort.signal)
          // IPC structured clone rejects Vue reactive proxies / class instances
          // that tool outputs can contain (e.g. MediaItem.settings) — flatten to
          // plain JSON first.
          const plainResult: unknown = JSON.parse(JSON.stringify(result ?? null))
          await window.electronAPI.agentMode.submitToolResult(requestId, plainResult)
        } catch (error) {
          errors.report(error, {
            category: 'inference',
            code: 'agent/tool-failed',
            userMessage: `Agent tool '${toolName}' failed: ${extractMessage(error)}`,
            surface: 'silent',
          })
          await window.electronAPI.agentMode.submitToolResult(
            requestId,
            undefined,
            extractMessage(error),
          )
        } finally {
          runningTools.delete(requestId)
        }
      },
    })
    watch(activeSessionId, () => {
      toolImages.value = {}
    })

    /**
     * Extra request-body fields for a local agent turn: the sampling the active
     * model's publisher recommends (models.json `inferenceDefaults`), the shared
     * temperature setting, and the reasoning depth for templates that read it.
     * Pi has no typed home for these, so they travel as `samplingParams` and the
     * main process merges them into each request body (electron/agentMode/piSampling.ts).
     */
    function buildSamplingParams(): Record<string, unknown> {
      const params: Record<string, unknown> = {
        ...textInference.samplingRequestBody,
        temperature: textInference.temperature,
      }
      const kwargs = chatTemplateKwargs({
        supportsThinkingToggle: textInference.modelSupportsThinkingToggle,
        thinkingEnabled: textInference.thinkingEnabled,
        thinkingActive: textInference.thinkingActive,
        reasoningEffort: textInference.effectiveReasoningEffort,
      })
      if (Object.keys(kwargs).length > 0) params.chat_template_kwargs = kwargs
      return params
    }

    async function buildTurnConfig(): Promise<AgentModeTurnConfig> {
      const toolSpecs = getAgentToolSpecs()
      const sessionId = ensureActiveSessionId()
      const enabledCapabilities = [...capabilities.value]
      // The preset's system prompt is what specializes the agent (e.g. into a game
      // maker); it is appended to the harness's own instructions in the main process.
      const instructions = activeAgentPreset.value?.systemPrompt?.trim() ?? ''
      // Fully shared model selection: the agent uses whatever backend/model
      // Chat is configured for — including Cloud Mode, which routes through
      // the same main-process loopback proxy (the key never leaves main).
      if (textInference.backend === 'cloud') {
        const upstreamBaseUrl = cloudMode.activeProviderBaseUrl
        if (!upstreamBaseUrl) {
          throw new Error(
            'Cloud Mode has no provider base URL configured. Set one up in Cloud Settings.',
          )
        }
        const proxyBaseUrl = await cloudMode.ensureProxyUrl()
        return {
          sessionId,
          workspaceDir: workspaceDir.value,
          modelConfig: {
            source: 'cloud',
            model: textInference.activeModel ?? CLOUD_DEFAULT_MODEL,
            proxyBaseUrl,
            upstreamBaseUrl,
            providerId: cloudMode.selectedProviderId,
            authStyle: cloudMode.activeProviderAuthStyle,
            supportsVision: textInference.modelSupportsVision,
            // From the provider's /v1/models `context_length` when it reports
            // one; the main process falls back to a generous default otherwise.
            contextWindow: textInference.maxContextSizeFromModel
              ? textInference.effectiveContextWindow
              : undefined,
          },
          toolSpecs,
          instructions,
          capabilities: enabledCapabilities,
          unsandboxed: unsandboxed.value,
        }
      }
      // Only a local template reads the thinking switch, so the planning phase
      // is a local-turn affair; cloud turns above never carry it.
      const servedModelId = textInference.activeModel?.split('/').join('---') ?? ''
      const baseUrl = textInference.localBackendUrl
      if (!baseUrl) {
        throw new Error(
          'No local inference backend is available. Pick a local backend and model in Agent Settings.',
        )
      }
      return {
        sessionId,
        workspaceDir: workspaceDir.value,
        modelConfig: {
          source: 'local',
          model: servedModelId,
          // Which server is behind `baseUrl`, and on what. Only the renderer
          // knows; tracing in main reads the rest (version, launch line) off
          // that service itself.
          backend: textInference.backend,
          device: textInference.getCurrentDeviceId() ?? undefined,
          deviceName: textInference.getCurrentDeviceName() ?? undefined,
          // Deliberately the raw backend URL, not `currentBackendUrl`: that one
          // prefers the Home Agent / Cloud Mode loopback proxies, which reject
          // requests (401) without headers only the chat store attaches. Pi
          // dials this endpoint itself from the main process.
          baseUrl: `${baseUrl}/v1`,
          // The window the turn actually gets, matching the chat gauge's
          // denominator: with a dynamically sized backend (OpenVINO on GPU) the
          // configured `contextSize` is not what the model ends up with.
          contextWindow: textInference.effectiveContextWindow,
          // Decides whether an image a tool read (an attached sprite, a
          // screenshot) is handed to the model or dropped with a note.
          supportsVision: textInference.modelSupportsVision,
          // What the model's publisher recommends for this mode, plus the
          // temperature and template kwargs Chat would send. Pi models none of
          // these itself, so they ride along as raw body fields.
          samplingParams: buildSamplingParams(),
        },
        toolSpecs,
        instructions,
        capabilities: enabledCapabilities,
        unsandboxed: unsandboxed.value,
        planningThinkingOnly:
          textInference.modelSupportsThinkingToggle &&
          textInference.thinkingEnabled &&
          textInference.planningThinkingOnly,
      }
    }

    const transport: ChatTransport<UIMessage> = {
      sendMessages: async ({ messages, abortSignal }) => {
        const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
        const prompt =
          lastUserMessage?.parts
            ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n\n') ?? ''

        const turnId = `turn-${++turnCounter}`
        const config = await buildTurnConfig()

        return new ReadableStream<UIMessageChunk>({
          start: (controller) => {
            activeTurn = { turnId, controller, closed: false }
            abortSignal?.addEventListener('abort', () => {
              window.electronAPI.agentMode.cancel()
            })
            // Fire the turn; chunks/done arrive via the push listeners above.
            // A failed start is surfaced as an error chunk by the main process,
            // but guard against IPC-level rejections too.
            window.electronAPI.agentMode.startTurn(turnId, prompt, config).catch((error) => {
              if (activeTurn?.turnId === turnId && !activeTurn.closed) {
                activeTurn.closed = true
                try {
                  controller.enqueue({ type: 'error', errorText: extractMessage(error) })
                  controller.close()
                } catch {
                  // Stream already closed.
                }
                activeTurn = null
              }
            })
          },
          cancel: () => {
            if (activeTurn?.turnId === turnId) {
              activeTurn.closed = true
              activeTurn = null
            }
            window.electronAPI.agentMode.cancel()
          },
        })
      },
      reconnectToStream: async () => null,
    }

    // markRaw: the Chat class uses private fields internally; Pinia's reactive()
    // proxy breaks its getters (`this` no longer carries the private state).
    const chat = markRaw(
      new Chat<UIMessage>({
        transport,
        onError: (error) => {
          errors.report(error, {
            category: 'inference',
            code: 'agent/turn-failed',
            userMessage: `Agent turn failed: ${extractMessage(error)}`,
            surface: 'toast',
          })
        },
      }),
    )

    const messages = computed(() => chat.messages)

    // Usage the main process attaches to the assistant message metadata, both
    // during the turn (`message-metadata` chunks, so the gauge tracks a long
    // agentic turn) and at its end (see piAgentManager's turnSummary). Two
    // different things arrive together:
    //
    //  - `usage`: CUMULATIVE SESSION TOTALS from Pi's getSessionStats(). Every
    //    agentic step re-sends the conversation, so the input total climbs far
    //    past the model's context window — it is a cost figure, not occupancy.
    //  - `contextUsage`: Pi's estimate of how full the context window actually
    //    is right now, which is what the gauge in the UI shows.
    //  - `lastStep`: usage of the newest model call — the same figure Chat mode's
    //    gauge reports, so Input/Output mean one thing across both modes.
    type TurnMetadata = {
      usage?: {
        inputTokens?: number
        outputTokens?: number
        cacheReadTokens?: number
        cacheWriteTokens?: number
        costUsd?: number
      }
      contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
      lastStep?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
    }

    function latestMetadata<K extends keyof TurnMetadata>(key: K): TurnMetadata[K] {
      const latest = [...messages.value]
        .reverse()
        .find((m) => (m.metadata as TurnMetadata | undefined)?.[key])
      return (latest?.metadata as TurnMetadata | undefined)?.[key]
    }

    const sessionUsage = computed(() => latestMetadata('usage'))

    const sessionTokens = computed(
      () => (sessionUsage.value?.inputTokens ?? 0) + (sessionUsage.value?.outputTokens ?? 0),
    )

    /** How full the model's context window is, straight from Pi. */
    const contextUsage = computed(() => latestMetadata('contextUsage'))

    /** Usage of the most recent model call within the session. */
    const lastStepUsage = computed(() => latestMetadata('lastStep'))

    function mintSessionId(): string {
      return `aipg-agent-${crypto.randomUUID()}`
    }

    // A session id is minted lazily (first turn / explicit new session), so an
    // untouched app never accumulates empty session records.
    function ensureActiveSessionId(): string {
      if (!activeSessionId.value) activeSessionId.value = mintSessionId()
      return activeSessionId.value
    }

    function deriveSessionTitle(sessionMessages: UIMessage[]): string {
      const firstUser = sessionMessages.find((m) => m.role === 'user')
      const text =
        firstUser?.parts
          ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join(' ')
          .trim() ?? ''
      if (!text) return 'New session'
      return text.length > 60 ? `${text.slice(0, 60)}…` : text
    }

    // Snapshot the live transcript into the active session record as plain
    // JSON (no reactive proxies/functions) so it persists cleanly. Empty
    // transcripts are not archived.
    function snapshotActiveSession(): void {
      const id = activeSessionId.value
      if (!id || !workspaceDir.value) return
      const plainMessages = JSON.parse(JSON.stringify(chat.messages)) as UIMessage[]
      if (plainMessages.length === 0) return
      const existing = sessions.value[id]
      sessions.value = {
        ...sessions.value,
        [id]: {
          id,
          workspaceDir: existing?.workspaceDir ?? workspaceDir.value,
          title: deriveSessionTitle(plainMessages),
          messages: plainMessages,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          // Freeze the set this conversation actually ran with.
          capabilities: existing?.capabilities ?? [...capabilities.value],
          presetName: existing?.presetName ?? agentPresetName.value,
        },
      }
    }

    // Load the active session's transcript into the Chat via the reactive
    // messages setter (safe under markRaw), or clear it when there is none.
    function restoreActiveSession(): void {
      chat.messages = (sessions.value[activeSessionId.value]?.messages ?? []) as UIMessage[]
    }

    // Archive the current conversation and start a fresh one (new session id →
    // brand-new Pi session on the next turn). The archived session stays
    // resumable from the Sessions panel.
    async function newSession(): Promise<void> {
      await stop()
      activeSessionId.value = mintSessionId()
      sessionCapabilities.value = null
      chat.messages = []
    }

    async function switchSession(id: string): Promise<void> {
      if (id === activeSessionId.value) return
      const target = sessions.value[id]
      if (!target) return
      await stop()
      restoringSession = true
      try {
        // A session belongs to the preset it was held with, so resuming a Game
        // Agent conversation goes back to Game Agent rather than showing its
        // transcript under whatever preset happens to be active.
        if (target.presetName && target.presetName !== agentPresetName.value) {
          await presetSwitching.switchPreset(target.presetName)
        }
        activeSessionId.value = id
        sessionCapabilities.value = null
        workspaceDir.value = target.workspaceDir
        lastWorkspaceByKind.value = {
          ...lastWorkspaceByKind.value,
          [agentWorkspaceKind.value]: target.workspaceDir,
        }
        restoreActiveSession()
        await refreshCurrentGame()
      } finally {
        restoringSession = false
      }
    }

    // Drop a session's transcript record AND its main-side state (the stored
    // session pointer plus Pi's session file).
    async function deleteSession(id: string): Promise<void> {
      const next = { ...sessions.value }
      delete next[id]
      sessions.value = next
      if (id === activeSessionId.value) {
        await stop()
        activeSessionId.value = mintSessionId()
        sessionCapabilities.value = null
        chat.messages = []
      }
      const result = await window.electronAPI.agentMode.deleteSession(id)
      if (!result.success) {
        errors.report(new Error(result.error ?? 'Failed to delete session.'), {
          category: 'unknown',
          code: 'agent/delete-session-failed',
          userMessage: result.error ?? 'Failed to delete the agent session.',
          surface: 'silent',
        })
      }
    }

    /**
     * Park the current conversation and continue in `dir`: pick up its most recent
     * session when one exists, else start fresh (a new id is minted on the first
     * turn).
     */
    async function adoptWorkspace(dir: string): Promise<void> {
      await stop()
      workspaceDir.value = dir
      const latest = Object.values(sessions.value)
        .filter((s) => s.workspaceDir === dir)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      activeSessionId.value = latest?.id ?? ''
      sessionCapabilities.value = null
      restoreActiveSession()
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

    /** Re-read the workspace's `game.json` (the agent edits it through its tools). */
    async function refreshCurrentGame(): Promise<void> {
      const dir = workspaceDir.value
      currentGame.value = dir ? await window.electronAPI.games.read(dir) : null
    }

    /**
     * Files the user attached for the next turn, still in memory.
     *
     * They are held rather than saved on sight because the folder they belong in
     * may not exist yet: Game Agent mints a game folder from the first prompt, so
     * attaching before sending has nowhere to write to. `importAttachments` puts
     * them in the workspace once `generate` has one.
     */
    const attachments = ref<{ name: string; bytes: ArrayBuffer }[]>([])

    async function attachFiles(files: File[]): Promise<void> {
      const read = await Promise.all(
        files.map(async (file) => ({ name: file.name, bytes: await file.arrayBuffer() })),
      )
      attachments.value = [...attachments.value, ...read]
    }

    function removeAttachment(index: number): void {
      attachments.value = attachments.value.filter((_, i) => i !== index)
    }

    function clearAttachments(): void {
      attachments.value = []
    }

    /**
     * Save the pending attachments into the workspace and return the sentence that
     * tells the agent about them.
     *
     * The agent gets a path, not the bytes: it reads, references and ships
     * workspace files with the tools it already has, which works with any model
     * and leaves an attached sprite where the game can load it. Even an image
     * reaches a vision model this way, because Pi's `read` returns images as
     * attachments. The paths go into the prompt itself so the transcript shows
     * what the agent was told.
     *
     * They are written as `@`-prefixed workspace-relative paths, which is how a
     * file is referenced in a prompt throughout Pi: its editor completes `@` to a
     * project file, and the path resolution behind every file tool strips the
     * prefix back off (`stripAtPrefix`). A path with spaces is quoted, again
     * following what Pi's completion produces.
     */
    async function importAttachments(): Promise<string> {
      if (attachments.value.length === 0) return ''
      const saved: string[] = []
      for (const attachment of attachments.value) {
        const result = await window.electronAPI.agentMode.importAttachment(
          workspaceDir.value,
          attachment.name,
          new Uint8Array(attachment.bytes),
        )
        if (result.success && result.path) saved.push(result.path)
        else {
          errors.report(new Error(result.error ?? `Failed to attach ${attachment.name}.`), {
            category: 'unknown',
            code: 'agent/attachment-failed',
            userMessage: `Could not attach ${attachment.name}.`,
            surface: 'toast',
          })
        }
      }
      clearAttachments()
      if (saved.length === 0) return ''
      const references = saved.map((file) => (/\s/.test(file) ? `@"${file}"` : `@${file}`))
      return `\n\nAttached files, saved in the workspace: ${references.join(' ')}`
    }

    /**
     * Whether `dir` is a game folder, i.e. carries a `game.json`. This is what
     * makes a folder usable by Game Agent: the game bar's Play, Save and open-
     * folder actions, the library listing and the `game` tool all resolve through
     * that card, so a plain folder leaves them with nothing to act on.
     */
    async function isGameFolder(dir: string): Promise<boolean> {
      return !!dir && !!(await window.electronAPI.games.read(dir))
    }

    /**
     * Start a game from scratch: no folder yet, so the first turn creates one named
     * after what the user asked for (see `generate`). The previous game's session
     * stays in the Sessions panel, grouped under its own folder.
     */
    async function newGame(): Promise<void> {
      await stop()
      workspaceDir.value = ''
      activeSessionId.value = ''
      sessionCapabilities.value = null
      currentGame.value = null
      chat.messages = []
    }

    /**
     * What "start something new" means under the active preset, for the single
     * plus button in the Sessions panel: a fresh game (own folder, own session)
     * for Game Agent, a fresh conversation in the same workspace otherwise.
     */
    async function startNew(): Promise<void> {
      if (agentWorkspaceKind.value === 'games') await newGame()
      else await newSession()
    }

    /**
     * Hand a workspace that is not a game back to the Agent preset it came from,
     * whenever Game Agent is the one holding it.
     *
     * `workspaceDir` is persisted as a single value while the two kinds mean
     * unrelated folders, so the folder picked for Agent can come back as Game
     * Agent's workspace — and the kind watcher below never notices, because with
     * Game Agent already active at launch the kind does not *change*, it starts
     * out as 'games'. Games were then built into the picked folder, outside the
     * library and without a `game.json`, which is what left the game bar's Play
     * and Save disabled and its folder button pointing at the library root.
     */
    async function reconcileWorkspaceKind(): Promise<void> {
      // Only Game Agent has an answer to "is this the wrong folder": it needs a
      // game folder, while the Agent preset works in any folder the user picked.
      if (agentWorkspaceKind.value !== 'games') return
      // An empty workspace is a deliberate state here ("New game"), not a folder
      // to be restored over.
      if (!workspaceDir.value) return
      if (await isGameFolder(workspaceDir.value)) return
      lastWorkspaceByKind.value = { ...lastWorkspaceByKind.value, pick: workspaceDir.value }
      await adoptWorkspace(lastWorkspaceByKind.value.games ?? '')
    }

    // Switching between an app-managed games workspace and a user-picked one moves
    // to the folder that kind was last using, so neither preset inherits the
    // other's folder. Resuming a session from the panel is the one case where the
    // kind changes and this must stay out of the way: the preset switch it makes
    // is a consequence of the folder and transcript already chosen, not a reason
    // to pick different ones.
    watch(
      agentWorkspaceKind,
      async (kind, previous) => {
        if (restoringSession) return
        // First run: nothing was switched, so check what we started with.
        if (previous === undefined) {
          await reconcileWorkspaceKind()
          return
        }
        if (kind === previous) return
        lastWorkspaceByKind.value = { ...lastWorkspaceByKind.value, [previous]: workspaceDir.value }
        const restored = lastWorkspaceByKind.value[kind] ?? ''
        if (restored !== workspaceDir.value) await adoptWorkspace(restored)
      },
      { immediate: true },
    )

    async function generate(prompt: string): Promise<void> {
      // Game Agent never asks for a folder: the first turn of a game mints one,
      // named after the request, and everything the agent writes lands in it. A
      // folder that holds no game counts as "no folder yet" — it is the Agent
      // preset's picked folder, and building a game there would put it outside the
      // library, where the game bar and the `game` tool cannot reach it.
      if (agentWorkspaceKind.value === 'games' && !(await isGameFolder(workspaceDir.value))) {
        const game = await window.electronAPI.games.create(prompt, {
          scaffold: !capabilities.value.includes(GAME_STUDIO_QUICK_ID),
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
      // The workspace exists now, so anything the user attached can be put in it.
      const attached = await importAttachments()
      // Make sure the backend is ready before the main-process Pi session
      // dials it: local backends get started + the model loaded, Cloud Mode
      // gets its loopback proxy URL resolved. Context size is user-controlled
      // via Agent Settings (shared textInference.contextSize; agentic sessions
      // need a much larger window than the 8k chat default).
      await textInference.ensureReadyForInference()
      ensureActiveSessionId()
      toolProgress.value = {}
      processing.value = true
      try {
        await chat.sendMessage({ text: `${prompt}${attached}` })
      } finally {
        processing.value = false
        // Persist the transcript after every turn (Pi persists its own session
        // file on every message), so a restart restores both sides.
        snapshotActiveSession()
        // The turn may have named the game or given it an icon (the `game` tool
        // writes straight to game.json), so the game bar re-reads it.
        await refreshCurrentGame()
      }
    }

    async function stop(): Promise<void> {
      await window.electronAPI.agentMode.cancel()
      for (const abort of runningTools.values()) abort.abort()
      runningTools.clear()
      await chat.stop()
      processing.value = false
      snapshotActiveSession()
    }

    return {
      workspaceDir,
      activeAgentPreset,
      agentWorkspaceKind,
      currentGame,
      lastWorkspaceByKind,
      mcpServerIds,
      defaultCapabilities,
      capabilities,
      isCapabilityEnabled,
      setCapabilityEnabled,
      migrateMcpServerIds,
      migrateSessionPresets,
      unsandboxedWorkspaces,
      unsandboxed,
      setUnsandboxed,
      attachments,
      attachFiles,
      removeAttachment,
      clearAttachments,
      processing,
      messages,
      toolProgress,
      toolImages,
      sessionUsage,
      sessionTokens,
      contextUsage,
      lastStepUsage,
      chat,
      sessions,
      presetSessions,
      activeSessionId,
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
      restoreActiveSession,
    }
  },
  {
    persist: {
      pick: [
        'workspaceDir',
        'lastWorkspaceByKind',
        'mcpServerIds',
        'defaultCapabilities',
        'unsandboxedWorkspaces',
        'sessions',
        'activeSessionId',
      ],
      afterHydrate: (ctx) => {
        // Settings saved before capabilities existed listed MCP servers on their
        // own; carry them over so attached servers stay attached.
        ctx.store.migrateMcpServerIds()
        // Sessions from before presets drove Agent Mode belong to one of them.
        void ctx.store.migrateSessionPresets()
        // Restore the active session's visible transcript so the chat isn't
        // empty on launch (Pi restores its own context separately, keyed by
        // the same session id).
        ctx.store.restoreActiveSession()
        // Whether the restored workspace is a game (and what it is called) lives
        // on disk, not in this store.
        void ctx.store.refreshCurrentGame()
        // One `workspaceDir` is persisted for two kinds of workspace, so the
        // folder that just came back may belong to the other preset.
        void ctx.store.reconcileWorkspaceKind()
      },
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => unregisterAgentModeIpc())
  import.meta.hot.accept(acceptHMRUpdate(useAgentMode, import.meta.hot))
}
