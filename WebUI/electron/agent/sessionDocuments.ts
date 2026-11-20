import fs from 'node:fs'
import type { AttachmentsFolder } from './workspaceAttachments.ts'
import { documentExtension, forgetIndexedDocument, indexedDocument } from './documentIndex.ts'
import { realFileInside } from './hostPathContainment.ts'
import { ragAccess } from './ragAccess.ts'
import type { DocumentEmbedding } from '@/types/rag'

/** The Attached Documents in `folder`, as the paths a prompt names them by, in name order. */
export function sessionDocuments(folder: AttachmentsFolder): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(folder.dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && documentExtension(entry.name))
    .map((entry) => `${folder.reference}/${entry.name}`)
    .sort((a, b) => a.localeCompare(b))
}

/** Goes on the user message, never the system prompt, so the cached prompt prefix holds. */
export function documentsLine(folder: AttachmentsFolder): string {
  const documents = sessionDocuments(folder)
  if (documents.length === 0) return ''
  return `Documents attached to this Session (search them with the rag tool): ${documents.join(', ')}`
}

function attachedDocument(folder: AttachmentsFolder, reference: string) {
  const prefix = `${folder.reference}/`
  const name = reference.startsWith(prefix) ? reference.slice(prefix.length) : ''
  const realPath = name && !name.includes('/') ? realFileInside(folder.dir, name) : null
  const extension = realPath ? documentExtension(realPath) : undefined
  if (!realPath || !extension) throw new Error(`Not an attached document: ${reference}`)
  return { realPath, extension }
}

/** Deletes the Session's copy; the user's original was never touched. */
export async function removeSessionDocument(
  folder: AttachmentsFolder,
  relativePath: string,
): Promise<void> {
  const { realPath } = attachedDocument(folder, relativePath)
  forgetIndexedDocument(realPath)
  await fs.promises.unlink(realPath)
}

/** Embeds on attach, so the first `rag` call only has to embed the question. */
export async function indexSessionDocument(
  folder: AttachmentsFolder,
  relativePath: string,
  { model: embeddingModel, backend }: DocumentEmbedding,
): Promise<void> {
  const { realPath, extension } = attachedDocument(folder, relativePath)
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
