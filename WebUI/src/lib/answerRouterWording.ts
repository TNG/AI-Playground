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
}

// Only reached before the window has pushed its locale (tests, a reload mid-boot).
const ENGLISH: AnswerRouterCopy = {
  starting: '➡️ Sent to {title} — starting…',
  queued: '➡️ Sent to {title} — queued (position {position})',
  notSent: '⚠️ Not sent to {title}: {reason}',
  noSession: '⚠️ That session no longer exists',
  realShell: '🖥️ {title} uses the real system shell. Answer on your computer.',
  fixOnDesktop: 'Fix it in AI Playground on your computer, then answer again.',
  textOnly: '⚠️ Answers to agents can only be text for now',
  noSpeech: "🎙️ Couldn't make out any speech in that voice message, so nothing was sent.",
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
