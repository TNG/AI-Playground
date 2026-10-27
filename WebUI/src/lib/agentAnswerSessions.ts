import { watch } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import type { AnswerSendResult, SessionPause } from '@/assets/js/store/channels/answerRouter'
import { registerAnswerSessions } from '@/assets/js/store/channels/answerSessionsPort'
import type { AgentAnswerOrigin } from '@/types/agentIpc'

const ADMISSION_WAIT_MS = 3000

/** Lets the Home Agent poll path send Answers into Agent Mode sessions. */
export function registerAgentAnswerSessions(label: (sessionId: string) => string): void {
  const agentMode = useAgentMode()

  // A new turn is queued locally first; main then admits it or gives it a place in the queue.
  function admitted(sessionId: string): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        stop()
        resolve(null)
      }, ADMISSION_WAIT_MS)
      const stop = watch(
        () => agentMode.sessionTurns[sessionId],
        (turn) => {
          if (!turn || (turn.state === 'queued' && turn.queuePosition === null)) return
          clearTimeout(timer)
          // `immediate` can call back before `stop` is assigned.
          queueMicrotask(() => stop())
          resolve(turn.state === 'queued' ? turn.queuePosition : null)
        },
        { immediate: true },
      )
    })
  }

  async function send(
    sessionId: string,
    text: string,
    answer: AgentAnswerOrigin,
  ): Promise<AnswerSendResult> {
    const result = await agentMode.sendToSession(sessionId, text, {
      useStoredSettings: true,
      answer,
    })
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message }
    return { ok: true, queuePosition: await admitted(sessionId) }
  }

  function pause(sessionId: string): SessionPause | null {
    const kind = agentMode.sessionTurns[sessionId]?.pauseReason?.kind
    if (!kind) return null
    return kind === 'download' ? 'download' : 'desktop'
  }

  registerAnswerSessions({
    lookup: (kind, ref) => window.electronAPI.notifications.lookupMessage(kind, ref),
    label,
    usesRealShell: (sessionId) => {
      const record = agentMode.sessions[sessionId]
      return !!record && agentMode.isUnsandboxed(record.workspaceDir)
    },
    send,
    pause,
    held: (sessionId, answer) => agentMode.setHeldAnswer(sessionId, answer),
    onTurnEnd: (listener) => agentMode.onHeldAnswerSettled(listener),
  })
}
