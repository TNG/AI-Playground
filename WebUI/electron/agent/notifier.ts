import path from 'node:path'
import type { ChannelKind, KeyboardButton } from '@/assets/js/store/channels/types'
import type { PauseReason } from '@/types/kernelEvents'
import type { AnswerTarget, NotificationConfig, TrialRunOwner } from '@/types/notificationsIpc'
import type { AgentAnswerOrigin, AgentModeTurnConfig } from '@/types/agentIpc'
import type { SpeechClipPayload } from '@/types/chatRequests'
import { fillTemplate } from '@/lib/fillTemplate'
import { notificationSessionLabel, trialRunLabel } from '@/lib/notificationLabel'
import { channelMediaKind } from '@/lib/channelMediaKind'
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
import { liveTrialRunOf } from './trialRuns.ts'
import { channelMediaOf, readAttachments, type ChannelMedia } from './notificationAttachments.ts'
import { appLoggerInstance } from '../observability/logger.ts'
import { tellDroppedQueues } from './queueQuitNotice.ts'
import {
  openReplyDraft,
  type ChannelDraft,
  type DraftEdit,
  type ReplyDraft,
} from './replyDrafts.ts'
import { createChannelTyping } from './channelTyping.ts'
import { plainTextOf, type ChannelText } from './channelText.ts'
import type { InFlightWorkItem } from '@/types/lifecycleIpc'

// The one sender of Notifications (docs/adr/0010, 0011): only Reachable Sessions and notifying
// Trial Runs send, to every enabled Channel; what a Channel caused goes back to it alone.

const LOG_SOURCE = 'notifier'

/** `fileNotSentReason` says which 3D files the channel refused, and why, in a delivered Notification. */
export type NotificationDelivery =
  { delivered: true; fileNotSentReason?: string } | { delivered: false; reason: string }

export type { ChannelMedia }

/**
 * What the Notifier hands a channel. `text` is the agent's markdown, or template text when
 * `plain`; `header` and `footer` are plain lines around it. `replyTo` is the platform ref of
 * the message it answers; with `media`, the text is the caption; `buttons` are rows of
 * inline buttons; `answerTitle` is the session label an Answer button answers; `draft` is the
 * streamed reply this message settles.
 */
