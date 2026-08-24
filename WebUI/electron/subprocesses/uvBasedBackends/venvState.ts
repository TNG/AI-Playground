import fs from 'node:fs'
import path from 'node:path'
import { restoreTreeWritePermissions } from '../tools.ts'

export function venvInterpreterPath(venvDir: string): string {
  return path.join(
    venvDir,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  )
}

export function isUsableVenv(venvDir: string): boolean {
  return fs.existsSync(venvInterpreterPath(venvDir))
}

export function requireUsableVenv(venvDir: string): void {
  if (isUsableVenv(venvDir)) return
  throw new Error(`Virtual environment at ${venvDir} is missing ${venvInterpreterPath(venvDir)}`)
}

/**
 * Remove a leftover `.venv` that has no interpreter. `uv venv --allow-existing`
 * preserves that directory instead of recreating python.exe — the state an
 * incomplete uninstall / app upgrade leaves behind (dir exists, spawn ENOENT).
 * Returns true when a broken venv was removed.
 */
export async function removeBrokenVenv(venvDir: string): Promise<boolean> {
  if (!fs.existsSync(venvDir)) return false
  if (isUsableVenv(venvDir)) return false

  await restoreTreeWritePermissions(venvDir)

  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.promises.rm(venvDir, { recursive: true, force: true })
      return true
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException)?.code === 'EACCES') {
        await restoreTreeWritePermissions(venvDir)
      }
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      }
    }
  }
  throw lastError
}
