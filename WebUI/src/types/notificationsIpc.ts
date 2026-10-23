import type { ChannelKind } from '@/assets/js/store/channels/types'

/** What main needs from the window to deliver a Notification (docs/adr/0003). */
export type NotificationConfig = {
  /** The title-bar master toggle is on and the Home Agent backend is running. */
  homeAgentEnabled: boolean
  notificationChannel: ChannelKind | null
}
