// Main-process pushes for Agent Mode. Registering at store setup used to stack
// a new ipcRenderer.on per Pinia HMR of agentMode.ts, so media tools could run
// twice. These helpers subscribe once and return the matching removeListener.
//
// The four notification channels ride the kernel event stream
// (projection/kernelProjection.ts); only executeTool stays point-to-point — it
// is a request the renderer answers, not a notification.

import { connectKernelEventStream } from '@/assets/js/projection/kernelProjection'
import type { AgentTurnState, KernelSnapshot, PauseReason } from '@/types/kernelEvents'

type AgentTurnRef = { sessionId: string; turnId: string }

type AgentModeIpcHandlers = {
  onStreamChunk: (data: AgentTurnRef & { chunk: unknown }) => void
  onToolProgress: (data: AgentToolProgress) => void
  onToolImage: (data: AgentToolImage) => void
  onTurnState: (data: AgentTurnRef & { state: AgentTurnState; pauseReason?: PauseReason }) => void
  onTurnDone: (data: AgentTurnRef) => void
  /** A text run's Turn Queue position; `position` is absent once it holds the place. */
  onQueuePosition: (data: AgentTurnRef & { position?: number }) => void
  onExecuteTool: (data: AgentToolExecuteRequest) => void | Promise<void>
  /**
   * The kernel snapshot, at install time — before buffered events are applied.
   * This is where a renderer that (re)connected mid-turn adopts it.
   */
  onSnapshot: (snapshot: KernelSnapshot) => void
}

let disposers: Array<() => void> = []

export function registerAgentModeIpc(handlers: AgentModeIpcHandlers): void {
  if (disposers.length > 0) return
  const api = window.electronAPI?.agentMode
  if (!api) return
  const projection = connectKernelEventStream(
    (event) => {
      switch (event.type) {
        case 'agent-chunk':
          handlers.onStreamChunk({
            sessionId: event.sessionId,
            turnId: event.turnId,
            chunk: event.chunk,
          })
          break
        case 'agent-tool-progress':
          handlers.onToolProgress({
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            text: event.text,
          })
          break
        case 'agent-tool-image':
          handlers.onToolImage({
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolCallId: event.toolCallId,
            dataUri: event.dataUri,
            label: event.label,
          })
          break
        case 'agent-turn-state':
          handlers.onTurnState({
            sessionId: event.sessionId,
            turnId: event.turnId,
            state: event.state,
            pauseReason: event.pauseReason,
          })
          break
        case 'agent-turn-done':
          handlers.onTurnDone({ sessionId: event.sessionId, turnId: event.turnId })
          break
        case 'queue-event':
          if (event.kind !== 'text' || !event.conversationKey) break
          handlers.onQueuePosition({
            sessionId: event.conversationKey,
            turnId: event.runKey,
            position: event.position,
          })
          break
      }
    },
    (snapshot) => handlers.onSnapshot(snapshot),
  )
  disposers = [projection.dispose, api.onExecuteTool(handlers.onExecuteTool)].filter(
    (dispose): dispose is () => void => typeof dispose === 'function',
  )
}

export function unregisterAgentModeIpc(): void {
  for (const dispose of disposers) dispose()
  disposers = []
}
