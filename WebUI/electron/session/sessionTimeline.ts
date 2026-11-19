import { emitSessionChanged } from '../kernel/kernelBus'
import { mutateSession, sessionDocumentOf } from './sessions'

type TimelineMessage = { id: string }

function idOf(message: unknown): string | undefined {
  const id = (message as Partial<TimelineMessage> | null)?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * Saves display messages into a Session's timeline: one it already holds is
 * replaced where it stands, a new one is appended. The renderer assembles a
 * turn's UI messages, so it is the one that saves them once the turn settles —
 * and every other window (a remote-kernel client, or the workstation when the
 * client ran the turn) only learns the settled reply from this push.
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
  }))
  emitSessionChanged(sessionDocumentOf(file))
  return file.timeline
}
