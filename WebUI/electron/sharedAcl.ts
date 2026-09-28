import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Inheritable modify for BUILTIN\Users. The SID avoids a locale-specific group
// name. (OI)(CI) is required: without it, only the folder itself is writable
// and files created by one account stay locked for every other account.
const usersModifyAce = '*S-1-5-32-545:(OI)(CI)M'

function icaclsArgs(dir: string): string[] {
  return [dir, '/grant', usersModifyAce, '/T', '/C']
}

/** Best-effort. Used at startup, before the logger exists. No-op off Windows. */
export function grantUsersModifySync(dir: string): void {
  if (process.platform !== 'win32') return
  const result = spawnSync('icacls', icaclsArgs(dir), { windowsHide: true })
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ?? result.stderr?.toString().trim() ?? `exit ${result.status}`
    console.error(`[aipg] could not grant all users write access on ${dir}: ${detail}`)
  }
}

/** Throws on failure so the caller can log it. No-op off Windows. */
export async function grantUsersModify(dir: string): Promise<void> {
  if (process.platform !== 'win32') return
  await execFileAsync('icacls', icaclsArgs(dir), { windowsHide: true })
}
