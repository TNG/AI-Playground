import fs from 'node:fs/promises'
import { z } from 'zod'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { AnswerTarget, ChannelMessageOwner } from '@/types/notificationsIpc'
import { appLoggerInstance } from '../observability/logger'
import { atomicWriteJson, makeWriteChains, readJson } from './fsJsonStore'
import { getChannelMessageMapDemoFile, getChannelMessageMapFile } from './userDataPaths.ts'

/**
 * The kernel's channel message map: (channel kind, platform message reference) →
 * the Session and Harness Session that sent it. An entry routes there as long as that
 * Harness Session lives; there is no time-based expiry, so a days-old Notification can still
 * be answered. Deleting ends that routing but keeps each entry as a tombstone (no owner):
 * dropping it would route a later Answer as a plain message, where the user
 * must instead be told the session no longer exists. A Start Prompt Request is recorded too, with
 * no Session, so a reply to one from before a restart can be told it has expired.
 */

const LOG_SCOPE = 'channel-messages'

const OwnerSchema = z.object({ sessionRef: z.string(), harnessSessionId: z.string() })
const StartPromptRequestSchema = z.object({ startPromptRequest: z.literal(true) })
const EntrySchema = z.object({
  kind: z.string(),
  ref: z.string(),
  owner: z.union([OwnerSchema, StartPromptRequestSchema]).nullable(),
})
const FileSchema = z.object({ schemaVersion: z.literal(2), entries: z.array(EntrySchema) })

// Before Sessions owned these messages, an entry named only its Harness Session.
const LegacyFileSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(
    z.object({ kind: z.string(), ref: z.string(), sessionId: z.string().nullable() }),
  ),
})

type Entry = z.infer<typeof EntrySchema>
type Owner = NonNullable<Entry['owner']>

export type ChannelMessageMapDeps = {
  isDemoMode: () => boolean
  /** Every Harness Session id → its Session, for migrating entries that named only the former. */
  harnessSessionOwners: () => Promise<Map<string, string>>
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

// Losing the map only turns later Answers into plain messages, so an unreadable
// file is started over rather than kept. Only called on the file chain.
async function readEntries(): Promise<Entry[]> {
  const read = await readJson(mapFile(), LOG_SCOPE)
  if (read.status === 'missing') return []
  if (read.status === 'ok') {
    const parsed = FileSchema.safeParse(read.value)
    if (parsed.success) return parsed.data.entries
    const legacy = LegacyFileSchema.safeParse(read.value)
    if (legacy.success) return migrate(legacy.data.entries)
  }
  appLoggerInstance.warn('channel message map unreadable; starting over', LOG_SCOPE)
  return []
}

/** A Harness Session no Session holds any more becomes a tombstone. */
async function migrate(legacy: z.infer<typeof LegacyFileSchema>['entries']): Promise<Entry[]> {
  if (!deps) throw new Error('channel message map migrated before Sessions can be read')
  const owners = await deps.harnessSessionOwners()
  const entries = legacy.map(({ kind, ref, sessionId }): Entry => {
    const sessionRef = sessionId ? owners.get(sessionId) : undefined
    return {
      kind,
      ref,
      owner: sessionId && sessionRef ? { sessionRef, harnessSessionId: sessionId } : null,
    }
  })
  await writeEntries(entries)
  return entries
}

async function writeEntries(entries: Entry[]): Promise<void> {
  await atomicWriteJson(mapFile(), { schemaVersion: 2, entries })
}

async function record(kind: ChannelKind, ref: string, owner: Owner): Promise<void> {
  return serialize(FILE_CHAIN, async () => {
    const entries = (await readEntries()).filter((e) => e.kind !== kind || e.ref !== ref)
    entries.push({ kind, ref, owner })
    await writeEntries(entries)
  })
}

export async function recordChannelMessage(
  kind: ChannelKind,
  ref: string,
  owner: AnswerTarget,
): Promise<void> {
  if (!ref || !owner.sessionRef || !owner.harnessSessionId) return
  return record(kind, ref, owner)
}

/** Only to recognize a reply to it after a restart, when the request itself is forgotten. */
export async function recordStartPromptRequest(kind: ChannelKind, ref: string): Promise<void> {
  if (!ref) return
  return record(kind, ref, { startPromptRequest: true })
}

/** Who sent this message: a Harness Session, a deleted one, a Start Prompt Request, or null. */
export async function channelMessageOwner(
  kind: ChannelKind,
  ref: string,
): Promise<ChannelMessageOwner | null> {
  return serialize(FILE_CHAIN, async () => {
    const entry = (await readEntries()).find((e) => e.kind === kind && e.ref === ref)
    if (!entry) return null
    return entry.owner ? { ...entry.owner } : { deletedSession: true }
  })
}

async function tombstone(owned: (owner: AnswerTarget) => boolean): Promise<void> {
  const hit = (owner: Owner | null) => !!owner && 'sessionRef' in owner && owned(owner)
  return serialize(FILE_CHAIN, async () => {
    const entries = await readEntries()
    if (!entries.some((e) => hit(e.owner))) return
    await writeEntries(entries.map((e) => (hit(e.owner) ? { ...e, owner: null } : e)))
  })
}

export async function forgetHarnessSessionMessages(harnessSessionId: string): Promise<void> {
  return tombstone((owner) => owner.harnessSessionId === harnessSessionId)
}

export async function forgetSessionMessages(sessionRef: string): Promise<void> {
  return tombstone((owner) => owner.sessionRef === sessionRef)
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
