import fs from 'node:fs'
import path from 'node:path'
import { ATTACHMENTS_DIR } from './workspaceAttachments.ts'
import { documentExtension, forgetIndexedDocument, indexedDocument } from './documentIndex.ts'
import { realFileInside } from './hostPathContainment.ts'
import { ragAccess } from './ragAccess.ts'
import type { DocumentEmbedding } from '@/types/rag'

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

/** Goes on the user message, never the system prompt, so the cached prompt prefix holds. */
export function documentsLine(workspaceDir: string): string {
  const documents = sessionDocuments(workspaceDir)
  if (documents.length === 0) return ''
  return `Documents attached to this Session (search them with the rag tool): ${documents.join(', ')}`
}

function attachedDocument(workspaceDir: string, relativePath: string) {
  const candidate = realFileInside(workspaceDir, relativePath)
  const realPath = candidate && realFileInside(path.join(workspaceDir, ATTACHMENTS_DIR), candidate)
  const extension = realPath ? documentExtension(realPath) : undefined
  if (!realPath || !extension) throw new Error(`Not an attached document: ${relativePath}`)
  return { realPath, extension }
}

/** Deletes the Session's copy; the user's original was never touched. */
export async function removeSessionDocument(
  workspaceDir: string,
  relativePath: string,
): Promise<void> {
  const { realPath } = attachedDocument(workspaceDir, relativePath)
  forgetIndexedDocument(realPath)
  await fs.promises.unlink(realPath)
}

/** Embeds on attach, so the first `rag` call only has to embed the question. */
export async function indexSessionDocument(
  workspaceDir: string,
  relativePath: string,
  { model: embeddingModel, backend }: DocumentEmbedding,
): Promise<void> {
  const { realPath, extension } = attachedDocument(workspaceDir, relativePath)
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
