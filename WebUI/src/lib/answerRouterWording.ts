import english from '@/assets/i18n/en-US.json'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { answerGesture, GESTURE_WORDING } from '@/lib/answerButton'

/** What the Answer router tells the channel, and how answering is explained, in the app language. */
export type AnswerRouterCopy = {
  /** `{title}` (a session label) */
  starting: string
  /** `{title}`, `{position}` */
  queued: string
  /** `{title}`, `{reason}` */
  notSent: string
  noSession: string
  /** `{title}`; the Session is no longer reachable from Channels */
  unreachable: string
  /** `{title}` */
  realShell: string
  /** Follows `notSent` when the reason can only be fixed on the computer. */
  fixOnDesktop: string
  noSpeech: string
  /** A channel voice message dropped: no speech-to-text, its model declined, or `{error}` */
  voiceNoBackend: string
  voiceModelDeclined: string
  voiceFailed: string
  /** `{position}` (an ordinal), `{title}`, `{waitingFor}`; a message queued behind a busy Session */
  queuedMessage: string
  /** What a queued message waits for: the turn, or `{name}`, `{step}`, `{steps}` of an Agent Run */
  queueAfterTurn: string
  queueAfterAgentRun: string
  /** A line under the queued acknowledgement while the turn is paused */
  queueWaitsDownload: string
  queueWaitsDownloadElsewhere: string
  queueWaitsDesktop: string
  /** `{title}`, `{limit}` */
  queueFull: string
  /** `{title}`, `{count}`; told on each Channel whose queued messages were dropped */
  queueDroppedStopped: string
  queueDroppedUnreachable: string
  queueDroppedDeleted: string
  /** `/stop`: what it stopped (`{title}`; an Agent Run's `{name}`, `{step}`, `{steps}`) */
  stopTurn: string
  stopAgentRun: string
  /** `{count}`, the line under what `/stop` stopped */
  stopDropped: string
  /** `{title}` */
  stopNothing: string
  stopNoSession: string
  /** The `/help` line on answering agents, per channel gesture. */
  helpReply: string
  helpThread: string
  helpButton: string
  /** The setup screen's note on answering agents, per channel gesture. */
  noticeReply: string
  noticeThread: string
  noticeButton: string
  /** `{file}` refused before it reached a Session */
  fileTooLarge: string
  fileUnsupported: string
  /** `{title}`; its model cannot see the image sent to it */
  imagesUnseen: string
  /** `{title}`, `{files}`; a message carrying only documents runs no turn */
  documentsAttached: string
  /** `{file}`, `{error}` */
  attachFailed: string
  /** `/help`: its heading, one line per command, and where plain messages go */
  helpTitle: string
  helpSessions: string
  helpLoad: string
  helpNew: string
  helpStop: string
  helpAgents: string
  helpHelp: string
  helpPlain: string
  /** Above the `/sessions` buttons */
  sessionsPick: string
  sessionsNone: string
  /** `{title}` (a quoted Session title) */
  sessionLoaded: string
  sessionStarted: string
  /** `{n}`, what the user asked `/load` for */
  sessionNotFound: string
  /** The Channel Session was deleted or made unreachable since the last message */
  sessionLost: string
  /** `{reason}` */
  sessionNotCreated: string
  /** Above the `/agents` buttons */
  agentsPick: string
  agentsNone: string
  /** `{name}`, what the user asked `/agents` for */
  agentNotFound: string
  /** `{name}` (the Agent), `{title}` (a quoted Session title), `{reason}` */
  agentNotStarted: string
  /** Follows `agentNotStarted` when the reason can only be fixed on the computer. */
  agentFixOnDesktop: string
  /** `{name}` (the Agent), `{step}`, `{title}` (a quoted Session title), `{reason}` */
  agentStepRefused: string
  /** Under the `/agents` buttons: what ✎ does */
  agentsPromptHint: string
  /** `{name}` (the Agent), `{title}` (a quoted Session title); a Start Prompt Request */
  startPromptRequest: string
  /** `{name}`; Telegram's reply box hint on a Start Prompt Request */
  startPromptPlaceholder: string
  /** A Start Prompt Request once its reply started the Agent */
  startPromptUsed: string
  /** A later reply to a used Start Prompt Request */
  startPromptAlready: string
  /** A later reply to a Start Prompt Request whose start waits in the Session's queue */
  startPromptQueued: string
  /** A reply to a Start Prompt Request posted before the app restarted */
  startPromptExpired: string
  /** LAN chat's Answer button, which makes a Start Prompt Request answerable there */
  answerButton: string
  /** `{command}` */
  unknownCommand: string
  untitled: string
  /** A queue position in the app language: 2 → "2nd". */
  ordinal: (n: number) => string
}

