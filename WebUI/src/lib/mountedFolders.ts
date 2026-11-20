import type { MountedFolder, MountedFolderAccess } from '@/types/agentSessionIpc'
import type { SessionFolderEntry, SessionFolderList } from '@/types/sessionIpc'

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

function uniqueName(raw: string, taken: ReadonlySet<string>): string {
  const base = sanitizedName(raw)
  let name = base
  for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) name = `${base}-${suffix}`
  return name
}

/** Give each folder its sandbox name: the user's name or the folder name, made unique. */
export function resolveMountedFolders(folders: readonly MountedFolder[]): ResolvedMountedFolder[] {
  const taken = new Set<string>()
  return folders.map((folder) => {
    const name = uniqueName(folder.name?.trim() || folderBaseName(folder.hostPath), taken)
    taken.add(name.toLowerCase())
    return { hostPath: folder.hostPath, name, access: folder.access ?? 'read-only' }
  })
}

/** The slug a folder added to a Session gets: its sanitised name, unique among `taken`. */
export function assignSlug(hostPath: string, taken: readonly string[]): string {
  return uniqueName(folderBaseName(hostPath), new Set(taken.map((slug) => slug.toLowerCase())))
}

export function workspaceEntryOf(list: SessionFolderList): SessionFolderEntry | undefined {
  return list.folders.find((folder) => folder.id === list.workspaceId)
}

/** The Session's folders other than its Workspace, as a turn mounts them at `/mnt/<slug>`. */
export function mountedFoldersBesideWorkspace(list: SessionFolderList): ResolvedMountedFolder[] {
  return list.folders
    .filter((folder) => folder.id !== list.workspaceId && !folder.planned)
    .map(({ hostPath, slug, access }) => ({ hostPath, name: slug, access }))
}

/** A turn's folders beside its Workspace: the Workspace itself dropped, a name it holds suffixed. */
export function foldersBesideWorkspace(
  workspace: ResolvedMountedFolder,
  folders: readonly ResolvedMountedFolder[],
  isWorkspace: (folder: ResolvedMountedFolder) => boolean,
): ResolvedMountedFolder[] {
  const beside = folders.filter((folder) => !isWorkspace(folder))
  const taken = new Set([workspace, ...beside].map((folder) => folder.name.toLowerCase()))
  return beside.map((folder) => {
    if (folder.name.toLowerCase() !== workspace.name.toLowerCase()) return folder
    const name = uniqueName(folder.name, taken)
    taken.add(name.toLowerCase())
    return { ...folder, name }
  })
}

export type MountedFolderRefusal =
  { reason: 'too-broad' | 'home' } | { reason: 'mounted' | 'contains-mounted'; folder: string }

export type MountedFolderContext = {
  homeFolder?: string
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

/** Whether two host paths name the same folder, case-insensitively on Windows. */
export function sameHostPath(a: string, b: string): boolean {
  const left = comparablePathSegments(a)
  const right = comparablePathSegments(b)
  return left.length === right.length && isSameOrAncestor(left, right)
}

function isSameOrAncestor(outer: string[], inner: string[]): boolean {
  return outer.length <= inner.length && outer.every((segment, i) => segment === inner[i])
}

function tooBroad(
  folder: string[],
  homeFolder: string | undefined,
): MountedFolderRefusal | undefined {
  if (isDriveRoot(folder)) return { reason: 'too-broad' }
  if (homeFolder && isSameOrAncestor(folder, comparablePathSegments(homeFolder)))
    return { reason: 'home' }
  return undefined
}

function overlapRefusal(
  folder: string[],
  others: readonly { hostPath: string; name: string }[],
): MountedFolderRefusal | undefined {
  for (const other of others) {
    const otherPath = comparablePathSegments(other.hostPath)
    const sandboxPath = mountedFolderSandboxPath(other)
    if (isSameOrAncestor(otherPath, folder)) return { reason: 'mounted', folder: sandboxPath }
    if (isSameOrAncestor(folder, otherPath))
      return { reason: 'contains-mounted', folder: sandboxPath }
  }
  return undefined
}

/** Why a folder cannot be added as a Mounted Folder, or undefined when it can. */
export function mountedFolderRefusal(
  candidate: string,
  context: MountedFolderContext,
): MountedFolderRefusal | undefined {
  const folder = comparablePathSegments(candidate)
  return (
    tooBroad(folder, context.homeFolder) ??
    overlapRefusal(folder, resolveMountedFolders(context.mountedFolders))
  )
}

/** Why a folder cannot join a Session's list, whose Workspace counts like any other entry. */
export function sessionFolderRefusal(
  candidate: string,
  context: { homeFolder?: string; folders: readonly SessionFolderEntry[] },
): MountedFolderRefusal | undefined {
  const folder = comparablePathSegments(candidate)
  const others = context.folders.map((entry) => ({ hostPath: entry.hostPath, name: entry.slug }))
  return tooBroad(folder, context.homeFolder) ?? overlapRefusal(folder, others)
}
