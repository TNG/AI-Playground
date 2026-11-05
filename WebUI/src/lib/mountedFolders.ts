import type { MountedFolder, MountedFolderAccess } from '@/types/agentSessionIpc'

/** A Mounted Folder as a turn uses it: its host folder, seen at `/mnt/<name>`. */
export type ResolvedMountedFolder = {
  hostPath: string
  name: string
  access: MountedFolderAccess
}

export const MOUNTED_FOLDERS_ROOT = '/mnt'

export function folderBaseName(hostPath: string): string {
  return (
    hostPath
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? ''
  )
}

function sanitizedName(raw: string): string {
  const name = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '')
  return name || 'folder'
}

/** Give each folder its sandbox name: the user's name or the folder name, made unique. */
export function resolveMountedFolders(folders: readonly MountedFolder[]): ResolvedMountedFolder[] {
  const taken = new Set<string>()
  return folders.map((folder) => {
    const base = sanitizedName(folder.name?.trim() || folderBaseName(folder.hostPath))
    let name = base
    for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) name = `${base}-${suffix}`
    taken.add(name.toLowerCase())
    return { hostPath: folder.hostPath, name, access: folder.access ?? 'read-only' }
  })
}

export type MountedFolderRefusal =
  | { reason: 'too-broad' | 'home' | 'session-folder' }
  | { reason: 'mounted' | 'contains-mounted'; folder: string }

export type MountedFolderContext = {
  homeFolder?: string
  sessionFolder?: string
  mountedFolders: readonly MountedFolder[]
}

/** Path segments with separators unified; a drive letter or UNC share is the first segment. */
function segmentsOf(hostPath: string): string[] {
  const unified = hostPath.replace(/\\/g, '/')
  const unc = unified.match(/^\/\/([^/]+)\/([^/]+)/)
  if (unc) {
    const rest = unified.slice(unc[0].length)
    return [`//${unc[1]}/${unc[2]}`.toLowerCase(), ...rest.split('/').filter(Boolean)]
  }
  return unified.split('/').filter(Boolean)
}

function isDriveRoot(segments: string[]): boolean {
  if (segments.length === 0) return true
  if (segments.length === 1) return /^[a-z]:$/i.test(segments[0]) || segments[0].startsWith('//')
  return segments.length === 2 && segments[0] === 'Volumes'
}

function comparable(hostPath: string): string[] {
  const segments = segmentsOf(hostPath)
  const windows = /^[a-z]:$/i.test(segments[0] ?? '') || hostPath.match(/^[\\/]{2}/)
  return windows ? segments.map((segment) => segment.toLowerCase()) : segments
}

/** Whether `outer` is `inner` or one of its parent folders. */
function holds(outer: string[], inner: string[]): boolean {
  return outer.length <= inner.length && outer.every((segment, i) => segment === inner[i])
}

/** Why a folder cannot be added as a Mounted Folder, or undefined when it can. */
export function mountedFolderRefusal(
  candidate: string,
  context: MountedFolderContext,
): MountedFolderRefusal | undefined {
  const folder = comparable(candidate)
  if (isDriveRoot(folder)) return { reason: 'too-broad' }
  if (context.homeFolder && holds(folder, comparable(context.homeFolder))) return { reason: 'home' }
  if (context.sessionFolder) {
    const sessionFolder = comparable(context.sessionFolder)
    if (holds(folder, sessionFolder) || holds(sessionFolder, folder)) {
      return { reason: 'session-folder' }
    }
  }
  for (const mounted of resolveMountedFolders(context.mountedFolders)) {
    const mountedPath = comparable(mounted.hostPath)
    const sandboxPath = `${MOUNTED_FOLDERS_ROOT}/${mounted.name}`
    if (holds(mountedPath, folder)) return { reason: 'mounted', folder: sandboxPath }
    if (holds(folder, mountedPath)) return { reason: 'contains-mounted', folder: sandboxPath }
  }
  return undefined
}
