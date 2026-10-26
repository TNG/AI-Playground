/** What the Answer router tells the channel, in the app language. */
export type AnswerRouterCopy = {
  /** `{title}` (a session label) */
  starting: string
  /** `{title}`, `{position}` */
  queued: string
  /** `{title}`, `{reason}` */
  notSent: string
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
