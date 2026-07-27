import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, markRaw, ref } from 'vue'
import { Chat } from '@ai-sdk/vue'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { useTextInference } from './textInference'
import { useCloudMode, CLOUD_DEFAULT_MODEL } from './cloudMode'
import { useErrors } from './errors'
import { extractMessage } from '../errors/appError'
import { executeAgentTool, getAgentToolSpecs } from '../tools/agentBridge'

// ── Agent Mode (PoC): renderer side of the Pi harness integration ───────────
//
// The HarnessAgent runs in the Electron main process (harnessAgentManager.ts).
// This store owns the UI state (workspace folder) and a custom ChatTransport
// whose sendMessages() triggers `agentMode:startTurn` over IPC and
// reconstructs the UI message chunk stream from `agentMode:streamChunk`
// pushes — feeding a standard @ai-sdk/vue Chat instance so the existing part
// renderers work unchanged. Backend/model selection is fully shared with Chat
// (textInference + cloudMode) — no agent-specific model settings.

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
}

export const useAgentMode = defineStore(
  'agentMode',
  () => {
    const textInference = useTextInference()
    const cloudMode = useCloudMode()
    const errors = useErrors()

    const workspaceDir = ref<string>('')
    // MCP servers (from mcp.json) whose tools are attached to the agent.
    // Web debugging is provided by the built-in Electron `browser` tool +
    // `browser-debugging` skill (see harnessAgentManager), which reuse the
    // bundled Chromium at ~1 tool schema instead of the 29-schema Chrome
    // DevTools MCP. MCP servers are opt-in (attach extras via Agent Settings).
    const mcpServerIds = ref<string[]>([])

    // Multi-session persistence: each conversation is a session record keyed
    // by a minted session id (also the Pi sessionId on the main side, so both
    // sides of a conversation — visible transcript here, Pi context there —
    // share one key). Multiple sessions can live in the same workspace; the
    // History panel lists them grouped by workspace.
    const sessions = ref<Record<string, AgentSessionRecord>>({})
    const activeSessionId = ref<string>('')

    const processing = ref(false)
    let turnCounter = 0
    let activeTurn: ActiveTurn | null = null

    // Main-process pushes. Registered once; chunks are routed to the active
    // turn's stream controller by turnId.
    window.electronAPI.agentMode.onStreamChunk(({ turnId, chunk }) => {
      if (!activeTurn || activeTurn.turnId !== turnId || activeTurn.closed) return
      try {
        activeTurn.controller.enqueue(chunk as UIMessageChunk)
      } catch {
        // Stream already closed (e.g. user aborted) — drop the chunk.
      }
    })
    window.electronAPI.agentMode.onTurnDone(({ turnId }) => {
      if (!activeTurn || activeTurn.turnId !== turnId || activeTurn.closed) return
      activeTurn.closed = true
      try {
        activeTurn.controller.close()
      } catch {
        // Already closed.
      }
      activeTurn = null
    })
    // Bridged tool execution: the main-process HarnessAgent proxies AIPG media
    // tool calls back here, where the real implementations run against the
    // Pinia stores. Errors flow back to Pi as the tool result — report them
    // silently (the model surfaces/handles the failure in its reply).
    window.electronAPI.agentMode.onExecuteTool(
      async ({ requestId, toolCallId, toolName, input }) => {
        try {
          const result = await executeAgentTool(toolName, input, toolCallId)
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
        }
      },
    )

    async function buildTurnConfig(): Promise<AgentModeTurnConfig> {
      const toolSpecs = getAgentToolSpecs()
      const attachedMcpServerIds = [...mcpServerIds.value]
      const sessionId = ensureActiveSessionId()
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
            // Cloud model metadata rarely includes a context window; the main
            // process falls back to a generous default when undefined.
            contextWindow: textInference.maxContextSizeFromModel,
          },
          toolSpecs,
          mcpServerIds: attachedMcpServerIds,
        }
      }
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
          // Deliberately the raw backend URL, not `currentBackendUrl`: that one
          // prefers the Home Agent / Cloud Mode loopback proxies, which reject
          // requests (401) without headers only the chat store attaches. Pi
          // dials this endpoint itself from the main process.
          baseUrl: `${baseUrl}/v1`,
          contextWindow: textInference.contextSize,
        },
        toolSpecs,
        mcpServerIds: attachedMcpServerIds,
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

    // Token usage the main process attaches to the assistant message metadata
    // (see harnessAgentManager toUIMessageStream.messageMetadata).
    //
    // These are CUMULATIVE SESSION TOTALS, not current context occupancy: the
    // Pi harness derives its usage from `getSessionStats().tokens`, which Pi
    // documents as "assistant usage totals for the current session state" —
    // every agentic step re-sends the conversation, so the input total climbs
    // far past the model's context window. Pi's real context estimate lives in
    // a sibling `contextUsage` field the harness does not forward and its
    // session API does not expose, so the UI reports these as session totals
    // rather than pretending they gauge the window. The only exact context
    // figures we receive are tokensBefore/tokensAfter on compaction parts.
    type UsageMetadata = { usage?: { inputTokens?: number; outputTokens?: number } }

    const sessionUsage = computed(() => {
      const lastWithUsage = [...messages.value]
        .reverse()
        .find((m) => (m.metadata as UsageMetadata | undefined)?.usage)
      return (lastWithUsage?.metadata as UsageMetadata | undefined)?.usage
    })

    const sessionTokens = computed(
      () => (sessionUsage.value?.inputTokens ?? 0) + (sessionUsage.value?.outputTokens ?? 0),
    )

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
      chat.messages = []
    }

    async function switchSession(id: string): Promise<void> {
      if (id === activeSessionId.value) return
      const target = sessions.value[id]
      if (!target) return
      await stop()
      activeSessionId.value = id
      workspaceDir.value = target.workspaceDir
      restoreActiveSession()
    }

    // Drop a session's transcript record AND its main-side state (persisted
    // resume pointer + the Pi session file in the workspace).
    async function deleteSession(id: string): Promise<void> {
      const next = { ...sessions.value }
      delete next[id]
      sessions.value = next
      if (id === activeSessionId.value) {
        await stop()
        activeSessionId.value = mintSessionId()
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

    async function pickWorkspaceFolder(): Promise<void> {
      const result = await window.electronAPI.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select the agent workspace folder',
      })
      if (result.canceled || result.filePaths.length === 0) return
      const previous = workspaceDir.value
      const next = result.filePaths[0]
      if (previous === next) return
      // Park the current conversation and continue in the new workspace: pick
      // up its most recent session when one exists, else start fresh (a new id
      // is minted on the first turn).
      await stop()
      workspaceDir.value = next
      const latest = Object.values(sessions.value)
        .filter((s) => s.workspaceDir === next)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      activeSessionId.value = latest?.id ?? ''
      restoreActiveSession()
    }

    async function generate(prompt: string): Promise<void> {
      if (!workspaceDir.value) {
        errors.report(new Error('Select a workspace folder before starting the agent.'), {
          category: 'validation',
          code: 'agent/no-workspace',
          userMessage: 'Select a workspace folder before starting the agent.',
          surface: 'toast',
        })
        return
      }
      // Make sure the backend is ready before the main-process Pi session
      // dials it: local backends get started + the model loaded, Cloud Mode
      // gets its loopback proxy URL resolved. Context size is user-controlled
      // via Agent Settings (shared textInference.contextSize; agentic sessions
      // need a much larger window than the 8k chat default).
      await textInference.ensureReadyForInference()
      ensureActiveSessionId()
      processing.value = true
      try {
        await chat.sendMessage({ text: prompt })
      } finally {
        processing.value = false
        // Persist the transcript after every turn (mirrors the main-process
        // detach+persist of Pi's session), so a restart restores both sides.
        snapshotActiveSession()
      }
    }

    async function stop(): Promise<void> {
      await window.electronAPI.agentMode.cancel()
      await chat.stop()
      processing.value = false
      snapshotActiveSession()
    }

    const compacting = ref(false)

    // Manually trigger Pi's built-in context compaction. The detailed result
    // (trigger/summary/token deltas) surfaces on the next turn as a
    // 'compaction' dynamic-tool part; here we just report success/failure.
    async function compact(): Promise<void> {
      if (compacting.value || processing.value) return
      compacting.value = true
      try {
        const result = await window.electronAPI.agentMode.compact()
        if (!result.success) {
          errors.report(new Error(result.error ?? 'Compaction failed.'), {
            category: 'inference',
            code: 'agent/compaction-failed',
            userMessage: result.error ?? 'Context compaction failed.',
            surface: 'toast',
          })
        }
      } finally {
        compacting.value = false
      }
    }

    return {
      workspaceDir,
      mcpServerIds,
      processing,
      compacting,
      messages,
      sessionUsage,
      sessionTokens,
      chat,
      sessions,
      activeSessionId,
      pickWorkspaceFolder,
      generate,
      stop,
      newSession,
      switchSession,
      deleteSession,
      restoreActiveSession,
      compact,
    }
  },
  {
    persist: {
      pick: ['workspaceDir', 'mcpServerIds', 'sessions', 'activeSessionId'],
      afterHydrate: (ctx) => {
        // Restore the active session's visible transcript so the chat isn't
        // empty on launch (Pi restores its own context separately, keyed by
        // the same session id).
        ctx.store.restoreActiveSession()
      },
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAgentMode, import.meta.hot))
}
