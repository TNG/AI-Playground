import type {
  InvokeHandlerMap,
  NotificationsInvokeName,
  NotificationsSendName,
  SendHandlerMap,
} from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import type { setNotificationConfig } from '../../agent/notifier'
import type { channelMessageOwner, recordChannelMessage } from '../../persist/channelMessageMap'

export type NotificationsDeps = {
  setNotificationConfig: typeof setNotificationConfig
}

export type NotificationsInvokeDeps = {
  channelMessageOwner: typeof channelMessageOwner
  recordChannelMessage: typeof recordChannelMessage
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
      return deps.channelMessageOwner(kind, ref).catch(() => null)
    },
    'notifications:recordMessage': async (_event, kind, ref, sessionId) => {
      try {
        await deps.recordChannelMessage(kind, ref, sessionId)
        return { success: true }
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<NotificationsInvokeName>
}
