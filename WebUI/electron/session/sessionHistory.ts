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
import {
  HistoryEntrySchema,
  type HistoryArtifact,
  type HistoryEntry,
  type OverviewSummaryUpdateRow,
  type SessionLastPreset,
} from '@/types/sessionIpc'

const LOG_SCOPE = 'sessions'

export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'timestamp'>

/** Appends one History Entry on the Session's write chain. */
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

/** Rewrites one History Entry in place on the Session's write chain; undefined when none matched. */
export async function updateHistoryEntry(
  sessionId: string,
  entryId: string,
  patch: Partial<HistoryEntry>,
): Promise<HistoryEntry | undefined> {
  assertSessionId(sessionId)
  return serializeSession(sessionId, async () => {
    const lines = (await readHistoryFile(sessionId))
      .split('\n')
      .filter((line) => line.trim() !== '')
    let updated: HistoryEntry | undefined
    const next = lines.map((line) => {
      try {
        const parsed = HistoryEntrySchema.safeParse(JSON.parse(line))
        if (!parsed.success || parsed.data.id !== entryId) return line
        updated = HistoryEntrySchema.parse({ ...parsed.data, ...patch })
        return JSON.stringify(updated)
      } catch {
        return line
      }
    })
    if (updated) await writeHistoryLines(sessionId, next)
    return updated
  })
}

/** The entries whose turns recorded an Overview Summary update outcome. */
export async function historyOverviewUpdates(
  sessionId: string,
): Promise<OverviewSummaryUpdateRow[]> {
  const entries = await readHistoryEntries(sessionId)
  const place = new Map(
    entries.map((entry, index) => [entry.id, { at: entry.timestamp, number: index + 1 }]),
  )
  return entries.flatMap((entry) => {
    if (!entry.overviewUpdate) return []
    const coveredEntryId = entry.overviewUpdate.coveredEntryId
    const covered = coveredEntryId ? place.get(coveredEntryId) : undefined
    return [
      {
        entryId: entry.id,
        kind: entry.kind,
        prompt: entry.prompt,
        ...(entry.harnessSessionId ? { harnessSessionId: entry.harnessSessionId } : {}),
        update: entry.overviewUpdate,
        ...(covered ? { covered } : {}),
      },
    ]
  })
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

/**
 * Removes every History Entry of the given Harness turns — those stamped with
 * their `turnId` — so deleted or regenerated work stays out of later Session
 * Updates and `session_history`. Entries from before `turnId` was recorded
 * cannot be matched and stay. Returns how many went.
 */
export async function removeHistoryEntries(
  sessionId: string,
  harnessSessionId: string,
  turnIds: ReadonlySet<string>,
): Promise<number> {
  assertSessionId(sessionId)
  return serializeSession(sessionId, async () => {
    const lines = (await readHistoryFile(sessionId))
      .split('\n')
      .filter((line) => line.trim() !== '')
    const slots: { entry: HistoryEntry; removed: boolean }[] = []
    let removedAny = false
    const keep = lines.map((line) => {
      let entry: HistoryEntry | undefined
      try {
        const parsed = HistoryEntrySchema.safeParse(JSON.parse(line))
        if (parsed.success) entry = parsed.data
        else appLoggerInstance.warn(`history entry failed schema (${sessionId})`, LOG_SCOPE)
      } catch {
        appLoggerInstance.warn(`unreadable history line (${sessionId})`, LOG_SCOPE)
      }
      const removed =
        entry !== undefined &&
        entry.harnessSessionId === harnessSessionId &&
        entry.turnId !== undefined &&
        turnIds.has(entry.turnId)
      if (entry) slots.push({ entry, removed })
      removedAny ||= removed
      return !removed
    })
    if (!removedAny) return 0
    await writeHistoryLines(
      sessionId,
      lines.filter((_, index) => keep[index]),
    )
    const removedIds = new Set(slots.filter((slot) => slot.removed).map((slot) => slot.entry.id))
    const read = await readSessionFile(sessionId)
    if (read.status !== 'ok') return removedIds.size
    const stale = Object.entries(read.file.updateCursors).filter(([, id]) => removedIds.has(id))
    if (stale.length === 0) return removedIds.size
    // A cursor on a removed entry moves back to the nearest surviving one
    // before it, or is dropped when nothing precedes it.
    const cursors = { ...read.file.updateCursors }
    for (const [key, id] of stale) {
      const at = slots.findIndex((slot) => slot.entry.id === id)
      let previous: string | undefined
      for (let index = at - 1; index >= 0; index--) {
        if (!slots[index].removed) {
          previous = slots[index].entry.id
          break
        }
      }
      if (previous) cursors[key] = previous
      else delete cursors[key]
    }
    await writeSessionFile({ ...read.file, updateCursors: cursors })
    return removedIds.size
  })
}

/**
 * Rewrites every Artifact reference through `change`, in one write; a line that does not parse
 * stays as it was. Call it on the Session's write chain: it does not take the chain itself.
 */
export async function rewriteHistoryArtifacts(
  sessionId: string,
  change: (artifact: HistoryArtifact) => HistoryArtifact,
): Promise<void> {
  const raw = await readHistoryFile(sessionId)
  let changed = false
  const lines = raw.split('\n').map((line) => {
    if (!line.trim()) return line
    try {
      const parsed = HistoryEntrySchema.safeParse(JSON.parse(line))
      if (!parsed.success) return line
      const artifacts = parsed.data.artifacts.map(change)
      if (artifacts.every((artifact, index) => artifact === parsed.data.artifacts[index])) {
        return line
      }
      changed = true
      return JSON.stringify({ ...parsed.data, artifacts })
    } catch {
      return line
    }
  })
  if (changed) {
    await writeHistoryLines(
      sessionId,
      lines.filter((line) => line.trim() !== ''),
    )
  }
}

/** The preset and variant of the newest entry, which opening the Session switches back to. */
export async function lastTurnPreset(sessionId: string): Promise<SessionLastPreset | null> {
  const last = (await readHistoryEntries(sessionId)).at(-1)
  if (!last) return null
  return last.variant ? { preset: last.preset, variant: last.variant } : { preset: last.preset }
}
