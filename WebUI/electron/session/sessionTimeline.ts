import { emitSessionChanged } from '../kernel/kernelBus'
import { listSessionFolders, readSessionFile } from '../persist/sessionFiles'
import { mutateSession, sessionDocumentOf } from './sessions'

type TimelineMessage = { id: string }

function idOf(message: unknown): string | undefined {
  const id = (message as Partial<TimelineMessage> | null)?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * Saves display messages into a Session's timeline: one it already holds is
 * replaced where it stands, a new one is appended. The renderer assembles a
 * turn's UI messages, so it is the one that saves them once the turn settles.
 */
export async function upsertTimelineMessages(
  sessionId: string,
  messages: TimelineMessage[],
): Promise<unknown[]> {
  const file = await mutateSession(sessionId, (current) => {
    const timeline = [...current.timeline]
    const at = new Map(timeline.map((message, index) => [idOf(message), index]))
    for (const message of messages) {
      const index = at.get(message.id)
      if (index === undefined) {
        at.set(message.id, timeline.length)
        timeline.push(message)
      } else {
        timeline[index] = message
      }
    }
    return { ...current, timeline }
  })
  // A change announced meanwhile carried the timeline it read; the window keeps the last one.
  emitSessionChanged(sessionDocumentOf(file))
  return file.timeline
}

/** Takes deleted display messages out of a Session's timeline. */
export async function removeTimelineMessages(
  sessionId: string,
  messageIds: string[],
): Promise<unknown[]> {
  const removed = new Set(messageIds)
  const file = await mutateSession(sessionId, (current) => ({
    ...current,
    timeline: current.timeline.filter((message) => !removed.has(idOf(message) ?? '')),
    // A message that leaves the timeline takes its hidden mark with it.
    hiddenMessageIds: current.hiddenMessageIds.filter((id) => !removed.has(id)),
  }))
  return file.timeline
}

type TurnStampedMessage = {
  metadata?: {
    harnessTurnId?: unknown
    agentTurn?: { harnessSessionId?: unknown } | undefined
  }
}

/** The answers one Harness turn wrote into the timeline; its prompt is not one of them. */
function answersOfTurn(message: unknown, harnessSessionId: string, turnId: string): boolean {
  const metadata = (message as TurnStampedMessage | null)?.metadata
  return (
    metadata?.harnessTurnId === turnId && metadata.agentTurn?.harnessSessionId === harnessSessionId
  )
}

/**
 * Takes the answers a rewound turn left in a Session's timeline out of the file:
 * a regenerate dropped them from what the model sees, and main — not a
 * fire-and-forget from the renderer — owns that they go whatever the re-run did.
 */
export async function removeTimelineMessagesOfTurn(
  sessionId: string,
  harnessSessionId: string,
  turnId: string,
): Promise<unknown[]> {
  const file = await mutateSession(sessionId, (current) => {
    const gone = new Set(
      current.timeline
        .filter((message) => answersOfTurn(message, harnessSessionId, turnId))
        .map((message) => idOf(message) ?? ''),
    )
    if (gone.size === 0) return current
    return {
      ...current,
      timeline: current.timeline.filter((message) => !gone.has(idOf(message) ?? '')),
      hiddenMessageIds: current.hiddenMessageIds.filter((id) => !gone.has(id)),
    }
  })
  return file.timeline
}

/** Ids not in the file yet are kept too, so a live turn hides once it settles. */
export async function addHiddenMessages(sessionId: string, messageIds: string[]): Promise<void> {
  const hidden = new Set(messageIds)
  let changed = false
  const file = await mutateSession(sessionId, (current) => {
    const next = [...new Set([...current.hiddenMessageIds, ...hidden])]
    const same =
      next.length === current.hiddenMessageIds.length &&
      next.every((id, index) => current.hiddenMessageIds[index] === id)
    if (same) return current
    changed = true
    return { ...current, hiddenMessageIds: next }
  })
  if (changed) emitSessionChanged(sessionDocumentOf(file))
}

/** Brings every hidden message of one Session back into its timeline view. */
export async function clearHiddenMessages(sessionId: string): Promise<void> {
  let changed = false
  const file = await mutateSession(sessionId, (current) => {
    if (current.hiddenMessageIds.length === 0) return current
    changed = true
    return { ...current, hiddenMessageIds: [] }
  })
  if (changed) emitSessionChanged(sessionDocumentOf(file))
}

/** Brings every hidden message of every Session back into its timeline view. */
export async function clearAllHiddenMessages(): Promise<void> {
  const folders = await listSessionFolders()
  await Promise.all(
    folders.map(async ({ id }) => {
      // A cheap skip only: clearHiddenMessages decides again under the Session's write lock.
      const read = await readSessionFile(id)
      if (read.status !== 'ok' || read.file.hiddenMessageIds.length === 0) return
      await clearHiddenMessages(id)
    }),
  )
}
