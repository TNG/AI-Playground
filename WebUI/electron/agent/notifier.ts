import path from 'node:path'
import type { ChannelKind, KeyboardButton } from '@/assets/js/store/channels/types'
import type { PauseReason } from '@/types/kernelEvents'
import type { NotificationConfig } from '@/types/notificationsIpc'
import type { AgentAnswerOrigin, AgentModeTurnConfig } from '@/types/agentIpc'
import type { SpeechClipPayload } from '@/types/chatRequests'
import { fillTemplate } from '@/lib/fillTemplate'
import { notificationSessionLabel } from '@/lib/notificationLabel'
import {
  answerGesture,
  GESTURE_WORDING,
  hasAnswerTyping,
  withAnswerButton,
} from '@/lib/answerButton'
import { onKernelEvent } from '../kernel/kernelBus.ts'
import { askRenderer } from '../chat/chatAsk.ts'
import { onAgentTurnEnd } from './agentTurnOutcome.ts'
import { onGeneratedMedia } from './generatedMedia.ts'
import { readAgentSessionTitle } from '../persist/agentSessionFiles.ts'
import { readAgentTasks } from '../persist/agentTaskFiles.ts'
import { recordChannelMessage } from '../persist/channelMessageMap.ts'
import { sessionOfHarnessSession } from '../session/sessionHarness.ts'
import { readReachableSession } from '../session/sessionChannels.ts'
import { channelMediaOf, readAttachments, type ChannelMedia } from './notificationAttachments.ts'
import { appLoggerInstance } from '../observability/logger.ts'
import { tellDroppedQueues } from './queueQuitNotice.ts'
import type { InFlightWorkItem } from '@/types/lifecycleIpc'

// The one sender of Notifications (docs/adr/0010): only Reachable Sessions send, to every
// enabled Channel, except that what a Channel caused goes back to that Channel alone.

const LOG_SOURCE = 'notifier'

/** `fileNotSentReason` says which 3D files the channel refused, and why, in a delivered Notification. */
export type NotificationDelivery =
  { delivered: true; fileNotSentReason?: string } | { delivered: false; reason: string }

export type { ChannelMedia }

/**
 * What the Notifier hands a channel. `replyTo` is the platform ref of the message it
 * answers; with `media`, `text` is the caption; `buttons` are rows of inline buttons;
 * `answerTitle` is the session label an Answer button answers.
 */
export type ChannelMessage = {
  text: string
  replyTo?: string
  media?: ChannelMedia
  buttons?: KeyboardButton[][]
  answerTitle?: string
}

/** `ref` is the platform's id of the sent message, when it has one. */
export type ChannelSendOutcome = { success: true; ref?: string } | { success: false; error: string }

export type ChannelSend = (
  kind: ChannelKind,
  message: ChannelMessage,
) => Promise<ChannelSendOutcome>

/** The channel's "typing…" indicator, which `start` keeps alive only for a few seconds. */
export type ChannelTypingState = 'start' | 'stop'

export type ChannelTyping = (
  kind: ChannelKind,
  state: ChannelTypingState,
) => Promise<{ success: true } | { success: false; error: string }>

/** How the Notifier reaches the Channels. */
export type NotificationChannel = { send: ChannelSend; typing: ChannelTyping }

export type NotificationOptions = {
  /** The sending Harness Session; its Session must be reachable and is named in the header. */
  sessionId: string
  /** Workspace-relative files to send with the text, validated against the session's workspace. */
  attachments?: { workspaceDir: string; paths: string[] }
}

const OFF_CONFIG: NotificationConfig = {
  channels: [],
  sessionOnScreen: null,
  realShellSessions: [],
  templates: {
    header: '',
    paused: '',
    pauseReason: '',
    pauseKinds: { download: '', 'vram-warning': '', confirmation: '', question: '' },
    failed: '',
    sessionLabel: '',
    taskLabel: '',
    untitled: '',
    answerButton: '',
    answerOnComputer: '',
    answerInThread: '',
    answerByReply: '',
    queueDroppedOnQuit: '',
    agentStarted: '',
  },
}

let config: NotificationConfig = OFF_CONFIG
let channel: NotificationChannel | undefined
let windowShown: () => boolean = () => false

/**
 * A turn whose result is sent when it ends: the turn an Answer started, which replies on
 * the Answer's Channel alone, or a Scheduled Run's last Step, which reports to every Channel.
 */
