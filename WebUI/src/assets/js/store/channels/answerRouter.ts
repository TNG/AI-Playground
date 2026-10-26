import { answerRouterCopy, type AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/notificationLabel'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { ChannelAdapter } from './adapter'
import type { ChannelQuestionRegistry, InboundAnswer } from './channelQuestions'
import type { ChannelKind, InboundMeta } from './types'

/** How sending an Answer into its session went; `queuePosition` is set while it waits its turn. */
export type AnswerSendResult =
  { ok: true; queuePosition: number | null } | { ok: false; reason: string; message: string }

/** The agent sessions an Answer can reach; registered by the window's composition file. */
export type AnswerSessions = {
  /** The session that sent this channel message, or null when no agent did. */
  lookup: (kind: ChannelKind, ref: string) => Promise<string | null>
  /** The session's Notification label, quoted (`"Asteroids clone"`, or a Task and its step). */
  label: (sessionId: string) => string
  /** `origin` is where the Answer came from; the turn's result is replied under it. */
  send: (sessionId: string, text: string, origin: AgentAnswerOrigin) => Promise<AnswerSendResult>
}

/**
 * An inbound channel message: `replyTo` is the platform id of the message it replies
 * to, `replyTarget` the ref a reply to this message names.
 */
export type InboundChannelMessage = InboundAnswer & { replyTo?: string; replyTarget?: string }

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
  copy?: () => AnswerRouterCopy
  log?: (message: string, error: unknown) => void
}

export function createAnswerRouter(deps: AnswerRouterDeps): AnswerRouter {
  const copy = deps.copy ?? answerRouterCopy
  const log = deps.log ?? ((message, error) => console.error(message, error))

  async function answeredSession(
    sessions: AnswerSessions,
    kind: ChannelKind,
    ref: string,
  ): Promise<string | null> {
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
    replyTarget: string | undefined,
    meta?: InboundMeta,
  ): Promise<void> {
    const title = sessions.label(sessionId)
    const wording = copy()
    const origin: AgentAnswerOrigin = {
      channel: adapter.kind,
      ...(replyTarget ? { replyTo: replyTarget } : {}),
    }
    let result: AnswerSendResult
    try {
      result = await sessions.send(sessionId, text, origin)
    } catch (e) {
      result = { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
    }
    if (!result.ok) {
      await tell(adapter, fillTemplate(wording.notSent, { title, reason: result.message }), meta)
    } else if (result.queuePosition !== null) {
      const position = String(result.queuePosition)
      await tell(adapter, fillTemplate(wording.queued, { title, position }), meta)
    } else {
      await tell(adapter, fillTemplate(wording.starting, { title }), meta)
    }
  }

  async function route(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<boolean> {
    if (msg.callback) return deps.questions.handleInbound(adapter, msg, meta)
    const sessions = deps.sessions()
    const text = msg.text?.trim()
    if (sessions && msg.replyTo && text) {
      const sessionId = await answeredSession(sessions, adapter.kind, msg.replyTo)
      if (sessionId) {
        await answer(adapter, sessions, sessionId, text, msg.replyTarget, meta)
        return true
      }
    }
    return deps.questions.handleInbound(adapter, msg, meta)
  }

  return { route }
}
