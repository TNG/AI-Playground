import type { ChannelKind } from '@/assets/js/store/channels/types'

/** Each Channel's name as the app shows it; product names, never translated. */
export const CHANNEL_NAMES: Record<ChannelKind, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  'local-web': 'LAN chat',
}
