import { OpenAIEmbeddings } from '@langchain/openai'
import { CacheBackedEmbeddings } from '@langchain/classic/embeddings/cache_backed'
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory'
import { LocalFileStore } from 'langchain/storage/file_system'

import { TextLoader } from '@langchain/classic/document_loaders/fs/text'
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx'
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf'
import { Document } from '@langchain/classic/document'

import { RecursiveCharacterTextSplitter } from '@langchain/classic/text_splitter'

import type {
  IndexedDocument,
  EmbedInquiry,
  MergedGroup,
  WarmupRequest,
  PhisonKmIngestConfig,
} from '@/assets/js/store/textInference.ts'

import { createHash, randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import fs from 'fs'

/** OpenAI SDK v6+ rejects empty-string apiKey; local embedding servers ignore this value. */
const LOCAL_COMPAT_OPENAI_API_KEY = process.env.AIPG_LOCAL_OPENAI_API_KEY?.trim() || randomUUID()

/**
 * Maximum tokens per merged group — mirrors Phison KM service MAX_TOKENS_PER_GROUP.
 * Sized so that one group fits within the Phison-recommended 16 K context window
 * (group ~13 000 tokens + shared prefix + query + output ~16 384 tokens).
 */
const MAX_TOKENS_PER_GROUP = 13000

let documentEmbeddingStore: LocalFileStore

type AddDocumentArgs = {
  document: IndexedDocument
  phisonKmConfig?: PhisonKmIngestConfig
}

process.parentPort.on('message', async (message) => {
  console.log('message received in langchain utility process', message)
  const type = message.data.type
  switch (type) {
    case 'init':
      console.log('Initializing Langchain process')
      // ensure that path exists
      if (!fs.existsSync(message.data.embeddingCachePath)) {
        fs.mkdirSync(message.data.embeddingCachePath, { recursive: true })
      }

      documentEmbeddingStore = new LocalFileStore({
        rootPath: message.data.embeddingCachePath,
      })
      console.log('Langchain process initialized')
      break

    case 'addDocumentToRAGList':
      process.parentPort.postMessage({
        type,
        returnValue: await addDocumentToRAGList(message.data.args as AddDocumentArgs),
      })
      break

    case 'embedInputUsingRag':
      process.parentPort.postMessage({
        type,
        returnValue: await embedInputUsingRag(message.data.args as EmbedInquiry),
      })
      break

    case 'warmupKVCacheForDocument':
      await warmupKVCache(message.data.args as WarmupRequest)
      process.parentPort.postMessage({ type, returnValue: { success: true } })
      break
  }
})

setInterval(() => {}, 10000)

// ---------------------------------------------------------------------------
// Document ingestion
// ---------------------------------------------------------------------------

async function addDocumentToRAGList(args: AddDocumentArgs): Promise<IndexedDocument> {
  const { document, phisonKmConfig } = args
  console.log(
    `[addDocumentToRAGList] file: ${document.filename}, phisonKmConfig: ${phisonKmConfig ? `present (url: ${phisonKmConfig.embeddingServerUrl})` : 'absent'}`,
  )

  const rawDocument = await loadDocument(document.type, document.filepath)
  console.log(rawDocument)

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 512,
    chunkOverlap: 64,
  })
  const splitDocument = await splitter.splitDocuments(rawDocument)

  let mergedGroups: MergedGroup[] | undefined
  if (phisonKmConfig?.embeddingServerUrl) {
    mergedGroups = await groupChunks(splitDocument, phisonKmConfig.embeddingServerUrl)
    for (const group of mergedGroups) {
      for (let i = group.startChunkIdx; i <= group.endChunkIdx; i++) {
        splitDocument[i].metadata.groupId = group.groupId
      }
    }
    console.log(
      `Phison KM: created ${mergedGroups.length} merged group(s) for ${document.filename}`,
    )
  }

  return {
    ...document,
    splitDB: splitDocument,
    mergedGroups,
    hash: await generateFileSHA256Hash(document.filepath),
  }
}

async function loadDocument(type: string, filepath: string) {
  let loader: TextLoader | DocxLoader | PDFLoader
  switch (type) {
    case 'md':
    case 'txt': {
      loader = new TextLoader(filepath)
      break
    }
    case 'doc': {
      loader = new DocxLoader(filepath, { type: 'doc' })
      break
    }
    case 'docx': {
      loader = new DocxLoader(filepath)
      break
    }
    case 'pdf': {
      loader = new PDFLoader(filepath)
      break
    }
    default: {
      console.error('Invalid document type')
      throw new Error('Invalid document type')
    }
  }
  return await loader.load()
}

// ---------------------------------------------------------------------------
// Phison KM: token-based chunk grouping (mirrors KM MAX_TOKENS_PER_GROUP logic)
// ---------------------------------------------------------------------------

/**
 * Groups consecutive chunks into merged groups, each capped at MAX_TOKENS_PER_GROUP tokens.
 * Token counts are obtained via the embedding server /tokenize endpoint for accuracy.
 * Groups have zero overlap (matching KM behaviour).
 */