export type ChannelMessage = ChannelText & {
  replyTo?: string
  media?: ChannelMedia
  buttons?: KeyboardButton[][]
  answerTitle?: string
  draft?: ChannelDraft
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
export type NotificationChannel = { send: ChannelSend; typing: ChannelTyping; draft: DraftEdit }

export type NotificationOptions = {
  /** The sending Harness Session; its Session must be reachable and is named in the header. */
  sessionId: string
  /** Workspace-relative files to send with the text, validated against the session's workspace. */
  attachments?: { workspaceDir: string; paths: string[] }
}

const OFF_CONFIG: NotificationConfig = {
  channels: [],
  sessionOnScreen: null,
  trialRunInView: null,
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
    trialRunLabel: '',
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
  /** Sent after the turn's text: what earlier Steps of its run generated. */
  media: string[]
  /** Files already on the Channel, sent as made or by `notify_user`; not sent again. */
  attached: Set<string>
  /** Media sent as it is made, in order. */
  sending: Promise<unknown>
  /** The text the turn has streamed, by text block. */
  streamed: Map<string, string>
  /** The Session's header and the owner its messages are recorded under; null when unreachable. */
  heading?: Promise<Heading | null>
  draft?: ReplyDraft
  /** The turn ended: nothing more streams. */
  ended?: boolean
  /** The Session holding the turn, looked up once. */
  sessionRef?: Promise<string | null>
  answer?: AgentAnswerOrigin
  /** The reply is spoken too, after its text, unless the turn already sent a voice clip. */
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

function pulseTyping(kind: ChannelKind, state: ChannelTypingState): void {
  void channel
    ?.typing(kind, state)
    .catch((error) => appLoggerInstance.warn(`typing not sent: ${error}`, LOG_SOURCE))
}

const typing = createChannelTyping(pulseTyping, TYPING_REPEAT_MS)

function startTyping(turnId: string, kind: ChannelKind): void {
  if (!hasAnswerTyping(kind) || !config.channels.includes(kind)) return
  typing.start(turnId, kind)
}

/** A new reported turn of `sessionId` replaces its last one, whose typing must not linger. */
function replaceReportedTurn(sessionId: string, turn: ReportedTurn): void {
  const previous = reportedTurns.get(sessionId)
  if (previous) typing.stop(previous.turnId)
  reportedTurns.set(sessionId, turn)
}

function newReportedTurn(turnId: string, workspaceDir: string, media: string[]): ReportedTurn {
  return {
    turnId,
    workspaceDir,
    media,
    attached: new Set(),
    sending: Promise.resolve(),
    streamed: new Map(),
  }
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
  const media = step && step.stepIndex > 1 ? (runMedia.get(sessionId) ?? []) : []
  runMedia.delete(sessionId)
  const turn: ReportedTurn = {
    ...newReportedTurn(turnId, workspaceDir, media),
    answer: origin,
    speaks,
    ...(step && !step.notifiesResult ? { quiet: true } : {}),
  }
  replaceReportedTurn(sessionId, turn)
  if (step?.stepIndex === 1) turn.started = sendStarted(sessionId, step.taskName)
}

async function sendStarted(sessionId: string, name: string): Promise<void> {
  const { templates } = config
  const sessionRef = await sessionRefOf(sessionId)
  const session = sessionRef ? await readReachableSession(sessionRef) : null
  const title = fillTemplate(templates.sessionLabel, {
    title: session?.title || templates.untitled,
  })
  const text = fillTemplate(templates.agentStarted, { name, title })
  await deliverOrWarn({ text, bare: true, plain: true }, sessionId, 'agent start')
}

/** A Scheduled Run's last Step: its result goes to every Channel when it completes. */
export function noteResultTurn(sessionId: string, turnId: string, workspaceDir: string): void {
  replaceReportedTurn(sessionId, newReportedTurn(turnId, workspaceDir, []))
}

type Owner = AnswerTarget | TrialRunOwner
type Heading = { header: string; owner: Owner }
type Sender = { owner: Owner; title: string }

/** Harness Sessions whose latest turn started with the `notify` capability. */
const notifyingHarnessSessions = new Set<string>()

/** At turn start: a Trial Run notifies only when the capabilities it runs with include `notify`. */
export function noteTurnCapabilities(sessionId: string, capabilities: readonly string[] = []) {
  if (capabilities.includes('notify')) notifyingHarnessSessions.add(sessionId)
  else forgetHarnessSession(sessionId)
}

export function forgetHarnessSession(sessionId: string): void {
  notifyingHarnessSessions.delete(sessionId)
}

/** The Session holding `sessionId`, looked up once per reported turn: it never changes. */
function sessionRefOf(sessionId: string): Promise<string | null> {
  const turn = reportedTurns.get(sessionId)
  if (!turn) return sessionOfHarnessSession(sessionId)
  turn.sessionRef ??= sessionOfHarnessSession(sessionId).then((ref) => {
    if (!ref) turn.sessionRef = undefined
    return ref
  })
  return turn.sessionRef
}

/** Its Reachable Session, or else a live Trial Run holding it that may notify (ADR 0011). */
async function senderOf(sessionId: string): Promise<Sender | null> {
  const sessionRef = await sessionRefOf(sessionId)
  if (sessionRef) {
    const session = await readReachableSession(sessionRef)
    if (!session) return null
    const title = await sessionLabel(sessionId, session.title)
    return { owner: { sessionRef, harnessSessionId: sessionId }, title }
  }
  if (!notifyingHarnessSessions.has(sessionId)) return null
  const trial = await liveTrialRunOf(sessionId)
  if (!trial) return null
  const agent = trial.name || (await readAgentSessionTitle(sessionId))
  return {
    owner: { trialRun: true, harnessSessionId: sessionId, agentId: trial.agentId },
    title: trialRunLabel(config.templates, agent),
  }
}

async function headingOf(sessionId: string): Promise<Heading | null> {
  const sender = await senderOf(sessionId)
  if (!sender) return null
  return {
    header: fillTemplate(config.templates.header, { title: sender.title }),
    owner: sender.owner,
  }
}

function recordSent(kind: ChannelKind, ref: string, owner: Owner): Promise<void> {
  return recordChannelMessage(kind, ref, owner).catch((error) =>
    appLoggerInstance.warn(`notification not recorded: ${error}`, LOG_SOURCE),
  )
}

/** Telegram refuses a message over 4096 characters; the header needs room too. */
function clipped(text: string): string {
  return text.length > REPLY_MAX_CHARS ? `${text.slice(0, REPLY_MAX_CHARS)}…` : text
}

function streamedText(turn: ReportedTurn): string {
  return [...turn.streamed.values()]
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** What a Channel-caused turn has written so far, as a draft under the Answer. */
function streamReply(sessionId: string, turn: ReportedTurn): void {
  const kind = turn.answer?.channel
  const port = channel
  if (!kind || turn.quiet || !port || !config.channels.includes(kind)) return
  turn.heading ??= headingOf(sessionId).catch(() => null)
  void turn.heading.then((heading) => {
    if (!heading || turn.ended) return
    turn.draft ??= openReplyDraft(kind, {
      edit: port.draft,
      header: heading.header,
      ...(turn.answer?.replyTo ? { replyTo: turn.answer.replyTo } : {}),
      onPosted: (ref) => void recordSent(kind, ref, heading.owner),
    })
    turn.draft.update(clipped(streamedText(turn)))
  })
}

/** Ends the turn's streaming; resolves with the draft its final message settles, if one showed. */
async function closeReply(turn: ReportedTurn): Promise<ChannelDraft | null> {
  turn.ended = true
  await turn.heading
  return turn.draft ? turn.draft.close() : null
}

/** A turn that ended without its result still settles what it streamed. */
async function settleStreamed(sessionId: string, turn: ReportedTurn): Promise<void> {
  await turn.sending
  const draft = await closeReply(turn)
  if (!draft) return
  const delivery = await deliver({ text: clipped(streamedText(turn)), draft }, sessionId)
  if (!delivery.delivered) {
    appLoggerInstance.warn(`streamed reply not settled: ${delivery.reason}`, LOG_SOURCE)
  }
}

/** Media a reported turn made, sent at once unless its run's result keeps it. */
function noteTurnMedia(sessionId: string, turn: ReportedTurn, files: string[]): void {
  if (turn.quiet) {
    turn.media.push(...files)
    return
  }
  const fresh = files.filter((file) => !turn.attached.has(file))
  for (const file of fresh) turn.attached.add(file)
  if (fresh.length === 0) return
  if (fresh.some((file) => channelMediaKind(file) === 'voice')) turn.speaks = false
  turn.sending = turn.sending
    .then(async () => {
      await turn.started
      await sendMedia(sessionId, fresh)
    })
    .catch((error) => appLoggerInstance.warn(`generated media not sent: ${error}`, LOG_SOURCE))
}

async function sendMedia(sessionId: string, files: string[]): Promise<void> {
  for (const file of files) {
    const items = await channelMediaOf(file).catch((error) => {
      appLoggerInstance.warn(`generated media not readable: ${error}`, LOG_SOURCE)
      return []
    })
    for (const media of items) {
      await deliverOrWarn({ text: '', media }, sessionId, 'answer media')
    }
  }
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
    send: (kind, text) => send(kind, { text, plain: true }),
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
  const { sessionId } = options
  const turn = reportedTurnOf(sessionId)
  const attachments = options.attachments && notSentYet(options.attachments, turn)
  const delivery = await deliverOrWarn({ text, attachments }, sessionId)
  if (delivery.delivered && attachments) {
    for (const file of attachments.paths) {
      turn?.attached.add(path.resolve(attachments.workspaceDir, file))
    }
  }
  return delivery
}

/** The attachments the turn has not already put on the Channel; undefined when none are left. */
function notSentYet(
  attachments: NonNullable<NotificationOptions['attachments']>,
  turn: ReportedTurn | undefined,
): NotificationOptions['attachments'] {
  const paths = attachments.paths.filter(
    (file) => !turn?.attached.has(path.resolve(attachments.workspaceDir, file)),
  )
  return paths.length > 0 ? { ...attachments, paths } : undefined
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
  /** Template text, never read as markdown. */
  plain?: boolean
  /** The streamed reply this text settles. */
  draft?: ChannelDraft
}

/** The Channels a message of `sessionId` goes to now: the Answer's alone, or every one. */
function channelsFor(sessionId: string): ChannelKind[] {
  const answer = reportedTurnOf(sessionId)?.answer
  return answer ? config.channels.filter((kind) => kind === answer.channel) : config.channels
}

async function deliverOrWarn(
  body: Body,
  sessionId: string,
  what = 'notification',
): Promise<NotificationDelivery> {
  const delivery = await deliver(body, sessionId)
  if (!delivery.delivered) {
    appLoggerInstance.warn(`${what} not delivered: ${delivery.reason}`, LOG_SOURCE)
  }
  return delivery
}

async function deliver(body: Body, sessionId: string): Promise<NotificationDelivery> {
  const kinds = channelsFor(sessionId)
  if (!channel || kinds.length === 0) return { delivered: false, reason: 'no Channel is on' }
  try {
    const sender = await senderOf(sessionId)
    if (!sender) return { delivered: false, reason: 'the Session is not reachable from Channels' }
    const outcomes: NotificationDelivery[] = []
    for (const kind of kinds) {
      outcomes.push(await deliverOn(kind, channel, body, sender.owner, sender.title))
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
  owner: Owner,
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
    ...(header ? { header } : {}),
    text: body.text,
    ...(body.plain ? { plain: true } : {}),
    ...(answer?.replyTo ? { replyTo: answer.replyTo } : {}),
    ...(body.draft && kind === answer?.channel ? { draft: body.draft } : {}),
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
      await recordSent(kind, result.ref, owner)
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
  if (plainTextOf(message).length > CAPTION_MAX_CHARS[kind] || !takesCaption(first)) {
    return [message, ...media.map(uncaptioned)]
  }
  return [{ ...message, media: first }, ...rest.map(uncaptioned)]
}

const REPLY_MAX_CHARS = 3800

/** A reported turn's result: its last text, settling its draft, then what earlier Steps made. */
async function sendTurnResult(sessionId: string, turn: ReportedTurn, reply: string | undefined) {
  await turn.started
  await turn.sending
  const draft = await closeReply(turn)
  const text = reply ?? (draft ? streamedText(turn) : '')
  if (text) {
    await deliverOrWarn({ text: clipped(text), ...(draft ? { draft } : {}) }, sessionId)
  }
  if (reply && turn.answer && turn.speaks) await speakReply(sessionId, turn.answer, reply)
  await sendMedia(
    sessionId,
    turn.media.filter((file) => !turn.attached.has(file)),
  )
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
  await deliverOrWarn({ text: '', media }, sessionId, 'spoken reply')
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
    return { ...message, footer: templates.answerOnComputer }
  }
  const gesture = answerGesture(kind)
  const hint = gesture && GESTURE_WORDING[gesture].hint
  if (hint) {
    // A reply to an Answer is already part of the conversation and needs no pointer to it.
    if (message.replyTo) return message
    return { ...message, footer: templates[hint] }
  }
  const withButton = withAnswerButton(kind, message, templates.answerButton)
  return withButton === message ? message : { ...withButton, answerTitle: title }
}

/** The window is hidden, or shows another Session or, for one no Session holds, another Trial Run. */
async function offScreen(sessionId: string): Promise<boolean> {
  if (!windowShown()) return true
  const sessionRef = await sessionRefOf(sessionId)
  if (!sessionRef) return config.trialRunInView !== sessionId
  return config.sessionOnScreen === null || sessionRef !== config.sessionOnScreen
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
  await deliverOrWarn(
    {
      text: fillTemplate(config.templates.paused, { reason: pauseReasonText(reason) }),
      plain: true,
    },
    sessionId,
  )
}

async function notifyFailed(sessionId: string, turnId: string, error: string): Promise<void> {
  if (!(await notifiesAutomatically(sessionId, turnId))) return
  // The template supplies its own full stop after the error.
  const reason = error.trim().replace(/[.。]+$/, '')
  await deliverOrWarn(
    { text: fillTemplate(config.templates.failed, { error: reason }), plain: true },
    sessionId,
  )
}

/** Notifies when a Background Session's turn pauses for the user or fails; returns the unsubscribe. */
export function startAutoNotifications(): () => void {
  const stopMedia = onGeneratedMedia((workspaceDir, relativePaths) => {
    for (const [sessionId, turn] of reportedTurns) {
      if (path.resolve(turn.workspaceDir) !== path.resolve(workspaceDir)) continue
      const files = relativePaths.map((file) => path.resolve(workspaceDir, file))
      noteTurnMedia(sessionId, turn, files)
    }
  })
  const stopFailures = onAgentTurnEnd((end) => {
    const reported = reportedTurnOf(end.sessionId, end.turnId)
    if (reported) typing.stop(end.turnId)
    if (reported?.quiet && end.outcome === 'completed') {
      runMedia.set(
        end.sessionId,
        reported.media.filter((file) => !reported.attached.has(file)),
      )
    }
    const sending =
      end.outcome === 'completed' && reported && !reported.quiet
        ? sendTurnResult(end.sessionId, reported, end.reply)
        : (reported ? settleStreamed(end.sessionId, reported) : Promise.resolve()).then(() =>
            end.outcome === 'failed'
              ? notifyFailed(end.sessionId, end.turnId, end.error)
              : undefined,
          )
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
    if (event.type === 'agent-chunk') {
      const turn = reportedTurnOf(event.sessionId, event.turnId)
      const chunk = event.chunk as { type?: string; id?: string; delta?: string }
      if (!turn?.answer || turn.ended || chunk.type !== 'text-delta' || !chunk.id) return
      turn.streamed.set(chunk.id, (turn.streamed.get(chunk.id) ?? '') + (chunk.delta ?? ''))
      streamReply(event.sessionId, turn)
      return
    }
    if (event.type === 'agent-turn-done') {
      pausedTurns.delete(event.turnId)
      return
    }
    if (event.type !== 'agent-turn-state') return
    const answer = reportedTurnOf(event.sessionId, event.turnId)?.answer
    if (answer && event.state === 'running') startTyping(event.turnId, answer.channel)
    else if (answer) typing.stop(event.turnId)
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
    typing.stopAll()
  }
}
