export type HarnessTurnEnd = 'cancelled' | 'failed'

type Metadata = { harnessTurnId?: unknown; harnessTurnEnd?: unknown }

function metadataOf(message: { metadata?: unknown }): Metadata {
  return typeof message.metadata === 'object' && message.metadata !== null
    ? (message.metadata as Metadata)
    : {}
}

/** The harness turn a display message came from, as main stamped it. */
export function harnessTurnIdOf(message: { metadata?: unknown }): string | undefined {
  const id = metadataOf(message).harnessTurnId
  return typeof id === 'string' ? id : undefined
}

/** How the harness turn a display message came from ended, once it settled. */
export function harnessTurnEndOf(message: { metadata?: unknown }): HarnessTurnEnd | undefined {
  const end = metadataOf(message).harnessTurnEnd
  return end === 'cancelled' || end === 'failed' ? end : undefined
}

/** Marks the newest harness turn's messages with how it ended, for its settled Turn to show. */
export function stampHarnessTurnEnd<M extends { metadata?: unknown }>(
  messages: readonly M[],
  end: HarnessTurnEnd,
): M[] {
  const turnId = messages
    .map(harnessTurnIdOf)
    .filter((id): id is string => id !== undefined)
    .at(-1)
  if (!turnId) return [...messages]
  return messages.map((message) =>
    harnessTurnIdOf(message) === turnId
      ? ({
          ...message,
          metadata: { ...(message.metadata as object | undefined), harnessTurnEnd: end },
        } as M)
      : message,
  )
}
