import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { appLoggerInstance } from '../observability/logger'
import { importAttachment } from '../agent/workspaceAttachments'
import { listFileIds, readJson } from '../persist/fsJsonStore'
import { readPreferenceSection, writePreferenceSection } from '../persist/preferencesFile'
import { readRagDocumentSection } from '../persist/ragDocumentFiles'
import { appendHistoryLine, serializeSession } from '../persist/sessionFiles'
import { getConversationsDemoDir, getConversationsDir } from '../persist/userDataPaths'
import { setSessionReachable } from './sessionChannels'
import { textOfMessage, type ChatTranscriptMessage } from './sessionChatTurn'
import { autoTitle } from './sessionTitle'
import { createSession, mutateSession, sessionPaths } from './sessions'
import { ChannelKindSchema } from '@/assets/js/store/channels/types'
import { titleFromMessages } from '@/lib/conversationTitle'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
import { HistoryEntrySchema, type HistoryEntry } from '@/types/sessionIpc'

// Home Agent threads become Reachable Sessions (Channels spec, "Migration"). The inputs are read
// raw, so this keeps working after the Home Agent thread kind is gone from the schemas.

const LOG_SCOPE = 'home-agent-thread-migration'

const LEGACY_SINGLETON_KEY = '__aipg_home_agent__'
const MARKER_SECTION = 'homeAgentThreadMigration'
const POINTER_SECTION = 'channelSessions'

const ThreadSchema = z.object({
  meta: z.object({ kind: z.string().optional() }).passthrough().nullable().optional(),
  ragHashes: z.array(z.string()).catch([]),
  messages: z.array(z.unknown()),
  updatedAt: z.number().catch(0),
})

const RagDocumentSchema = z.object({ hash: z.string(), filepath: z.string() }).passthrough()

const MarkerSchema = z.object({
  done: z.boolean().catch(false),
  sessions: z.record(z.string(), z.string()).catch({}),
})

type Marker = z.infer<typeof MarkerSchema>

type Thread = { id: string } & z.infer<typeof ThreadSchema>

export type HomeAgentThreadMigrationDeps = { isDemoMode: () => boolean }

export type HomeAgentThreadMigrationInput = {
  /** The Home Agent's routing pointer, which the window kept. */
  routingKey: string | null
  /** Assistant's default capabilities, so the Sessions notify as a hand-made Reachable one would. */
  defaultCapabilities?: string[]
}

/** The Channel Session it set; null when there was none, or the migration ran before. */
export type HomeAgentThreadMigrationResult = { channelSession: string | null }

let deps: HomeAgentThreadMigrationDeps = { isDemoMode: () => false }

export function setHomeAgentThreadMigrationDeps(next: HomeAgentThreadMigrationDeps): void {
  deps = next
}

function conversationsDir(): string {
  return deps.isDemoMode() ? getConversationsDemoDir() : getConversationsDir()
}

async function readMarker(): Promise<Marker> {
  const parsed = MarkerSchema.safeParse((await readPreferenceSection(MARKER_SECTION)) ?? {})
  return parsed.success ? parsed.data : { done: false, sessions: {} }
}

async function homeAgentThreads(): Promise<Thread[]> {
  const dir = conversationsDir()
  const threads: Thread[] = []
  for (const id of await listFileIds(dir)) {
    const read = await readJson(path.join(dir, `${id}.json`), LOG_SCOPE)
    if (read.status !== 'ok') continue
    const parsed = ThreadSchema.safeParse(read.value)
    if (!parsed.success) continue
    const isHomeAgent = parsed.data.meta?.kind === 'homeAgent' || id === LEGACY_SINGLETON_KEY
    if (isHomeAgent && parsed.data.messages.length > 0) threads.push({ id, ...parsed.data })
  }
  return threads.sort((a, b) => a.updatedAt - b.updatedAt)
}

function chatMessages(thread: Thread): ChatTranscriptMessage[] {
  return thread.messages.flatMap((value) => {
    const message = value as ChatTranscriptMessage | null
    if (!message || typeof message.id !== 'string' || typeof message.role !== 'string') return []
    return [{ ...message, metadata: { ...message.metadata, chatTurn: true } }]
  })
}

function timestampOf(message: ChatTranscriptMessage, fallback: number): number {
  const stamp = message.metadata?.timestamp
  return Math.max(0, Math.floor(typeof stamp === 'number' ? stamp : fallback))
}

