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