async function groupChunks(chunks: Document[], embeddingServerUrl: string): Promise<MergedGroup[]> {
  const tokenizeUrl = `${embeddingServerUrl}/tokenize`
  const groups: MergedGroup[] = []
  let groupChunksBuf: Document[] = []
  let groupStartIdx = 0
  let groupTokens = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunkTokens = await countTokens(chunks[i].pageContent, tokenizeUrl)

    if (groupTokens + chunkTokens > MAX_TOKENS_PER_GROUP && groupChunksBuf.length > 0) {
      groups.push(buildMergedGroup(groupChunksBuf, groupStartIdx, i - 1))
      groupChunksBuf = [chunks[i]]
      groupStartIdx = i
      groupTokens = chunkTokens
    } else {
      groupChunksBuf.push(chunks[i])
      groupTokens += chunkTokens
    }
  }

  if (groupChunksBuf.length > 0) {
    groups.push(buildMergedGroup(groupChunksBuf, groupStartIdx, chunks.length - 1))
  }

  return groups
}

async function countTokens(text: string, tokenizeUrl: string): Promise<number> {
  try {
    const response = await fetch(tokenizeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    })
    if (!response.ok) return Math.ceil(text.length / 4)
    const data = (await response.json()) as { tokens: number[] }
    return data.tokens.length
  } catch {
    return Math.ceil(text.length / 4)
  }
}

function buildMergedGroup(chunks: Document[], startIdx: number, endIdx: number): MergedGroup {
  const source = String(chunks[0]?.metadata?.source ?? 'unknown')
  const groupId = createHash('md5')
    .update(`${source}|${startIdx}|${endIdx}`)
    .digest('hex')
  return {
    groupId,
    content: chunks.map((c) => c.pageContent).join('\n\n'),
    startChunkIdx: startIdx,
    endChunkIdx: endIdx,
  }
}

// ---------------------------------------------------------------------------
// RAG retrieval
// ---------------------------------------------------------------------------