type ReportedTurn = {
  turnId: string
  workspaceDir: string
  media: string[]
  /** Already sent by `notify_user`, so the turn's result leaves them out. */
  attached: Set<string>
  answer?: AgentAnswerOrigin
  /** The reply is spoken too, after its text. */
  speaks?: boolean
  /** A Step of an Agent Run before its last: its result is kept for the run's. */
  quiet?: boolean
  /** The "Started" message, sent before anything else of the run. */
  started?: Promise<unknown>
}

/** A Channel-started Agent Run's Step, as its turn config names it. */
export type ReportedStep = { taskName: string; stepIndex: number; notifiesResult?: boolean }

/** What a Channel-started run's earlier Steps generated, for its last Step to send. */
const runMedia = new Map<string, string[]>()

/** Per Harness Session. */
const reportedTurns = new Map<string, ReportedTurn>()

// Telegram's indicator lapses after about 5 s.
const TYPING_REPEAT_MS = 4000

/** The running heartbeat of each session's Answer turn. */
const typingHeartbeats = new Map<string, { channel: ChannelKind; timer: NodeJS.Timeout }>()

function pulseTyping(kind: ChannelKind, state: ChannelTypingState): void {
  void channel
    ?.typing(kind, state)
    .catch((error) => appLoggerInstance.warn(`typing not sent: ${error}`, LOG_SOURCE))
}

function startTyping(sessionId: string, kind: ChannelKind): void {
  if (!hasAnswerTyping(kind) || typingHeartbeats.has(sessionId)) return
  if (!config.channels.includes(kind)) return
  pulseTyping(kind, 'start')
  const timer = setInterval(() => pulseTyping(kind, 'start'), TYPING_REPEAT_MS)
  typingHeartbeats.set(sessionId, { channel: kind, timer })
}

function stopTyping(sessionId: string): void {
  const heartbeat = typingHeartbeats.get(sessionId)
  if (!heartbeat) return
  clearInterval(heartbeat.timer)
  typingHeartbeats.delete(sessionId)
  pulseTyping(heartbeat.channel, 'stop')
}

/** A voice message's turn speaks its reply when it has the text-to-speech tool on. */
export function answerSpeaks(config: Pick<AgentModeTurnConfig, 'answer' | 'toolSpecs'>): boolean {
  if (!config.answer?.voice) return false
  return !!config.toolSpecs?.some((spec) => spec.name === 'synthesizeTextToSpeech')
}

/** A turn a Channel caused; each Step of an Agent Run it started reports only the run's result. */
export function noteAnswerTurn(
  sessionId: string,
  turnId: string,
  workspaceDir: string,
  origin: AgentAnswerOrigin,
  speaks = false,
  step?: ReportedStep,
): void {
  stopTyping(sessionId)
  const media = step && step.stepIndex > 1 ? (runMedia.get(sessionId) ?? []) : []
  runMedia.delete(sessionId)
  const turn: ReportedTurn = {
    answer: origin,
    speaks,
    turnId,
    workspaceDir,
    media,
    attached: new Set(),
    ...(step && !step.notifiesResult ? { quiet: true } : {}),
  }
  reportedTurns.set(sessionId, turn)
  if (step?.stepIndex === 1) turn.started = sendStarted(sessionId, step.taskName)
}

async function sendStarted(sessionId: string, name: string): Promise<void> {
  const { templates } = config
  const sessionRef = await sessionOfHarnessSession(sessionId)
  const session = sessionRef ? await readReachableSession(sessionRef) : null
  const title = fillTemplate(templates.sessionLabel, {
    title: session?.title || templates.untitled,
  })
  const text = fillTemplate(templates.agentStarted, { name, title })
  const delivery = await deliver({ text, bare: true }, sessionId)
  if (!delivery.delivered) {
    appLoggerInstance.warn(`agent start not delivered: ${delivery.reason}`, LOG_SOURCE)
  }
}

/** A Scheduled Run's last Step: its result goes to every Channel when it completes. */
export function noteResultTurn(sessionId: string, turnId: string, workspaceDir: string): void {
  stopTyping(sessionId)
  reportedTurns.set(sessionId, { turnId, workspaceDir, media: [], attached: new Set() })
}

function reportedTurnOf(sessionId: string, turnId?: string): ReportedTurn | undefined {
  const turn = reportedTurns.get(sessionId)
  return turn && (turnId === undefined || turn.turnId === turnId) ? turn : undefined
}

export function setNotificationConfig(next: NotificationConfig): void {
  config = { ...next, channels: [...next.channels] }
}

export function setNotificationChannel(next: NotificationChannel | undefined): void {
  channel = next
}

