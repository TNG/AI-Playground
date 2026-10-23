import type { NotificationsSendName, SendHandlerMap } from '../ipcRegistries'
import type { setNotificationConfig } from '../../agent/notifier'

export type NotificationsDeps = {
  setNotificationConfig: typeof setNotificationConfig
}

export function buildNotificationsSendRegistry(deps: NotificationsDeps) {
  return {
    'notifications:setConfig': (_event, config) => deps.setNotificationConfig(config),
  } satisfies SendHandlerMap<NotificationsSendName>
}
