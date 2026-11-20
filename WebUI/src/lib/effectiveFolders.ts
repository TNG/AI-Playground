import {
  hostPathsNest,
  isWritable,
  resolveMountedFolders,
  sameHostPath,
  uniqueName,
  workspaceEntryOf,
  type ResolvedMountedFolder,
} from '@/lib/mountedFolders'
import type { MountedFolderAccess } from '@/types/agentSessionIpc'
import type { SessionFolderEntry, SessionFolderList } from '@/types/sessionIpc'

/** A folder of an Agent's overrides; `name` is its slug, else the folder name. */
export type AgentFolder = {
  id?: string
  hostPath: string
  name?: string
  access?: MountedFolderAccess
}

/** What an Agent puts in place of its Session's folders; an absent part is inherited. */
export type AgentFolderOverrides = {
  workspace?: Omit<AgentFolder, 'access'>
  folders?: readonly AgentFolder[]
}

/** A folder in effect for a turn, at `/mnt/<name>`, and the list it came from. */
export type EffectiveFolder = ResolvedMountedFolder & {
  id?: string
  source: 'session' | 'agent'
  planned?: boolean
}

export type EffectiveFolders = { workspace: EffectiveFolder; others: EffectiveFolder[] }

export type EffectiveFoldersInput = {
  session: SessionFolderList
  agent?: AgentFolderOverrides
  /** How two host paths are matched as one folder; main passes one that follows symlinks. */
  sameFolder?: (a: string, b: string) => boolean
}

function fromEntry(entry: SessionFolderEntry, access = entry.access): EffectiveFolder {
  return {
    id: entry.id,
    hostPath: entry.hostPath,
    name: entry.slug,
    access,
    source: 'session',
    ...(entry.planned ? { planned: true } : {}),
  }
}

function fromAgent(agent: AgentFolderOverrides): {
  workspace?: EffectiveFolder
  folders?: EffectiveFolder[]
} {
  const listed = [
    ...(agent.workspace ? [{ ...agent.workspace, access: 'read-write' as const }] : []),
    ...(agent.folders ?? []),
  ]
  const resolved = resolveMountedFolders(listed).map((folder, i): EffectiveFolder => ({
    ...folder,
    ...(listed[i].id ? { id: listed[i].id } : {}),
    source: 'agent',
  }))
  const workspace = agent.workspace ? resolved[0] : undefined
  return { workspace, folders: agent.folders && resolved.slice(workspace ? 1 : 0) }
}

/**
 * Which Workspace and folders are in effect: the Agent's overrides, else the Session's star and
 * other folders; the Session's Workspace stays mounted read-write beside an overriding one.
 */
export function effectiveFolders(input: EffectiveFoldersInput): EffectiveFolders | undefined {
  const star = workspaceEntryOf(input.session)
  if (!star) return undefined
  const agent = fromAgent(input.agent ?? {})
  const workspace = agent.workspace ?? fromEntry(star, 'read-write')
  const others = [
    ...(agent.folders ??
      input.session.folders.filter((entry) => entry.id !== star.id).map((e) => fromEntry(e))),
    ...(agent.workspace ? [fromEntry(star, 'read-write')] : []),
  ]
  const kept = withoutOverlaps(workspace, others, input.sameFolder ?? sameHostPath)
  const [named, ...rest] = withUniqueNames([workspace, ...kept])
  return { workspace: named, others: rest }
}

/** Whether `folder` gives way to `rival`, which comes first when `rivalFirst`. */
function givesWay(
  folder: EffectiveFolder,
  rival: EffectiveFolder,
  rivalFirst: boolean,
  sameFolder: (a: string, b: string) => boolean,
): boolean {
  if (sameFolder(folder.hostPath, rival.hostPath)) {
    if (isWritable(folder) !== isWritable(rival)) return isWritable(rival)
    if (folder.source !== rival.source) return rival.source === 'agent'
    return rivalFirst
  }
  return (
    folder.source === 'session' &&
    rival.source === 'agent' &&
    hostPathsNest(folder.hostPath, rival.hostPath)
  )
}

function withoutOverlaps(
  workspace: EffectiveFolder,
  others: readonly EffectiveFolder[],
  sameFolder: (a: string, b: string) => boolean,
): EffectiveFolder[] {
  return others.filter(
    (folder, i) =>
      !sameFolder(folder.hostPath, workspace.hostPath) &&
      !givesWay(folder, workspace, true, sameFolder) &&
      !others.some((rival, j) => j !== i && givesWay(folder, rival, j < i, sameFolder)),
  )
}

/** Session slugs are kept as stored; an Agent folder's name one already holds is suffixed. */
function withUniqueNames(folders: readonly EffectiveFolder[]): EffectiveFolder[] {
  const ofSession = new Set(
    folders.filter((folder) => folder.source === 'session').map((f) => f.name.toLowerCase()),
  )
  const taken = new Set(folders.map((folder) => folder.name.toLowerCase()))
  return folders.map((folder) => {
    if (folder.source === 'session' || !ofSession.has(folder.name.toLowerCase())) return folder
    const name = uniqueName(folder.name, taken)
    taken.add(name.toLowerCase())
    return { ...folder, name }
  })
}
