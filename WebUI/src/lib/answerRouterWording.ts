/** What the Answer router tells the channel, in the app language. */
export type AnswerRouterCopy = {
  /** `{title}` (a session label) */
  starting: string
  /** `{title}`, `{position}` */
  queued: string
  /** `{title}`, `{reason}` */
  notSent: string
  /** The Answer Prompt the 💬 Answer button opens: `{title}` */
  answerPrompt: string
  /** The input placeholder while replying to an Answer Prompt: `{title}` */
  answerPlaceholder: string
  /** The Answer button was tapped under a message of a deleted session. */
  sessionGone: string
}

// Only reached before the window has pushed its locale (tests, a reload mid-boot).
const ENGLISH: AnswerRouterCopy = {
  starting: '➡️ Sent to {title} — starting…',
  queued: '➡️ Sent to {title} — queued (position {position})',
  notSent: '⚠️ Not sent to {title}: {reason}',
  answerPrompt: 'Your message to {title}:',
  answerPlaceholder: 'Message to {title}',
  sessionGone: '⚠️ That session no longer exists',
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
