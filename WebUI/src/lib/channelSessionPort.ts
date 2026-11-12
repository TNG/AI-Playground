import { computed, watch } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useAgentTrialRuns } from '@/assets/js/store/agentTrialRuns'
import { useSessionLifecycle } from '@/assets/js/store/sessionLifecycle'
import { useSessions } from '@/assets/js/store/sessions'
import type {
  ChannelTarget,
  ChannelTranscriptMessage,
  SessionActivity,
  SessionChange,
  SessionSendResult,
  TrialRunChange,
} from '@/assets/js/store/channels/answerRouter'
import type { RawPart } from '@/assets/js/store/channels/adapter'
import type { AttachResult, ChannelFile } from '@/assets/js/store/channels/channelInbound'
import { registerSessionPort } from '@/assets/js/store/channels/sessionPort'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
import { extractMessage } from '@/assets/js/errors/appError'
import { base64ToBytes } from '@/lib/synthesizeSpeech'
import type { AgentAnswerOrigin } from '@/types/agentIpc'

const ADMISSION_WAIT_MS = 3000

export type ChannelSessionLabels = {
  /** A Harness Session's Notification label (a Task run names its Step). */
  harness: (harnessSessionId: string) => string
  /** A Session's quoted title. */
  session: (sessionRef: string) => string
  /** A Trial Run's Notification label. */
  trialRun: (harnessSessionId: string) => string
}

