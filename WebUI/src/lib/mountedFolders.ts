import type { MountedFolder, MountedFolderAccess } from '@/types/agentSessionIpc'

/** A Mounted Folder as a turn uses it: its host folder, seen at `/mnt/<name>`. */
export type ResolvedMountedFolder = {
  hostPath: string
  name: string
  access: MountedFolderAccess
}

export const MOUNTED_FOLDERS_ROOT = '/mnt'

export function mountedFolderSandboxPath(folder: { name: string }): string {
  return `${MOUNTED_FOLDERS_ROOT}/${folder.name}`
}

/** Where the agent finds a folder: its sandbox path, or its real path under the real shell. */
export function mountedFolderLocation(folder: ResolvedMountedFolder, unsandboxed: boolean): string {
  return unsandboxed ? folder.hostPath : mountedFolderSandboxPath(folder)
}

export function isWritable(folder: { access?: MountedFolderAccess }): boolean {
  return folder.access === 'read-write'
}

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

function comparablePathSegments(hostPath: string): string[] {
  const segments = segmentsOf(hostPath)
  const windows = /^[a-z]:$/i.test(segments[0] ?? '') || hostPath.match(/^[\\/]{2}/)
  return windows ? segments.map((segment) => segment.toLowerCase()) : segments
}

function isSameOrAncestor(outer: string[], inner: string[]): boolean {
  return outer.length <= inner.length && outer.every((segment, i) => segment === inner[i])
}

/** Why a folder cannot be added as a Mounted Folder, or undefined when it can. */
export function mountedFolderRefusal(
  candidate: string,
  context: MountedFolderContext,
): MountedFolderRefusal | undefined {
  const folder = comparablePathSegments(candidate)
  if (isDriveRoot(folder)) return { reason: 'too-broad' }
  if (context.homeFolder && isSameOrAncestor(folder, comparablePathSegments(context.homeFolder)))
    return { reason: 'home' }
  if (context.sessionFolder) {
    const sessionFolder = comparablePathSegments(context.sessionFolder)
    if (isSameOrAncestor(folder, sessionFolder) || isSameOrAncestor(sessionFolder, folder)) {
      return { reason: 'session-folder' }
    }
  }
  for (const mounted of resolveMountedFolders(context.mountedFolders)) {
    const mountedPath = comparablePathSegments(mounted.hostPath)
    const sandboxPath = mountedFolderSandboxPath(mounted)
    if (isSameOrAncestor(mountedPath, folder)) return { reason: 'mounted', folder: sandboxPath }
    if (isSameOrAncestor(folder, mountedPath))
      return { reason: 'contains-mounted', folder: sandboxPath }
  }
  return undefined
}
