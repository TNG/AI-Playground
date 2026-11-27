import { randomUUID } from 'node:crypto'
import type {
  ChannelSpeech,
  SessionActivity,
  SessionChange,
  SessionPort,
  TrialRunChange,
} from '@/assets/js/store/channels/answerRouter'
import type { AnswerRouterCopy } from '@/lib/answerRouterWording'
import type { ChannelQuestionRegistry } from '@/assets/js/store/channels/channelQuestions'
import { parseConfirmationReply } from '@/assets/js/store/confirmationReply'
import type {
  ChannelPortAnswer,
  ChannelPortAsk,
  ChannelPortCall,
  ChannelPortResults,
  ChannelPortState,
} from '@/types/channelHostIpc'

type Op = ChannelPortCall['op']

export type WindowPortDeps = {
  /** Hands one call to the window; false when there is no window to take it. */
  post: (ask: ChannelPortAsk) => boolean
  lookup: SessionPort['lookup']
  recordStartPromptRequest: SessionPort['recordStartPromptRequest']
  log: (message: string, error: unknown) => void
  /** How long the window has to answer `subscribe`; a window still loading misses the ask. */
  subscribeTimeoutMs?: number
}

const SUBSCRIBE_TIMEOUT_MS = 5000

export type WindowPort = {
  /** Null until the window has sent its first mirror, so the router drops nothing on purpose. */
  port: () => SessionPort | null
  speech: ChannelSpeech
  questions: Pick<ChannelQuestionRegistry, 'handleInbound'>
  /** Asks the window to start mirroring; resolves once the first mirror has arrived. */
  subscribe: () => Promise<void>
  answer: (payload: ChannelPortAnswer) => void
  mirror: (state: ChannelPortState) => void
  /** The window went away: every call in flight fails and the mirror is dropped. */
  reset: (reason: string) => void
  ready: () => boolean
  /** The router's wording in the window's language, once mirrored. */
  copy: () => AnswerRouterCopy | null
}

const IDLE: SessionActivity = { kind: 'idle' }

/**
 * The Sessions as the router sees them while Agent Mode's stores still live in the window: reads
 * answer from the window's mirror, everything that changes a Session is a call to that window.
 */
