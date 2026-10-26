import { answerRouterCopy, type AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/notificationLabel'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { ChannelMessageOwner } from '@/types/notificationsIpc'
import { ANSWER_CALLBACK } from '@/lib/answerButton'
import type { ChannelAdapter } from './adapter'
import type { ChannelQuestionRegistry, InboundAnswer } from './channelQuestions'
import type { ChannelKind, InboundMeta, RemoteAudio, RemoteDocument, RemoteImage } from './types'

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
  lookup: (kind: ChannelKind, ref: string) => Promise<ChannelMessageOwner | null>
  /** The session's Notification label, quoted (`"Asteroids clone"`, or a Task and its step). */
  label: (sessionId: string) => string
  /** The session's folder runs the real system shell, which is never driven from a channel. */
  usesRealShell: (sessionId: string) => boolean
  /** Remembers that a message sent on `kind` belongs to the session, so a reply to it is an Answer. */
  record: (kind: ChannelKind, ref: string, sessionId: string) => Promise<void>
  /** `origin` is where the Answer came from; the turn's result is replied under it. */
  send: (sessionId: string, text: string, origin: AgentAnswerOrigin) => Promise<AnswerSendResult>
  /** What the session's paused turn waits on, or null when it is not paused. */
  pause: (sessionId: string) => SessionPause | null
  /** The session's Held Answer changed; null when it is gone. */
  held: (sessionId: string, answer: HeldAnswerView | null) => void
  /** Hear every session's turn end and the desktop's discard; returns the unsubscribe. */
  onTurnEnd: (listener: (sessionId: string, end: SessionTurnEnd) => void) => () => void
}

/**
 * An inbound channel message: `replyTo` is the platform id of the message it replies
 * to, `replyTarget` the ref a reply to this message names.
 */
export type InboundChannelMessage = InboundAnswer & {
  replyTo?: string
  replyTarget?: string
  images?: RemoteImage[]
  audio?: RemoteAudio[]
  documents?: RemoteDocument[]
}

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
  /** The channel is up: tells it which Held Answers the last app close lost. */
  channelReady: (adapter: ChannelAdapter) => Promise<void>
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
  /** Persisted: whether the channel was already told how answering works. */
  onboarding?: { seen: () => boolean; markSeen: () => void }
  copy?: () => AnswerRouterCopy
  /** Defaults to memory only: a lost Held Answer then goes unreported after a restart. */
  journal?: HeldAnswerJournal
  log?: (message: string, error: unknown) => void
}

// Refusals the user can only clear on the computer, so the reply says where to go.
const FIXED_ON_DESKTOP = new Set(['missing-folder', 'settings-problems'])
// Telegram's input_field_placeholder limit.
const PLACEHOLDER_MAX = 64

function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

export function createAnswerRouter(deps: AnswerRouterDeps): AnswerRouter {
  const copy = deps.copy ?? answerRouterCopy
  const log = deps.log ?? ((message, error) => console.error(message, error))
  const journal = deps.journal ?? memoryJournal()

  type Held = {
    adapter: ChannelAdapter
    sessions: AnswerSessions
    text: string
    origin: AgentAnswerOrigin
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
      await deliverHeld(entry, sessionId)
      return
    }
    setHeld(sessionId, null)
    const wording = copy()
    const template = end === 'deleted' ? wording.heldSessionGone : wording.heldDesktopTookOver
    await tell(entry.adapter, fillTemplate(template, { title: entry.title }), entry.meta)
  }

  /** Sends a Held Answer; still busy (a Task run between two Steps) keeps it held. */
  async function deliverHeld(entry: Held, sessionId: string): Promise<void> {
    const result = await send(entry.sessions, sessionId, entry.text, entry.origin)
    if (!result.ok && isHold(result.reason)) return
    if (held.get(sessionId) === entry) setHeld(sessionId, null)
    await confirm(entry.adapter, entry.title, result, entry.meta)
  }

  async function send(
    sessions: AnswerSessions,
    sessionId: string,
    text: string,
    origin: AgentAnswerOrigin,
  ): Promise<AnswerSendResult> {
    try {
      return await sessions.send(sessionId, text, origin)
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
    replyTarget: string | undefined,
    meta?: InboundMeta,
  ): Promise<void> {
    const origin: AgentAnswerOrigin = {
      channel: adapter.kind,
      ...(replyTarget ? { replyTo: replyTarget } : {}),
    }
    const entry: Held = { adapter, sessions, text, origin, title: sessions.label(sessionId), meta }
    // Sending past a Held Answer would put the newer one first; it replaces it instead.
    if (held.has(sessionId)) {
      await hold(entry, sessionId)
    } else {
      const result = await send(sessions, sessionId, text, origin)
      if (!result.ok && isHold(result.reason)) await hold(entry, sessionId)
      else await confirm(adapter, entry.title, result, meta)
    }
    if (deps.onboarding && !deps.onboarding.seen()) {
      deps.onboarding.markSeen()
      await tell(adapter, copy().onboarding, meta)
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
    if (text) await answer(adapter, sessions, sessionId, text, msg.replyTarget, meta)
  }

  async function openAnswerPrompt(
    adapter: ChannelAdapter,
    tappedRef: string | undefined,
    meta?: InboundMeta,
  ): Promise<void> {
    const sessions = deps.sessions()
    const wording = copy()
    const owner =
      sessions && tappedRef ? await answeredSession(sessions, adapter.kind, tappedRef) : null
    if (!sessions || !owner || 'deletedSession' in owner || !adapter.answerPrompt) {
      await tell(adapter, wording.noSession, meta)
      return
    }
    const { sessionId } = owner
    const title = sessions.label(sessionId)
    if (sessions.usesRealShell(sessionId)) {
      await tell(adapter, fillTemplate(wording.realShell, { title }), meta)
      return
    }
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
    if (sessions && msg.replyTo) {
      const owner = await answeredSession(sessions, adapter.kind, msg.replyTo)
      if (owner) {
        await deliver(adapter, sessions, owner, msg, meta)
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
