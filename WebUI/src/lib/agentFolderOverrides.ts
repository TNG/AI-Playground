import { assignSlug, resolveMountedFolders, sameHostPath } from '@/lib/mountedFolders'
import type {
  AgentFolderEntry,
  AgentFolderOverrides,
  AgentSessionSettings,
  MountedFolder,
} from '@/types/agentSessionIpc'

/** An Agent folder entry as a Mounted Folder named by its slug. */
export function namedFolder(entry: {
  hostPath: string
  slug: string
  access?: AgentFolderEntry['access']
}): MountedFolder {
  const { hostPath, slug, access } = entry
  return { hostPath, name: slug, ...(access ? { access } : {}) }
}

/** An Agent's other folders as the shared folder list edits them. */
export function editableFolders(entries: readonly AgentFolderEntry[]): MountedFolder[] {
  return entries.map(namedFolder)
}

/** The edited list back as entries: each keeps its id; a new folder gets an id and slug once. */
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

/** “Always work in” a folder, or undefined to use the Session's; another folder gets a new id. */
export function withWorkspace(
  overrides: AgentFolderOverrides,
  hostPath: string | undefined,
  newId: () => string,
): AgentFolderOverrides {
  const { workspace: previous, ...rest } = overrides
  if (!hostPath) return rest
  if (previous && sameHostPath(previous.hostPath, hostPath)) return { workspace: previous, ...rest }
  return { workspace: { id: newId(), hostPath, slug: assignSlug(hostPath, []) }, ...rest }
}

/** The Agent with its own Workspace moved to `hostPath`, keeping its id and slug. */
export function withWorkspaceAt<T extends { settingsTemplate: AgentSessionSettings }>(
  agent: T,
  hostPath: string,
): T {
  const overrides = agent.settingsTemplate.folderOverrides
  if (!overrides?.workspace) return agent
  const workspace = { ...overrides.workspace, hostPath }
  const folderOverrides = { ...overrides, workspace }
  return { ...agent, settingsTemplate: { ...agent.settingsTemplate, folderOverrides } }
}