export function createWindowPort(deps: WindowPortDeps): WindowPort {
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >()
  let state: ChannelPortState | null = null
  const sessionListeners = new Set<(sessionRef: string, change: SessionChange) => void>()
  const trialRunListeners = new Set<(harnessSessionId: string, change: TrialRunChange) => void>()

  function call<O extends Op>(
    request: Extract<ChannelPortCall, { op: O }>,
    timeoutMs?: number,
  ): Promise<ChannelPortResults[O]> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              pending.delete(requestId)
              reject(new Error('The app window did not answer'))
            }, timeoutMs)
      const settle = () => clearTimeout(timer)
      pending.set(requestId, {
        resolve: (value) => {
          settle()
          ;(resolve as (value: unknown) => void)(value)
        },
        reject: (error) => {
          settle()
          reject(error)
        },
      })
      let posted = false
      try {
        posted = deps.post({ requestId, call: request })
      } catch (error) {
        pending.delete(requestId)
        settle()
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (!posted) {
        pending.delete(requestId)
        settle()
        reject(new Error('No app window to reach the Sessions through'))
      }
    })
  }

  function busy(next: ChannelPortState | null): Set<string> {
    return new Set(Object.keys(next?.activity ?? {}))
  }

  function busyTrialRuns(next: ChannelPortState | null): Set<string> {
    return new Set(
      Object.entries(next?.trialRuns ?? {})
        .filter(([, activity]) => activity.kind !== 'idle')
        .map(([id]) => id),
    )
  }

  // Same order as the window's own watch: losing reachability first, so a queue dropped for it
  // is not also run by the settle that comes with it.
  function mirror(next: ChannelPortState): void {
    const previous = state
    state = next
    if (!previous) return
    const reachable = new Set(next.reachable)
    const existing = new Set(next.existing)
    const tell = (sessionRef: string, change: SessionChange) => {
      for (const listener of [...sessionListeners]) listener(sessionRef, change)
    }
    for (const sessionRef of previous.reachable) {
      if (reachable.has(sessionRef)) continue
      tell(sessionRef, existing.has(sessionRef) ? 'unreachable' : 'deleted')
    }
    const nowBusy = busy(next)
    for (const sessionRef of busy(previous))
      if (!nowBusy.has(sessionRef)) tell(sessionRef, 'settled')

    const tellTrial = (harnessSessionId: string, change: TrialRunChange) => {
      for (const listener of [...trialRunListeners]) listener(harnessSessionId, change)
    }
    const live = new Set(Object.keys(next.trialRuns))
    for (const id of Object.keys(previous.trialRuns))
      if (!live.has(id)) tellTrial(id, 'thrown-away')
    const trialBusy = busyTrialRuns(next)
    for (const id of busyTrialRuns(previous)) {
      if (!trialBusy.has(id) && live.has(id)) tellTrial(id, 'settled')
    }
  }

  function answer(payload: ChannelPortAnswer): void {
    if (payload.state) mirror(payload.state)
    const entry = pending.get(payload.requestId)
    if (!entry) return
    pending.delete(payload.requestId)
    if ('error' in payload) entry.reject(new Error(payload.error))
    else entry.resolve(payload.result)
  }

  function reset(reason: string): void {
    state = null
    for (const entry of pending.values()) entry.reject(new Error(reason))
    pending.clear()
  }

  const quoted = (labels: Record<string, string> | undefined, id: string) => labels?.[id] ?? ''

  const port: SessionPort = {
    exists: (sessionRef) => call({ op: 'exists', sessionRef }),
    isReachable: (sessionRef) => call({ op: 'isReachable', sessionRef }),
    listReachable: () => call({ op: 'listReachable' }),
    create: () => call({ op: 'create' }),
    transcript: (sessionRef) => call({ op: 'transcript', sessionRef }),
    lookup: deps.lookup,
    recordStartPromptRequest: deps.recordStartPromptRequest,
    label: (target) =>
      'trialRunSessionId' in target
        ? quoted(state?.labels.trialRuns, target.trialRunSessionId)
        : 'harnessSessionId' in target
          ? quoted(state?.labels.harness, target.harnessSessionId)
          : quoted(state?.labels.sessions, target.sessionRef),
    usesRealShell: ({ harnessSessionId }) => state?.harness[harnessSessionId]?.realShell === true,
    turnTarget: (target) => {
      if ('trialRunSessionId' in target) return target.trialRunSessionId
      if (!('harnessSessionId' in target)) return target.sessionRef
      const assistantOf = state?.harness[target.harnessSessionId]?.assistantOf
      return assistantOf === target.sessionRef ? target.sessionRef : target.harnessSessionId
    },
    attach: (target, file) => call({ op: 'attach', target, file }),
    send: (target, message, origin) => call({ op: 'send', target, message, origin }),
    listStartableAgents: () => call({ op: 'listStartableAgents' }),
    agentName: (agentId) => state?.agentNames[agentId] ?? null,
    startAgent: (sessionRef, agentId, origin, prompt) =>
      call({ op: 'startAgent', sessionRef, agentId, origin, ...(prompt ? { prompt } : {}) }),
    bringIntoView: async (sessionRef, view) => {
      await call({ op: 'bringIntoView', sessionRef, view })
    },
    unpickAgent: async (sessionRef) => {
      await call({ op: 'unpickAgent', sessionRef })
    },
    activity: (sessionRef) => state?.activity[sessionRef] ?? IDLE,
    stop: (sessionRef) => call({ op: 'stop', sessionRef }),
    onSessionChange: (listener) => {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    },
    trialRunLive: (harnessSessionId) => !!state && harnessSessionId in state.trialRuns,
    trialRunActivity: (harnessSessionId) => state?.trialRuns[harnessSessionId] ?? IDLE,
    onTrialRunChange: (listener) => {
      trialRunListeners.add(listener)
      return () => trialRunListeners.delete(listener)
    },
  }

  const speech: ChannelSpeech = {
    prepare: async (adapter, meta) => {
      const prepared = await call({
        op: 'speechPrepare',
        kind: adapter.kind,
        ...(meta ? { meta } : {}),
      })
      if ('ready' in prepared) return prepared
      return { downloading: call({ op: 'speechDownload', token: prepared.downloadToken }) }
    },
    transcribe: (adapter, audio, meta) =>
      call({ op: 'speechTranscribe', kind: adapter.kind, audio, ...(meta ? { meta } : {}) }),
  }

  // A question lives in the window that asked it; whether a message answers one is decided here,
  // from the mirror, and the answer goes back to the window to settle it.
  const questions: Pick<ChannelQuestionRegistry, 'handleInbound'> = {
    handleInbound: (adapter, msg, meta) => {
      const forward = () =>
        void call({
          op: 'questionInbound',
          kind: adapter.kind,
          msg,
          ...(meta ? { meta } : {}),
        }).catch((error: unknown) =>
          deps.log('channels: answering a Channel Question failed:', error),
        )
      if (msg.callback) {
        if (!msg.callback.startsWith('confirm:')) return false
        forward()
        return true
      }
      if (!state?.typedQuestionKinds.includes(adapter.kind)) return false
      forward()
      return parseConfirmationReply(msg.text ?? '') !== null
    },
  }

  return {
    port: () => (state ? port : null),
    speech,
    questions,
    subscribe: async () => {
      await call({ op: 'subscribe' }, deps.subscribeTimeoutMs ?? SUBSCRIBE_TIMEOUT_MS)
    },
    answer,
    mirror,
    reset,
    ready: () => state !== null,
    copy: () => state?.copy ?? null,
  }
}
