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
import {
  CHANNEL_QUEUE_LIMIT,
  combineMessages,
  createChannelQueue,
  type ChannelTurnMessage,
  type QueuedChannelMessage,
  type QueuedEntry,
} from './channelQueue'
import { createChannelSessions } from './channelSessions'
import type { ChannelKind, InboundMeta, RemoteAudio, RemoteDocument, RemoteImage } from './types'

/** How sending into a Session went; `queuePosition` is set while it waits its turn. */
export type SessionSendResult =
  { ok: true; queuePosition: number | null } | { ok: false; reason: string; message: string }

/** What a paused turn waits on: the download buttons in the channel, or the computer. */
export type SessionPause = 'download' | 'desktop'

/** What a Session is busy with: a queued message waits for it to end. */
export type SessionActivity =
  | { kind: 'idle' }
  | { kind: 'turn'; paused?: SessionPause }
  | { kind: 'agent-run'; name: string; step: number; steps: number }

/** The Session's turn and Agent Run are over, or it can no longer take queued messages. */
export type SessionChange = 'settled' | 'unreachable' | 'deleted'

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
  /** The Session's turn in flight, or its Agent Run (also between Steps). */
  activity: (sessionRef: string) => SessionActivity
  /** Stops the Session's turn or Agent Run, the run's next Step included; returns what it was. */
  stop: (sessionRef: string) => Promise<SessionActivity>
  /** Hear each Session settle, become unreachable or be deleted; returns the unsubscribe. */
  onSessionChange: (listener: (sessionRef: string, change: SessionChange) => void) => () => void
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
  /** Each Session's queued messages as they change, for its timeline and In-flight Work. */
  publishQueue?: (sessionRef: string, queued: QueuedChannelMessage[]) => void
  /** Where failures that reach no channel go: the window's error sink. */
  log: (message: string, error: unknown) => void
}

// Refusals the user can only clear on the computer, so the reply says where to go.
const FIXED_ON_DESKTOP = new Set(['missing-folder', 'settings-problems'])

/** A message waiting for its Session's turn or Agent Run to end. */
type QueuedMessage = {
  adapter: ChannelAdapter
  target: SessionTarget
  message: ChannelTurnMessage
  origin: AgentAnswerOrigin
  meta?: InboundMeta
}

