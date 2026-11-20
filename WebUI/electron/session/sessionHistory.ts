import { randomUUID } from 'node:crypto'
import { appLoggerInstance } from '../observability/logger'
import {
  appendHistoryLine,
  assertSessionId,
  readHistoryFile,
  readSessionFile,
  serializeSession,
  writeHistoryLines,
  writeSessionFile,
} from '../persist/sessionFiles'
import { HistoryEntrySchema, type HistoryEntry, type SessionLastPreset } from '@/types/sessionIpc'

const LOG_SCOPE = 'sessions'

export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'timestamp'>

/** Appends one History Entry on the Session's write chain; earlier lines are never touched. */
export async function appendHistoryEntry(
  sessionId: string,
  entry: NewHistoryEntry,
): Promise<HistoryEntry> {
  assertSessionId(sessionId)
  return serializeSession(sessionId, async () => {
    const written = HistoryEntrySchema.parse({
      ...entry,
      id: `entry-${randomUUID()}`,
      timestamp: Date.now(),
    })
    await appendHistoryLine(sessionId, JSON.stringify(written))
    return written
  })
}

/** Every readable entry in append order; a torn or foreign line is skipped. */
export async function readHistoryEntries(sessionId: string): Promise<HistoryEntry[]> {
  const raw = await readHistoryFile(sessionId)
  const entries: HistoryEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = HistoryEntrySchema.safeParse(JSON.parse(line))
      if (parsed.success) entries.push(parsed.data)
      else appLoggerInstance.warn(`history entry failed schema (${sessionId})`, LOG_SCOPE)
    } catch {
      appLoggerInstance.warn(`unreadable history line (${sessionId})`, LOG_SCOPE)
    }
  }
  return entries
}

/**
 * A Session Update cursor on the removed entry moves back one entry (or is dropped), so its
 * consumer is not reset to the whole history. False when no entry matched.
 */
export async function removeHistoryEntry(sessionId: string, entryId: string): Promise<boolean> {
  assertSessionId(sessionId)
  return serializeSession(sessionId, async () => {
    const lines = (await readHistoryFile(sessionId))
      .split('\n')
      .filter((line) => line.trim() !== '')
    const entries: HistoryEntry[] = []
    let lineAt = -1
    for (let index = 0; index < lines.length; index++) {
      try {
        const parsed = HistoryEntrySchema.safeParse(JSON.parse(lines[index]))
        if (!parsed.success) {
          appLoggerInstance.warn(`history entry failed schema (${sessionId})`, LOG_SCOPE)
          continue
        }
        if (parsed.data.id === entryId) lineAt = index
        entries.push(parsed.data)
      } catch {
        appLoggerInstance.warn(`unreadable history line (${sessionId})`, LOG_SCOPE)
      }
    }
    if (lineAt < 0) return false
    await writeHistoryLines(
      sessionId,
      lines.filter((_, index) => index !== lineAt),
    )
    const at = entries.findIndex((entry) => entry.id === entryId)
    const previous = at > 0 ? entries[at - 1].id : undefined
    const read = await readSessionFile(sessionId)
    if (read.status !== 'ok') return true
    const stale = Object.entries(read.file.updateCursors).filter(([, id]) => id === entryId)
    if (stale.length === 0) return true
    const cursors = { ...read.file.updateCursors }
    for (const [key] of stale) {
      if (previous) cursors[key] = previous
      else delete cursors[key]
    }
    await writeSessionFile({ ...read.file, updateCursors: cursors })
    return true
  })
}

/** The preset and variant of the newest entry, which opening the Session switches back to. */
export async function lastTurnPreset(sessionId: string): Promise<SessionLastPreset | null> {
  const last = (await readHistoryEntries(sessionId)).at(-1)
  if (!last) return null
  return last.variant ? { preset: last.preset, variant: last.variant } : { preset: last.preset }
}
