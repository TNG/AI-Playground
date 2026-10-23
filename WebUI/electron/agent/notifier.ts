import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { IpcMutationResult } from '@/types/ipcChannels'
import type { PauseReason } from '@/types/kernelEvents'
import type { NotificationConfig } from '@/types/notificationsIpc'
import { fillTemplate, notificationSessionLabel } from '@/lib/notificationLabel'
import { onKernelEvent } from '../kernel/kernelBus.ts'
import { onAgentTurnEnd } from './agentTurnOutcome.ts'
import { readAgentSessionTitle } from '../persist/agentSessionFiles.ts'
import { readAgentTasks } from '../persist/agentTaskFiles.ts'
import { appLoggerInstance } from '../observability/logger.ts'

// The one sender of Notifications (docs/adr/0003): owns the delivery decision and
// calls the Home Agent channel's `reply` with no inbound meta, so the Python
// channel resolves the Paired Chat itself.

const LOG_SOURCE = 'notifier'

export type NotificationDelivery = { delivered: true } | { delivered: false; reason: string }

export type ChannelReply = (kind: ChannelKind, text: string) => Promise<IpcMutationResult>

const OFF_CONFIG: NotificationConfig = {
  homeAgentEnabled: false,
  notificationChannel: null,
  autoNotify: false,
  sessionInView: null,
  templates: {
    paused: '',
    pauseReason: '',
    pauseKinds: { download: '', 'vram-warning': '', confirmation: '', question: '' },
    failed: '',
    sessionLabel: '',
    taskLabel: '',
    untitled: '',
  },
}

let config: NotificationConfig = OFF_CONFIG
let reply: ChannelReply | undefined
let windowShown: () => boolean = () => false

export function setNotificationConfig(next: NotificationConfig): void {
  config = { ...next }
}

export function setNotificationChannelReply(next: ChannelReply | undefined): void {
  reply = next
}

/** Whether the window is on screen: neither hidden to the tray nor minimized. Focus does not count. */
export function setNotificationWindowShown(next: () => boolean): void {
  windowShown = next
}

export async function sendNotification(text: string): Promise<NotificationDelivery> {
  const delivery = await deliver(text)
  if (!delivery.delivered) {
    appLoggerInstance.warn(`notification not delivered: ${delivery.reason}`, LOG_SOURCE)
  }
  return delivery
}

async function deliver(text: string): Promise<NotificationDelivery> {
  const { homeAgentEnabled, notificationChannel } = config
  if (!homeAgentEnabled || !reply) return { delivered: false, reason: 'Home Agent is off' }
  if (!notificationChannel) return { delivered: false, reason: 'no Notification Channel set up' }
  try {
    const result = await reply(notificationChannel, text)
    return result.success ? { delivered: true } : { delivered: false, reason: result.error }
  } catch (error) {
    return { delivered: false, reason: error instanceof Error ? error.message : String(error) }
  }
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
  )
}

async function notifyFailed(sessionId: string, error: string): Promise<void> {
  if (!config.autoNotify || !offScreen(sessionId)) return
  const title = await sessionLabel(sessionId)
  // The template supplies its own full stop after the error.
  const reason = error.trim().replace(/[.。]+$/, '')
  await sendNotification(fillTemplate(config.templates.failed, { title, error: reason }))
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
