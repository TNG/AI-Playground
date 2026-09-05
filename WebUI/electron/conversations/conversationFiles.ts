import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../logging/logger'
import { getConversationsDemoDir, getConversationsDir } from '../util.ts'
import { completeOrphanedToolParts, sanitizeBulkyToolOutputs } from '@/lib/toolMessageSanitize'
import {
  ConversationIndexFileSchema,
  ConversationThreadFileSchema,
  type ConversationBootstrap,
  type ConversationIndexEntry,
  type ConversationIndexFile,
  type ConversationLegacyState,
  type ConversationSaveRequest,
  type ConversationThreadFile,
  type ConversationThreadMeta,
} from '@/types/conversationIpc'

/**
 * The kernel's one-writer conversation store (architecture-target §6.1,
 * step 8). Threads live as user-data files — `AI-Playground/conversations/`
 * (`<id>.json` plus `index.json`) — and everything else (renderer, Home Agent
 * surfaces) sends mutations here instead of touching the files.
 *
 * Correctness notes from §6.1, all implemented here: writes are atomic
 * (tmp + rename) so a crash cannot tear a thread; each thread carries
 * `schemaVersion` and is validated on read; the writer re-runs the
 * orphaned-tool-part repair and the bulky-output strip on every save, so an
 * interrupted turn can never be persisted into a brick; and two write chains
 * keep order — per-thread for the thread files, one global chain for the
 * index, always nested thread→index so the chains cannot deadlock. Demo mode
 * routes to a sibling directory that is wiped on exit.
 */

const appLogger = appLoggerInstance

export type ConversationFileDeps = {
  isDemoMode: () => boolean
}

let conversationFileDeps: ConversationFileDeps | null = null

export function setConversationFileDeps(deps: ConversationFileDeps): void {
  conversationFileDeps = deps
}

const writeChains = new Map<string, Promise<unknown>>()

function serialize<T>(id: string, run: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(id) ?? Promise.resolve()
  const next = previous.then(run, run)
  writeChains.set(id, next)
  return next
}

function conversationsDir(): string {
  return conversationFileDeps?.isDemoMode() ? getConversationsDemoDir() : getConversationsDir()
}

const INDEX_CHAIN = 'index'
const INDEX_FILE = 'index.json'

/** Timestamp ids plus the legacy Home Agent singleton; never a path or `index`. */
function isSafeConversationId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && id !== 'index' && /^[\w.-]+$/.test(id)
}

function assertSafeConversationId(id: string): void {
  if (!isSafeConversationId(id)) throw new Error(`invalid conversation id: ${id}`)
}

function threadFile(id: string): string {
  assertSafeConversationId(id)
  return path.join(conversationsDir(), `${id}.json`)
}

function indexFile(): string {
  return path.join(conversationsDir(), INDEX_FILE)
}

