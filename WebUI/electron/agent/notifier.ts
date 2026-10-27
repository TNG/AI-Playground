import fs from 'node:fs/promises'
import path from 'node:path'
import type { ChannelKind, KeyboardButton } from '@/assets/js/store/channels/types'
import type { PauseReason } from '@/types/kernelEvents'
import type { NotificationConfig } from '@/types/notificationsIpc'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import { fillTemplate, notificationSessionLabel } from '@/lib/notificationLabel'
import { answersInThread, hasAnswerTyping, withAnswerButton } from '@/lib/answerButton'
import { onKernelEvent } from '../kernel/kernelBus.ts'
import { onAgentTurnEnd } from './agentTurnOutcome.ts'
import { onGeneratedMedia } from './generatedMedia.ts'
import { readAgentSessionTitle } from '../persist/agentSessionFiles.ts'
import { readAgentTasks } from '../persist/agentTaskFiles.ts'
import { recordChannelMessage } from '../persist/channelMessageMap.ts'
import { appLoggerInstance } from '../observability/logger.ts'

// The one sender of Notifications (docs/adr/0003): owns the delivery decision and
// calls the Home Agent channel's `reply` with no inbound meta, so the Python
// channel resolves the Paired Chat itself.

const LOG_SOURCE = 'notifier'

export type NotificationDelivery = { delivered: true } | { delivered: false; reason: string }

export type ChannelMedia = { kind: 'photo' | 'video'; base64: string; filename: string }

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

/** The channel's "typing…" indicator, which `start` keeps alive only for a few seconds. */
export type ChannelTyping = { typing: 'start' | 'stop' }

export type ChannelSend = (
  kind: ChannelKind,
  message: ChannelMessage | ChannelTyping,
) => Promise<ChannelSendOutcome>

export type NotificationOptions = {
  /** The sending session: names it in the header and makes the message answerable. */
  sessionId?: string
}

const OFF_CONFIG: NotificationConfig = {
  homeAgentEnabled: false,
  notificationChannel: null,
  autoNotify: false,
  sessionInView: null,
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
  },
}

let config: NotificationConfig = OFF_CONFIG
let channelSend: ChannelSend | undefined
let windowShown: () => boolean = () => false

type AnswerTurn = AgentAnswerOrigin & { turnId: string; workspaceDir: string; media: string[] }

/** The turn an Answer started, per session: its messages go under the Answer, past the gates. */
const answerTurns = new Map<string, AnswerTurn>()

// Telegram's indicator lapses after about 5 s.
const TYPING_REPEAT_MS = 4000

/** The running heartbeat of each session's Answer turn. */
const typingHeartbeats = new Map<string, { channel: ChannelKind; timer: NodeJS.Timeout }>()

function sendTyping(channel: ChannelKind, typing: ChannelTyping['typing']): void {
  void channelSend?.(channel, { typing }).catch((error) =>
    appLoggerInstance.warn(`typing not sent: ${error}`, LOG_SOURCE),
  )
}

function startTyping(sessionId: string, channel: ChannelKind): void {
  if (!hasAnswerTyping(channel) || typingHeartbeats.has(sessionId)) return
  sendTyping(channel, 'start')
  const timer = setInterval(() => sendTyping(channel, 'start'), TYPING_REPEAT_MS)
  typingHeartbeats.set(sessionId, { channel, timer })
}

function stopTyping(sessionId: string): void {
  const heartbeat = typingHeartbeats.get(sessionId)
  if (!heartbeat) return
  clearInterval(heartbeat.timer)
  typingHeartbeats.delete(sessionId)
  sendTyping(heartbeat.channel, 'stop')
}

export function noteAnswerTurn(
  sessionId: string,
  turnId: string,
  workspaceDir: string,
  origin: AgentAnswerOrigin,
): void {
  stopTyping(sessionId)
  answerTurns.set(sessionId, { ...origin, turnId, workspaceDir, media: [] })
}

