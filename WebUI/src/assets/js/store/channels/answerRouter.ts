import { answerRouterCopy, type AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/fillTemplate'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { AnswerTarget, ChannelMessageOwner } from '@/types/notificationsIpc'
import { hasAnswerTyping } from '@/lib/answerButton'
import type { ChannelAdapter } from './adapter'
import type { ChannelQuestionRegistry, InboundAnswer } from './channelQuestions'
import type { ChannelKind, InboundMeta, RemoteAudio, RemoteDocument, RemoteImage } from './types'

/** How sending into a Session went; `queuePosition` is set while it waits its turn. */
export type SessionSendResult =
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

/** The Sessions a channel reaches, keyed by Session (`docs/adr/0010`); registered by the window. */
export type SessionPort = {
  /** The Session and Harness Session that sent this channel message, or null when none did. */
  lookup: (kind: ChannelKind, ref: string) => Promise<ChannelMessageOwner | null>
  /** The Notification label, quoted (`"Asteroids clone"`, or a Task and its step). */
  label: (target: AnswerTarget) => string
  /** The folder runs the real system shell, which is never driven from a channel. */
  usesRealShell: (target: AnswerTarget) => boolean
  /** `origin` is where the message came from; the turn's result is replied under it. */
  send: (
    target: AnswerTarget,
    message: string,
    origin: AgentAnswerOrigin,
  ) => Promise<SessionSendResult>
  /** What the target's paused turn waits on, or null when it is not paused. */
  pause: (target: AnswerTarget) => SessionPause | null
  /** The target's Held Answer changed; null when it is gone. */
  held: (target: AnswerTarget, answer: HeldAnswerView | null) => void
  /** Hear every Harness Session's turn end and the desktop's discard; returns the unsubscribe. */
  onTurnEnd: (listener: (harnessSessionId: string, end: SessionTurnEnd) => void) => () => void
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
  sessions: () => SessionPort | null
  questions: Pick<ChannelQuestionRegistry, 'handleInbound'>
  /** Home Agent's speech-to-text; null means it failed and already told the channel why. */
  transcribe?: (
    adapter: ChannelAdapter,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ) => Promise<string | null>
  prepareVoiceAnswer: (
    adapter: ChannelAdapter,
    harnessSessionId: string,
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
    sessions: SessionPort
    target: AnswerTarget
    text: string
    origin: AgentAnswerOrigin
    title: string
    meta?: InboundMeta
  }
  // These three are keyed by Harness Session id.
  // One per Harness Session: a newer Answer replaces the one waiting.
  const held = new Map<string, Held>()
  // First sends still awaiting their result, flagged when the turn ends meanwhile.
  const sending = new Map<string, { turnEnded: boolean }>()
  // Answers queued behind a voice Answer's speech model download, kept in order.
  const waitingBehindDownload = new Map<string, Promise<void>>()
  // Notes from the previous run, reported once their channel is up again.
  let lost = readJournal()
  let unsubscribe: (() => void) | null = null
  let subscribedTo: SessionPort | null = null

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

  function listen(sessions: SessionPort): void {
    if (subscribedTo === sessions) return
    unsubscribe?.()
    subscribedTo = sessions
    unsubscribe = sessions.onTurnEnd((harnessSessionId, end) => void settle(harnessSessionId, end))
  }

  function setHeld(target: AnswerTarget, next: Held | null): void {
    const key = target.harnessSessionId
    const sessions = next?.sessions ?? held.get(key)?.sessions
    if (next) held.set(key, next)
    else held.delete(key)
    writeJournal()
    sessions?.held(target, next ? { text: next.text, channel: next.adapter.kind } : null)
  }

  async function hold(entry: Held): Promise<void> {
    listen(entry.sessions)
    const earlier = held.get(entry.target.harnessSessionId)
    setHeld(entry.target, entry)
    const wording = copy()
    const pause = entry.sessions.pause(entry.target)
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

  async function settle(harnessSessionId: string, end: SessionTurnEnd): Promise<void> {
    const attempt = sending.get(harnessSessionId)
    if (attempt) attempt.turnEnded = true
    const entry = held.get(harnessSessionId)
    if (!entry) return
    if (end === 'completed' || end === 'failed') {
      await deliverHeld(entry)
      return
    }
    setHeld(entry.target, null)
    const wording = copy()
    const template = end === 'deleted' ? wording.heldSessionGone : wording.heldDesktopTookOver
    await tell(entry.adapter, fillTemplate(template, { title: entry.title }), entry.meta)
  }

  /** Sends a Held Answer; still busy (a Task run between two Steps) keeps it held. */
  async function deliverHeld(entry: Held): Promise<void> {
    const result = await send(entry.sessions, entry.target, entry.text, entry.origin)
    if (!result.ok && isHold(result.reason)) return
    if (held.get(entry.target.harnessSessionId) === entry) setHeld(entry.target, null)
    await confirm(entry.adapter, entry.title, result, entry.meta)
  }

  async function send(
    sessions: SessionPort,
    target: AnswerTarget,
    text: string,
    origin: AgentAnswerOrigin,
  ): Promise<SessionSendResult> {
    try {
      return await sessions.send(target, text, origin)
    } catch (e) {
      return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }

  async function confirm(
    adapter: ChannelAdapter,
    title: string,
    result: SessionSendResult,
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
    sessions: SessionPort,
    target: AnswerTarget,
    text: string,
    origin: AgentAnswerOrigin,
  ): Promise<SessionSendResult> {
    listen(sessions)
    const key = target.harnessSessionId
    const attempt = { turnEnded: false }
    sending.set(key, attempt)
    try {
      let result: SessionSendResult
      do {
        attempt.turnEnded = false
        result = await send(sessions, target, text, origin)
      } while (!result.ok && isHold(result.reason) && attempt.turnEnded)
      return result
    } finally {
      if (sending.get(key) === attempt) sending.delete(key)
    }
  }

  async function answeredSession(
    sessions: SessionPort,
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
    sessions: SessionPort,
    target: AnswerTarget,
    text: string,
    replyTarget: string | undefined,
    meta?: InboundMeta,
  ): Promise<void> {
    const origin: AgentAnswerOrigin = {
      channel: adapter.kind,
      ...(replyTarget ? { replyTo: replyTarget } : {}),
    }
    const title = sessions.label(target)
    const entry: Held = { adapter, sessions, target, text, origin, title, meta }
    // Sending past a Held Answer would put the newer one first; it replaces it instead.
    if (held.has(target.harnessSessionId)) {
      await hold(entry)
    } else {
      const result = await firstSend(sessions, target, text, origin)
      if (!result.ok && isHold(result.reason)) await hold(entry)
      else await confirm(adapter, entry.title, result, meta)
    }
  }

  async function deliver(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    owner: ChannelMessageOwner,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<void> {
    if ('deletedSession' in owner) return tell(adapter, copy().noSession, meta)
    if (msg.images?.length || msg.documents?.length || msg.refused) {
      return tell(adapter, copy().textOnly, meta)
    }
    const target: AnswerTarget = {
      sessionRef: owner.sessionRef,
      harnessSessionId: owner.harnessSessionId,
    }
    if (sessions.usesRealShell(target)) {
      const title = sessions.label(target)
      return tell(adapter, fillTemplate(copy().realShell, { title }), meta)
    }
    if (waitingBehindDownload.has(target.harnessSessionId)) {
      afterDownload(target, () => answerMessage(adapter, sessions, target, msg, meta, true))
      return
    }
    await answerMessage(adapter, sessions, target, msg, meta, false)
  }

  /** Runs `work` once the target's earlier Answers are through, off the channel's poll loop. */
  function afterDownload(target: AnswerTarget, work: () => Promise<void>): void {
    const key = target.harnessSessionId
    const next = (waitingBehindDownload.get(key) ?? Promise.resolve())
      .then(work)
      .catch((e: unknown) => log('answerRouter: voice Answer failed:', e))
    waitingBehindDownload.set(key, next)
    void next.then(() => {
      if (waitingBehindDownload.get(key) === next) waitingBehindDownload.delete(key)
    })
  }

  async function answerMessage(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    target: AnswerTarget,
    msg: InboundChannelMessage,
    meta: InboundMeta | undefined,
    queued: boolean,
  ): Promise<void> {
    const audio = msg.audio
    if (!audio?.length || !deps.transcribe) {
      const text = msg.text?.trim() ?? ''
      if (text) await answer(adapter, sessions, target, text, msg.replyTarget, meta)
      return
    }
    const voiceMsg = { ...msg, audio }
    const preparation = await deps.prepareVoiceAnswer(adapter, target.harnessSessionId, meta)
    if (!('downloading' in preparation)) {
      if (preparation.ready) await answerByVoice(adapter, sessions, target, voiceMsg, meta)
      return
    }
    const { downloading } = preparation
    const finish = async () => {
      if (await downloading) await answerByVoice(adapter, sessions, target, voiceMsg, meta)
    }
    // A download can take minutes: the channel's other messages go on meanwhile.
    if (queued) await finish()
    else afterDownload(target, finish)
  }

  async function answerByVoice(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    target: AnswerTarget,
    msg: InboundChannelMessage & { audio: RemoteAudio[] },
    meta?: InboundMeta,
  ): Promise<void> {
    const transcript = await deps.transcribe?.(adapter, msg.audio, meta)
    if (transcript == null) return
    const text = [msg.text?.trim(), transcript.trim()].filter(Boolean).join(' ')
    if (!text) return tell(adapter, copy().noSpeech, meta)
    await answer(adapter, sessions, target, text, msg.replyTarget, meta)
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