export function createAnswerRouter(deps: AnswerRouterDeps): AnswerRouter {
  const copy = deps.copy ?? answerRouterCopy
  const log = deps.log
  const downloadQuestionChannels = deps.downloadQuestionChannels ?? (() => [])

  const queue = createChannelQueue<QueuedMessage>({ onChange: deps.publishQueue })
  // Sessions whose next queued batch is being sent.
  const draining = new Set<string>()
  // Per Channel: its messages behind a voice message whose speech model downloads, in order.
  const waitingForSpeech = new Map<ChannelKind, Promise<void>>()
  let unsubscribe: (() => void) | null = null
  let subscribedTo: SessionPort | null = null

  function listen(sessions: SessionPort): void {
    if (subscribedTo === sessions) return
    unsubscribe?.()
    subscribedTo = sessions
    unsubscribe = sessions.onSessionChange((sessionRef, change) => {
      if (change === 'settled') void drain(sessions, sessionRef)
      else void dropQueue(sessions, sessionRef, change)
    })
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

  /** Sends a Channel's message into its Session, or queues it while the Session is busy. */
  async function submit(sessions: SessionPort, entry: QueuedMessage): Promise<void> {
    listen(sessions)
    const { sessionRef } = entry.target
    if (
      queue.size(sessionRef) > 0 ||
      draining.has(sessionRef) ||
      sessions.activity(sessionRef).kind !== 'idle'
    ) {
      return enqueue(sessions, entry)
    }
    const result = await send(sessions, entry.target, entry.message.text, entry.origin)
    if (!result.ok && isBusy(result.reason)) return enqueue(sessions, entry)
    await confirm(entry.adapter, sessions.label(entry.target), result, entry.meta)
  }

  async function enqueue(sessions: SessionPort, entry: QueuedMessage): Promise<void> {
    const { sessionRef } = entry.target
    const wording = copy()
    const title = sessions.label(entry.target)
    const position = queue.add(sessionRef, {
      channel: entry.adapter.kind,
      batchKey: 'harnessSessionId' in entry.target ? entry.target.harnessSessionId : sessionRef,
      preview: entry.message.text,
      item: entry,
    })
    if (position === null) {
      const full = fillTemplate(wording.queueFull, { title, limit: CHANNEL_QUEUE_LIMIT })
      return tell(entry.adapter, full, entry.meta)
    }
    const activity = sessions.activity(sessionRef)
    const waitingFor =
      activity.kind === 'agent-run'
        ? fillTemplate(wording.queueAfterAgentRun, {
            name: activity.name,
            step: activity.step,
            steps: activity.steps,
          })
        : wording.queueAfterTurn
    const ack = fillTemplate(wording.queuedMessage, {
      position: wording.ordinal(position),
      title,
      waitingFor,
    })
    const pause = activity.kind === 'turn' ? activity.paused : undefined
    const pauseLine = pause ? pauseNote(pause, entry.adapter.kind, wording) : null
    await tell(entry.adapter, pauseLine ? `${ack}\n${pauseLine}` : ack, entry.meta)
    // The Session may have settled while the message was refused or acknowledged.
    await drain(sessions, sessionRef)
  }

  function pauseNote(pause: SessionPause, kind: ChannelKind, wording: AnswerRouterCopy): string {
    if (pause === 'desktop') return wording.queueWaitsDesktop
    const askedOn = downloadQuestionChannels()
    if (askedOn.includes(kind)) return wording.queueWaitsDownload
    return askedOn.length > 0 ? wording.queueWaitsDownloadElsewhere : wording.queueWaitsDesktop
  }

  /** Runs the oldest Channel's queued messages as one turn once the Session is idle. */
  async function drain(sessions: SessionPort, sessionRef: string): Promise<void> {
    while (!draining.has(sessionRef) && sessions.activity(sessionRef).kind === 'idle') {
      const batch = queue.takeBatch(sessionRef)
      if (batch.length === 0) return
      draining.add(sessionRef)
      try {
        const busy = await sendBatch(sessions, sessionRef, batch)
        if (busy) return
      } finally {
        draining.delete(sessionRef)
      }
    }
  }

  /** True when the Session turned out busy and the batch went back to wait for it. */
  async function sendBatch(
    sessions: SessionPort,
    sessionRef: string,
    batch: QueuedEntry<QueuedMessage>[],
  ): Promise<boolean> {
    const last = batch[batch.length - 1].item
    const message = combineMessages(batch.map((entry) => entry.item.message))
    const replyTo = batch.findLast((entry) => entry.item.origin.replyTo)?.item.origin.replyTo
    const origin = { ...last.origin, ...(replyTo ? { replyTo } : {}) }
    const result = await send(sessions, last.target, message.text, origin)
    if (!result.ok && isBusy(result.reason)) {
      queue.putBack(sessionRef, batch)
      return true
    }
    await confirm(last.adapter, sessions.label(last.target), result, last.meta)
    return false
  }

  /** Drops the Session's queue, telling each Channel but `except` how many of its messages went. */
  async function dropQueue(
    sessions: SessionPort,
    sessionRef: string,
    why: 'stopped' | 'unreachable' | 'deleted',
    except?: ChannelKind,
  ): Promise<number> {
    const dropped = queue.drop(sessionRef)
    const wording = copy()
    const template =
      why === 'stopped'
        ? wording.queueDroppedStopped
        : why === 'unreachable'
          ? wording.queueDroppedUnreachable
          : wording.queueDroppedDeleted
    const title = sessions.label({ sessionRef })
    const byChannel = new Map<ChannelKind, QueuedEntry<QueuedMessage>[]>()
    for (const entry of dropped) {
      byChannel.set(entry.channel, [...(byChannel.get(entry.channel) ?? []), entry])
    }
    for (const [kind, entries] of byChannel) {
      if (kind === except) continue
      const last = entries[entries.length - 1].item
      await tell(last.adapter, fillTemplate(template, { title, count: entries.length }), last.meta)
    }
    return dropped.length
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
    await submit(sessions, { adapter, target, message: { text }, origin, meta })
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
      submit: (adapter, target, message, origin, meta) =>
        submit(sessions, { adapter, target, message, origin, meta }),
      attach: (adapter, target, msg, meta) =>
        attachedPrompt({ copy, tell }, sessions, adapter, target, msg, meta),
      log,
    })
  }

  /** The Session `/stop` is for: a Notification's it replies to, else the Channel Session. */
  async function stopTarget(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<string | null> {
    const owner = msg.replyTo ? await answeredSession(sessions, adapter.kind, msg.replyTo) : null
    if (owner) {
      if ('deletedSession' in owner || !(await sessions.exists(owner.sessionRef))) {
        await tell(adapter, copy().noSession, meta)
        return null
      }
      if (!(await sessions.isReachable(owner.sessionRef))) {
        const title = sessions.label({ sessionRef: owner.sessionRef })
        await tell(adapter, fillTemplate(copy().unreachable, { title }), meta)
        return null
      }
      return owner.sessionRef
    }
    const current = await channelSessions(sessions).current(adapter, meta)
    if (!current) await tell(adapter, copy().stopNoSession, meta)
    return current
  }

  function stopCommand(sessions: SessionPort): ChannelCommand {
    return {
      name: 'stop',
      usage: '/stop',
      describe: (wording) => wording.helpStop,
      run: async ({ adapter, msg, meta }) => {
        const sessionRef = await stopTarget(adapter, sessions, msg, meta)
        if (!sessionRef) return
        const wording = copy()
        const title = sessions.label({ sessionRef })
        const running = sessions.activity(sessionRef)
        if (running.kind === 'idle' && queue.size(sessionRef) === 0) {
          return tell(adapter, fillTemplate(wording.stopNothing, { title }), meta)
        }
        // Dropped first, so the stopped turn's settle has nothing left to run.
        const count = await dropQueue(sessions, sessionRef, 'stopped', adapter.kind)
        const stopped = running.kind === 'idle' ? running : await sessions.stop(sessionRef)
        const what =
          stopped.kind === 'agent-run'
            ? fillTemplate(wording.stopAgentRun, {
                name: stopped.name,
                title,
                step: stopped.step,
                steps: stopped.steps,
              })
            : stopped.kind === 'turn'
              ? fillTemplate(wording.stopTurn, { title })
              : fillTemplate(wording.stopNothing, { title })
        await tell(adapter, `${what}\n${fillTemplate(wording.stopDropped, { count })}`, meta)
      },
    }
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
    listen(sessions)
    const own = channelSessions(sessions).commands
    const commands: ChannelCommand[] = [...own, stopCommand(sessions), helpCommand(() => commands)]
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

  return { route }
}

/** A Session busy with a turn, or held by an Agent Run, takes the message once that ends. */
function isBusy(reason: string): boolean {
  return reason === 'busy' || reason === 'task-locked'
}
