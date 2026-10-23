import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { PauseReason } from './kernelEvents'

/** Where a Notification goes, and whether it can go at all. */
export type NotificationRoute = {
  /** The title-bar master toggle is on and the Home Agent backend is running. */
  homeAgentEnabled: boolean
  notificationChannel: ChannelKind | null
}

/** Automatic Notification texts in the app language. */
export type NotificationTemplates = {
  /** `{title}` (a label), `{reason}` */
  paused: string
  /** `{kind}`, `{summary}` */
  pauseReason: string
  pauseKinds: Record<PauseReason['kind'], string>
  /** `{title}` (a label), `{error}` */
  failed: string
  /** The label of a session, quoted: `{title}` */
  sessionLabel: string
  /** The label of a Task run: `{task}`, `{step}`, `{steps}` */
  taskLabel: string
  /** The title of a session with no title. */
  untitled: string
}

/** What main needs from the window to deliver a Notification (docs/adr/0003). */
export type NotificationConfig = NotificationRoute & {
  /** Background Sessions notify when they pause or fail. */
  autoNotify: boolean
  /** The Agent Mode session open on screen; null while Agent Mode is not shown. */
  sessionInView: string | null
  templates: NotificationTemplates
}
