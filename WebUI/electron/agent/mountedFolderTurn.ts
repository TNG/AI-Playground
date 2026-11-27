import fs from 'node:fs'
import path from 'node:path'
import {
  isWritable,
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

/** Nested folders may share a sandbox when both are read-write; the same folder twice never. */
function conflicts(a: string, b: string, bothWritable: boolean): boolean {
  if (a === b) return true
  return !bothWritable && overlaps(a, b)
}

function overlaps(a: string, b: string): boolean {
  return containedIn(a, b) || containedIn(b, a)
}

/**
 * Refuses a turn whose Mounted Folders, by real path, repeat the Workspace or each other, or nest
 * with them at other access. The picker refuses these too, but cannot see symlinked aliases or
 * folders that reached the turn another way (an Agent's Settings Template, a run in another
 * Session).
 */
export function assertMountedFoldersApart(
  workspace: string,
  folders: readonly MountedFolder[],
): void {
  const realWorkspace = realOrResolved(workspace)
  const seen: { name: string; hostPath: string; real: string; writable: boolean }[] = []
  for (const folder of resolveMountedFolders(folders)) {
    const real = realOrResolved(folder.hostPath)
    const writable = isWritable(folder)
    if (conflicts(real, realWorkspace, writable)) {
      throw new Error(
        `Mounted Folder "${folder.name}" (${folder.hostPath}) overlaps the Workspace ` +
          `${workspace}. Remove it from the agent settings, or mount a folder beside it.`,
      )
    }
    const clash = seen.find((other) => conflicts(real, other.real, writable && other.writable))
    if (clash) {
      throw new Error(
        `Mounted Folder "${folder.name}" (${folder.hostPath}) overlaps Mounted Folder ` +
          `"${clash.name}" (${clash.hostPath}). Keep only one of them in the agent settings.`,
      )
    }
    seen.push({ ...folder, real, writable })
  }
}

/** The note a turn starts with when its folders changed or a Session folder was left out. */
export function mountedFoldersChangeNote(
  previous: readonly ResolvedMountedFolder[],
  current: readonly ResolvedMountedFolder[],
  unsandboxed: boolean,
  workdir?: { before: string; after: string },
  leftOut: readonly { hostPath: string; overlaps: string }[] = [],
): string | undefined {
  const notes = [changedFolders(previous, current, unsandboxed, workdir), leftOutNote(leftOut)]
  return notes.filter(Boolean).join(' ') || undefined
}

function leftOutNote(leftOut: readonly { hostPath: string; overlaps: string }[]): string {
  if (leftOut.length === 0) return ''
  const each = leftOut.map(
    (folder) => `${folder.hostPath}, the Session's folder, overlaps ${folder.overlaps}`,
  )
  return `[Not mounted for this run: ${each.join('; ')}.]`
}

function changedFolders(
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
