import { answerRouterCopy, type AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/fillTemplate'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { AnswerTarget, ChannelMessageOwner } from '@/types/notificationsIpc'
import {
  ANSWER_CALLBACK,
  answerGesture,
  GESTURE_WORDING,
  hasAnswerTyping,
} from '@/lib/answerButton'
import type { ChannelAdapter, RawPart } from './adapter'
import { helpText, parseCommand, type ChannelCommand } from './channelCommands'
import type { ChannelQuestionRegistry, InboundAnswer } from './channelQuestions'
import {
  attachedPrompt,
  fileRefusal,
  inboundOrigin,
  type AttachResult,
  type ChannelFile,
} from './channelInbound'
import { createChannelSessions } from './channelSessions'
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

/** A plain message goes to the Session's Assistant; an Answer to the Harness Session that asked. */
export type SessionTarget = { sessionRef: string } | AnswerTarget

/** One message of a Session's transcript, for repainting a Channel that keeps no history. */
export type ChannelTranscriptMessage = { role: 'user' | 'assistant'; parts: RawPart[] }

/** Each Channel's Channel Session, kept by the window across restarts. */
export type ChannelSessionPointers = {
  get: (kind: ChannelKind) => string | null
  set: (kind: ChannelKind, sessionRef: string | null) => void
}

/** The Sessions a channel reaches, keyed by Session (`docs/adr/0010`); registered by the window. */
export type SessionPort = {
  /** The Session has not been deleted. */
  exists: (sessionRef: string) => Promise<boolean>
  /** The Session exists and is a Reachable Session; nothing else is ever driven from a channel. */
  isReachable: (sessionRef: string) => Promise<boolean>
  /** The Reachable Sessions, newest first; an untitled one has an empty title. */
  listReachable: () => Promise<{ sessionRef: string; title: string }[]>
  /** A new Reachable Session, not opened on the desktop; throws when it could not be made. */
  create: () => Promise<string>
  transcript: (sessionRef: string) => Promise<ChannelTranscriptMessage[]>
  /** The Session and Harness Session that sent this channel message, or null when none did. */
  lookup: (kind: ChannelKind, ref: string) => Promise<ChannelMessageOwner | null>
  /** The label, quoted (`"Asteroids clone"`, or a Task and its step for an Answer). */
  label: (target: SessionTarget) => string
  /** The folder runs the real system shell, which is never driven from a channel. */
  usesRealShell: (target: AnswerTarget) => boolean
  /**
   * Stores an image in the attachments of the target's workspace, or a document there as an
   * Attached Document; an image is refused when the target's model cannot see images.
   */
  attach: (target: SessionTarget, file: ChannelFile) => Promise<AttachResult>
  /**
   * `origin` is where the message came from; the turn's result is replied under it. A plain
   * message runs in the Session's Assistant Harness Session, minted on first use.
   */
  send: (
    target: SessionTarget,
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
  /** The channel's notice for a file it refused to read. */
  refused?: string
  /** The text was spoken: a voice message, transcribed. */
  voice?: boolean
}

export type AnswerRouter = {
  /**
   * Routes everything a Channel sends: a button tap to its Channel Question or command, a
   * command, a reply to a Session's message to that Harness Session as an Answer, a typed yes/no
   * to an open confirmation, and anything else to the Channel's Channel Session.
   */
  route: (adapter: ChannelAdapter, msg: InboundChannelMessage, meta?: InboundMeta) => Promise<void>
  /** The channel is up: tells it which Held Answers the last app close lost. */
  channelReady: (adapter: ChannelAdapter) => Promise<void>
}

/** Speech-to-text for a voice message: usable now, refused (the channel was told why), or downloading. */
export type VoicePreparation = { ready: boolean } | { downloading: Promise<boolean> }

/** A Channel's speech-to-text; a null transcript means it failed and already told the channel why. */
export type ChannelSpeech = {
  prepare: (adapter: ChannelAdapter, meta?: InboundMeta) => Promise<VoicePreparation>
  transcribe: (
    adapter: ChannelAdapter,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ) => Promise<string | null>
}

export type AnswerRouterDeps = {
  /** Null until the window has registered it; messages are dropped until then. */
  sessions: () => SessionPort | null
  pointers: ChannelSessionPointers
  questions: Pick<ChannelQuestionRegistry, 'handleInbound'>
  /** Voice messages are dropped without it. */
  speech?: ChannelSpeech
  /** The Channels an agent's download question is asked on; empty when only the computer asks. */
  downloadQuestionChannels?: () => readonly ChannelKind[]
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
  const downloadQuestionChannels = deps.downloadQuestionChannels ?? (() => [])

  type Held = {
    adapter: ChannelAdapter
    sessions: SessionPort
    target: AnswerTarget
    text: string
    origin: AgentAnswerOrigin
    title: string
    meta?: InboundMeta
  }
  // These two are keyed by Harness Session id.
  // One per Harness Session: a newer Answer replaces the one waiting.
  const held = new Map<string, Held>()
  // First sends still awaiting their result, flagged when the turn ends meanwhile.
  const sending = new Map<string, { turnEnded: boolean }>()
  // Per Channel: its messages behind a voice message whose speech model downloads, in order.
  const waitingForSpeech = new Map<ChannelKind, Promise<void>>()
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
    const askedOn = downloadQuestionChannels()
    if (askedOn.includes(kind)) return wording.heldDownload
    return askedOn.length > 0 ? wording.heldDownloadElsewhere : wording.heldDesktop
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
    target: SessionTarget,
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
    origin: AgentAnswerOrigin,
    meta?: InboundMeta,
  ): Promise<void> {
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
    if ('deletedSession' in owner || !(await sessions.exists(owner.sessionRef))) {
      return tell(adapter, copy().noSession, meta)
    }
    const target: AnswerTarget = {
      sessionRef: owner.sessionRef,
      harnessSessionId: owner.harnessSessionId,
    }
    if (!(await sessions.isReachable(target.sessionRef))) {
      const title = sessions.label(target)
      return tell(adapter, fillTemplate(copy().unreachable, { title }), meta)
    }
    if (sessions.usesRealShell(target)) {
      const title = sessions.label(target)
      return tell(adapter, fillTemplate(copy().realShell, { title }), meta)
    }
    const prompt = await attachedPrompt({ copy, tell }, sessions, adapter, target, msg, meta)
    if (prompt === null) return
    await answer(adapter, sessions, target, prompt, inboundOrigin(adapter.kind, msg), meta)
  }

  function channelSessions(sessions: SessionPort) {
    return createChannelSessions({
      port: sessions,
      pointers: deps.pointers,
      copy,
      tell,
      confirm,
      send: (target, text, origin) => send(sessions, target, text, origin),
      attach: (adapter, target, msg, meta) =>
        attachedPrompt({ copy, tell }, sessions, adapter, target, msg, meta),
      log,
    })
  }

  function helpCommand(commands: () => ChannelCommand[]): ChannelCommand {
    return {
      name: 'help',
      usage: '/help',
      describe: (wording) => wording.helpHelp,
      run: async ({ adapter, meta }) => {
        const wording = copy()
        const gesture = answerGesture(adapter.kind)
        const answering = gesture ? wording[GESTURE_WORDING[gesture].help] : null
        await tell(adapter, helpText(commands(), wording, answering), meta)
      },
    }
  }

  async function runCommand(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<boolean> {
    const parsed = parseCommand(msg.text ?? '')
    if (!parsed) return false
    const own = channelSessions(sessions).commands
    const commands: ChannelCommand[] = [...own, helpCommand(() => commands)]
    const command = commands.find((entry) => entry.name === parsed.name.toLowerCase())
    if (!command) {
      const unknown = fillTemplate(copy().unknownCommand, { command: `/${parsed.name}` })
      await tell(adapter, unknown, meta)
      return true
    }
    await command.run({ adapter, msg, meta, args: parsed.args })
    return true
  }

  async function runCallback(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<boolean> {
    const data = msg.callback ?? ''
    const callback = channelSessions(sessions).callbacks.find((entry) =>
      data.startsWith(entry.prefix),
    )
    if (!callback) return false
    await callback.run({ adapter, msg, meta }, data.slice(callback.prefix.length))
    return true
  }

  async function route(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<void> {
    const sessions = deps.sessions()
    if (msg.callback) {
      if (msg.callback === ANSWER_CALLBACK) return
      if (sessions && (await runCallback(adapter, sessions, msg, meta))) return
      await deps.questions.handleInbound(adapter, msg, meta)
      return
    }
    if (!sessions) {
      log('answerRouter: a channel message arrived before Sessions were reachable', null)
      return
    }
    if (waitingForSpeech.has(adapter.kind)) {
      // A typed answer to the download question cannot wait behind that download.
      if (deps.questions.handleInbound(adapter, msg, meta)) return
      afterSpeech(adapter.kind, () => inbound(adapter, sessions, msg, meta, true))
      return
    }
    await inbound(adapter, sessions, msg, meta, false)
  }

  /** Runs `work` once the Channel's earlier messages are through, off the channel's poll loop. */
  function afterSpeech(kind: ChannelKind, work: () => Promise<void>): void {
    const next = (waitingForSpeech.get(kind) ?? Promise.resolve())
      .then(work)
      .catch((e: unknown) => log('answerRouter: a message behind a voice message failed:', e))
    waitingForSpeech.set(kind, next)
    void next.then(() => {
      if (waitingForSpeech.get(kind) === next) waitingForSpeech.delete(kind)
    })
  }

  /** Refuses files no Session takes and transcribes voice, then routes it like typed text. */
  async function inbound(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    meta: InboundMeta | undefined,
    waiting: boolean,
  ): Promise<void> {
    const refusal = fileRefusal(adapter.kind, msg, copy())
    if (refusal) return tell(adapter, refusal, meta)
    const { audio, ...rest } = msg
    if (!audio?.length || !deps.speech) return dispatch(adapter, sessions, rest, meta)
    const spoken = (clips: RemoteAudio[]) => byVoice(adapter, sessions, rest, clips, meta)
    const preparation = await deps.speech.prepare(adapter, meta)
    if (!('downloading' in preparation)) {
      if (preparation.ready) await spoken(audio)
      return
    }
    const { downloading } = preparation
    const finish = async () => {
      if (await downloading) await spoken(audio)
    }
    // A download can take minutes, and its question is answered through this very poll loop.
    if (waiting) await finish()
    else afterSpeech(adapter.kind, finish)
  }

  async function byVoice(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ): Promise<void> {
    const transcript = await deps.speech?.transcribe(adapter, audio, meta)
    if (transcript == null) return
    const text = [msg.text?.trim(), transcript.trim()].filter(Boolean).join(' ')
    if (!text) return tell(adapter, copy().noSpeech, meta)
    await dispatch(adapter, sessions, { ...msg, text, voice: true }, meta)
  }

  async function dispatch(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<void> {
    if (await runCommand(adapter, sessions, msg, meta)) return
    if (msg.replyTo) {
      const owner = await answeredSession(sessions, adapter.kind, msg.replyTo)
      if (owner) {
        const answerMeta = msg.replyTarget ? { ...meta, threadTs: msg.replyTarget } : meta
        await deliver(adapter, sessions, owner, msg, answerMeta)
        return
      }
    }
    if (await deps.questions.handleInbound(adapter, msg, meta)) return
    await channelSessions(sessions).plainMessage(adapter, msg, meta)
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
