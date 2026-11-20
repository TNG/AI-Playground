import fs from 'node:fs'
import path from 'node:path'
import {
  mountedFolderLocation,
  resolveMountedFolders,
  type ResolvedMountedFolder,
} from '@/lib/mountedFolders'
import type { MountedFolder } from '@/types/agentSessionIpc'
import { containedIn, isFolder } from './hostPathContainment.ts'

/** Refuses a turn whose Mounted Folders are not all there: the agent never runs with less. */
export function assertMountedFoldersPresent(folders: readonly MountedFolder[]): void {
  const missing = resolveMountedFolders(folders).find((folder) => !isFolder(folder.hostPath))
  if (!missing) return
  throw new Error(
    `Mounted Folder "${missing.name}" is missing: ${missing.hostPath} no longer exists or is ` +
      'not a folder. Reconnect it, or remove it from the agent settings.',
  )
}

function realOrResolved(hostPath: string): string {
  try {
    return fs.realpathSync(hostPath)
  } catch {
    return path.resolve(hostPath)
  }
}

function overlaps(a: string, b: string): boolean {
  return containedIn(a, b) || containedIn(b, a)
}

/**
 * Refuses a turn whose Mounted Folders, by real path, overlap the Workspace or each
 * other. The picker refuses these too, but cannot see symlinked aliases or folders that
 * reached the turn another way (an Agent's Settings Template, a run in another Session).
 */
export function assertMountedFoldersApart(
  workspace: string,
  folders: readonly MountedFolder[],
): void {
  const realWorkspace = realOrResolved(workspace)
  const seen: { name: string; hostPath: string; real: string }[] = []
  for (const folder of resolveMountedFolders(folders)) {
    const real = realOrResolved(folder.hostPath)
    if (overlaps(real, realWorkspace)) {
      throw new Error(
        `Mounted Folder "${folder.name}" (${folder.hostPath}) overlaps the Workspace ` +
          `${workspace}. Remove it from the agent settings, or mount a folder beside it.`,
      )
    }
    const clash = seen.find((other) => overlaps(real, other.real))
    if (clash) {
      throw new Error(
        `Mounted Folder "${folder.name}" (${folder.hostPath}) overlaps Mounted Folder ` +
          `"${clash.name}" (${clash.hostPath}). Keep only one of them in the agent settings.`,
      )
    }
    seen.push({ ...folder, real })
  }
}

/** One line for the turn after its folders or working directory changed; undefined when not. */
export function mountedFoldersChangeNote(
  previous: readonly ResolvedMountedFolder[],
  current: readonly ResolvedMountedFolder[],
  unsandboxed: boolean,
  workdir?: { before: string; after: string },
): string | undefined {
  const where = (folder: ResolvedMountedFolder) => mountedFolderLocation(folder, unsandboxed)
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
  const moved = workdir && workdir.before !== workdir.after
  if (added.length + changed.length + removed.length === 0 && !moved) return undefined
  const parts = [
    moved
      ? `Your working directory, the Workspace, is now ${workdir.after}; save new files there. ` +
        `${workdir.before} is no longer your working directory.`
      : '',
    added.length > 0 ? `Added: ${added.join(', ')}.` : '',
    changed.length > 0 ? `Changed: ${changed.join(', ')}.` : '',
    removed.length > 0 ? `Removed, no longer available: ${removed.join(', ')}.` : '',
  ].filter(Boolean)
  return `[The user changed your folders since your last turn. ${parts.join(' ')}]`
}
