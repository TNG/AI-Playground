import { answerRouterCopy, type AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/notificationLabel'
import type { ChannelAdapter } from './adapter'
import type { ChannelQuestionRegistry, InboundAnswer } from './channelQuestions'
import type { ChannelKind, InboundMeta } from './types'

/** How sending an Answer into its session went; `queuePosition` is set while it waits its turn. */
export type AnswerSendResult =
  { ok: true; queuePosition: number | null } | { ok: false; reason: string; message: string }

/** What a paused session waits on: the download buttons in the channel, or the computer. */
export type SessionPause = 'download' | 'desktop'

/** How the turn a Held Answer waits for ended, or what the desktop did to it instead. */
export type SessionTurnEnd = 'completed' | 'failed' | 'stopped' | 'deleted' | 'discarded'

/** A Held Answer as the session shows it on the desktop. */
export type HeldAnswerView = { text: string; channel: ChannelKind }

/** A Held Answer outlives nothing but this note, so the channel hears it was lost. */
export type HeldAnswerNote = { channel: ChannelKind; title: string; meta?: InboundMeta }

/** Where Held Answer notes survive an app close. */
export type HeldAnswerJournal = {
  load: () => HeldAnswerNote[]
  save: (notes: HeldAnswerNote[]) => void
}

/** The agent sessions an Answer can reach; registered by the window's composition file. */
export type AnswerSessions = {
  /** The session that sent this channel message, or null when no agent did. */
  lookup: (kind: ChannelKind, ref: string) => Promise<string | null>
  /** The session's Notification label, quoted (`"Asteroids clone"`, or a Task and its step). */
  label: (sessionId: string) => string
  send: (sessionId: string, text: string) => Promise<AnswerSendResult>
  /** What the session's paused turn waits on, or null when it is not paused. */
  pause: (sessionId: string) => SessionPause | null
  /** The session's Held Answer changed; null when it is gone. */
  held: (sessionId: string, answer: HeldAnswerView | null) => void
  /** Hear every session's turn end and the desktop's discard; returns the unsubscribe. */
  onTurnEnd: (listener: (sessionId: string, end: SessionTurnEnd) => void) => () => void
}

/** An inbound channel message; `replyTo` is the platform id of the message it replies to. */
export type InboundChannelMessage = InboundAnswer & { replyTo?: string }

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
  /** The channel is up: tells it which Held Answers the last app close lost. */
  channelReady: (adapter: ChannelAdapter) => Promise<void>
}

export type AnswerRouterDeps = {
  /** Null until Agent Mode has registered; replies then reach Home Agent as before. */
  sessions: () => AnswerSessions | null
  questions: Pick<ChannelQuestionRegistry, 'handleInbound'>
  copy?: () => AnswerRouterCopy
  /** Defaults to memory only: a lost Held Answer then goes unreported after a restart. */
  journal?: HeldAnswerJournal
  log?: (message: string, error: unknown) => void
}