const KEYS: Record<Exclude<keyof AnswerRouterCopy, 'ordinal'>, string> = {
  starting: 'AGENT_ANSWER_STARTING',
  queued: 'AGENT_ANSWER_QUEUED',
  notSent: 'AGENT_ANSWER_NOT_SENT',
  noSession: 'AGENT_ANSWER_NO_SESSION',
  unreachable: 'AGENT_ANSWER_UNREACHABLE',
  realShell: 'AGENT_ANSWER_REAL_SHELL',
  fixOnDesktop: 'AGENT_ANSWER_FIX_ON_DESKTOP',
  noSpeech: 'AGENT_ANSWER_NO_SPEECH',
  voiceNoBackend: 'CHANNEL_VOICE_NO_BACKEND',
  voiceModelDeclined: 'CHANNEL_VOICE_MODEL_DECLINED',
  voiceFailed: 'CHANNEL_VOICE_FAILED',
  queuedMessage: 'CHANNEL_QUEUED',
  queueAfterTurn: 'CHANNEL_QUEUE_AFTER_TURN',
  queueAfterAgentRun: 'CHANNEL_QUEUE_AFTER_AGENT_RUN',
  queueWaitsDownload: 'CHANNEL_QUEUE_WAITS_DOWNLOAD',
  queueWaitsDownloadElsewhere: 'CHANNEL_QUEUE_WAITS_DOWNLOAD_ELSEWHERE',
  queueWaitsDesktop: 'CHANNEL_QUEUE_WAITS_DESKTOP',
  queueFull: 'CHANNEL_QUEUE_FULL',
  queueDroppedStopped: 'CHANNEL_QUEUE_DROPPED_STOPPED',
  queueDroppedUnreachable: 'CHANNEL_QUEUE_DROPPED_UNREACHABLE',
  queueDroppedDeleted: 'CHANNEL_QUEUE_DROPPED_DELETED',
  stopTurn: 'CHANNEL_STOP_TURN',
  stopAgentRun: 'CHANNEL_STOP_AGENT_RUN',
  stopDropped: 'CHANNEL_STOP_DROPPED',
  stopNothing: 'CHANNEL_STOP_NOTHING',
  stopNoSession: 'CHANNEL_STOP_NO_SESSION',
  helpReply: 'AGENT_ANSWER_HELP_REPLY',
  helpThread: 'AGENT_ANSWER_HELP_THREAD',
  helpButton: 'AGENT_ANSWER_HELP_BUTTON',
  noticeReply: 'CHANNEL_NOTIFICATION_ANSWERABLE_REPLY',
  noticeThread: 'CHANNEL_NOTIFICATION_ANSWERABLE_THREAD',
  noticeButton: 'CHANNEL_NOTIFICATION_ANSWERABLE_BUTTON',
  fileTooLarge: 'CHANNEL_FILE_TOO_LARGE',
  fileUnsupported: 'CHANNEL_FILE_UNSUPPORTED',
  imagesUnseen: 'CHANNEL_IMAGES_UNSEEN',
  documentsAttached: 'CHANNEL_DOCUMENTS_ATTACHED',
  attachFailed: 'CHANNEL_ATTACH_FAILED',
  helpTitle: 'CHANNEL_HELP_TITLE',
  helpSessions: 'CHANNEL_HELP_SESSIONS',
  helpLoad: 'CHANNEL_HELP_LOAD',
  helpNew: 'CHANNEL_HELP_NEW',
  helpStop: 'CHANNEL_HELP_STOP',
  helpAgents: 'CHANNEL_HELP_AGENTS',
  helpHelp: 'CHANNEL_HELP_HELP',
  helpPlain: 'CHANNEL_HELP_PLAIN',
  sessionsPick: 'CHANNEL_SESSIONS_PICK',
  sessionsNone: 'CHANNEL_SESSIONS_NONE',
  sessionLoaded: 'CHANNEL_SESSION_LOADED',
  sessionStarted: 'CHANNEL_SESSION_STARTED',
  sessionNotFound: 'CHANNEL_SESSION_NOT_FOUND',
  sessionLost: 'CHANNEL_SESSION_LOST',
  sessionNotCreated: 'CHANNEL_SESSION_NOT_CREATED',
  agentsPick: 'CHANNEL_AGENTS_PICK',
  agentsNone: 'CHANNEL_AGENTS_NONE',
  agentNotFound: 'CHANNEL_AGENT_NOT_FOUND',
  agentNotStarted: 'CHANNEL_AGENT_NOT_STARTED',
  agentFixOnDesktop: 'CHANNEL_AGENT_FIX_ON_DESKTOP',
  agentStepRefused: 'CHANNEL_AGENT_STEP_REFUSED',
  agentsPromptHint: 'CHANNEL_AGENTS_PROMPT_HINT',
  startPromptRequest: 'CHANNEL_START_PROMPT_REQUEST',
  startPromptPlaceholder: 'CHANNEL_START_PROMPT_PLACEHOLDER',
  startPromptUsed: 'CHANNEL_START_PROMPT_USED',
  startPromptAlready: 'CHANNEL_START_PROMPT_ALREADY',
  startPromptQueued: 'CHANNEL_START_PROMPT_QUEUED',
  startPromptExpired: 'CHANNEL_START_PROMPT_EXPIRED',
  answerButton: 'AGENT_NOTIFY_ANSWER_BUTTON',
  unknownCommand: 'CHANNEL_UNKNOWN_COMMAND',
  untitled: 'SESSIONS_UNTITLED',
}

