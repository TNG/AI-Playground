import { watch } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useSessions } from '@/assets/js/store/sessions'
import type {
  ChannelTranscriptMessage,
  SessionPause,
  SessionSendResult,
  SessionTarget,
} from '@/assets/js/store/channels/answerRouter'
import type { RawPart } from '@/assets/js/store/channels/adapter'
import { registerSessionPort } from '@/assets/js/store/channels/sessionPort'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
import { extractMessage } from '@/assets/js/errors/appError'
import type { AgentAnswerOrigin } from '@/types/agentIpc'

const ADMISSION_WAIT_MS = 3000

export type ChannelSessionLabels = {
  /** A Harness Session's Notification label (a Task run names its Step). */
  harness: (harnessSessionId: string) => string
  /** A Session's quoted title. */
  session: (sessionRef: string) => string
}

/** Lets the channels reach Sessions, over Agent Mode's send-to-session path. */
export function registerChannelSessionPort(labels: ChannelSessionLabels): void {
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

  /** The Session's Assistant Harness Session, minted in main and recorded here on first use. */
  async function assistantOf(sessionRef: string): Promise<string> {
    const result = await window.electronAPI.sessions.harnessSession(sessionRef, HARNESS_CHAT_PRESET)
    if (!result.success) throw new Error(result.error)
    const { harnessSessionId, workspaceDir } = result.harness
    if (!agentMode.sessions[harnessSessionId]) {
      agentMode.createSession({
        id: harnessSessionId,
        sessionRef,
        workspaceDir,
        settings: {},
        presetName: HARNESS_CHAT_PRESET,
        title: '',
      })
    }
    return harnessSessionId
  }

  async function send(
    target: SessionTarget,
    message: string,
    answer: AgentAnswerOrigin,
  ): Promise<SessionSendResult> {
    let harnessSessionId: string
    try {
      harnessSessionId =
        'harnessSessionId' in target
          ? target.harnessSessionId
          : await assistantOf(target.sessionRef)
    } catch (error) {
      return { ok: false, reason: 'error', message: extractMessage(error) }
    }
    const result = await agentMode.sendToSession(harnessSessionId, message, {
      useStoredSettings: true,
      answer,
    })
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message }
    return { ok: true, queuePosition: await admitted(harnessSessionId) }
  }

  function pause(target: SessionTarget): SessionPause | null {
    if (!('harnessSessionId' in target)) return null
    const kind = agentMode.sessionTurns[target.harnessSessionId]?.pauseReason?.kind
    if (!kind) return null
    return kind === 'download' ? 'download' : 'desktop'
  }

  async function transcript(sessionRef: string): Promise<ChannelTranscriptMessage[]> {
    const result = await window.electronAPI.sessions.open(sessionRef)
    if (!result.success) throw new Error(result.error)
    return result.session.timeline.flatMap((item) => {
      const message = item as { role?: unknown; parts?: unknown }
      if (message.role !== 'user' && message.role !== 'assistant') return []
      if (!Array.isArray(message.parts)) return []
      return [{ role: message.role, parts: message.parts as RawPart[] }]
    })
  }

  registerSessionPort({
    exists: async (sessionRef) => !!sessions.sessions[sessionRef],
    isReachable: async (sessionRef) => sessions.sessions[sessionRef]?.reachable === true,
    listReachable: async () =>
      Object.values(sessions.sessions)
        .filter((session) => session.reachable && !session.unreadable)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((session) => ({ sessionRef: session.id, title: session.title })),
    create: () => sessions.createReachable(agentMode.agentDefaults().capabilities),
    transcript,
    lookup: (kind, ref) => window.electronAPI.notifications.lookupMessage(kind, ref),
    label: (target) =>
      'harnessSessionId' in target
        ? labels.harness(target.harnessSessionId)
        : labels.session(target.sessionRef),
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
