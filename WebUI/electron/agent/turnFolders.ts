import fs from 'node:fs'
import path from 'node:path'
import { containedIn } from './hostPathContainment.ts'
import { ensureFolder } from '../persist/fileOps'
import { isDemoSessions } from '../persist/sessionFiles'
import { trialFolderAgentIdOf } from '../persist/trialRunFiles'
import { getAgentTrialsDir } from '../persist/userDataPaths.ts'
import { readSessionFolders, registerAgentFolder } from '../session/sessionFolders'
import {
  agentOverridesOf,
  effectiveFolders,
  type AgentFolderOverrides,
} from '@/lib/effectiveFolders'
import {
  assignSlug,
  mountedFolderLocation,
  mountedFolderSandboxPath,
  resolveMountedFolders,
  workspaceEntryOf,
  type ResolvedMountedFolder,
} from '@/lib/mountedFolders'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { SessionFolderEntry, SessionFolderList } from '@/types/sessionIpc'

/** The folders a turn's sandbox mounts (ADR-0013). */
export type TurnFolders = {
  /** The Workspace at `/mnt/<slug>`, the working directory; absent for a game, kept at `/workspace`. */
  workspace?: ResolvedMountedFolder
  /** Every other folder, at `/mnt/<name>`. */
  mounted: ResolvedMountedFolder[]
  /** Session folders not mounted because an Agent folder they nest with has other access. */
  leftOut?: { hostPath: string; name: string; overlaps: string }[]
}

function realOrResolved(hostPath: string): string {
  try {
    return fs.realpathSync(hostPath)
  } catch {
    return path.resolve(hostPath)
  }
}

function sameFolder(a: string, b: string): boolean {
  return realOrResolved(a) === realOrResolved(b)
}

/** The Agent whose Trial Run works in `agent-trials/<agentId>/files`, if this is one. */
export function trialAgentIdOf(workspaceDir: string): string | undefined {
  const root = realOrResolved(getAgentTrialsDir())
  const [agentId, files, ...rest] = path
    .relative(root, realOrResolved(workspaceDir))
    .split(path.sep)
  if (!agentId || agentId.startsWith('.') || files !== 'files' || rest.length > 0) return undefined
  return agentId
}

async function folderListOf(sessionRef: string): Promise<SessionFolderList | undefined> {
  try {
    return await readSessionFolders(sessionRef)
  } catch {
    return undefined
  }
}

/** The folders in effect as the sandbox mounts them, the Workspace at the turn's own path. */
function mountsOf(
  session: SessionFolderList,
  workspaceDir: string,
  agent?: AgentFolderOverrides,
): TurnFolders {
  const resolved = effectiveFolders({ session, agent, sameFolder })
  if (!resolved) return { mounted: [] }
  const mount = ({ hostPath, name, access }: ResolvedMountedFolder) => ({ hostPath, name, access })
  const leftOut = resolved.leftOut
    .filter((folder) => !folder.planned)
    .map(({ hostPath, name, overlaps }) => ({ hostPath, name, overlaps }))
  return {
    workspace: { ...mount(resolved.workspace), hostPath: workspaceDir },
    mounted: resolved.others.filter((folder) => !folder.planned).map(mount),
    ...(leftOut.length > 0 ? { leftOut } : {}),
  }
}

function agentIdOf(config: AgentModeTurnConfig): string | undefined {
  return config.taskRun?.taskId ?? config.followUp?.agentId
}

/** The folder an Agent Run (or Follow-up) in a Session always works in, when its Agent sets one. */
export function agentWorkspaceOverride(
  config: AgentModeTurnConfig,
): { id?: string; hostPath: string } | undefined {
  if (!config.sessionRef || isDemoSessions() || !(config.taskRun || config.followUp)) return
  const own = config.folderOverrides?.workspace
  return own && { id: own.id, hostPath: own.hostPath }
}

/**
 * The Agent a turn is a Trial Run of: by its scratch folder, or by the Harness Session a Trial
 * Run holds when it works in its Agent's own folder.
 */
export async function trialAgentOf(
  config: Pick<AgentModeTurnConfig, 'sessionRef' | 'sessionId' | 'workspaceDir'>,
): Promise<string | undefined> {
  if (config.sessionRef) return undefined
  return trialAgentIdOf(config.workspaceDir) ?? (await trialFolderAgentIdOf(config.sessionId))
}