const ENGLISH_SUFFIXES: Record<string, string> = { one: 'st', two: 'nd', few: 'rd', other: 'th' }
const englishOrdinals = new Intl.PluralRules('en-US', { type: 'ordinal' })

/** `n` as a place in a queue, written the way `language` (an app locale) writes ordinals. */
export function ordinalIn(language: string, n: number): string {
  const base = language.split('-')[0]
  if (base === 'en') return `${n}${ENGLISH_SUFFIXES[englishOrdinals.select(n)]}`
  if (base === 'de' || base === 'pl' || base === 'tr') return `${n}.`
  if (base === 'zh' || base === 'ja') return `第${n}`
  if (base === 'ko') return `${n}번째`
  if (base === 'es' || base === 'it') return `${n}º`
  return `#${n}`
}

/** The router's copy in the language `text` holds (the window's i18n state). */
export function answerRouterCopyFrom(
  text: Record<string, string | undefined>,
  language = 'en-US',
): AnswerRouterCopy {
  const entries = Object.entries(KEYS).map(([field, key]) => [field, text[key] ?? ''])
  return {
    ...(Object.fromEntries(entries) as Omit<AnswerRouterCopy, 'ordinal'>),
    ordinal: (n) => ordinalIn(language, n),
  }
}

// Only reached before the window has pushed its locale (tests, a reload mid-boot).
const ENGLISH = answerRouterCopyFrom(english)

let provider: (() => AnswerRouterCopy) | null = null

export function registerAnswerRouterCopy(next: (() => AnswerRouterCopy) | null): void {
  provider = next
}

export function answerRouterCopy(): AnswerRouterCopy {
  const copy = provider?.()
  if (!copy) return ENGLISH
  const filled = { ...copy }
  for (const key of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
    if (!filled[key]) filled[key] = ENGLISH[key]
  }
  return filled
}

/** The `/help` line for `kind`, or null where agents cannot be answered. */
export function answerHelpLine(kind: ChannelKind): string | null {
  const gesture = answerGesture(kind)
  return gesture ? answerRouterCopy()[GESTURE_WORDING[gesture].help] : null
}

/** The setup screen's note on answering agents over `kind`, or null where they cannot be. */
export function answerableNotice(kind: ChannelKind): string | null {
  const gesture = answerGesture(kind)
  return gesture ? answerRouterCopy()[GESTURE_WORDING[gesture].notice] : null
}
