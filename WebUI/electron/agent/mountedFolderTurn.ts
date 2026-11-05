import fs from 'node:fs'
import path from 'node:path'
import {
  MOUNTED_FOLDERS_ROOT,
  resolveMountedFolders,
  type ResolvedMountedFolder,
} from '@/lib/mountedFolders'
import type { MountedFolder } from '@/types/agentSessionIpc'

function isFolder(hostPath: string): boolean {
  try {
    return fs.statSync(hostPath).isDirectory()
  } catch {
    return false
  }
}

/** Refuses a turn whose Mounted Folders are not all there: the agent never runs with less. */
export function assertMountedFoldersPresent(folders: readonly MountedFolder[]): void {
  const missing = resolveMountedFolders(folders).find((folder) => !isFolder(folder.hostPath))
  if (!missing) return
  throw new Error(
    `Mounted Folder "${missing.name}" is missing: ${missing.hostPath} no longer exists or is ` +
      'not a folder. Reconnect it, or remove it from the agent settings.',
  )
}

/** One line for the turn after the Mounted Folders changed; undefined when they did not. */
export function mountedFoldersChangeNote(
  previous: readonly ResolvedMountedFolder[],
  current: readonly ResolvedMountedFolder[],
  unsandboxed: boolean,
): string | undefined {
  const where = (folder: ResolvedMountedFolder) =>
    unsandboxed ? folder.hostPath : path.posix.join(MOUNTED_FOLDERS_ROOT, folder.name)
  const before = new Map(previous.map((folder) => [folder.name, folder]))
  const now = new Set(current.map((folder) => folder.name))
  const added: string[] = []
  const changed: string[] = []
  for (const folder of current) {
    const was = before.get(folder.name)
    const label = `${where(folder)} (${folder.access})`
    if (!was) added.push(label)
    else if (was.hostPath !== folder.hostPath || was.access !== folder.access) changed.push(label)
  }
  const removed = previous.filter((folder) => !now.has(folder.name)).map(where)
  if (added.length + changed.length + removed.length === 0) return undefined
  const parts = [
    added.length > 0 ? `Added: ${added.join(', ')}.` : '',
    changed.length > 0 ? `Changed: ${changed.join(', ')}.` : '',
    removed.length > 0 ? `Removed, no longer available: ${removed.join(', ')}.` : '',
  ].filter(Boolean)
  return `[The user changed your Mounted Folders since your last turn. ${parts.join(' ')}]`
}
