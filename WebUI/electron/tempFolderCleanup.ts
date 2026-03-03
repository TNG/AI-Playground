import fs from 'node:fs'
import path from 'node:path'
import { appLoggerInstance } from './logging/logger.ts'

const logger = appLoggerInstance
const LOG_SOURCE = 'tmpCleanup'

// Matches temp folders created by model_downloader.py getTmpPath(), e.g.
// fd824df26f56f9a3_tmp, 0a1b2c3d4e5f6789_tmp, etc.
export const TMP_FOLDER_PATTERN = /^[0-9a-f]{16}_tmp$/
const REQUIRED_PARENT_FOLDER = 'models'

export function findTempFolders(baseDir: string): string[] {
  const entries = fs.readdirSync(baseDir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && TMP_FOLDER_PATTERN.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
}

export function cleanupTempFolders(baseDir: string) {
  logger.info(`[tmpCleanup] Attempting to clean up temp folders in: ${baseDir}`, LOG_SOURCE)
  if (!fs.existsSync(baseDir)) {
    logger.warn(`[tmpCleanup] Base directory does not exist: ${baseDir}`, LOG_SOURCE)
    return
  }

  if (!path.normalize(baseDir).split(path.sep).includes(REQUIRED_PARENT_FOLDER)) {
    logger.warn(
      `[tmpCleanup] Base directory does not contain a ${REQUIRED_PARENT_FOLDER} folder. This should not happen, aborting.`,
      LOG_SOURCE,
    )
    return
  }

  const tempFolders = findTempFolders(baseDir)

  if (tempFolders.length === 0) {
    logger.info(`[tmpCleanup] No temp folders found.`, LOG_SOURCE)
    return
  }

  logger.info(`[tmpCleanup] Found the following temp folder(s):`, LOG_SOURCE)
  for (const tempFolder of tempFolders) {
    logger.info(`[tmpCleanup] - ${tempFolder}`, LOG_SOURCE)
  }

  for (const tempFolder of tempFolders) {
    try {
      logger.info(`[tmpCleanup] Removing: ${tempFolder}`, LOG_SOURCE)
      fs.rmSync(tempFolder, { recursive: true, force: true })
    } catch (error) {
      logger.error(
        `[tmpCleanup] Failed to remove ${tempFolder}: ${error instanceof Error ? error.message : String(error)}`,
        LOG_SOURCE,
      )
    }
  }
}
