/** What the Answer router tells the channel, in the app language. */
export type AnswerRouterCopy = {
  /** `{title}` (a session label) */
  starting: string
  /** `{title}`, `{position}` */
  queued: string
  /** `{title}`, `{reason}` */
  notSent: string
  /** `{title}`; an Answer held until the session's turn ends */
  held: string
  /** `{title}`; held while the turn waits for the download buttons in the channel */
  heldDownload: string
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
  /** Shown once, after the first Answer: how Home Agent and agents share the channel. */
  onboarding: string
  /** The `/help` line on answering agents. */
  help: string
}

// Only reached before the window has pushed its locale (tests, a reload mid-boot).
const ENGLISH: AnswerRouterCopy = {
  starting: '➡️ Sent to {title} — starting…',
  queued: '➡️ Sent to {title} — queued (position {position})',
  notSent: '⚠️ Not sent to {title}: {reason}',
  held: '⏳ Queued for {title} — it is sent when the current turn ends.',
  heldDownload: '⏳ Queued for {title} — the session is waiting for the download buttons above.',
  heldDesktop: '⏳ Queued for {title} — the session is waiting on your computer.',
  heldReplaced: 'It replaces your earlier Answer, which will not be sent.',
  heldReplacedElsewhere: '⚠️ Not sent to {title}: a newer Answer replaced it.',
  heldDesktopTookOver: '⚠️ Not sent to {title}: the desktop took over.',
  heldSessionGone: '⚠️ Not sent to {title}: that session no longer exists.',
  heldAppClosed: '⚠️ Not sent to {title}: AI Playground closed before it could be sent.',
  onboarding:
    '💡 Plain messages go to Home Agent. To talk to an agent, reply to its message (or tap 💬 Answer).',
  help: 'To answer an agent, reply to its message or tap 💬 Answer. Plain messages go to Home Agent.',
}

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
