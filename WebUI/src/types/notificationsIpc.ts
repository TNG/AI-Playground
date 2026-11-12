import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { PauseReason } from './kernelEvents'

/** The Harness Session an Answer runs in, and the Session it belongs to. */
export type AnswerTarget = { sessionRef: string; harnessSessionId: string }

/** Who sent a channel message: a live Harness Session, or one that has since been deleted. */
export type SessionMessageOwner = AnswerTarget | { deletedSession: true }

/** A posted Start Prompt Request, which the message map records with no Session. */
export type StartPromptRequestOwner = { startPromptRequest: true }

/** A live Trial Run that sent a channel message: its Harness Session and its Agent (ADR 0011). */
export type TrialRunOwner = { trialRun: true; harnessSessionId: string; agentId: string }

/** A Trial Run thrown away since it sent the message: by the next one, a discard, or a restart. */
export type ThrownAwayTrialRun = { thrownAwayTrialRun: true; agentId: string }

export type TrialRunMessageOwner = TrialRunOwner | ThrownAwayTrialRun

/** A channel message in the message map: a Session's, a Trial Run's, or a Start Prompt Request. */
export type ChannelMessageOwner =
  SessionMessageOwner | TrialRunMessageOwner | StartPromptRequestOwner

export function isStartPromptRequest(owner: ChannelMessageOwner): owner is StartPromptRequestOwner {
  return 'startPromptRequest' in owner
}

export function isTrialRunMessage(owner: ChannelMessageOwner): owner is TrialRunMessageOwner {
  return 'trialRun' in owner || 'thrownAwayTrialRun' in owner
}

/** Automatic Notification texts in the app language. */
export type NotificationTemplates = {
  /** First line of every agent's Notification: `{title}` (a label) */
  header: string
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
  /** Label of the 💬 Answer button under an answerable Notification. */
  answerButton: string
  /** Last line of a Notification from a session that cannot be answered remotely. */
  answerOnComputer: string
  /** Last line of an answerable Notification on a channel answered by replying in its thread. */
  answerInThread: string
  /** Last line of an answerable Notification on a channel answered by replying to the message. */
  answerByReply: string
  /** Told on each Channel whose queued messages a quit drops: `{count}` */
  queueDroppedOnQuit: string
  /** An Agent Run a Channel started: `{name}` (the Agent), `{title}` (the Session's label) */
  agentStarted: string
  /** The label of a Trial Run's Notification: `{agent}` (the Agent's name) */
  trialRunLabel: string
}

/** What main needs from the window to deliver a Notification (docs/adr/0010). */
export type NotificationConfig = {
  /** The enabled, verified Channels; empty while the Channels toggle is off. */
  channels: ChannelKind[]
  /** The Session open in the window, shown or not; null when none is. */
  sessionOnScreen: string | null
  /** The Harness Session of the Trial Run the Agent Library shows, shown or not; null when none. */
  trialRunInView: string | null
  /** Harness Sessions whose folder uses the real system shell; Answers to them are refused. */
  realShellSessions: string[]
  templates: NotificationTemplates
}
