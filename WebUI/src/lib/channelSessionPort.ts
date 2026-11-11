import { watch } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useSessions } from '@/assets/js/store/sessions'
import type { SessionPause, SessionSendResult } from '@/assets/js/store/channels/answerRouter'
import { registerSessionPort } from '@/assets/js/store/channels/sessionPort'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { AnswerTarget } from '@/types/notificationsIpc'

const ADMISSION_WAIT_MS = 3000

/** Lets the channels reach Sessions, over Agent Mode's send-to-session path. */
export function registerChannelSessionPort(label: (harnessSessionId: string) => string): void {
  const agentMode = useAgentMode()
  const sessions = useSessions()

  // A new turn is queued locally first; main then admits it or gives it a place in the queue.
  function admitted(harnessSessionId: string): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        stop()
        resolve(null)
      }, ADMISSION_WAIT_MS)
      const stop = watch(
        () => agentMode.sessionTurns[harnessSessionId],
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
    target: AnswerTarget,
    message: string,
    answer: AgentAnswerOrigin,
  ): Promise<SessionSendResult> {
    const { harnessSessionId } = target
    const result = await agentMode.sendToSession(harnessSessionId, message, {
      useStoredSettings: true,
      answer,
    })
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message }
    return { ok: true, queuePosition: await admitted(harnessSessionId) }
  }

  function pause({ harnessSessionId }: AnswerTarget): SessionPause | null {
    const kind = agentMode.sessionTurns[harnessSessionId]?.pauseReason?.kind
    if (!kind) return null
    return kind === 'download' ? 'download' : 'desktop'
  }

  registerSessionPort({
    exists: async (sessionRef) => !!sessions.sessions[sessionRef],
    isReachable: async (sessionRef) => sessions.sessions[sessionRef]?.reachable === true,
    lookup: (kind, ref) => window.electronAPI.notifications.lookupMessage(kind, ref),
    label: ({ harnessSessionId }) => label(harnessSessionId),
    usesRealShell: ({ harnessSessionId }) => {
      const record = agentMode.sessions[harnessSessionId]
      return !!record && agentMode.isUnsandboxed(record.workspaceDir)
    },
    send,
    pause,
    held: ({ harnessSessionId }, answer) => agentMode.setHeldAnswer(harnessSessionId, answer),
    onTurnEnd: (listener) => agentMode.onHeldAnswerSettled(listener),
  })
}
