import { answerRouterCopy, type AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/notificationLabel'
import { ANSWER_CALLBACK } from '@/lib/answerButton'
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
  /** Remembers that a message sent on `kind` belongs to the session, so a reply to it is an Answer. */
  record: (kind: ChannelKind, ref: string, sessionId: string) => Promise<void>
  send: (sessionId: string, text: string) => Promise<AnswerSendResult>
}

/** An inbound channel message; `replyTo` is the platform id of the message it replies to. */
export type InboundChannelMessage = InboundAnswer & { replyTo?: string }

export type AnswerRouter = {
  /**
   * Routes one inbound message ahead of Home Agent: the 💬 Answer button to an
   * Answer Prompt, a button tap to its Channel Question, a reply to an agent's message to that session, a typed yes/no to an
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

// Telegram's input_field_placeholder limit.
const PLACEHOLDER_MAX = 64

function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
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
    if (!result.ok) {
      await tell(adapter, fillTemplate(wording.notSent, { title, reason: result.message }), meta)
    } else if (result.queuePosition !== null) {
      const position = String(result.queuePosition)
      await tell(adapter, fillTemplate(wording.queued, { title, position }), meta)
    } else {
      await tell(adapter, fillTemplate(wording.starting, { title }), meta)
    }
  }

  async function openAnswerPrompt(
    adapter: ChannelAdapter,
    tappedRef: string | undefined,
    meta?: InboundMeta,
  ): Promise<void> {
    const sessions = deps.sessions()
    const wording = copy()
    const sessionId =
      sessions && tappedRef ? await answeredSession(sessions, adapter.kind, tappedRef) : null
    if (!sessions || !sessionId || !adapter.answerPrompt) {
      await tell(adapter, wording.sessionGone, meta)
      return
    }
    const title = sessions.label(sessionId)
    const placeholder = clip(fillTemplate(wording.answerPlaceholder, { title }), PLACEHOLDER_MAX)
    try {
      const sent = await adapter.answerPrompt(
        adapter.formatMarkdown(fillTemplate(wording.answerPrompt, { title })),
        placeholder,
        meta,
      )
      const ref = sent.ref?.messageId?.toString() ?? sent.ref?.ts
      if (!sent.success || !ref) throw new Error(sent.error ?? 'no message reference')
      await sessions.record(adapter.kind, ref, sessionId)
    } catch (e) {
      log('answerRouter: Answer Prompt failed:', e)
    }
  }

  async function route(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<boolean> {
    if (msg.callback === ANSWER_CALLBACK) {
      await openAnswerPrompt(adapter, msg.replyTo, meta)
      return true
    }
    if (msg.callback) return deps.questions.handleInbound(adapter, msg, meta)
    const sessions = deps.sessions()
    const text = msg.text?.trim()
    if (sessions && msg.replyTo && text) {
      const sessionId = await answeredSession(sessions, adapter.kind, msg.replyTo)
      if (sessionId) {
        await answer(adapter, sessions, sessionId, text, meta)
        return true
      }
    }
    return deps.questions.handleInbound(adapter, msg, meta)
  }

  return { route }
}
