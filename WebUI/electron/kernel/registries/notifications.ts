import type {
  InvokeHandlerMap,
  NotificationsInvokeName,
  NotificationsSendName,
  SendHandlerMap,
} from '../ipcRegistries'
import { ipcErrorText } from '../typedIpc'
import type { setNotificationConfig } from '../../agent/notifier'
import type { channelMessageOwner, recordStartPromptRequest } from '../../persist/channelMessageMap'
import type { appLoggerInstance } from '../../observability/logger'

export type NotificationsDeps = {
  setNotificationConfig: typeof setNotificationConfig
}

export type NotificationsInvokeDeps = {
  channelMessageOwner: typeof channelMessageOwner
  recordStartPromptRequest: typeof recordStartPromptRequest
  appLogger: typeof appLoggerInstance
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
      return deps.channelMessageOwner(kind, ref).catch((e) => {
        deps.appLogger.warn(`channel message lookup failed: ${ipcErrorText(e)}`, 'notifications')
        return null
      })
    },
    'notifications:recordStartPromptRequest': async (_event, kind, ref) => {
      if (typeof ref !== 'string' || !ref) return
      await deps.recordStartPromptRequest(kind, ref).catch((e) => {
        deps.appLogger.warn(
          `start prompt request record failed: ${ipcErrorText(e)}`,
          'notifications',
        )
      })
    },
  } satisfies InvokeHandlerMap<NotificationsInvokeName>
}
