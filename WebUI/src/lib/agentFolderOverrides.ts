import { resolveMountedFolders, sameHostPath } from '@/lib/mountedFolders'
import type { AgentFolderEntry, AgentFolderOverrides, MountedFolder } from '@/types/agentSessionIpc'

/** An Agent's other folders as the shared folder list edits them. */
export function editableFolders(entries: readonly AgentFolderEntry[]): MountedFolder[] {
  return entries.map(({ hostPath, slug, access }) => ({ hostPath, name: slug, access }))
}

/** The edited list back as entries: each keeps its id, and a new folder gets an id and slug once. */
export function agentFolderEntries(
  folders: readonly MountedFolder[],
  previous: readonly AgentFolderEntry[],
  newId: () => string,
): AgentFolderEntry[] {
  const resolved = resolveMountedFolders(folders)
  return folders.map((folder, index) => ({
    id: previous.find((entry) => sameHostPath(entry.hostPath, folder.hostPath))?.id ?? newId(),
    hostPath: folder.hostPath,
    slug: resolved[index].name,
    access: resolved[index].access,
  }))
}

/** “Use only these” folders, or undefined to use the Session's; the Workspace choice is kept. */
export function withOtherFolders(
  overrides: AgentFolderOverrides,
  folders: AgentFolderEntry[] | undefined,
): AgentFolderOverrides {
  const { folders: _previous, ...rest } = overrides
  return folders ? { ...rest, folders } : rest
}
