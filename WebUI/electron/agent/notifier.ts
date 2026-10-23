import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { IpcMutationResult } from '@/types/ipcChannels'
import type { NotificationConfig } from '@/types/notificationsIpc'
import { appLoggerInstance } from '../observability/logger.ts'

// The one sender of Notifications (docs/adr/0003): owns the delivery decision and
// calls the Home Agent channel's `reply` with no inbound meta, so the Python
// channel resolves the Paired Chat itself.

const LOG_SOURCE = 'notifier'

export type NotificationDelivery = { delivered: true } | { delivered: false; reason: string }

export type ChannelReply = (kind: ChannelKind, text: string) => Promise<IpcMutationResult>

const OFF_CONFIG: NotificationConfig = { homeAgentEnabled: false, notificationChannel: null }

let config: NotificationConfig = OFF_CONFIG
let reply: ChannelReply | undefined

export function setNotificationConfig(next: NotificationConfig): void {
  config = { ...next }
}

export function setNotificationChannelReply(next: ChannelReply | undefined): void {
  reply = next
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
