import type { ChannelKind } from './types'

/** Queued messages a Session takes from every Channel together, before the next is refused. */
export const CHANNEL_QUEUE_LIMIT = 10

/** What a Channel message gives the turn it starts; combined when several run as one. */
export type ChannelTurnMessage = { text: string }

/** One queued message as the desktop shows it: a queued bubble labelled with its Channel. */
export type QueuedChannelMessage = { id: string; channel: ChannelKind; text: string }

export type QueuedEntry<T> = {
  id: string
  channel: ChannelKind
  /** Entries of one Channel with the same key run as one turn; a unique key runs alone. */
  batchKey: string
  /** What the desktop's queued bubble shows. */
  preview: string
  item: T
}

export type ChannelQueue<T> = {
  /** Its 1-based place in the Session's queue, or null when the Session's queue is full. */
  add: (sessionRef: string, entry: Omit<QueuedEntry<T>, 'id'>) => number | null
  size: (sessionRef: string) => number
  /** The oldest entry's Channel and key, taken out with every later entry that shares them. */
  takeBatch: (sessionRef: string) => QueuedEntry<T>[]
  /** A batch that could not start goes back to the front, in its order. */
  putBack: (sessionRef: string, batch: QueuedEntry<T>[]) => void
  drop: (sessionRef: string) => QueuedEntry<T>[]
  sessionRefs: () => string[]
}

export type ChannelQueueOptions = {
  limit?: number
  newId?: () => string
  /** The Session's queue changed; an empty list when it emptied. */
  onChange?: (sessionRef: string, queued: QueuedChannelMessage[]) => void
}

/** The router's in-memory queue per Session (ADR 0002: nothing queued survives a restart). */
export function createChannelQueue<T>(options: ChannelQueueOptions = {}): ChannelQueue<T> {
  const limit = options.limit ?? CHANNEL_QUEUE_LIMIT
  let counter = 0
  const newId = options.newId ?? (() => `queued-${++counter}`)
  const queues = new Map<string, QueuedEntry<T>[]>()

  function set(sessionRef: string, entries: QueuedEntry<T>[]): void {
    if (entries.length > 0) queues.set(sessionRef, entries)
    else queues.delete(sessionRef)
    options.onChange?.(
      sessionRef,
      entries.map(({ id, channel, preview }) => ({ id, channel, text: preview })),
    )
  }

  const of = (sessionRef: string) => queues.get(sessionRef) ?? []

  return {
    add: (sessionRef, entry) => {
      const entries = of(sessionRef)
      if (entries.length >= limit) return null
      set(sessionRef, [...entries, { ...entry, id: newId() }])
      return entries.length + 1
    },
    size: (sessionRef) => of(sessionRef).length,
    takeBatch: (sessionRef) => {
      const entries = of(sessionRef)
      const first = entries[0]
      if (!first) return []
      const joins = (entry: QueuedEntry<T>) =>
        entry.channel === first.channel && entry.batchKey === first.batchKey
      set(
        sessionRef,
        entries.filter((entry) => !joins(entry)),
      )
      return entries.filter(joins)
    },
    putBack: (sessionRef, batch) => {
      if (batch.length > 0) set(sessionRef, [...batch, ...of(sessionRef)])
    },
    drop: (sessionRef) => {
      const entries = of(sessionRef)
      if (entries.length > 0) set(sessionRef, [])
      return entries
    },
    sessionRefs: () => [...queues.keys()],
  }
}

/** Several queued messages of one Channel, as the one turn they start. */
export function combineMessages(messages: readonly ChannelTurnMessage[]): ChannelTurnMessage {
  return { text: messages.map((message) => message.text).join('\n\n') }
}
