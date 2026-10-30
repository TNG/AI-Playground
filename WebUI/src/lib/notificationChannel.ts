import type { ChannelKind, ChannelPrefs } from '@/assets/js/store/channels/types'
import type { NotificationRoute } from '@/types/notificationsIpc'

const DEFAULT_ORDER: readonly ChannelKind[] = ['telegram', 'slack', 'local-web']

type ChannelReadiness = Partial<Record<ChannelKind, Pick<ChannelPrefs, 'enabled' | 'verified'>>>

/** The Channels a Notification can go to: enabled + verified, in default order. */
export function usableNotificationChannels(prefs: ChannelReadiness): ChannelKind[] {
  return DEFAULT_ORDER.filter((kind) => prefs[kind]?.enabled && prefs[kind]?.verified)
}

/** The chosen Channel while it is still usable, else the first usable one in default order. */
export function resolveNotificationChannel(
  prefs: ChannelReadiness,
  chosen: ChannelKind | null = null,
): ChannelKind | null {
  const options = usableNotificationChannels(prefs)
  if (chosen && options.includes(chosen)) return chosen
  return options[0] ?? null
}

export function canDeliverNotifications(config: NotificationRoute): boolean {
  return config.homeAgentEnabled && config.notificationChannel !== null
}
