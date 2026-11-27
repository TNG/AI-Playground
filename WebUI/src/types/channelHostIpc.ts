import type {
  ChannelKind,
  ChannelPrefs,
  InboundMeta,
  RemoteAudio,
} from '@/assets/js/store/channels/types'
import type {
  AgentStartResult,
  ChannelTarget,
  ChannelTranscriptMessage,
  DesktopView,
  InboundChannelMessage,
  SessionActivity,
  SessionSendResult,
  StartableAgent,
} from '@/assets/js/store/channels/answerRouter'
import type { AttachResult, ChannelFile } from '@/assets/js/store/channels/channelInbound'
import type { QueuedChannelMessage } from '@/assets/js/store/channels/channelQueue'
import type { AnswerRouterCopy } from '@/lib/answerRouterWording'
import type { AgentAnswerOrigin } from '@/types/agentIpc'

/** The Channels as the kernel runs them: one copy, on the machine whose backend polls. */
export type ChannelsState = {
  /** The Home Agent backend is running. */
  available: boolean
  /** The title-bar switch. */
  masterEnabled: boolean
  prefs: Record<ChannelKind, ChannelPrefs>
  /** Fielding remote traffic: available, switched on, enabled and verified. */
  active: Record<ChannelKind, boolean>
}

/** What the Channels' router has queued per Session, and whose batch is being sent. */
export type ChannelQueuesState = {
  queued: Record<string, QueuedChannelMessage[]>
  sending: string[]
}

/** The window's legacy copy of the switch and prefs, taken once when main has none. */
export type ChannelsLegacyState = {
  masterEnabled: boolean
  prefs: Partial<Record<ChannelKind, ChannelPrefs>>
}

/**
 * What the router reads synchronously, mirrored from the window that holds Agent Mode's stores.
 * Every answer to a port call carries a fresh copy, so a send that started a turn is seen as busy.
 */
export type ChannelPortState = {
  existing: string[]
  reachable: string[]
  /** Sessions that are not idle. */
  activity: Record<string, SessionActivity>
  /** Every Trial Run the window still holds, by Harness Session, with what it is doing. */
  trialRuns: Record<string, SessionActivity>
  labels: {
    sessions: Record<string, string>
    harness: Record<string, string>
    trialRuns: Record<string, string>
  }
  /** Harness Sessions: whether they use the real shell, and the Session they are Assistant of. */
  harness: Record<string, { realShell: boolean; assistantOf?: string }>
  agentNames: Record<string, string>
  /** Channels with an open Channel Question that takes a typed yes/no. */
  typedQuestionKinds: ChannelKind[]
  copy: AnswerRouterCopy
}

export type ChannelPortCall =
  | { op: 'subscribe' }
  | { op: 'exists'; sessionRef: string }
  | { op: 'isReachable'; sessionRef: string }
  | { op: 'listReachable' }
  | { op: 'create' }
  | { op: 'transcript'; sessionRef: string }
  | { op: 'attach'; target: ChannelTarget; file: ChannelFile }
  | { op: 'send'; target: ChannelTarget; message: string; origin: AgentAnswerOrigin }
  | { op: 'listStartableAgents' }
  | {
      op: 'startAgent'
      sessionRef: string
      agentId: string
      origin: AgentAnswerOrigin
      prompt?: string
    }
  | { op: 'bringIntoView'; sessionRef: string; view: DesktopView }
  | { op: 'unpickAgent'; sessionRef: string }
  | { op: 'stop'; sessionRef: string }
  | { op: 'speechPrepare'; kind: ChannelKind; meta?: InboundMeta }
  /** Settles when the speech model download `speechPrepare` started has ended. */
  | { op: 'speechDownload'; token: string }
  | { op: 'speechTranscribe'; kind: ChannelKind; audio: RemoteAudio[]; meta?: InboundMeta }
  | { op: 'questionInbound'; kind: ChannelKind; msg: InboundChannelMessage; meta?: InboundMeta }

export type ChannelPortResults = {
  subscribe: null
  exists: boolean
  isReachable: boolean
  listReachable: { sessionRef: string; title: string }[]
  create: string
  transcript: ChannelTranscriptMessage[]
  attach: AttachResult
  send: SessionSendResult
  listStartableAgents: StartableAgent[]
  startAgent: AgentStartResult
  bringIntoView: null
  unpickAgent: null
  stop: SessionActivity
  speechPrepare: { ready: boolean } | { downloadToken: string }
  speechDownload: boolean
  speechTranscribe: string | null
  questionInbound: boolean
}

export type ChannelPortAsk = { requestId: string; call: ChannelPortCall }

export type ChannelPortAnswer = { requestId: string; state?: ChannelPortState } & (
  { result: unknown } | { error: string }
)