/** Torn-write-safe JSON write: a crash mid-write leaves the old file intact. */
async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, `${JSON.stringify(data)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

type JsonRead = { status: 'missing' } | { status: 'ok'; value: unknown } | { status: 'corrupt' }

async function readJson(file: string): Promise<JsonRead> {
  try {
    return { status: 'ok', value: JSON.parse(await fs.readFile(file, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    appLogger.warn(`conversation file unreadable (${file}): ${String(error)}`, 'conversations')
    return { status: 'corrupt' }
  }
}

function threadDocFromRead(read: JsonRead): ConversationThreadFile | null {
  if (read.status !== 'ok') return null
  return parseThreadDoc(read.value)
}

function parseThreadDoc(raw: unknown): ConversationThreadFile | null {
  const parsed = ConversationThreadFileSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  appLogger.warn('conversation thread failed schema; treated as missing', 'conversations')
  return null
}

function emptyIndex(): ConversationIndexFile {
  return { schemaVersion: 1, lastMainKey: null, threads: [] }
}

async function listThreadIds(): Promise<string[]> {
  try {
    const names = await fs.readdir(conversationsDir())
    return names
      .filter((name) => name.endsWith('.json') && name !== INDEX_FILE)
      .map((name) => name.slice(0, -'.json'.length))
      .filter(isSafeConversationId)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function rebuildIndexFromThreadFiles(): Promise<ConversationIndexFile> {
  const ids = await listThreadIds()
  const threads: ConversationIndexEntry[] = []
  for (const id of ids) {
    const doc = threadDocFromRead(await readJson(threadFile(id)))
    if (!doc) continue
    threads.push({
      id,
      title: titleFromMessages(doc.messages),
      presetName: doc.meta?.presetName || undefined,
      kind: doc.meta?.kind,
      updatedAt: doc.updatedAt,
    })
  }
  threads.sort((a, b) => a.updatedAt - b.updatedAt)
  const index: ConversationIndexFile = { schemaVersion: 1, lastMainKey: null, threads }
  await writeIndex(index)
  return index
}

function indexWithSafeIds(index: ConversationIndexFile): ConversationIndexFile {
  return {
    ...index,
    threads: index.threads.filter((thread) => isSafeConversationId(thread.id)),
  }
}

/** Null only when nothing has ever been written (no index and no thread files). */
async function readIndex(): Promise<ConversationIndexFile | null> {
  const raw = await readJson(indexFile())
  if (raw.status === 'missing') {
    const ids = await listThreadIds()
    if (ids.length === 0) return null
    appLogger.warn('conversation index missing; rebuilding from thread files', 'conversations')
    return rebuildIndexFromThreadFiles()
  }
  if (raw.status === 'ok') {
    const parsed = ConversationIndexFileSchema.safeParse(raw.value)
    if (parsed.success) return indexWithSafeIds(parsed.data)
  }
  appLogger.warn('conversation index failed schema; rebuilding from thread files', 'conversations')
  return rebuildIndexFromThreadFiles()
}

async function currentIndex(): Promise<ConversationIndexFile> {
  return (await readIndex()) ?? emptyIndex()
}

async function writeIndex(index: ConversationIndexFile): Promise<void> {
  await atomicWriteJson(indexFile(), index)
}

/**
 * The conversation title as the UI defines it: the first message's
 * `conversationTitle` metadata (set on rename, or the summary). The index
 * keeps it only as a listing convenience, so best-effort is enough.
 */
function titleFromMessages(messages: unknown[]): string | undefined {
  const first = messages[0] as { metadata?: { conversationTitle?: unknown } } | undefined
  const title = first?.metadata?.conversationTitle
  return typeof title === 'string' && title.length > 0 ? title : undefined
}

/**
 * Same repair-and-strip the renderer applies to its live copy. The one
 * writer re-runs them so a thread can never be persisted with an orphaned
 * tool call (which bricks the next generation) or an inline data URI.
 */
function sanitizeMessages(messages: unknown[]): unknown[] {
  return sanitizeBulkyToolOutputs(completeOrphanedToolParts(messages as never)) as unknown[]
}

type HydratedThread = {
  id: string
  meta: ConversationThreadMeta | null
  ragHashes: string[]
  messages: unknown[]
}

function hydratedThread(id: string, doc: ConversationThreadFile | null): HydratedThread {
  if (!doc) return { id, meta: null, ragHashes: [], messages: [] }
  return { id, meta: doc.meta, ragHashes: doc.ragHashes, messages: doc.messages }
}

async function threadsFromIndex(index: ConversationIndexFile): Promise<HydratedThread[]> {
  return Promise.all(
    index.threads
      .filter((entry) => isSafeConversationId(entry.id))
      .map(async (entry) =>
        hydratedThread(entry.id, threadDocFromRead(await readJson(threadFile(entry.id)))),
      ),
  )
}

async function bootstrapFromIndex(index: ConversationIndexFile): Promise<ConversationBootstrap> {
  return {
    status: 'ok' as const,
    lastMainKey: index.lastMainKey,
    threads: await threadsFromIndex(index),
  }
}

// ── Public API (IPC handlers) ─────────────────────────────────────────────────

export async function bootstrapConversations(): Promise<ConversationBootstrap> {
  return serialize(INDEX_CHAIN, async () => {
    const index = await readIndex()
    if (index === null) {
      // No index ever written: a fresh install (nothing to hydrate) or a
      // legacy boot — the renderer answers the latter with
      // `conversations:migrate`. An index with zero threads is NOT empty: it
      // was written, so the legacy upload already happened.
      return { status: 'empty' as const }
    }
    return bootstrapFromIndex(index)
  })
}

/**
 * One-shot legacy upload (§6.1: "localStorage migrates once, do not
 * dual-write"). Writes every legacy thread as a file plus the index, then the
 * renderer drops its localStorage key. Empty lists are fine — the point is
 * that an index now exists, so this never runs again.
 */
export async function migrateLegacyConversations(
  legacy: ConversationLegacyState,
): Promise<ConversationBootstrap> {
  return serialize(INDEX_CHAIN, async () => {
    const existing = await readIndex()
    if (existing !== null) return bootstrapFromIndex(existing)
    const now = Date.now()
    const ids = Object.keys(legacy.conversationList)
    const entries: ConversationIndexEntry[] = []
    const threads: HydratedThread[] = []
    for (const id of ids) {
      if (!isSafeConversationId(id)) {
        appLogger.warn(`skipping unsafe legacy conversation id: ${id}`, 'conversations')
        continue
      }
      const messages = sanitizeMessages(legacy.conversationList[id])
      const meta = legacy.conversationThreadMeta[id] ?? null
      const doc: ConversationThreadFile = {
        schemaVersion: 1,
        meta,
        ragHashes: legacy.conversationRagSelection[id] ?? [],
        messages,
        updatedAt: now,
      }
      await atomicWriteJson(threadFile(id), doc)
      entries.push({
        id,
        title: titleFromMessages(messages),
        presetName: meta?.presetName || undefined,
        kind: meta?.kind,
        updatedAt: now,
      })
      threads.push(hydratedThread(id, doc))
    }
    const index: ConversationIndexFile = {
      schemaVersion: 1,
      lastMainKey: legacy.lastMainKey,
      threads: entries,
    }
    await writeIndex(index)
    return { status: 'ok' as const, lastMainKey: index.lastMainKey, threads }
  })
}

/** Upsert one thread (messages sanitized here) plus its index entry. */
export async function saveConversation(request: ConversationSaveRequest): Promise<void> {
  assertSafeConversationId(request.id)
  return serialize(request.id, async () => {
    const now = Date.now()
    const doc: ConversationThreadFile = {
      schemaVersion: 1,
      meta: request.meta,
      ragHashes: request.ragHashes,
      messages: sanitizeMessages(request.messages),
      updatedAt: now,
    }
    await atomicWriteJson(threadFile(request.id), doc)

    // Index updates run on the index chain (thread→index only, never the
    // reverse, so the chains cannot deadlock).
    await serialize(INDEX_CHAIN, async () => {
      const index = await currentIndex()
      const entry: ConversationIndexEntry = {
        id: request.id,
        title: titleFromMessages(doc.messages),
        presetName: request.meta?.presetName || undefined,
        kind: request.meta?.kind,
        updatedAt: now,
      }
      index.threads = [...index.threads.filter((thread) => thread.id !== request.id), entry]
      if (request.lastMainKey !== undefined) index.lastMainKey = request.lastMainKey
      await writeIndex(index)
    })
  })
}

export async function deleteConversation(id: string): Promise<void> {
  assertSafeConversationId(id)
  return serialize(id, async () => {
    try {
      await fs.rm(threadFile(id))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        appLogger.warn(`conversation delete failed (${id}): ${String(error)}`, 'conversations')
      }
    }
    await serialize(INDEX_CHAIN, async () => {
      const index = await currentIndex()
      index.threads = index.threads.filter((thread) => thread.id !== id)
      await writeIndex(index)
    })
  })
}

export async function saveConversationLastMainKey(key: string | null): Promise<void> {
  return serialize(INDEX_CHAIN, async () => {
    const index = await currentIndex()
    index.lastMainKey = key
    await writeIndex(index)
  })
}

/** §6.1: demo threads are session-scoped; wipe on exit (and on boot, for a crash tail). */
export async function wipeDemoConversations(): Promise<void> {
  try {
    await fs.rm(getConversationsDemoDir(), { recursive: true, force: true })
  } catch (error) {
    appLogger.warn(`demo conversation wipe failed: ${String(error)}`, 'conversations')
  }
}

export function resetConversationFilesForTest(): void {
  conversationFileDeps = null
  writeChains.clear()
}