async function embedInputUsingRag(embedInquiry: EmbedInquiry): Promise<Document[]> {
  console.log('embedInputUsingRag', embedInquiry)

  const model = embedInquiry.embeddingModel.split('/').join('---')
  const baseURL = `${embedInquiry.backendBaseUrl}/v1`

  // Per-document retrieval: fetch perDocResults from each document independently.
  // With multiple documents, a single shared top-K search can cause relevant chunks
  // from one document to be outcompeted by superficially similar chunks from another.
  // Per-document retrieval guarantees every document contributes to the result set.
  const perDocResults = embedInquiry.perDocResults ?? 2

  // Phison KM: ensure every doc has merged groups before retrieval.
  // Documents persisted from older sessions won't carry mergedGroups, so rebuild lazily.
  if (embedInquiry.useGroupRetrieval) {
    await ensureMergedGroups(embedInquiry.ragList, embedInquiry.backendBaseUrl)
  }

  const underlyingEmbeddings = new OpenAIEmbeddings({
    verbose: true,
    openAIApiKey: LOCAL_COMPAT_OPENAI_API_KEY,
    model,
    configuration: { baseURL },
  })

  const cacheBackedEmbeddings = CacheBackedEmbeddings.fromBytesStore(
    underlyingEmbeddings,
    documentEmbeddingStore,
    { namespace: createHash('sha256').update(underlyingEmbeddings.model).digest('hex') },
  )

  // Per-document retrieval: build a separate vector store per document and
  // collect top-perDocResults from each, then merge and de-duplicate.
  const perDocHits: [Document, number][] = []
  for (const ragDoc of embedInquiry.ragList) {
    if (!ragDoc.splitDB || ragDoc.splitDB.length === 0) continue
    const docStore = await MemoryVectorStore.fromDocuments(ragDoc.splitDB, cacheBackedEmbeddings)
    const hits = await docStore.similaritySearchWithScore(embedInquiry.prompt, perDocResults)
    perDocHits.push(...hits)
  }

  // De-duplicate by pageContent and sort by descending score.
  const seen = new Set<string>()
  const result = perDocHits
    .sort(([, a], [, b]) => b - a)
    .filter(([doc]) => {
      const key = doc.pageContent
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  console.log(
    `Per-doc retrieval: ${result.length} unique results across ${embedInquiry.ragList.length} doc(s):`,
    result.map(
      ([doc, score]) =>
        `${doc.metadata.source}@${JSON.stringify(doc.metadata.loc)}: Score ${score}`,
    ),
  )

  const filtered = result.filter(([_doc, score]) => score > 0.5)

  if (embedInquiry.useGroupRetrieval) {
    return phisonGroupRetrieval(filtered, embedInquiry.ragList)
  }

  // Standard path: return individual chunks ordered by similarity score
  return filtered.map(([doc]) => doc)
}

/**
 * Ensures each document in the rag list has merged groups, building them lazily
 * from splitDB when missing. Also (re)stamps groupId onto every chunk's metadata.
 */
async function ensureMergedGroups(
  ragList: IndexedDocument[],
  embeddingServerUrl: string,
): Promise<void> {
  for (const doc of ragList) {
    if (!doc.splitDB || doc.splitDB.length === 0) continue

    if (!doc.mergedGroups || doc.mergedGroups.length === 0) {
      console.log(
        `[ensureMergedGroups] building groups on-the-fly for ${doc.filename} ` +
          `(${doc.splitDB.length} chunk(s))`,
      )
      doc.mergedGroups = await groupChunks(doc.splitDB, embeddingServerUrl)
      console.log(
        `[ensureMergedGroups] created ${doc.mergedGroups.length} group(s) for ${doc.filename}`,
      )
    }

    // Always (re)stamp groupId onto chunk metadata — persisted chunks may have lost it.
    for (const group of doc.mergedGroups) {
      for (let i = group.startChunkIdx; i <= group.endChunkIdx && i < doc.splitDB.length; i++) {
        doc.splitDB[i].metadata.groupId = group.groupId
      }
    }
  }
}

/**
 * Phison KM retrieval: find the best-scoring chunk, look up its merged group,
 * and return the full group content as a single Document.
 * Falls back to individual chunks (stable-sorted) when no group info is available.
 */
function phisonGroupRetrieval(
  filtered: [Document, number][],
  ragList: IndexedDocument[],
): Document[] {
  if (filtered.length === 0) return []

  // Walk results from highest to lowest score; use the first one that has a groupId
  for (const [topChunk] of filtered) {
    const groupId = topChunk.metadata?.groupId as string | undefined
    if (!groupId) continue

    for (const ragDoc of ragList) {
      if (!ragDoc.mergedGroups) continue
      const group = ragDoc.mergedGroups.find((g) => g.groupId === groupId)
      if (group) {
        console.log(
          `Phison KM: serving merged group ${group.groupId} ` +
            `(chunks ${group.startChunkIdx}-${group.endChunkIdx})`,
        )
        return [
          new Document({
            pageContent: group.content,
            metadata: {
              source: topChunk.metadata?.source ?? 'unknown',
              groupId: group.groupId,
              startChunkIdx: group.startChunkIdx,
              endChunkIdx: group.endChunkIdx,
            },
          }),
        ]
      }
    }
  }

  // Fallback: mergedGroups absent — stable-sorted chunks
  console.warn(
    'Phison KM: no merged group found for retrieved chunks — falling back to stable-sorted chunks',
  )
  return filtered
    .map(([doc]) => doc)
    .sort((a, b) => stableChunkKey(a).localeCompare(stableChunkKey(b)))
}

/**
 * Build a deterministic ordering key for a retrieved RAG chunk.
 * Uses file source + page (PDF) + line range.
 */
function stableChunkKey(doc: Document): string {
  const source = String(doc.metadata?.source ?? '')
  const loc = (doc.metadata?.loc ?? {}) as {
    pageNumber?: number
    lines?: { from?: number; to?: number }
  }
  const page = loc.pageNumber ?? 0
  const from = loc.lines?.from ?? 0
  const to = loc.lines?.to ?? 0
  return `${source}|${String(page).padStart(8, '0')}|${String(from).padStart(8, '0')}|${String(to).padStart(8, '0')}`
}

// ---------------------------------------------------------------------------
// Phison KM: KV cache pre-warming (Approach A)
// ---------------------------------------------------------------------------

/**
 * Pre-warm the LLM's KV cache for each merged group.
 *
 * Approach A: the warmup system message is built as:
 *   {request.ragSystemPrefix}\n\nDocument context:\n\n{group.content}
 *
 * This is the SAME prefix that prepareRagContext in textInference.ts uses for the
 * actual query (PHISON_KM_RAG_PREFIX + "Document context:" + ragContext). Because
 * the prefix is identical, the LLM's KV states for these tokens can be reused on
 * the real request, dramatically reducing TTFT.
 *
 * The preset's systemPrompt is appended AFTER in the real query (not in warmup),
 * so it falls outside the cached prefix — but it is short and cheap to prefill.
 *
 * Failures are logged but never propagated — warmup is best-effort.
 */
async function warmupKVCache(request: WarmupRequest): Promise<void> {
  console.log(
    `Phison KM: warming KV cache for ${request.mergedGroups.length} group(s) ` +
      `via ${request.llmBackendUrl}`,
  )
  for (const group of request.mergedGroups) {
    try {
      const systemContent = `${request.ragSystemPrefix}\n\nDocument context:\n\n${group.content}`
      const resp = await fetch(`${request.llmBackendUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.modelName || 'local-model',
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: '.' },
          ],
          max_tokens: 1,
          stream: false,
        }),
      })
      if (!resp.ok) {
        console.warn(`Phison KM: warmup HTTP ${resp.status} for group ${group.groupId}`)
      } else {
        console.log(`Phison KM: warmed group ${group.groupId}`)
      }
    } catch (err) {
      console.warn(`Phison KM: warmup failed for group ${group.groupId}:`, err)
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function generateFileSHA256Hash(filePath: string): Promise<string> {
  try {
    const fileBuffer = await readFile(filePath)
    const hashSum = createHash('sha256')
    hashSum.update(fileBuffer)
    const hex = hashSum.digest('hex')
    return hex
  } catch (error) {
    console.error('Error generating file hash:', error)
    throw error
  }
}
