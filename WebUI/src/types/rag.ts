import type { Document } from '@langchain/classic/document'
import type { MergedGroup, MergedGroupsMeta } from '@/types/phisonKmRag'

/** Extensions the langchain worker's loadDocument can index. */
export type ValidFileExtension = 'txt' | 'doc' | 'docx' | 'md' | 'pdf'

export type IndexedDocument = {
  filename: string
  filepath: string
  type: ValidFileExtension
  splitDB: Document[]
  hash: string
  isChecked: boolean
  mergedGroups?: MergedGroup[]
  mergedGroupsMeta?: MergedGroupsMeta
}

export type EmbedInquiry = {
  prompt: string
  ragList: IndexedDocument[]
  backendBaseUrl: string
  embeddingModel: string
  maxResults?: number
  useGroupRetrieval: boolean
  /** Number of top chunks to retrieve per document (prevents cross-doc competition). */
  perDocResults?: number
}

/** Where one passage a `rag` tool call returned came from; the Source Docs badge reads these. */
export type RagPassageSource = { file: string; page?: number; lines?: { from: number; to: number } }

/** The `details` of a `rag` tool result. */
export type RagToolDetails = { sources: RagPassageSource[] }