/** Lets the channels reach Sessions, over Agent Mode's send-to-session path. */
export function registerChannelSessionPort(labels: ChannelSessionLabels): void {
  const agentMode = useAgentMode()
  const agentTasks = useAgentTasks()
  const agentTrialRuns = useAgentTrialRuns()
  const lifecycle = useSessionLifecycle()
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

  function harnessOf(target: ChannelTarget): Promise<string> {
    if ('trialRunSessionId' in target) return Promise.resolve(target.trialRunSessionId)
    return 'harnessSessionId' in target
      ? Promise.resolve(target.harnessSessionId)
      : assistantOf(target.sessionRef)
  }

  /** Into the workspace the target's turn runs in, which its prompt's `@attachments/` resolve against. */
  async function attach(target: ChannelTarget, file: ChannelFile): Promise<AttachResult> {
    try {
      const harnessSessionId = await harnessOf(target)
      const record = agentMode.sessions[harnessSessionId]
      if (!record) throw new Error(`No agent session ${harnessSessionId}.`)
      if (file.kind === 'image' && !(await agentMode.storedTurnSeesImages(harnessSessionId))) {
        return { ok: false, reason: 'images-unseen', message: '' }
      }
      const result = await window.electronAPI.agentMode.importAttachment(
        record.workspaceDir,
        file.filename,
        base64ToBytes(file.dataBase64),
      )
      if (!result.success) return { ok: false, reason: 'error', message: result.error ?? '' }
      return { ok: true, path: result.path }
    } catch (error) {
      return { ok: false, reason: 'error', message: extractMessage(error) }
    }
  }

  async function send(
    target: ChannelTarget,
    message: string,
    answer: AgentAnswerOrigin,
  ): Promise<SessionSendResult> {
    if ('trialRunSessionId' in target)
      return sendToTrialRun(target.trialRunSessionId, message, answer)
    let harnessSessionId: string
    try {
      harnessSessionId = await harnessOf(target)
    } catch (error) {
      return { ok: false, reason: 'error', message: extractMessage(error) }
    }
    // Answering an Agent Run's result continues that run, as a Follow-up.
    const followUp =
      'harnessSessionId' in target ? agentTasks.followUpOf(harnessSessionId) : undefined
    const result = await agentMode.sendToSession(harnessSessionId, message, {
      ...(followUp ?? { useStoredSettings: true }),
      answer,
    })
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message }
    return { ok: true, queuePosition: await admitted(harnessSessionId) }
  }

  /** A Follow-up to the Trial Run holding this Harness Session, never to its Agent's newer one. */
  async function sendToTrialRun(
    harnessSessionId: string,
    message: string,
    answer: AgentAnswerOrigin,
  ): Promise<SessionSendResult> {
    const run = agentTrialRuns.trialRunOfSession(harnessSessionId)
    if (!run) return { ok: false, reason: 'thrown-away', message: '' }
    const result = await agentTrialRuns.followUpTrialRun(run.agentId, message, { answer })
    if (!result.ok) {
      if (result.reason === 'running') return { ok: false, reason: 'busy', message: '' }
      return { ok: false, reason: result.reason, message: result.message }
    }
    return { ok: true, queuePosition: await admitted(harnessSessionId) }
  }

  function trialRunActivity(harnessSessionId: string): SessionActivity {
    const run = agentTrialRuns.trialRunOfSession(harnessSessionId)
    if (!run || !agentTrialRuns.trialRunInFlight(run.agentId)) return { kind: 'idle' }
    const paused = agentMode.sessionTurns[harnessSessionId]?.pauseReason?.kind
    if (!paused) return { kind: 'turn' }
    return { kind: 'turn', paused: paused === 'download' ? 'download' : 'desktop' }
  }

  /** The Session's Harness Sessions with a turn in this window, queued ones included. */
  function liveHarnessTurns(sessionRef: string): string[] {
    return Object.values(agentMode.sessions)
      .filter((record) => record.sessionRef === sessionRef && agentMode.sessionTurns[record.id])
      .map((record) => record.id)
  }

  function activity(sessionRef: string): SessionActivity {
    const run = agentTasks.agentRunStepIn(sessionRef)
    if (run) return { kind: 'agent-run', ...run }
    const turn = sessions.turns[sessionRef]
    const live = liveHarnessTurns(sessionRef)
    if (!turn && live.length === 0) return { kind: 'idle' }
    const harness = turn?.harnessSessionId ? [turn.harnessSessionId, ...live] : live
    const paused = harness
      .map((id) => agentMode.sessionTurns[id]?.pauseReason?.kind)
      .find((kind) => kind !== undefined)
    if (!paused) return { kind: 'turn' }
    return { kind: 'turn', paused: paused === 'download' ? 'download' : 'desktop' }
  }

  async function stop(sessionRef: string): Promise<SessionActivity> {
    const was = activity(sessionRef)
    if (was.kind === 'agent-run') {
      await agentTasks.stopRunIn(sessionRef)
    } else if (was.kind === 'turn') {
      const stopped = await lifecycle.stopTurnIn(sessionRef)
      // A turn still queued in this window has no turn in main's ledger yet.
      if (!stopped) {
        await Promise.all(liveHarnessTurns(sessionRef).map((id) => agentMode.stopSession(id)))
      }
    }
    return was
  }

  const changeListeners = new Set<(sessionRef: string, change: SessionChange) => void>()
  const busySessions = computed(
    () =>
      new Set([
        ...Object.keys(sessions.turns),
        ...Object.values(agentMode.sessions)
          .filter((record) => record.sessionRef && agentMode.sessionTurns[record.id])
          .map((record) => record.sessionRef!),
        ...Object.keys(sessions.sessions).filter((id) => agentTasks.agentRunStepIn(id)),
      ]),
  )
  const reachableSessions = computed(
    () =>
      new Set(
        Object.values(sessions.sessions)
          .filter((session) => session.reachable)
          .map((session) => session.id),
      ),
  )
  // Losing reachability goes first, so a queue dropped for it is not run by the same settle.
  watch([reachableSessions, busySessions], ([reachable, busy], [wasReachable, wasBusy]) => {
    const tell = (sessionRef: string, change: SessionChange) => {
      for (const listener of [...changeListeners]) listener(sessionRef, change)
    }
    for (const sessionRef of wasReachable) {
      if (reachable.has(sessionRef)) continue
      tell(sessionRef, sessions.sessions[sessionRef] ? 'unreachable' : 'deleted')
    }
    for (const sessionRef of wasBusy) {
      if (!busy.has(sessionRef)) tell(sessionRef, 'settled')
    }
  })

  const trialRunListeners = new Set<(harnessSessionId: string, change: TrialRunChange) => void>()
  const liveTrialRuns = computed(
    () => new Set(Object.values(agentTrialRuns.trialRuns).map((run) => run.harnessSessionId)),
  )
  const busyTrialRuns = computed(
    () =>
      new Set(
        Object.values(agentTrialRuns.trialRuns)
          .filter((run) => agentTrialRuns.trialRunInFlight(run.agentId))
          .map((run) => run.harnessSessionId),
      ),
  )
  // Thrown away goes first, so a queue dropped for it is not run by the same settle.
  watch([liveTrialRuns, busyTrialRuns], ([live, busy], [wasLive, wasBusy]) => {
    const tell = (harnessSessionId: string, change: TrialRunChange) => {
      for (const listener of [...trialRunListeners]) listener(harnessSessionId, change)
    }
    for (const id of wasLive) if (!live.has(id)) tell(id, 'thrown-away')
    for (const id of wasBusy) if (!busy.has(id) && live.has(id)) tell(id, 'settled')
  })

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
    recordStartPromptRequest: (kind, ref) =>
      window.electronAPI.notifications.recordStartPromptRequest(kind, ref),
    label: (target) =>
      'trialRunSessionId' in target
        ? labels.trialRun(target.trialRunSessionId)
        : 'harnessSessionId' in target
          ? labels.harness(target.harnessSessionId)
          : labels.session(target.sessionRef),
    attach,
    usesRealShell: ({ harnessSessionId }) => {
      const record = agentMode.sessions[harnessSessionId]
      return !!record && agentMode.isUnsandboxed(record.workspaceDir)
    },
    turnTarget: (target) => {
      if ('trialRunSessionId' in target) return target.trialRunSessionId
      if (!('harnessSessionId' in target)) return target.sessionRef
      const record = agentMode.sessions[target.harnessSessionId]
      const assistant =
        record?.sessionRef === target.sessionRef &&
        record.presetName === HARNESS_CHAT_PRESET &&
        !record.taskRun
      return assistant ? target.sessionRef : target.harnessSessionId
    },
    send,
    listStartableAgents: async () => agentTasks.startableAgents,
    agentName: (agentId) => agentTasks.tasks.find((task) => task.id === agentId)?.name ?? null,
    startAgent: (sessionRef, agentId, origin, prompt) =>
      agentTasks.startFromChannel(agentId, sessionRef, origin, prompt),
    activity,
    stop,
    onSessionChange: (listener) => {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
    onAgentRunRefused: (listener) => agentTasks.onChannelRunRefused(listener),
    trialRunLive: (harnessSessionId) => !!agentTrialRuns.trialRunOfSession(harnessSessionId),
    trialRunActivity,
    onTrialRunChange: (listener) => {
      trialRunListeners.add(listener)
      return () => trialRunListeners.delete(listener)
    },
  })
}
