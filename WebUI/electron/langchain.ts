import { utilityProcess, UtilityProcess } from 'electron'
import path from 'node:path'
import { externalResourcesDir } from './util.ts'
import { appLoggerInstance } from './logging/logger.ts'
import type { IndexedDocument, EmbedInquiry } from '@/assets/js/store/textInference.ts'

const appLogger = appLoggerInstance

let langchainChild: UtilityProcess | null = null

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

export function addDocumentToRAGList(document: IndexedDocument): Promise<IndexedDocument> {
  return handleUtilityFunction<IndexedDocument, IndexedDocument>(
    'addDocumentToRAGList',
    langchainChild,
    document,
  )
}

export function embedInputUsingRag(embedInquiry: EmbedInquiry): Promise<KVObject> {
  return handleUtilityFunction<EmbedInquiry, KVObject>(
    'embedInputUsingRag',
    langchainChild,
    embedInquiry,
  )
}

export function getLangchainChild(): UtilityProcess | null {
  return langchainChild
}

