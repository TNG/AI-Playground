import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, markRaw, ref } from 'vue'
import { Chat } from '@ai-sdk/vue'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { useTextInference } from './textInference'
import { useErrors } from './errors'
import { extractMessage } from '../errors/appError'

// ── Agent Mode (PoC): renderer side of the Pi harness integration ───────────
//
// The HarnessAgent runs in the Electron main process (harnessAgentManager.ts).
// This store owns the UI state (workspace folder, model source) and a custom
// ChatTransport whose sendMessages() triggers `agentMode:startTurn` over IPC
// and reconstructs the UI message chunk stream from `agentMode:streamChunk`
// pushes — feeding a standard @ai-sdk/vue Chat instance so the existing part
// renderers work unchanged.

export type AgentCloudProvider = 'AI_GATEWAY' | 'ANTHROPIC' | 'OPENAI' | 'OPENROUTER'

type ActiveTurn = {
  turnId: string
  controller: ReadableStreamDefaultController<UIMessageChunk>
  closed: boolean
}

export const useAgentMode = defineStore(
  'agentMode',
  () => {
    const textInference = useTextInference()
    const errors = useErrors()

    const workspaceDir = ref<string>('')
    const modelSource = ref<'local' | 'cloud'>('local')
    // Cloud settings (PoC): model id understood by Pi (e.g.
    // 'anthropic/claude-sonnet-4.6') plus an optional API key. An empty key
    // falls back to ambient host env vars (ANTHROPIC_API_KEY, ...).
    const cloudModel = ref<string>('')
    const cloudProvider = ref<AgentCloudProvider>('ANTHROPIC')
    const cloudApiKey = ref<string>('')

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

    function buildTurnConfig(): AgentModeTurnConfig {
      if (modelSource.value === 'local') {
        const servedModelId = textInference.activeModel?.split('/').join('---') ?? ''
        return {
          workspaceDir: workspaceDir.value,
          modelConfig: {
            source: 'local',
            model: servedModelId,
            baseUrl: `${textInference.currentBackendUrl}/v1`,
            contextWindow: textInference.contextSize,
          },
        }
      }
      return {
        workspaceDir: workspaceDir.value,
        modelConfig: {
          source: 'cloud',
          ...(cloudModel.value ? { model: cloudModel.value } : {}),
          ...(cloudApiKey.value
            ? { customEnv: { [`${cloudProvider.value}_API_KEY`]: cloudApiKey.value } }
            : {}),
        },
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
        const config = buildTurnConfig()

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

    async function pickWorkspaceFolder(): Promise<void> {
      const result = await window.electronAPI.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select the agent workspace folder',
      })
      if (!result.canceled && result.filePaths.length > 0) {
        const previous = workspaceDir.value
        workspaceDir.value = result.filePaths[0]
        // Folder change means a different sandbox root — drop the old session.
        if (previous && previous !== workspaceDir.value) {
          await window.electronAPI.agentMode.resetSession()
        }
      }
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
      if (modelSource.value === 'local') {
        // Make sure the local backend is up and the model is loaded before the
        // main-process Pi session dials it. Context size is user-controlled via
        // Agent Settings (shared textInference.contextSize; agentic sessions
        // need a much larger window than the 8k chat default).
        await textInference.ensureReadyForInference()
      }
      processing.value = true
      try {
        await chat.sendMessage({ text: prompt })
      } finally {
        processing.value = false
      }
    }

    async function stop(): Promise<void> {
      await window.electronAPI.agentMode.cancel()
      await chat.stop()
      processing.value = false
    }

    async function resetSession(): Promise<void> {
      await stop()
      await window.electronAPI.agentMode.resetSession()
      chat.messages.length = 0
    }

    return {
      workspaceDir,
      modelSource,
      cloudModel,
      cloudProvider,
      cloudApiKey,
      processing,
      messages,
      chat,
      pickWorkspaceFolder,
      generate,
      stop,
      resetSession,
    }
  },
  {
    persist: {
      pick: ['workspaceDir', 'modelSource', 'cloudModel', 'cloudProvider'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAgentMode, import.meta.hot))
}