/** On quit: each Channel with messages the window still had queued hears how many were dropped. */
export async function tellQueuesDroppedOnQuit(
  queued: Extract<InFlightWorkItem, { kind: 'channel-queue' }>[],
): Promise<void> {
  const send = channel?.send
  if (!send || queued.length === 0) return
  await tellDroppedQueues({
    queued,
    channels: config.channels,
    template: config.templates.queueDroppedOnQuit,
    send: (kind, text) => send(kind, { text }),
  })
}

/** Whether the window is on screen: neither hidden to the tray nor minimized. Focus does not count. */
export function setNotificationWindowShown(next: () => boolean): void {
  windowShown = next
}

export async function sendNotification(
  text: string,
  options: NotificationOptions,
): Promise<NotificationDelivery> {
  const { sessionId, attachments } = options
  const delivery = await deliver({ text, attachments }, sessionId)
  if (!delivery.delivered) {
    appLoggerInstance.warn(`notification not delivered: ${delivery.reason}`, LOG_SOURCE)
  } else if (attachments) {
    const turn = reportedTurnOf(sessionId)
    for (const file of attachments.paths) {
      turn?.attached.add(path.resolve(attachments.workspaceDir, file))
    }
  }
  return delivery
}

/** A document goes as a bare file: it never carries the text, which goes before it instead. */
function takesCaption(media: ChannelMedia | undefined): boolean {
  return media?.kind !== 'document'
}

type Body = {
  text: string
  media?: ChannelMedia
  attachments?: NotificationOptions['attachments']
  /** Neither the header nor how to answer: an acknowledgement. */
  bare?: boolean
}

/** The Channels a message of `sessionId` goes to now: the Answer's alone, or every one. */
function channelsFor(sessionId: string): ChannelKind[] {
  const answer = reportedTurnOf(sessionId)?.answer
  return answer ? config.channels.filter((kind) => kind === answer.channel) : config.channels
}