/** One completed chat turn per prompt that got an answer: what Pi replays on its first turn. */
function historyEntries(messages: ChatTranscriptMessage[], fallback: number): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  messages.forEach((message, index) => {
    const reply = messages[index + 1]
    if (message.role !== 'user' || reply?.role !== 'assistant') return
    const prompt = textOfMessage(message).trim()
    const response = textOfMessage(reply).trim()
    if (!prompt || !response) return
    entries.push(
      HistoryEntrySchema.parse({
        id: `entry-${randomUUID()}`,
        timestamp: timestampOf(reply, fallback),
        preset: HARNESS_CHAT_PRESET,
        kind: 'chat',
        prompt,
        response,
        status: 'completed',
        artifacts: [],
      }),
    )
  })
  return entries
}

async function ragDocumentPaths(hashes: string[]): Promise<string[]> {
  if (hashes.length === 0) return []
  const section = await readRagDocumentSection().catch(() => null)
  const documents = (section?.ragList ?? []).flatMap((value) => {
    const parsed = RagDocumentSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
  return hashes.flatMap((hash) => {
    const found = documents.find((document) => document.hash === hash)
    return found ? [found.filepath] : []
  })
}

async function attachDocuments(sessionId: string, thread: Thread): Promise<void> {
  const filesDir = sessionPaths(sessionId).filesDir
  for (const filepath of await ragDocumentPaths(thread.ragHashes)) {
    try {
      importAttachment(filesDir, path.basename(filepath), await fs.readFile(filepath))
    } catch (error) {
      appLoggerInstance.warn(`document ${filepath} not attached: ${String(error)}`, LOG_SCOPE)
    }
  }
}

async function sessionFromThread(
  thread: Thread,
  input: HomeAgentThreadMigrationInput,
): Promise<string> {
  const { id } = await createSession()
  const messages = chatMessages(thread)
  const entries = historyEntries(messages, thread.updatedAt)
  await attachDocuments(id, thread)
  await serializeSession(id, async () => {
    for (const entry of entries) await appendHistoryLine(id, JSON.stringify(entry))
  })
  const firstPrompt = messages.find((message) => message.role === 'user')
  const title =
    titleFromMessages(thread.messages) ??
    autoTitle({ kind: 'chat', preset: HARNESS_CHAT_PRESET, prompt: textOfMessage(firstPrompt) })
  await mutateSession(id, (current) => {
    const updatedAt = thread.updatedAt || current.updatedAt
    const createdAt = messages[0] ? timestampOf(messages[0], updatedAt) : updatedAt
    return {
      ...current,
      title,
      presetsUsed: [HARNESS_CHAT_PRESET],
      timeline: messages,
      createdAt: Math.min(createdAt, updatedAt),
      updatedAt,
    }
  })
  await setSessionReachable(id, true, {
    ...(input.defaultCapabilities ? { defaultCapabilities: input.defaultCapabilities } : {}),
  })
  return id
}

function routingTarget(
  marker: Marker,
  threads: Thread[],
  routingKey: string | null,
): string | null {
  if (routingKey !== null) return marker.sessions[routingKey] ?? null
  const newest = threads.at(-1)
  return newest ? (marker.sessions[newest.id] ?? null) : null
}

async function pointEveryChannelAt(sessionId: string): Promise<void> {
  const current = await readPreferenceSection(POINTER_SECTION)
  const section = current && typeof current === 'object' ? current : {}
  const pointers = Object.fromEntries(ChannelKindSchema.options.map((kind) => [kind, sessionId]))
  await writePreferenceSection(POINTER_SECTION, { ...section, pointers })
}

let running: Promise<HomeAgentThreadMigrationResult> | null = null

/** One-shot: each thread is recorded as it lands, so an interrupted run resumes without duplicates. */
export function migrateHomeAgentThreads(
  input: HomeAgentThreadMigrationInput,
): Promise<HomeAgentThreadMigrationResult> {
  // A window reloaded mid-run asks again; it must not migrate the same threads twice.
  running ??= migrate(input).finally(() => {
    running = null
  })
  return running
}

async function migrate(
  input: HomeAgentThreadMigrationInput,
): Promise<HomeAgentThreadMigrationResult> {
  let marker = await readMarker()
  if (marker.done) return { channelSession: null }
  const threads = await homeAgentThreads()
  for (const thread of threads) {
    if (marker.sessions[thread.id]) continue
    const sessionId = await sessionFromThread(thread, input)
    marker = { ...marker, sessions: { ...marker.sessions, [thread.id]: sessionId } }
    await writePreferenceSection(MARKER_SECTION, marker)
  }
  const channelSession = routingTarget(marker, threads, input.routingKey)
  if (channelSession) await pointEveryChannelAt(channelSession)
  await writePreferenceSection(MARKER_SECTION, { ...marker, done: true })
  appLoggerInstance.info(
    `moved ${Object.keys(marker.sessions).length} Home Agent thread(s) into Sessions`,
    LOG_SCOPE,
  )
  return { channelSession }
}
