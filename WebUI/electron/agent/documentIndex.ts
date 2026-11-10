import path from 'node:path'
import { DOCUMENT_EXTENSIONS, type IndexedDocument, type ValidFileExtension } from '@/types/rag'
import { ragAccess } from './ragAccess.ts'

// Shared by the `rag` tool and indexing on attach, so an attached document is split once.

export function documentExtension(file: string): ValidFileExtension | undefined {
  const extension = path.extname(file).slice(1).toLowerCase()
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)
    ? (extension as ValidFileExtension)
    : undefined
}

const MAX_DOCUMENTS = 32

type Entry = { mtimeMs: number; doc: Promise<IndexedDocument> }

const index = new Map<string, Entry>()

export function indexedDocument(
  realPath: string,
  extension: ValidFileExtension,
  mtimeMs: number,
): Promise<IndexedDocument> {
  const cached = index.get(realPath)
  index.delete(realPath)
  if (cached && cached.mtimeMs === mtimeMs) {
    index.set(realPath, cached)
    return cached.doc
  }
  const doc = ragAccess().ingest({
    filename: path.basename(realPath),
    filepath: realPath,
    type: extension,
    splitDB: [],
    hash: '',
    isChecked: true,
  })
  const entry: Entry = { mtimeMs, doc }
  index.set(realPath, entry)
  for (const key of index.keys()) {
    if (index.size <= MAX_DOCUMENTS) break
    index.delete(key)
  }
  doc.catch(() => {
    if (index.get(realPath) === entry) index.delete(realPath)
  })
  return doc
}

/** Tests only. */
export function resetDocumentIndex(): void {
  index.clear()
}
