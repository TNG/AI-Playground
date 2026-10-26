import type { ChannelKind, KeyboardButton } from '@/assets/js/store/channels/types'
import type { PauseReason } from '@/types/kernelEvents'
import type { NotificationConfig } from '@/types/notificationsIpc'
import { fillTemplate, notificationSessionLabel } from '@/lib/notificationLabel'
import { withAnswerButton } from '@/lib/answerButton'
import { onKernelEvent } from '../kernel/kernelBus.ts'
import { onAgentTurnEnd } from './agentTurnOutcome.ts'
import { readAgentSessionTitle } from '../persist/agentSessionFiles.ts'
import { readAgentTasks } from '../persist/agentTaskFiles.ts'
import { recordChannelMessage } from '../persist/channelMessageMap.ts'
import { appLoggerInstance } from '../observability/logger.ts'

// The one sender of Notifications (docs/adr/0003): owns the delivery decision and
// calls the Home Agent channel's `reply` with no inbound meta, so the Python
// channel resolves the Paired Chat itself.

const LOG_SOURCE = 'notifier'

export type NotificationDelivery = { delivered: true } | { delivered: false; reason: string }

/** What the Notifier hands a channel; `buttons` are rows of inline buttons. */
export type ChannelMessage = { text: string; buttons?: KeyboardButton[][] }

/** `ref` is the platform's id of the sent message, when it has one. */
export type ChannelSendOutcome = { success: true; ref?: string } | { success: false; error: string }

export type ChannelSend = (
  kind: ChannelKind,
  message: ChannelMessage,
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
  },
}

let config: NotificationConfig = OFF_CONFIG
let channelSend: ChannelSend | undefined
let windowShown: () => boolean = () => false

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
  const delivery = await deliver(text, options.sessionId)
  if (!delivery.delivered) {
    appLoggerInstance.warn(`notification not delivered: ${delivery.reason}`, LOG_SOURCE)
  }
  return delivery
}

async function deliver(text: string, sessionId: string | undefined): Promise<NotificationDelivery> {
  const { homeAgentEnabled, notificationChannel } = config
  if (!homeAgentEnabled || !channelSend) return { delivered: false, reason: 'Home Agent is off' }
  if (!notificationChannel) return { delivered: false, reason: 'no Notification Channel set up' }
  try {
    const header = sessionId
      ? fillTemplate(config.templates.header, { title: await sessionLabel(sessionId) })
      : ''
    const message = { text: header ? `${header}\n${text}` : text }
    const result = await channelSend(
      notificationChannel,
      answerable(notificationChannel, message, sessionId),
    )
    if (!result.success) return { delivered: false, reason: result.error }
    if (sessionId && result.ref) {
      await recordChannelMessage(notificationChannel, result.ref, sessionId).catch((error) =>
        appLoggerInstance.warn(`notification not recorded: ${error}`, LOG_SOURCE),
      )
    }
    return { delivered: true }
  } catch (error) {
    return { delivered: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** An agent's message with its 💬 Answer button, or a pointer to the computer for a real-shell session. */
export function answerable(
  kind: ChannelKind,
  message: ChannelMessage,
  sessionId: string | undefined,
): ChannelMessage {
  if (!sessionId) return message
  const { answerButton, answerOnComputer } = config.templates
  if (config.realShellSessions.includes(sessionId)) {
    return { ...message, text: `${message.text}\n${answerOnComputer}` }
  }
  return withAnswerButton(kind, message, answerButton)
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

async function notifyPaused(sessionId: string, reason: PauseReason | undefined): Promise<void> {
  // A download pause is asked as a Channel Question by the window instead (docs/adr/0004).
  if (reason?.kind === 'download') return
  if (!config.autoNotify || !offScreen(sessionId)) return
  const title = await sessionLabel(sessionId)
  await sendNotification(
    fillTemplate(config.templates.paused, { title, reason: pauseReasonText(reason) }),
    { sessionId },
  )
}

async function notifyFailed(sessionId: string, error: string): Promise<void> {
  if (!config.autoNotify || !offScreen(sessionId)) return
  const title = await sessionLabel(sessionId)
  // The template supplies its own full stop after the error.
  const reason = error.trim().replace(/[.。]+$/, '')
  await sendNotification(fillTemplate(config.templates.failed, { title, error: reason }), {
    sessionId,
  })
}

/** Notifies when a Background Session's turn pauses for the user or fails; returns the unsubscribe. */
export function startAutoNotifications(): () => void {
  const stopFailures = onAgentTurnEnd((end) => {
    if (end.outcome !== 'failed') return
    void notifyFailed(end.sessionId, end.error).catch((error) =>
      appLoggerInstance.warn(`failure notification failed: ${error}`, LOG_SOURCE),
    )
  })
  const pausedTurns = new Set<string>()
  const stopPauses = onKernelEvent((event) => {
    if (event.type === 'agent-turn-done') {
      pausedTurns.delete(event.turnId)
      return
    }
    if (event.type !== 'agent-turn-state') return
    if (event.state !== 'paused') {
      pausedTurns.delete(event.turnId)
      return
    }
    // A second question while already paused is not a new pause.
    if (pausedTurns.has(event.turnId)) return
    pausedTurns.add(event.turnId)
    void notifyPaused(event.sessionId, event.pauseReason).catch((error) =>
      appLoggerInstance.warn(`pause notification failed: ${error}`, LOG_SOURCE),
    )
  })
  return () => {
    stopFailures()
    stopPauses()
  }
}
