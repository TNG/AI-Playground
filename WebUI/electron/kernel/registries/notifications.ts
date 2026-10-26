import type {
  InvokeHandlerMap,
  NotificationsInvokeName,
  NotificationsSendName,
  SendHandlerMap,
} from '../ipcRegistries'
import type { setNotificationConfig } from '../../agent/notifier'
import type { lookupChannelMessage } from '../../persist/channelMessageMap'

export type NotificationsDeps = {
  setNotificationConfig: typeof setNotificationConfig
}

export type NotificationsInvokeDeps = {
  lookupChannelMessage: typeof lookupChannelMessage
}

export function buildNotificationsSendRegistry(deps: NotificationsDeps) {
  return {
    'notifications:setConfig': (_event, config) => deps.setNotificationConfig(config),
  } satisfies SendHandlerMap<NotificationsSendName>
}

export function buildNotificationsRegistry(deps: NotificationsInvokeDeps) {
  return {
    'notifications:lookupMessage': async (_event, kind, ref) => {
      if (typeof ref !== 'string' || !ref) return null
      return deps.lookupChannelMessage(kind, ref).catch(() => null)
    },
  } satisfies InvokeHandlerMap<NotificationsInvokeName>
}
