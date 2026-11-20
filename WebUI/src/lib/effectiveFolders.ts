import {
  hostPathsNest,
  isWritable,
  resolveMountedFolders,
  sameHostPath,
  uniqueName,
  workspaceEntryOf,
  type ResolvedMountedFolder,
} from '@/lib/mountedFolders'
import type {
  AgentFolderOverrides as StoredFolderOverrides,
  MountedFolderAccess,
} from '@/types/agentSessionIpc'
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

/** A Session folder not mounted because an Agent folder with other access nests with it. */
export type LeftOutFolder = EffectiveFolder & { overlaps: string }

export type EffectiveFolders = {
  workspace: EffectiveFolder
  others: EffectiveFolder[]
  leftOut: LeftOutFolder[]
}

export type EffectiveFoldersInput = {
  session: SessionFolderList
  agent?: AgentFolderOverrides
  /** How two host paths are matched as one folder; main passes one that follows symlinks. */
  sameFolder?: (a: string, b: string) => boolean
}

/** A Settings Template's overrides as the resolver reads them; undefined inherits everything. */
export function agentOverridesOf(
  stored: StoredFolderOverrides | undefined,
): AgentFolderOverrides | undefined {
  if (!stored) return undefined
  const { workspace, folders } = stored
  return {
    ...(workspace
      ? { workspace: { id: workspace.id, hostPath: workspace.hostPath, name: workspace.slug } }
      : {}),
    ...(folders
      ? {
          folders: folders.map(({ id, hostPath, slug, access }) => ({
            id,
            hostPath,
            name: slug,
            access,
          })),
        }
      : {}),
  }
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

/** Which Workspace and folders are in effect: the Agent's overrides, else the Session's. */
export function effectiveFolders(input: EffectiveFoldersInput): EffectiveFolders | undefined {
  const star = workspaceEntryOf(input.session)
  if (!star) return undefined
  const agent = fromAgent(input.agent ?? {})
  const workspace = agent.workspace ?? fromEntry(star, 'read-write')
  const others = [
    ...(agent.folders ??
      input.session.folders.filter((entry) => entry.id !== star.id).map((e) => fromEntry(e))),
    ...(agent.workspace && !agent.folders ? [fromEntry(star, 'read-write')] : []),
  ]
  const sameFolder = input.sameFolder ?? sameHostPath
  const kept: EffectiveFolder[] = []
  const leftOut: LeftOutFolder[] = []
  others.forEach((folder, i) => {
    if (sameFolder(folder.hostPath, workspace.hostPath)) return
    const rivals = [workspace, ...others.filter((_, j) => j !== i)]
    const winner = rivals.find((rival) =>
      givesWay(folder, rival, rival === workspace || others.indexOf(rival) < i, sameFolder),
    )
    if (!winner) kept.push(folder)
    else if (!sameFolder(folder.hostPath, winner.hostPath)) {
      leftOut.push({ ...folder, overlaps: winner.hostPath })
    }
  })
  const [named, ...rest] = withUniqueNames([workspace, ...kept])
  return { workspace: named, others: rest, leftOut }
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
    isWritable(folder) !== isWritable(rival) &&
    hostPathsNest(folder.hostPath, rival.hostPath)
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