async function deliver(body: Body, sessionId: string): Promise<NotificationDelivery> {
  const kinds = channelsFor(sessionId)
  if (!channel || kinds.length === 0) return { delivered: false, reason: 'no Channel is on' }
  try {
    const sessionRef = await sessionOfHarnessSession(sessionId)
    const session = sessionRef ? await readReachableSession(sessionRef) : null
    if (!sessionRef || !session) {
      return { delivered: false, reason: 'the Session is not reachable from Channels' }
    }
    const title = await sessionLabel(sessionId, session.title)
    const owner = { sessionRef, harnessSessionId: sessionId }
    const outcomes: NotificationDelivery[] = []
    for (const kind of kinds) {
      outcomes.push(await deliverOn(kind, channel, body, owner, title))
    }
    const delivered = outcomes.flatMap((outcome) => (outcome.delivered ? [outcome] : []))
    if (delivered.length === 0) {
      const reasons = outcomes.flatMap((outcome) => (outcome.delivered ? [] : [outcome.reason]))
      return { delivered: false, reason: [...new Set(reasons)].join('; ') }
    }
    const notSent = delivered.flatMap((outcome) => outcome.fileNotSentReason ?? [])
    return notSent.length > 0
      ? { delivered: true, fileNotSentReason: [...new Set(notSent)].join('; ') }
      : { delivered: true }
  } catch (error) {
    return { delivered: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function deliverOn(
  kind: ChannelKind,
  port: NotificationChannel,
  body: Body,
  owner: { sessionRef: string; harnessSessionId: string },
  title: string,
): Promise<NotificationDelivery> {
  const sessionId = owner.harnessSessionId
  const answer = reportedTurnOf(sessionId)?.answer
  const attached = body.attachments
    ? await readAttachments(body.attachments.workspaceDir, body.attachments.paths, kind)
    : { media: [] }
  if ('error' in attached) return { delivered: false, reason: attached.error }
  const header =
    takesCaption(body.media) && !body.bare ? fillTemplate(config.templates.header, { title }) : ''
  const message: ChannelMessage = {
    text: [header, body.text].filter(Boolean).join('\n'),
    ...(answer?.replyTo ? { replyTo: answer.replyTo } : {}),
  }
  const messages = body.media
    ? [{ ...message, media: body.media }]
    : body.bare
      ? [message]
      : laidOut(kind, answerable(kind, message, sessionId, title), attached.media)
  const filesNotSent: string[] = []
  for (const [index, next] of messages.entries()) {
    const result = await port.send(kind, next)
    if (!result.success && next.media && !takesCaption(next.media) && index > 0) {
      filesNotSent.push(`${next.media.filename}: ${result.error}`)
      continue
    }
    if (!result.success) return { delivered: false, reason: result.error }
    if (result.ref) {
      await recordChannelMessage(kind, result.ref, owner).catch((error) =>
        appLoggerInstance.warn(`notification not recorded: ${error}`, LOG_SOURCE),
      )
    } else {
      appLoggerInstance.warn(
        `${kind} returned no message ref; a reply to it is no Answer`,
        LOG_SOURCE,
      )
    }
  }
  return filesNotSent.length > 0
    ? { delivered: true, fileNotSentReason: filesNotSent.join('; ') }
    : { delivered: true }
}

/** The longest caption each channel shows under an attachment. */
const CAPTION_MAX_CHARS: Record<ChannelKind, number> = {
  telegram: 1024,
  slack: Infinity,
  'local-web': Infinity,
  discord: 2000,
}

/** The text captions the first attachment, or goes alone first when too long or the first takes no caption. */
function laidOut(
  kind: ChannelKind,
  message: ChannelMessage,
  media: ChannelMedia[],
): ChannelMessage[] {
  if (media.length === 0) return [message]
  const target = message.replyTo ? { replyTo: message.replyTo } : {}
  const uncaptioned = (item: ChannelMedia): ChannelMessage => ({ text: '', media: item, ...target })
  const [first, ...rest] = media
  if (message.text.length > CAPTION_MAX_CHARS[kind] || !takesCaption(first)) {
    return [message, ...media.map(uncaptioned)]
  }
  return [{ ...message, media: first }, ...rest.map(uncaptioned)]
}

// Telegram refuses a message over 4096 characters; the header needs room too.
const REPLY_MAX_CHARS = 3800

/** The result of a reported turn: its last text, then what it generated. */
async function sendTurnResult(sessionId: string, turn: ReportedTurn, reply: string | undefined) {
  await turn.started
  if (reply) {
    const text = reply.length > REPLY_MAX_CHARS ? `${reply.slice(0, REPLY_MAX_CHARS)}…` : reply
    await sendNotification(text, { sessionId })
    if (turn.answer && turn.speaks) await speakReply(sessionId, turn.answer, reply)
  }
  for (const file of turn.media) {
    if (turn.attached.has(file)) continue
    const items = await channelMediaOf(file).catch((error) => {
      appLoggerInstance.warn(`generated media not readable: ${error}`, LOG_SOURCE)
      return []
    })
    for (const media of items) {
      const delivery = await deliver({ text: '', media }, sessionId)
      if (!delivery.delivered) {
        appLoggerInstance.warn(`answer media not delivered: ${delivery.reason}`, LOG_SOURCE)
      }
    }
  }
}

const CLIP_EXTENSIONS: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
}

/** The reply read aloud by the window, sent as a voice message under the Answer. */
async function speakReply(sessionId: string, answer: AgentAnswerOrigin, reply: string) {
  const clip = await askRenderer<SpeechClipPayload | null>({
    kind: 'channel-voice-reply',
    channel: answer.channel,
    text: reply,
    ...(answer.replyTo ? { replyTo: answer.replyTo } : {}),
  }).catch((error) => {
    appLoggerInstance.warn(`spoken reply not made: ${error}`, LOG_SOURCE)
    return null
  })
  if (!clip?.audioBase64) return
  const filename = `reply.${CLIP_EXTENSIONS[clip.mediaType] ?? 'wav'}`
  const media: ChannelMedia = { kind: 'voice', base64: clip.audioBase64, filename }
  const delivery = await deliver({ text: '', media }, sessionId)
  if (!delivery.delivered) {
    appLoggerInstance.warn(`spoken reply not delivered: ${delivery.reason}`, LOG_SOURCE)
  }
}

/** An agent's message with how to answer it on `kind`, or a pointer to the computer for a real-shell session. */
export function answerable(
  kind: ChannelKind,
  message: ChannelMessage,
  sessionId: string,
  title: string,
): ChannelMessage {
  const { templates } = config
  if (config.realShellSessions.includes(sessionId)) {
    return { ...message, text: `${message.text}\n${templates.answerOnComputer}` }
  }
  const gesture = answerGesture(kind)
  const hint = gesture && GESTURE_WORDING[gesture].hint
  if (hint) {
    // A reply to an Answer is already part of the conversation and needs no pointer to it.
    if (message.replyTo) return message
    return { ...message, text: `${message.text}\n${templates[hint]}` }
  }
  const withButton = withAnswerButton(kind, message, templates.answerButton)
  return withButton === message ? message : { ...withButton, answerTitle: title }
}

/** The window is hidden or shows another Session. */
async function offScreen(sessionId: string): Promise<boolean> {
  if (!windowShown() || config.sessionOnScreen === null) return true
  return (await sessionOfHarnessSession(sessionId)) !== config.sessionOnScreen
}

function pauseReasonText(reason: PauseReason | undefined): string {
  const { pauseReason, pauseKinds } = config.templates
  const kind = pauseKinds[reason?.kind ?? 'question']
  return reason?.summary ? fillTemplate(pauseReason, { kind, summary: reason.summary }) : kind
}

/** The Session's quoted title, then the Agent Run's name and Step while one runs in it. */
async function sessionLabel(sessionId: string, sessionTitle: string): Promise<string> {
  const { templates } = config
  const tasks = await readAgentTasks().catch(() => [])
  const title = sessionTitle || (await readAgentSessionTitle(sessionId))
  const named = fillTemplate(templates.sessionLabel, { title: title || templates.untitled })
  const inRun = tasks.some((task) => task.activeRuns?.some((run) => run.sessionId === sessionId))
  return inRun ? `${named} · ${notificationSessionLabel(templates, sessionId, '', tasks)}` : named
}

/** Paused and failed: always for the turn an Answer started, else only off screen. */
async function notifiesAutomatically(sessionId: string, turnId: string): Promise<boolean> {
  if (reportedTurnOf(sessionId, turnId)?.answer) return true
  return offScreen(sessionId)
}

async function notifyPaused(
  sessionId: string,
  turnId: string,
  reason: PauseReason | undefined,
): Promise<void> {
  // A download pause is asked as a Channel Question by the window instead.
  if (reason?.kind === 'download') return
  if (!(await notifiesAutomatically(sessionId, turnId))) return
  await sendNotification(
    fillTemplate(config.templates.paused, { reason: pauseReasonText(reason) }),
    { sessionId },
  )
}

async function notifyFailed(sessionId: string, turnId: string, error: string): Promise<void> {
  if (!(await notifiesAutomatically(sessionId, turnId))) return
  // The template supplies its own full stop after the error.
  const reason = error.trim().replace(/[.。]+$/, '')
  await sendNotification(fillTemplate(config.templates.failed, { error: reason }), { sessionId })
}

/** Notifies when a Background Session's turn pauses for the user or fails; returns the unsubscribe. */
export function startAutoNotifications(): () => void {
  const stopMedia = onGeneratedMedia((workspaceDir, relativePaths) => {
    for (const turn of reportedTurns.values()) {
      if (path.resolve(turn.workspaceDir) !== path.resolve(workspaceDir)) continue
      turn.media.push(...relativePaths.map((file) => path.resolve(workspaceDir, file)))
    }
  })
  const stopFailures = onAgentTurnEnd((end) => {
    const reported = reportedTurnOf(end.sessionId, end.turnId)
    if (reported) stopTyping(end.sessionId)
    if (reported?.quiet && end.outcome === 'completed') {
      runMedia.set(
        end.sessionId,
        reported.media.filter((file) => !reported.attached.has(file)),
      )
    }
    const sending =
      end.outcome === 'failed'
        ? notifyFailed(end.sessionId, end.turnId, end.error)
        : end.outcome === 'completed' && reported && !reported.quiet
          ? sendTurnResult(end.sessionId, reported, end.reply)
          : Promise.resolve()
    void sending
      .catch((error) =>
        appLoggerInstance.warn(`turn-end notification failed: ${error}`, LOG_SOURCE),
      )
      .finally(() => {
        if (reportedTurnOf(end.sessionId, end.turnId)) reportedTurns.delete(end.sessionId)
      })
  })
  const pausedTurns = new Set<string>()
  const stopPauses = onKernelEvent((event) => {
    if (event.type === 'agent-turn-done') {
      pausedTurns.delete(event.turnId)
      return
    }
    if (event.type !== 'agent-turn-state') return
    const answer = reportedTurnOf(event.sessionId, event.turnId)?.answer
    if (answer && event.state === 'running') startTyping(event.sessionId, answer.channel)
    else if (answer) stopTyping(event.sessionId)
    if (event.state !== 'paused') {
      pausedTurns.delete(event.turnId)
      return
    }
    // A second question while already paused is not a new pause.
    if (pausedTurns.has(event.turnId)) return
    pausedTurns.add(event.turnId)
    void notifyPaused(event.sessionId, event.turnId, event.pauseReason).catch((error) =>
      appLoggerInstance.warn(`pause notification failed: ${error}`, LOG_SOURCE),
    )
  })
  return () => {
    stopMedia()
    stopFailures()
    stopPauses()
    for (const sessionId of [...typingHeartbeats.keys()]) stopTyping(sessionId)
  }
}
