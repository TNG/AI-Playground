import fs from 'node:fs'
import path from 'node:path'
import { ATTACHMENTS_DIR } from './workspaceAttachments.ts'
import { documentExtension, indexedDocument } from './documentIndex.ts'
import { realFileInside } from './hostPathContainment.ts'
import { ragAccess } from './ragAccess.ts'
import type { DocumentEmbedding } from '@/types/rag'

// ── Session documents ────────────────────────────────────────────────────────
//
// A document the user attaches is copied into the Session Folder's attachments
// and belongs to that Session alone. The model learns about them from one line
// on each user message, never from the system prompt, so the prompt prefix the
// KV cache holds stays the same from turn to turn.

/** The Session's attached documents, as workspace-relative paths in name order. */
export function sessionDocuments(workspaceDir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(workspaceDir, ATTACHMENTS_DIR), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && documentExtension(entry.name))
    .map((entry) => `${ATTACHMENTS_DIR}/${entry.name}`)
    .sort((a, b) => a.localeCompare(b))
}

/** The line a user message carries when the Session has documents and `rag` can search them. */
export function documentsLine(workspaceDir: string): string {
  const documents = sessionDocuments(workspaceDir)
  if (documents.length === 0) return ''
  return `Documents attached to this Session (search them with the rag tool): ${documents.join(', ')}`
}

/**
 * Split an attached document and embed its chunks into the worker's disk cache, so the
 * first `rag` call on it only has to embed the question.
 */
export async function indexSessionDocument(
  workspaceDir: string,
  relativePath: string,
  { model: embeddingModel, backend }: DocumentEmbedding,
): Promise<void> {
  const candidate = realFileInside(workspaceDir, relativePath)
  const realPath = candidate && realFileInside(path.join(workspaceDir, ATTACHMENTS_DIR), candidate)
  const extension = realPath ? documentExtension(realPath) : undefined
  if (!realPath || !extension) throw new Error(`Not an attached document: ${relativePath}`)
  const doc = await indexedDocument(realPath, extension, fs.statSync(realPath).mtimeMs)
  if (!doc.splitDB || doc.splitDB.length === 0) return
  const backendBaseUrl = await ragAccess().ensureEmbeddingServer(backend, embeddingModel)
  await ragAccess().retrieve({
    prompt: doc.filename,
    ragList: [{ ...doc, isChecked: true }],
    backendBaseUrl,
    embeddingModel,
    maxResults: 1,
    useGroupRetrieval: false,
  })
}