function answerTurnOf(sessionId: string, turnId?: string): AnswerTurn | undefined {
  const turn = answerTurns.get(sessionId)
  return turn && (turnId === undefined || turn.turnId === turnId) ? turn : undefined
}

export function setNotificationConfig(next: NotificationConfig): void {
  config = { ...next }
}

export function setNotificationChannelSend(next: ChannelSend | undefined): void {
  channelSend = next
}

/** Whether the window is on screen: neither hidden to the tray nor minimized. Focus does not count. */
export function setNotificationWindowShown(next: () => boolean): void {
  windowShown = next
}

export async function sendNotification(
  text: string,
  options: NotificationOptions = {},
): Promise<NotificationDelivery> {
  const delivery = await deliver({ text }, options.sessionId)
  if (!delivery.delivered) {
    appLoggerInstance.warn(`notification not delivered: ${delivery.reason}`, LOG_SOURCE)
  }
  return delivery
}

async function deliver(
  body: { text: string; media?: ChannelMedia },
  sessionId: string | undefined,
): Promise<NotificationDelivery> {
  const answer = sessionId ? answerTurnOf(sessionId) : undefined
  const { homeAgentEnabled } = config
  const channel = answer?.channel ?? config.notificationChannel
  if (!homeAgentEnabled || !channelSend) return { delivered: false, reason: 'Home Agent is off' }
  if (!channel) return { delivered: false, reason: 'no Notification Channel set up' }
  try {
    const title = sessionId ? await sessionLabel(sessionId) : ''
    const header = sessionId ? fillTemplate(config.templates.header, { title }) : ''
    const message: ChannelMessage = {
      text: [header, body.text].filter(Boolean).join('\n'),
      ...(answer?.replyTo ? { replyTo: answer.replyTo } : {}),
    }
    const result = await channelSend(
      channel,
      body.media
        ? { ...message, media: body.media }
        : answerable(channel, message, sessionId, title),
    )
    if (!result.success) return { delivered: false, reason: result.error }
    if (sessionId && result.ref) {
      await recordChannelMessage(channel, result.ref, sessionId).catch((error) =>
        appLoggerInstance.warn(`notification not recorded: ${error}`, LOG_SOURCE),
      )
    }
    return { delivered: true }
  } catch (error) {
    return { delivered: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

const MEDIA_KINDS: Record<string, ChannelMedia['kind']> = {
  '.png': 'photo',
  '.jpg': 'photo',
  '.jpeg': 'photo',
  '.webp': 'photo',
  '.mp4': 'video',
  '.webm': 'video',
}

async function channelMedia(file: string): Promise<ChannelMedia | null> {
  const kind = MEDIA_KINDS[path.extname(file).toLowerCase()]
  if (!kind) return null
  const base64 = (await fs.readFile(file)).toString('base64')
  return { kind, base64, filename: path.basename(file) }
}

// Telegram refuses a message over 4096 characters; the header needs room too.
const REPLY_MAX_CHARS = 3800

/** The result of the turn an Answer started: its last text, then what it generated. */
async function replyToAnswer(sessionId: string, turn: AnswerTurn, reply: string | undefined) {
  if (reply) {
    const text = reply.length > REPLY_MAX_CHARS ? `${reply.slice(0, REPLY_MAX_CHARS)}…` : reply
    await sendNotification(text, { sessionId })
  }
  for (const file of turn.media) {
    const media = await channelMedia(file).catch((error) => {
      appLoggerInstance.warn(`generated media not readable: ${error}`, LOG_SOURCE)
      return null
    })
    if (!media) continue
    const delivery = await deliver({ text: '', media }, sessionId)
    if (!delivery.delivered) {
      appLoggerInstance.warn(`answer media not delivered: ${delivery.reason}`, LOG_SOURCE)
    }
  }
}

/** An agent's message with its 💬 Answer button, or a pointer to the computer for a real-shell session. */
export function answerable(
  kind: ChannelKind,
  message: ChannelMessage,
  sessionId: string | undefined,
  title: string,
): ChannelMessage {
  if (!sessionId) return message
  const { answerButton, answerOnComputer, answerInThread } = config.templates
  if (config.realShellSessions.includes(sessionId)) {
    return { ...message, text: `${message.text}\n${answerOnComputer}` }
  }
  if (answersInThread(kind)) {
    // A message already in the thread needs no pointer to it.
    return message.replyTo ? message : { ...message, text: `${message.text}\n${answerInThread}` }
  }
  const withButton = withAnswerButton(kind, message, answerButton)
  return withButton === message ? message : { ...withButton, answerTitle: title }
}

function offScreen(sessionId: string): boolean {
  return config.sessionInView !== sessionId || !windowShown()
}

function pauseReasonText(reason: PauseReason | undefined): string {
  const { pauseReason, pauseKinds } = config.templates
  const kind = pauseKinds[reason?.kind ?? 'question']
  return reason?.summary ? fillTemplate(pauseReason, { kind, summary: reason.summary }) : kind
}

async function sessionLabel(sessionId: string): Promise<string> {
  const tasks = await readAgentTasks().catch(() => [])
  const title = tasks.some((task) => task.activeRun?.sessionId === sessionId)
    ? ''
    : await readAgentSessionTitle(sessionId)
  return notificationSessionLabel(config.templates, sessionId, title, tasks)
}

/** The automatic Notification rules, which the turn an Answer started skips. */
function notifiesAutomatically(sessionId: string, turnId: string): boolean {
  if (answerTurnOf(sessionId, turnId)) return true
  return config.autoNotify && offScreen(sessionId)
}

async function notifyPaused(
  sessionId: string,
  turnId: string,
  reason: PauseReason | undefined,
): Promise<void> {
  // A download pause is asked as a Channel Question by the window instead (docs/adr/0004).
  if (reason?.kind === 'download') return
  if (!notifiesAutomatically(sessionId, turnId)) return
  await sendNotification(
    fillTemplate(config.templates.paused, { reason: pauseReasonText(reason) }),
    {
      sessionId,
    },
  )
}

async function notifyFailed(sessionId: string, turnId: string, error: string): Promise<void> {
  if (!notifiesAutomatically(sessionId, turnId)) return
  // The template supplies its own full stop after the error.
  const reason = error.trim().replace(/[.。]+$/, '')
  await sendNotification(fillTemplate(config.templates.failed, { error: reason }), {
    sessionId,
  })
}

/** Notifies when a Background Session's turn pauses for the user or fails; returns the unsubscribe. */
export function startAutoNotifications(): () => void {
  const stopMedia = onGeneratedMedia((workspaceDir, relativePaths) => {
    for (const turn of answerTurns.values()) {
      if (path.resolve(turn.workspaceDir) !== path.resolve(workspaceDir)) continue
      turn.media.push(...relativePaths.map((file) => path.resolve(workspaceDir, file)))
    }
  })
  const stopFailures = onAgentTurnEnd((end) => {
    const answer = answerTurnOf(end.sessionId, end.turnId)
    if (answer) stopTyping(end.sessionId)
    const sending =
      end.outcome === 'failed'
        ? notifyFailed(end.sessionId, end.turnId, end.error)
        : end.outcome === 'completed' && answer
          ? replyToAnswer(end.sessionId, answer, end.reply)
          : Promise.resolve()
    void sending
      .catch((error) =>
        appLoggerInstance.warn(`turn-end notification failed: ${error}`, LOG_SOURCE),
      )
      .finally(() => {
        if (answerTurnOf(end.sessionId, end.turnId)) answerTurns.delete(end.sessionId)
      })
  })
  const pausedTurns = new Set<string>()
  const stopPauses = onKernelEvent((event) => {
    if (event.type === 'agent-turn-done') {
      pausedTurns.delete(event.turnId)
      return
    }
    if (event.type !== 'agent-turn-state') return
    const answer = answerTurnOf(event.sessionId, event.turnId)
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
