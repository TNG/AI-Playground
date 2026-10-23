import type { ChannelKind, ChannelPrefs } from '@/assets/js/store/channels/types'

const DEFAULT_ORDER: readonly ChannelKind[] = ['telegram', 'slack', 'local-web']

/** The Channel Notifications go to: the first enabled + verified one in default order. */
export function resolveNotificationChannel(
  prefs: Partial<Record<ChannelKind, Pick<ChannelPrefs, 'enabled' | 'verified'>>>,
): ChannelKind | null {
  return DEFAULT_ORDER.find((kind) => prefs[kind]?.enabled && prefs[kind]?.verified) ?? null
}
