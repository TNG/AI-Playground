import fs from 'node:fs/promises'
import { z } from 'zod'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { appLoggerInstance } from '../observability/logger'
import { atomicWriteJson, makeWriteChains, readJson } from './fsJsonStore'
import { getChannelMessageMapDemoFile, getChannelMessageMapFile } from './userDataPaths.ts'

/**
 * The kernel's channel message map: (channel kind, platform message reference) →
 * the agent session that sent it. An entry lives as long as its session; there is
 * no time-based expiry, so a days-old Notification can still be answered.
 */

const LOG_SCOPE = 'channel-messages'

const EntrySchema = z.object({ kind: z.string(), ref: z.string(), sessionId: z.string() })
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

/** The session that sent this message, or null when it was not an agent's. */
export async function lookupChannelMessage(kind: ChannelKind, ref: string): Promise<string | null> {
  const entries = await readEntries()
  return entries.find((e) => e.kind === kind && e.ref === ref)?.sessionId ?? null
}

export async function forgetSessionMessages(sessionId: string): Promise<void> {
  return serialize(FILE_CHAIN, async () => {
    const entries = await readEntries()
    const remaining = entries.filter((e) => e.sessionId !== sessionId)
    if (remaining.length !== entries.length) await writeEntries(remaining)
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
