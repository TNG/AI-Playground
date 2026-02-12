import fs from 'node:fs'
import path from 'node:path'

// Matches temp folder naming convention from the model_downloader.py getTmpPath()
// fd824df26f56f9a3_tmp, 0a1b2c3d4e5f6789_tmp, etc.
const TMP_FOLDER_PATTERN = /^[0-9a-f]{16}_tmp$/

export function cleanupTempFolders(baseDir: string) {
  console.log(`[tmpCleanup] Attempting to clean up temp folders in: ${baseDir}`)
  if (!fs.existsSync(baseDir)){
    console.warn(`[tmpCleanup] Base directory does not exist: ${baseDir}`)
     return
    }

  const entries = fs.readdirSync(baseDir, { recursive: true, withFileTypes: true })
  const tempFolders = entries
    .filter((e) => e.isDirectory() && TMP_FOLDER_PATTERN.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))

  if (tempFolders.length === 0) {
    console.log(`[tmpCleanup] No temp folders found.`)
    return
  } else {
    console.log(`[tmpCleanup] Found the following temp folder(s) to clean up:`)
    for (const tempFolder of tempFolders) {
      console.log(`[tmpCleanup] ${tempFolder}`)
    }
  }

  // disabled to verify correct paths first...
  // for (const tempFolder of tempFolders) {
  //   try {
  //     console.log(`[tmpCleanup] Removing temp folder: ${tempFolder}`)
  //     fs.rmSync(tempFolder, { recursive: true, force: true })
  //   } catch (error) {
  //     console.error(`[tmpCleanup] Failed to remove ${tempFolder}:`, error)
  //   }
  // }
}
