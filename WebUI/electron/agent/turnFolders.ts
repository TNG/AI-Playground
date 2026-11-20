import fs from 'node:fs'
import path from 'node:path'
import { ensureFolder } from '../persist/fileOps'
import { isDemoSessions } from '../persist/sessionFiles'
import { getAgentTrialsDir } from '../persist/userDataPaths.ts'
import { readSessionFolders } from '../session/sessionFolders'
import {
  assignSlug,
  foldersBesideWorkspace,
  mountedFolderLocation,
  mountedFoldersBesideWorkspace,
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

function besideWorkspace(
  workspace: ResolvedMountedFolder,
  folders: ResolvedMountedFolder[],
): TurnFolders {
  const mounted = foldersBesideWorkspace(workspace, folders, (folder) =>
    sameFolder(folder.hostPath, workspace.hostPath),
  )
  return { workspace, mounted }
}

/**
 * What a turn mounts: a turn in its Session's Workspace sees every folder in the Session's list,
 * an Agent Run (or Follow-up) the Workspace plus its Agent's folders, a Trial Run its scratch
 * folder plus the Agent's; a game keeps `/workspace` and the folders it was sent.
 */
export async function turnFolders(config: AgentModeTurnConfig): Promise<TurnFolders> {
  const agentFolders = isDemoSessions() ? [] : resolveMountedFolders(config.mountedFolders ?? [])
  const agentRun = !!config.taskRun || !!config.followUp
  if (!config.sessionRef) {
    if (!trialAgentIdOf(config.workspaceDir)) return { mounted: agentFolders }
    const name = assignSlug(config.workspaceDir, [])
    return besideWorkspace(
      { hostPath: config.workspaceDir, name, access: 'read-write' },
      agentFolders,
    )
  }
  const list = await folderListOf(config.sessionRef)
  const entry = list && workspaceEntryOf(list)
  if (!list || !entry || !sameFolder(entry.hostPath, config.workspaceDir)) {
    return { mounted: agentFolders }
  }
  const workspace = workspaceMountOf(entry, config.workspaceDir)
  if (agentRun) return besideWorkspace(workspace, agentFolders)
  await remakeOwnFolders(list)
  return besideWorkspace(workspace, mountedFoldersBesideWorkspace(list))
}

/** The folders the app created for the Session, made again if deleted, so no turn fails on one. */
async function remakeOwnFolders(list: SessionFolderList): Promise<void> {
  for (const folder of list.folders) {
    if (folder.appCreated && !folder.planned) await ensureFolder(folder.hostPath)
  }
}

function workspaceMountOf(entry: SessionFolderEntry, workspaceDir: string): ResolvedMountedFolder {
  return { hostPath: workspaceDir, name: entry.slug, access: 'read-write' }
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
  const found = mounted.find((folder) => sameFolder(folder.hostPath, entry.hostPath))
  return found && mountedFolderLocation(found, unsandboxed)
}
