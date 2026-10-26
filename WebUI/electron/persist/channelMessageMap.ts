import fs from 'node:fs/promises'
import { z } from 'zod'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { ChannelMessageOwner } from '@/types/notificationsIpc'
import { appLoggerInstance } from '../observability/logger'
import { atomicWriteJson, makeWriteChains, readJson } from './fsJsonStore'
import { getChannelMessageMapDemoFile, getChannelMessageMapFile } from './userDataPaths.ts'

/**
 * The kernel's channel message map: (channel kind, platform message reference) →
 * the agent session that sent it. An entry routes to its session as long as that
 * session lives; there is no time-based expiry, so a days-old Notification can still
 * be answered. Deleting a session ends that routing but keeps each entry as a tombstone
 * (no session id): dropping it would hand a later Answer to Home Agent as a plain message,
 * where the user must instead be told the session no longer exists.
 */

const LOG_SCOPE = 'channel-messages'

// A null session id marks a message of a session since deleted.
const EntrySchema = z.object({
  kind: z.string(),
  ref: z.string(),
  sessionId: z.string().nullable(),
})
const FileSchema = z.object({ schemaVersion: z.literal(1), entries: z.array(EntrySchema) })

type Entry = z.infer<typeof EntrySchema>

export type ChannelMessageMapDeps = {
  isDemoMode: () => boolean
}

let deps: ChannelMessageMapDeps | null = null

export function setChannelMessageMapDeps(next: ChannelMessageMapDeps): void {
  deps = next
}

const { serialize, clear: clearChains } = makeWriteChains()

const FILE_CHAIN = 'file'

function mapFile(): string {
  return deps?.isDemoMode() ? getChannelMessageMapDemoFile() : getChannelMessageMapFile()
}

// Losing the map only turns later Answers into Home Agent messages, so an unreadable
// file is started over rather than kept.
async function readEntries(): Promise<Entry[]> {
  const read = await readJson(mapFile(), LOG_SCOPE)
  if (read.status === 'missing') return []
  if (read.status === 'ok') {
    const parsed = FileSchema.safeParse(read.value)
    if (parsed.success) return parsed.data.entries
  }
  appLoggerInstance.warn('channel message map unreadable; starting over', LOG_SCOPE)
  return []
}

async function writeEntries(entries: Entry[]): Promise<void> {
  await atomicWriteJson(mapFile(), { schemaVersion: 1, entries })
}

export async function recordChannelMessage(
  kind: ChannelKind,
  ref: string,
  sessionId: string,
): Promise<void> {
  if (!ref || !sessionId) return
  return serialize(FILE_CHAIN, async () => {
    const entries = (await readEntries()).filter((e) => e.kind !== kind || e.ref !== ref)
    entries.push({ kind, ref, sessionId })
    await writeEntries(entries)
  })
}

/** Who sent this message: a live session, a deleted one, or null when no agent did. */
export async function channelMessageOwner(
  kind: ChannelKind,
  ref: string,
): Promise<ChannelMessageOwner | null> {
  const entries = await readEntries()
  const entry = entries.find((e) => e.kind === kind && e.ref === ref)
  if (!entry) return null
  return entry.sessionId ? { sessionId: entry.sessionId } : { deletedSession: true }
}

export async function forgetSessionMessages(sessionId: string): Promise<void> {
  return serialize(FILE_CHAIN, async () => {
    const entries = await readEntries()
    if (!entries.some((e) => e.sessionId === sessionId)) return
    await writeEntries(
      entries.map((e) => (e.sessionId === sessionId ? { ...e, sessionId: null } : e)),
    )
  })
}

export async function wipeDemoChannelMessageMap(): Promise<void> {
  try {
    await fs.rm(getChannelMessageMapDemoFile(), { force: true })
  } catch (error) {
    appLoggerInstance.warn(`demo channel message map wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetChannelMessageMapForTest(): void {
  deps = null
  clearChains()
}
