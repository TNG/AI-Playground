import english from '@/assets/i18n/en-US.json'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { answerGesture, type AnswerGesture } from '@/lib/answerButton'

/** What the Answer router tells the channel, in the app language. */
export type AnswerRouterCopy = {
  /** `{title}` (a session label) */
  starting: string
  /** `{title}`, `{position}` */
  queued: string
  /** `{title}`, `{reason}` */
  notSent: string
  noSession: string
  /** `{title}` */
  realShell: string
  /** Follows `notSent` when the reason can only be fixed on the computer. */
  fixOnDesktop: string
  textOnly: string
  noSpeech: string
  /** `{title}`; an Answer held until the session's turn ends */
  held: string
  /** `{title}`; held while the turn waits for the download buttons in the channel */
  heldDownload: string
  /** `{title}`; held while the download is asked on another channel and on the computer */
  heldDownloadElsewhere: string
  /** `{title}`; held while the turn waits on the computer */
  heldDesktop: string
  /** A line under the held confirmation when it replaced an earlier Held Answer */
  heldReplaced: string
  /** `{title}`; the earlier Held Answer, told on its own channel when the newer came elsewhere */
  heldReplacedElsewhere: string
  /** `{title}`; the turn was stopped, or the Held Answer discarded, on the desktop */
  heldDesktopTookOver: string
  /** `{title}`; the session was deleted while the Answer was held */
  heldSessionGone: string
  /** `{title}`; told on the next start */
  heldAppClosed: string
  /** The `/help` line on answering agents, per channel gesture. */
  helpReply: string
  helpThread: string
  helpButton: string
}

const KEYS: Record<keyof AnswerRouterCopy, string> = {
  starting: 'AGENT_ANSWER_STARTING',
  queued: 'AGENT_ANSWER_QUEUED',
  notSent: 'AGENT_ANSWER_NOT_SENT',
  noSession: 'AGENT_ANSWER_NO_SESSION',
  realShell: 'AGENT_ANSWER_REAL_SHELL',
  fixOnDesktop: 'AGENT_ANSWER_FIX_ON_DESKTOP',
  textOnly: 'AGENT_ANSWER_TEXT_ONLY',
  noSpeech: 'AGENT_ANSWER_NO_SPEECH',
  held: 'AGENT_ANSWER_HELD',
  heldDownload: 'AGENT_ANSWER_HELD_DOWNLOAD',
  heldDownloadElsewhere: 'AGENT_ANSWER_HELD_DOWNLOAD_ELSEWHERE',
  heldDesktop: 'AGENT_ANSWER_HELD_DESKTOP',
  heldReplaced: 'AGENT_ANSWER_HELD_REPLACED',
  heldReplacedElsewhere: 'AGENT_ANSWER_HELD_REPLACED_ELSEWHERE',
  heldDesktopTookOver: 'AGENT_ANSWER_HELD_DESKTOP_TOOK_OVER',
  heldSessionGone: 'AGENT_ANSWER_HELD_SESSION_GONE',
  heldAppClosed: 'AGENT_ANSWER_HELD_APP_CLOSED',
  helpReply: 'AGENT_ANSWER_HELP_REPLY',
  helpThread: 'AGENT_ANSWER_HELP_THREAD',
  helpButton: 'AGENT_ANSWER_HELP_BUTTON',
}

/** The router's copy in the language `text` holds (the window's i18n state). */
export function answerRouterCopyFrom(text: Record<string, string | undefined>): AnswerRouterCopy {
  const entries = Object.entries(KEYS).map(([field, key]) => [field, text[key] ?? ''])
  return Object.fromEntries(entries) as AnswerRouterCopy
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
  for (const key of Object.keys(ENGLISH) as (keyof AnswerRouterCopy)[]) {
    if (!filled[key]) filled[key] = ENGLISH[key]
  }
  return filled
}

const HELP_FIELD: Record<AnswerGesture, 'helpReply' | 'helpThread' | 'helpButton'> = {
  reply: 'helpReply',
  thread: 'helpThread',
  button: 'helpButton',
}

/** The `/help` line for `kind`, or null where agents cannot be answered. */
export function answerHelpLine(kind: ChannelKind): string | null {
  const gesture = answerGesture(kind)
  return gesture ? answerRouterCopy()[HELP_FIELD[gesture]] : null
}

const NOTICE_KEY: Record<AnswerGesture, string> = {
  reply: 'HOME_AGENT_NOTIFICATION_ANSWERABLE_REPLY',
  thread: 'HOME_AGENT_NOTIFICATION_ANSWERABLE_THREAD',
  button: 'HOME_AGENT_NOTIFICATION_ANSWERABLE_BUTTON',
}

/** The setup screen's note on answering agents over `kind`, in the language `text` holds. */
export function answerableNotice(
  kind: ChannelKind,
  text: Record<string, string | undefined>,
): string | null {
  const gesture = answerGesture(kind)
  if (!gesture) return null
  const key = NOTICE_KEY[gesture]
  return text[key] || (english as Record<string, string>)[key]
}
