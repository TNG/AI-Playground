import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// BUILTIN\Users. The SID avoids a locale-specific group name.
const usersSid = '*S-1-5-32-545'

// (OI)(CI) is inherited by a file that is created in the folder. uv hardlinks
// wheel contents out of its cache, and a same-volume move keeps the source
// security descriptor, so those files never inherit. The direct Modify ACE
// applies to the object itself, which is what a hardlink or move requires.
const inheritableModifyAce = `${usersSid}:(OI)(CI)M`
const objectModifyAce = `${usersSid}:M`

export function usersModifyIcaclsArgs(dir: string, recursive = true): string[] {
  const args = [dir, '/grant', inheritableModifyAce, '/grant', objectModifyAce]
  if (recursive) args.push('/T')
  args.push('/C')
  return args
}

/** Best-effort. Used at startup, before the logger exists. No-op off Windows. */
export function grantUsersModifySync(dir: string, recursive = true): boolean {
  if (process.platform !== 'win32') return true
  const result = spawnSync('icacls', usersModifyIcaclsArgs(dir, recursive), { windowsHide: true })
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return true
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ?? result.stderr?.toString().trim() ?? `exit ${result.status}`
    console.error(`[aipg] could not grant all users write access on ${dir}: ${detail}`)
    return false
  }
  return true
}

/** Throws on failure so the caller can log it. No-op off Windows. */
export async function grantUsersModify(dir: string, recursive = true): Promise<void> {
  if (process.platform !== 'win32') return
  await execFileAsync('icacls', usersModifyIcaclsArgs(dir, recursive), { windowsHide: true })
}