/** The Agent's own Workspace, when the turn is a Trial Run working in it. */
async function trialWorkspaceOverride(
  config: AgentModeTurnConfig,
  agent: AgentFolderOverrides | undefined,
): Promise<AgentFolderOverrides['workspace']> {
  const own = agent?.workspace
  if (!own || !sameFolder(own.hostPath, config.workspaceDir)) return undefined
  return (await trialFolderAgentIdOf(config.sessionId)) ? own : undefined
}

/** A Trial Run's Workspace as the one entry of a folder list. */
function trialFolderList(
  workspaceDir: string,
  slug = assignSlug(workspaceDir, []),
): SessionFolderList {
  return {
    workspaceId: 'trial',
    folders: [{ id: 'trial', hostPath: workspaceDir, slug, access: 'read-write' }],
  }
}

/**
 * What a turn mounts: a turn in its Session's Workspace sees every folder in the Session's list,
 * an Agent Run (or Follow-up) the same with its Agent's overrides in place, a Trial Run its
 * Agent's own Workspace or else its scratch folder, plus the Agent's folders; a game keeps `/workspace` and the folders it was sent.
 */
export async function turnFolders(config: AgentModeTurnConfig): Promise<TurnFolders> {
  const agent = isDemoSessions() ? undefined : agentOverridesOf(config.folderOverrides)
  const agentFolders = agent?.folders ?? []
  const agentRun = !!config.taskRun || !!config.followUp
  if (!config.sessionRef) {
    const own = await trialWorkspaceOverride(config, agent)
    if (!own && !trialAgentIdOf(config.workspaceDir)) {
      return { mounted: resolveMountedFolders(agentFolders) }
    }
    const trialAgent = agent?.folders ? { folders: agent.folders } : undefined
    const list = trialFolderList(config.workspaceDir, own?.name)
    return mountsOf(list, config.workspaceDir, trialAgent)
  }
  const list = await folderListOf(config.sessionRef)
  const entry = list && workspaceEntryOf(list)
  const own = agentRun ? agent?.workspace : undefined
  if (!list || !entry || !sameFolder(own?.hostPath ?? entry.hostPath, config.workspaceDir)) {
    return { mounted: resolveMountedFolders(agentFolders) }
  }
  if (own && agent) {
    const registered = await registerAgentFolder(config.sessionRef, {
      ...(agentIdOf(config) ? { agentId: agentIdOf(config) } : {}),
      folder: { id: own.id ?? '', hostPath: own.hostPath, slug: own.name ?? '' },
    })
    const workspace = { ...own, id: registered.id, name: registered.slug }
    return mountsOf(list, config.workspaceDir, { ...agent, workspace })
  }
  if (agentRun) return mountsOf(list, config.workspaceDir, agent)
  await remakeOwnFolders(list)
  return mountsOf(list, config.workspaceDir)
}

/** The folders the app created for the Session, made again if deleted, so no turn fails on one. */
async function remakeOwnFolders(list: SessionFolderList): Promise<void> {
  for (const folder of list.folders) {
    if (folder.appCreated && !folder.planned) await ensureFolder(folder.hostPath)
  }
}

/**
 * Where a turn finds a Session folder entry: its `/mnt/<name>`, or its real path under the real
 * shell; undefined when the turn does not mount it.
 */
export function folderEntryLocation(
  folders: TurnFolders,
  entry: Pick<SessionFolderEntry, 'hostPath'>,
  unsandboxed: boolean,
): string | undefined {
  const mounted = [...(folders.workspace ? [folders.workspace] : []), ...folders.mounted]
  const exact = mounted.find((folder) => sameFolder(folder.hostPath, entry.hostPath))
  if (exact) return mountedFolderLocation(exact, unsandboxed)
  const real = realOrResolved(entry.hostPath)
  for (const folder of mounted) {
    const root = realOrResolved(folder.hostPath)
    if (!containedIn(root, real)) continue
    const inside = path.relative(root, real).split(path.sep)
    return unsandboxed
      ? path.join(folder.hostPath, ...inside)
      : path.posix.join(mountedFolderSandboxPath(folder), ...inside)
  }
  return undefined
}
