import { answerRouterCopy, type AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/notificationLabel'
import type { ChannelMessageOwner } from '@/types/notificationsIpc'
import type { ChannelAdapter } from './adapter'
import type { ChannelQuestionRegistry, InboundAnswer } from './channelQuestions'
import type { ChannelKind, InboundMeta, RemoteAudio, RemoteDocument, RemoteImage } from './types'

/** How sending an Answer into its session went; `queuePosition` is set while it waits its turn. */
export type AnswerSendResult =
  { ok: true; queuePosition: number | null } | { ok: false; reason: string; message: string }

/** The agent sessions an Answer can reach; registered by the window's composition file. */
export type AnswerSessions = {
  /** The session that sent this channel message, or null when no agent did. */
  lookup: (kind: ChannelKind, ref: string) => Promise<ChannelMessageOwner | null>
  /** The session's Notification label, quoted (`"Asteroids clone"`, or a Task and its step). */
  label: (sessionId: string) => string
  /** The session's folder runs the real system shell, which is never driven from a channel. */
  usesRealShell: (sessionId: string) => boolean
  send: (sessionId: string, text: string) => Promise<AnswerSendResult>
}

/** An inbound channel message; `replyTo` is the platform id of the message it replies to. */
export type InboundChannelMessage = InboundAnswer & {
  replyTo?: string
  images?: RemoteImage[]
  audio?: RemoteAudio[]
  documents?: RemoteDocument[]
}

export type AnswerRouter = {
  /**
   * Routes one inbound message ahead of Home Agent: a button tap to its Channel
   * Question, a reply to an agent's message to that session, a typed yes/no to an
   * open Home Agent confirmation. False means it is Home Agent's.
   */
  route: (
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ) => Promise<boolean>
}

export type AnswerRouterDeps = {
  /** Null until Agent Mode has registered; replies then reach Home Agent as before. */
  sessions: () => AnswerSessions | null
  questions: Pick<ChannelQuestionRegistry, 'handleInbound'>
  /** Home Agent's speech-to-text; null means it failed and already told the channel why. */
  transcribe?: (
    adapter: ChannelAdapter,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ) => Promise<string | null>
  copy?: () => AnswerRouterCopy
  log?: (message: string, error: unknown) => void
}

// Refusals the user can only clear on the computer, so the reply says where to go.
const FIXED_ON_DESKTOP = new Set(['missing-folder', 'settings-problems'])

export function createAnswerRouter(deps: AnswerRouterDeps): AnswerRouter {
  const copy = deps.copy ?? answerRouterCopy
  const log = deps.log ?? ((message, error) => console.error(message, error))

  async function answeredSession(
    sessions: AnswerSessions,
    kind: ChannelKind,
    ref: string,
  ): Promise<ChannelMessageOwner | null> {
    try {
      return await sessions.lookup(kind, ref)
    } catch (e) {
      log('answerRouter: message lookup failed:', e)
      return null
    }
  }

  async function tell(adapter: ChannelAdapter, text: string, meta?: InboundMeta): Promise<void> {
    await adapter
      .reply(adapter.formatMarkdown(text), meta)
      .catch((e: unknown) => log('answerRouter: confirmation failed:', e))
  }

  async function answer(
    adapter: ChannelAdapter,
    sessions: AnswerSessions,
    sessionId: string,
    text: string,
    meta?: InboundMeta,
  ): Promise<void> {
    const title = sessions.label(sessionId)
    const wording = copy()
    let result: AnswerSendResult
    try {
      result = await sessions.send(sessionId, text)
    } catch (e) {
      result = { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
    }
    if (!result.ok && result.reason === 'no-session') {
      await tell(adapter, wording.noSession, meta)
    } else if (!result.ok) {
      const notSent = fillTemplate(wording.notSent, { title, reason: result.message })
      const fixable = FIXED_ON_DESKTOP.has(result.reason)
      await tell(adapter, fixable ? `${notSent}\n${wording.fixOnDesktop}` : notSent, meta)
    } else if (result.queuePosition !== null) {
      const position = String(result.queuePosition)
      await tell(adapter, fillTemplate(wording.queued, { title, position }), meta)
    } else {
      await tell(adapter, fillTemplate(wording.starting, { title }), meta)
    }
  }

  async function deliver(
    adapter: ChannelAdapter,
    sessions: AnswerSessions,
    owner: ChannelMessageOwner,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<void> {
    if ('deletedSession' in owner) return tell(adapter, copy().noSession, meta)
    if (msg.images?.length || msg.documents?.length) {
      return tell(adapter, copy().textOnly, meta)
    }
    const { sessionId } = owner
    if (sessions.usesRealShell(sessionId)) {
      const title = sessions.label(sessionId)
      return tell(adapter, fillTemplate(copy().realShell, { title }), meta)
    }
    let text = msg.text?.trim() ?? ''
    if (msg.audio?.length && deps.transcribe) {
      const transcript = await deps.transcribe(adapter, msg.audio, meta)
      if (transcript === null) return
      text = [text, transcript.trim()].filter(Boolean).join(' ')
      if (!text) return tell(adapter, copy().noSpeech, meta)
    }
    if (text) await answer(adapter, sessions, sessionId, text, meta)
  }

  async function route(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<boolean> {
    if (msg.callback) return deps.questions.handleInbound(adapter, msg, meta)
    const sessions = deps.sessions()
    if (sessions && msg.replyTo) {
      const owner = await answeredSession(sessions, adapter.kind, msg.replyTo)
      if (owner) {
        await deliver(adapter, sessions, owner, msg, meta)
        return true
      }
    }
    return deps.questions.handleInbound(adapter, msg, meta)
  }

  return { route }
}
