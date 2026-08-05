export type ReasoningTiming = { startedAt: number; finishedAt?: number }

type ReasoningMessage = {
  id: string
  parts?: readonly { type: string; state?: string }[]
}

/** Part positions are stable within a message; the message id keeps them apart. */
export function reasoningTimingKey(messageId: string, partIndex: number): string {
  return `${messageId}:${partIndex}`
}

/**
 * Reasoning parts carry a `state` but no wall clock, so the view records when it
 * first saw each one and how long it ran.
 *
 * Only a block seen streaming during a live turn gets a start, so no duration is
 * ever invented: a restored transcript would otherwise be stamped with "now",
 * both inventing timings for history and handing them to the next turn — keys
 * used to be positional, so a brand-new "Hi!" inherited the start of the
 * reasoning block that sat at the same position before it and claimed 15 minutes
 * of thinking. Finishing an already-started block is always allowed, since a
 * turn can settle after it stops being live.
 */
export function trackReasoningTimings(
  timings: Record<string, ReasoningTiming>,
  message: ReasoningMessage,
  options: { live: boolean; now?: () => number },
): void {
  const now = options.now ?? Date.now
  message.parts?.forEach((part, partIndex) => {
    if (part.type !== 'reasoning') return
    const key = reasoningTimingKey(message.id, partIndex)
    const timing = timings[key]
    if (!timing) {
      if (options.live && part.state === 'streaming') timings[key] = { startedAt: now() }
      return
    }
    if (part.state !== 'streaming' && timing.finishedAt === undefined) timing.finishedAt = now()
  })
}
