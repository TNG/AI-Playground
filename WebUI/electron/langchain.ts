import { utilityProcess, UtilityProcess } from 'electron'
import path from 'node:path'
import { externalResourcesDir } from './utils.ts'
import { appLoggerInstance } from './logging/logger.ts'
import type { IndexedDocument, EmbedInquiry } from '@/assets/js/store/textInference.ts'

const appLogger = appLoggerInstance

let langchainChild: UtilityProcess | null = null

/**
 * Starts and manages a single Langchain utility child process for IPC and embedding work.
 *
 * Initializes and forks the langchain worker (no-op if already running), wires its stdout/stderr to the application logger, sends an initial `init` message with the embedding cache path, and attaches `message`, `error`, and `exit` handlers. On non-zero exit the function schedules a restart after 1 second. Updates the module-level `langchainChild` reference and logs startup/shutdown events and errors.
 */
export function spawnLangchainUtilityProcess(): void {
  if (langchainChild) {
    appLogger.info('Langchain utility process already running', 'electron-backend')
    return
  }
  appLogger.info('Starting langchain utility process', 'electron-backend')
  try {
    appLogger.info(path.join(__dirname, '../langchain/langchain.js'), 'electron-backend')

    langchainChild = utilityProcess.fork(
      path.join(__dirname, '../langchain/langchain.js'),
      undefined,
      { stdio: 'pipe' },
    )
    langchainChild.stdout?.on('data', (data) => {
      appLogger.info(data.toString(), 'langchain')
    })
    langchainChild.stderr?.on('data', (data) => {
      appLogger.error(data.toString(), 'langchain')
    })
    langchainChild.postMessage({
      type: 'init',
      embeddingCachePath: path.join(externalResourcesDir(), 'embeddingCache'),
    })

    langchainChild.on('message', (message) => {
      appLogger.info(
        `Message from langchain utility process: Type ${message.type}`,
        'electron-backend',
      )
    })

    langchainChild.on('error', (error) => {
      appLogger.error(`Error from langchain utility process: ${error}`, 'electron-backend')
    })

    langchainChild.on('exit', (code) => {
      if (code !== 0) {
        appLogger.info(`Langchain utility process exited with code ${code}`, 'electron-backend')
      }
      setTimeout(() => {
        spawnLangchainUtilityProcess()
      }, 1000)
      langchainChild = null
    })
  } catch (error) {
    appLogger.error(`Error starting langchain utility process: ${error}`, 'electron-backend')
  }
}

/**
 * Send a request message to a utility child process and resolve with the child's matching response.
 *
 * @param eventType - The message type to send and the response `type` to wait for.
 * @param args - The payload to send with the request.
 * @returns The `returnValue` carried by the child's response message for `eventType`.
 * @throws If `child` is `null`. The returned promise also rejects if the child emits an error describing the failure.
 */
export function handleUtilityFunction<T, R>(
  eventType: string,
  child: UtilityProcess | null,
  args: T,
): Promise<R> {
  if (!child) {
    throw new Error('Utility process is not running')
  }
  return new Promise((resolve, reject) => {
    const messageHandler = (message: { type: string; returnValue: R }) => {
      if (message.type === eventType) {
        child.off('message', messageHandler)
        resolve(message.returnValue)
      }
    }

    const errorHandler = (type: string, location: string, report: string) => {
      const error = new Error(`Error in ${type} at ${location}: ${report}`)
      child.off('error', errorHandler)
      reject(error)
    }

    child.on('message', messageHandler)
    child.on('error', errorHandler)

    child.postMessage({ type: eventType, args: args })
  })
}

/**
 * Add a document to the retrieval-augmented generation (RAG) index.
 *
 * @param document - The document to add to the RAG list
 * @returns The stored `IndexedDocument`, potentially updated with assigned metadata or identifiers
 */
export function addDocumentToRAGList(document: IndexedDocument): Promise<IndexedDocument> {
  return handleUtilityFunction<IndexedDocument, IndexedDocument>(
    'addDocumentToRAGList',
    langchainChild,
    document,
  )
}

/**
 * Request retrieval-augmented embeddings for the given input and return the resulting key/value payload.
 *
 * @param embedInquiry - Parameters describing the input to embed and any retrieval or embedding options
 * @returns A KVObject containing the embedding vector and associated metadata (for example identifiers, scores, or other related fields)
 */
export function embedInputUsingRag(embedInquiry: EmbedInquiry): Promise<KVObject> {
  return handleUtilityFunction<EmbedInquiry, KVObject>(
    'embedInputUsingRag',
    langchainChild,
    embedInquiry,
  )
}

/**
 * Retrieve the current Langchain utility child process.
 *
 * @returns The running `UtilityProcess` for the Langchain worker, or `null` if it is not started.
 */
export function getLangchainChild(): UtilityProcess | null {
  return langchainChild
}