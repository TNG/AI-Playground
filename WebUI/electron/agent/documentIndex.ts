import path from 'node:path'
import type { IndexedDocument, ValidFileExtension } from '@/types/rag'
import { ragAccess } from './ragAccess.ts'

// The split of every document the agent has indexed, shared by the `rag` tool and
// indexing on attach, so a document split when it was attached is not split again
// on the first question. Chunk embeddings are cached on disk by the langchain worker.

/** Exactly what the langchain worker's loadDocument can index. */
export const DOCUMENT_EXTENSIONS = [
  'txt',
  'md',
  'doc',
  'docx',
  'pdf',
] as const satisfies readonly ValidFileExtension[]
type _ExtensionsCovered =
  Exclude<ValidFileExtension, (typeof DOCUMENT_EXTENSIONS)[number]> extends never ? true : never
const _extensionsCovered: _ExtensionsCovered = true

export function documentExtension(file: string): ValidFileExtension | undefined {
  const extension = path.extname(file).slice(1).toLowerCase()
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)
    ? (extension as ValidFileExtension)
    : undefined
}

const MAX_DOCUMENTS = 32

type Entry = { mtimeMs: number; doc: Promise<IndexedDocument> }

const index = new Map<string, Entry>()

/** The split of `realPath` as of `mtimeMs`, from the langchain worker on first use. */
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
