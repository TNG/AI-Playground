import fs from 'node:fs'
import path from 'node:path'

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
  console.log(`[tmpCleanup] Attempting to clean up temp folders in: ${baseDir}`)
  if (!fs.existsSync(baseDir)) {
    console.warn(`[tmpCleanup] Base directory does not exist: ${baseDir}`)
    return
  }

  if (!path.normalize(baseDir).split(path.sep).includes(REQUIRED_PARENT_FOLDER)) {
    console.warn(
      `[tmpCleanup] Base directory does not contain a ${REQUIRED_PARENT_FOLDER} folder. This should not happen, aborting.`,
    )
    return
  }

  const tempFolders = findTempFolders(baseDir)

  if (tempFolders.length === 0) {
    console.log(`[tmpCleanup] No temp folders found.`)
    return
  }

  console.log(`[tmpCleanup] Found the following temp folder(s):`)
  for (const tempFolder of tempFolders) {
    console.log(`[tmpCleanup] - ${tempFolder}`)
  }

  for (const tempFolder of tempFolders) {
    try {
      console.log(`[tmpCleanup] Removing: ${tempFolder}`)
      fs.rmSync(tempFolder, { recursive: true, force: true })
    } catch (error) {
      console.error(`[tmpCleanup] Failed to remove ${tempFolder}:`, error)
    }
  }
}
