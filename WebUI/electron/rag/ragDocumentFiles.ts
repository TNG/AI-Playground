import fs from 'node:fs/promises'
import { appLoggerInstance } from '../logging/logger'
import { getRagDocumentsDemoFile, getRagDocumentsFile } from '../util.ts'
import { RagDocumentsFileSchema, RagDocumentSectionSchema } from '@/types/ragDocumentIpc'
import { atomicWriteJson, makeWriteChains, readJson } from '../fsJsonStore'

/**
 * The kernel's one-writer RAG document store (architecture-target §6.1,
 * step 8): `AI-Playground/rag/documents.json` — the indexed document set the
 * textInference store projects, full split text included. The same
 * correctness contract as the other user-data stores (atomic tmp+rename
 * writes, schema validation on read, every mutation serialized on one chain
 * — the file is the unit). Items are opaque here; the store owns the
 * `IndexedDocument` interpretation.
 *
 * Best-effort like preferences: a corrupt or missing file reads as empty
 * (defaults apply) and is replaced by the next write.
 */

const appLogger = appLoggerInstance

const LOG_SCOPE = 'rag-documents'

export type RagDocumentFilesDeps = {
  isDemoMode: () => boolean
}

let ragDocumentFilesDeps: RagDocumentFilesDeps | null = null

export function setRagDocumentFilesDeps(deps: RagDocumentFilesDeps): void {
  ragDocumentFilesDeps = deps
}

const { serialize, clear: clearChains } = makeWriteChains()

const FILE_CHAIN = 'file'

function ragFile(): string {
  return ragDocumentFilesDeps?.isDemoMode() ? getRagDocumentsDemoFile() : getRagDocumentsFile()
}

function emptyDoc() {
  return { schemaVersion: 1 as const, documents: [] as unknown[] }
}

async function readDoc(): Promise<{ schemaVersion: 1; documents: unknown[] } | null> {
  const read = await readJson(ragFile(), LOG_SCOPE)
  if (read.status === 'missing') return null
  if (read.status === 'ok') {
    const parsed = RagDocumentsFileSchema.safeParse(read.value)
    if (parsed.success) return parsed.data
  }
  appLogger.warn('rag documents file failed schema; treated as empty', LOG_SCOPE)
  return null
}

function parseSection(payload: unknown): unknown[] {
  const parsed = RagDocumentSectionSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`invalid rag document section: expected { ragList: [...] }`)
  }
  return parsed.data.ragList
}

// ── Public API ────────────────────────────────────────────────────────────────

/** The section-shaped list; null when the file is absent (or unreadable). */
export async function readRagDocumentSection(): Promise<{ ragList: unknown[] } | null> {
  const doc = await readDoc()
  return doc ? { ragList: doc.documents } : null
}

export async function writeRagDocumentSection(payload: unknown): Promise<void> {
  const ragList = parseSection(payload)
  return serialize(FILE_CHAIN, async () => {
    const doc = (await readDoc()) ?? emptyDoc()
    doc.documents = ragList
    await atomicWriteJson(ragFile(), doc)
  })
}

/**
 * One-shot legacy upload (§6.1: "localStorage migrates once, do not
 * dual-write"): writes the payload only when the file is absent, so a
 * retried or racing migrate can never overwrite what the file already owns.
 */
export async function migrateRagDocumentSection(payload: unknown): Promise<boolean> {
  const ragList = parseSection(payload)
  return serialize(FILE_CHAIN, async () => {
    const doc = await readDoc()
    if (doc) return false
    await atomicWriteJson(ragFile(), { schemaVersion: 1, documents: ragList })
    return true
  })
}

/** §6.1: demo RAG documents are session-scoped; wipe on exit (and boot, for a crash tail). */
export async function wipeDemoRagDocuments(): Promise<void> {
  try {
    await fs.rm(getRagDocumentsDemoFile(), { force: true })
  } catch (error) {
    appLogger.warn(`demo rag documents wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetRagDocumentFilesForTest(): void {
  ragDocumentFilesDeps = null
  clearChains()
}