export function createAnswerRouter(deps: AnswerRouterDeps): AnswerRouter {
  const copy = deps.copy ?? answerRouterCopy
  const log = deps.log ?? ((message, error) => console.error(message, error))
  const journal = deps.journal ?? memoryJournal()

  type Held = {
    adapter: ChannelAdapter
    sessions: AnswerSessions
    text: string
    title: string
    meta?: InboundMeta
  }
  // One per session: a newer Answer replaces the one waiting.
  const held = new Map<string, Held>()
  // Notes from the previous run, reported once their channel is up again.
  let lost = readJournal()
  let unsubscribe: (() => void) | null = null
  let subscribedTo: AnswerSessions | null = null

  function readJournal(): HeldAnswerNote[] {
    try {
      return [...journal.load()]
    } catch (e) {
      log('answerRouter: reading held Answers failed:', e)
      return []
    }
  }

  function writeJournal(): void {
    const notes = [
      ...lost,
      ...[...held.values()].map((h) => ({
        channel: h.adapter.kind,
        title: h.title,
        ...(h.meta ? { meta: h.meta } : {}),
      })),
    ]
    try {
      journal.save(notes)
    } catch (e) {
      log('answerRouter: saving held Answers failed:', e)
    }
  }

  function listen(sessions: AnswerSessions): void {
    if (subscribedTo === sessions) return
    unsubscribe?.()
    subscribedTo = sessions
    unsubscribe = sessions.onTurnEnd((sessionId, end) => void settle(sessionId, end))
  }

  function setHeld(sessionId: string, next: Held | null): void {
    const sessions = next?.sessions ?? held.get(sessionId)?.sessions
    if (next) held.set(sessionId, next)
    else held.delete(sessionId)
    writeJournal()
    sessions?.held(sessionId, next ? { text: next.text, channel: next.adapter.kind } : null)
  }

  async function hold(entry: Held, sessionId: string): Promise<void> {
    listen(entry.sessions)
    const earlier = held.get(sessionId)
    setHeld(sessionId, entry)
    const wording = copy()
    const pause = entry.sessions.pause(sessionId)
    const template =
      pause === 'download'
        ? wording.heldDownload
        : pause === 'desktop'
          ? wording.heldDesktop
          : wording.held
    let confirmation = fillTemplate(template, { title: entry.title })
    if (earlier && earlier.adapter.kind === entry.adapter.kind) {
      confirmation += `\n${wording.heldReplaced}`
    } else if (earlier) {
      const replaced = fillTemplate(wording.heldReplacedElsewhere, { title: earlier.title })
      await tell(earlier.adapter, replaced, earlier.meta)
    }
    await tell(entry.adapter, confirmation, entry.meta)
  }

  async function settle(sessionId: string, end: SessionTurnEnd): Promise<void> {
    const entry = held.get(sessionId)
    if (!entry) return
    if (end === 'completed' || end === 'failed') {
      await deliver(entry, sessionId)
      return
    }
    setHeld(sessionId, null)
    const wording = copy()
    const template = end === 'deleted' ? wording.heldSessionGone : wording.heldDesktopTookOver
    await tell(entry.adapter, fillTemplate(template, { title: entry.title }), entry.meta)
  }

  /** Sends a Held Answer; still busy (a Task run between two Steps) keeps it held. */
  async function deliver(entry: Held, sessionId: string): Promise<void> {
    const result = await send(entry.sessions, sessionId, entry.text)
    if (!result.ok && isHold(result.reason)) return
    if (held.get(sessionId) === entry) setHeld(sessionId, null)
    await confirm(entry.adapter, entry.title, result, entry.meta)
  }

  async function send(
    sessions: AnswerSessions,
    sessionId: string,
    text: string,
  ): Promise<AnswerSendResult> {
    try {
      return await sessions.send(sessionId, text)
    } catch (e) {
      return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }

  async function confirm(
    adapter: ChannelAdapter,
    title: string,
    result: AnswerSendResult,
    meta?: InboundMeta,
  ): Promise<void> {
    const wording = copy()
    if (!result.ok) {
      await tell(adapter, fillTemplate(wording.notSent, { title, reason: result.message }), meta)
    } else if (result.queuePosition !== null) {
      const position = String(result.queuePosition)
      await tell(adapter, fillTemplate(wording.queued, { title, position }), meta)
    } else {
      await tell(adapter, fillTemplate(wording.starting, { title }), meta)
    }
  }

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
    const entry: Held = { adapter, sessions, text, title: sessions.label(sessionId), meta }
    // Sending past a Held Answer would put the newer one first; it replaces it instead.
    if (held.has(sessionId)) return hold(entry, sessionId)
    const result = await send(sessions, sessionId, text)
    if (!result.ok && isHold(result.reason)) return hold(entry, sessionId)
    await confirm(adapter, entry.title, result, meta)
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
        await answer(adapter, sessions, sessionId, text, meta)
        return true
      }
    }
    return deps.questions.handleInbound(adapter, msg, meta)
  }

  async function channelReady(adapter: ChannelAdapter): Promise<void> {
    const notes = lost.filter((note) => note.channel === adapter.kind)
    if (notes.length === 0) return
    lost = lost.filter((note) => note.channel !== adapter.kind)
    writeJournal()
    const template = copy().heldAppClosed
    for (const note of notes) {
      await tell(adapter, fillTemplate(template, { title: note.title }), note.meta)
    }
  }

  return { route, channelReady }
}

/** A session busy with a turn or held by a Task run takes the Answer once that turn ends. */
function isHold(reason: string): boolean {
  return reason === 'busy' || reason === 'task-locked'
}

function memoryJournal(): HeldAnswerJournal {
  let notes: HeldAnswerNote[] = []
  return { load: () => notes, save: (next) => (notes = next) }
}
