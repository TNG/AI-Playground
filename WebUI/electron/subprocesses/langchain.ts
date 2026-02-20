import { OpenAIEmbeddings } from '@langchain/openai'
import { CacheBackedEmbeddings } from '@langchain/classic/embeddings/cache_backed'
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory'
import { LocalFileStore } from '@langchain/classic/storage/file_system'

import { TextLoader } from '@langchain/classic/document_loaders/fs/text'
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx'
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf'
import { Document } from '@langchain/core/documents'

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'

import { IndexedDocument, EmbedInquiry } from '@/assets/js/store/textInference.ts'

import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import fs from 'fs'

let documentEmbeddingStore: LocalFileStore

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
        returnValue: await addDocumentToRAGList(message.data.args),
      })
      break
    case 'embedInputUsingRag':
      process.parentPort.postMessage({
        type,
        returnValue: await embedInputUsingRag(message.data.args),
      })
      break
  }
})

setInterval(() => {}, 10000)

async function addDocumentToRAGList(document: IndexedDocument): Promise<IndexedDocument> {
  console.log(document)
  const rawDocument = await loadDocument(document.type, document.filepath)
  console.log(rawDocument)
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 512,
    chunkOverlap: 64,
  })
  const splitDocument = await splitter.splitDocuments(rawDocument)
  const newDocument = {
    ...document,
    splitDB: splitDocument,
    hash: await generateFileMD5Hash(document.filepath),
  }
  return newDocument
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

/**
 * Finds the most relevant documents from a RAG list for the given prompt using cached embeddings.
 *
 * Builds an embeddings client from the specified model and backend URL, wraps it with a cache
 * namespaced by the model's MD5, indexes the RAG list chunks into a memory vector store, performs
 * a similarity search with the provided prompt (up to `maxResults`, default 6), and returns the
 * matching Documents whose similarity score is greater than 0.5.
 *
 * @param embedInquiry - Inquiry describing the embedding request. Expected fields:
 *   - `embeddingModel`: model identifier used for embeddings
 *   - `backendBaseUrl`: base URL for the embeddings API
 *   - `ragList`: array of documents where each document contains a `splitDB` array of chunks
 *   - `prompt`: text to use for the similarity search
 *   - `maxResults` (optional): maximum number of search results to retrieve (defaults to 6)
 * @returns An array of Documents from the RAG list whose similarity score to the prompt is greater than 0.5.
 */
async function embedInputUsingRag(embedInquiry: EmbedInquiry): Promise<Document[]> {
  console.log('embedInputUsingRag', embedInquiry)

  const model = embedInquiry.embeddingModel.split('/').join('---')
  const baseURL = `${embedInquiry.backendBaseUrl}/v1`
  const maxResults = embedInquiry.maxResults ?? 6

  const underlyingEmbeddings = new OpenAIEmbeddings({
    verbose: true,
    openAIApiKey: '',
    model,
    configuration: {
      baseURL,
    },
  })

  const cacheBackedEmbeddings = CacheBackedEmbeddings.fromBytesStore(
    underlyingEmbeddings,
    documentEmbeddingStore,
    { namespace: createHash('md5').update(underlyingEmbeddings.model).digest('hex') },
  )

  const vectorStore = await MemoryVectorStore.fromDocuments(
    embedInquiry.ragList.flatMap((doc) => doc.splitDB),
    cacheBackedEmbeddings,
  )

  const result = await vectorStore.similaritySearchWithScore(embedInquiry.prompt, maxResults)

  console.log(
    `Got ${result.length} results:`,
    result.map(
      ([doc, score]: [Document, number]) =>
        `${doc.metadata.source}@${JSON.stringify(doc.metadata.loc)}: Score ${score}`,
    ),
  )

  return result
    .filter(([_doc, score]: [Document, number]) => score > 0.5)
    .map(([doc, _score]: [Document, number]) => doc)
}

/**
 * Compute the MD5 hash of a file's contents.
 *
 * @param filePath - Filesystem path to the file to hash
 * @returns The MD5 digest as a hex string
 * @throws Rethrows any error encountered while reading the file or computing the hash
 */
async function generateFileMD5Hash(filePath: string): Promise<string> {
  try {
    const fileBuffer = await readFile(filePath)
    const hashSum = createHash('md5')
    hashSum.update(fileBuffer)
    const hex = hashSum.digest('hex')
    return hex
  } catch (error) {
    console.error('Error generating file hash:', error)
    throw error
  }
}