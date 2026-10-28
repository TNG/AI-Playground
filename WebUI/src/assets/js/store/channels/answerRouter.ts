import { answerRouterCopy, type AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/notificationLabel'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { ChannelMessageOwner } from '@/types/notificationsIpc'
import { hasAnswerTyping } from '@/lib/answerButton'
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
  /** The channel's notice for a file it refused to read; still an attachment, so not an Answer. */
  refused?: string
}

export type AnswerRouter = {
  /**
   * Routes one inbound message ahead of Home Agent: a button tap to its Channel Question,
   * a reply to an agent's message to that session, a typed yes/no to an open Home Agent
   * confirmation. False means it is Home Agent's.
   */
  route: (
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ) => Promise<boolean>
  /** The channel is up: tells it which Held Answers the last app close lost. */
  channelReady: (adapter: ChannelAdapter) => Promise<void>
}

/** Speech-to-text for a voice Answer: usable now, refused (the channel was told why), or downloading. */
export type VoiceAnswerPreparation = { ready: boolean } | { downloading: Promise<boolean> }

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
  prepareVoiceAnswer: (
    adapter: ChannelAdapter,
    sessionId: string,
    meta?: InboundMeta,
  ) => Promise<VoiceAnswerPreparation>
  /** The channel an agent's download question is asked on, or null when only the computer asks. */
  downloadQuestionChannel?: () => ChannelKind | null
  copy?: () => AnswerRouterCopy
  /** Defaults to memory only: a lost Held Answer then goes unreported after a restart. */
  journal?: HeldAnswerJournal
  /** Where failures that reach no channel go: the window's error sink. */
  log: (message: string, error: unknown) => void
}

// Refusals the user can only clear on the computer, so the reply says where to go.
const FIXED_ON_DESKTOP = new Set(['missing-folder', 'settings-problems'])

export function createAnswerRouter(deps: AnswerRouterDeps): AnswerRouter {
  const copy = deps.copy ?? answerRouterCopy
  const log = deps.log
  const journal = deps.journal ?? memoryJournal()
  const downloadQuestionChannel = deps.downloadQuestionChannel ?? (() => null)

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
  // First sends still awaiting their result, flagged when the session's turn ends meanwhile.
  const sending = new Map<string, { turnEnded: boolean }>()
  // Per session: Answers queued behind a voice Answer's speech model download, kept in order.
  const waitingBehindDownload = new Map<string, Promise<void>>()
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
        ? downloadHoldTemplate(entry.adapter.kind, wording)
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

  function downloadHoldTemplate(kind: ChannelKind, wording: AnswerRouterCopy): string {
    const askedOn = downloadQuestionChannel()
    if (askedOn === kind) return wording.heldDownload
    return askedOn ? wording.heldDownloadElsewhere : wording.heldDesktop
  }

  async function settle(sessionId: string, end: SessionTurnEnd): Promise<void> {
    const attempt = sending.get(sessionId)
    if (attempt) attempt.turnEnded = true
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
    } else if (!hasAnswerTyping(adapter.kind)) {
      await tell(adapter, fillTemplate(wording.starting, { title }), meta)
    }
  }

  /** A refusal answered after the turn already ended is retried, since no later end would free it. */
  async function firstSend(
    sessions: AnswerSessions,
    sessionId: string,
    text: string,
    origin: AgentAnswerOrigin,
  ): Promise<AnswerSendResult> {
    listen(sessions)
    const attempt = { turnEnded: false }
    sending.set(sessionId, attempt)
    try {
      let result: AnswerSendResult
      do {
        attempt.turnEnded = false
        result = await send(sessions, sessionId, text, origin)
      } while (!result.ok && isHold(result.reason) && attempt.turnEnded)
      return result
    } finally {
      if (sending.get(sessionId) === attempt) sending.delete(sessionId)
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

  // A post, not a reply: a reply would settle a Home Agent answer still streaming.
  async function tell(adapter: ChannelAdapter, text: string, meta?: InboundMeta): Promise<void> {
    await adapter
      .post(adapter.formatMarkdown(text), meta)
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
      const result = await firstSend(sessions, sessionId, text, origin)
      if (!result.ok && isHold(result.reason)) await hold(entry, sessionId)
      else await confirm(adapter, entry.title, result, meta)
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
    if (msg.images?.length || msg.documents?.length || msg.refused) {
      return tell(adapter, copy().textOnly, meta)
    }
    const { sessionId } = owner
    if (sessions.usesRealShell(sessionId)) {
      const title = sessions.label(sessionId)
      return tell(adapter, fillTemplate(copy().realShell, { title }), meta)
    }
    if (waitingBehindDownload.has(sessionId)) {
      afterDownload(sessionId, () => answerMessage(adapter, sessions, sessionId, msg, meta, true))
      return
    }
    await answerMessage(adapter, sessions, sessionId, msg, meta, false)
  }

  /** Runs `work` once the session's earlier Answers are through, off the channel's poll loop. */
  function afterDownload(sessionId: string, work: () => Promise<void>): void {
    const next = (waitingBehindDownload.get(sessionId) ?? Promise.resolve())
      .then(work)
      .catch((e: unknown) => log('answerRouter: voice Answer failed:', e))
    waitingBehindDownload.set(sessionId, next)
    void next.then(() => {
      if (waitingBehindDownload.get(sessionId) === next) waitingBehindDownload.delete(sessionId)
    })
  }

  async function answerMessage(
    adapter: ChannelAdapter,
    sessions: AnswerSessions,
    sessionId: string,
    msg: InboundChannelMessage,
    meta: InboundMeta | undefined,
    queued: boolean,
  ): Promise<void> {
    const audio = msg.audio
    if (!audio?.length || !deps.transcribe) {
      const text = msg.text?.trim() ?? ''
      if (text) await answer(adapter, sessions, sessionId, text, msg.replyTarget, meta)
      return
    }
    const voiceMsg = { ...msg, audio }
    const preparation = await deps.prepareVoiceAnswer(adapter, sessionId, meta)
    if (!('downloading' in preparation)) {
      if (preparation.ready) await answerByVoice(adapter, sessions, sessionId, voiceMsg, meta)
      return
    }
    const { downloading } = preparation
    const finish = async () => {
      if (await downloading) await answerByVoice(adapter, sessions, sessionId, voiceMsg, meta)
    }
    // A download can take minutes: the channel's other messages go on meanwhile.
    if (queued) await finish()
    else afterDownload(sessionId, finish)
  }

  async function answerByVoice(
    adapter: ChannelAdapter,
    sessions: AnswerSessions,
    sessionId: string,
    msg: InboundChannelMessage & { audio: RemoteAudio[] },
    meta?: InboundMeta,
  ): Promise<void> {
    const transcript = await deps.transcribe?.(adapter, msg.audio, meta)
    if (transcript == null) return
    const text = [msg.text?.trim(), transcript.trim()].filter(Boolean).join(' ')
    if (!text) return tell(adapter, copy().noSpeech, meta)
    await answer(adapter, sessions, sessionId, text, msg.replyTarget, meta)
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
        const answerMeta = msg.replyTarget ? { ...meta, threadTs: msg.replyTarget } : meta
        await deliver(adapter, sessions, owner, msg, answerMeta)
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
