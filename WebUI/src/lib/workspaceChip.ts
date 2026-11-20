import { folderBaseName, workspaceEntryOf } from '@/lib/mountedFolders'
import type { MountedFolder } from '@/types/agentSessionIpc'
import type { SessionFolderEntry, SessionFolderList } from '@/types/sessionIpc'

export type WorkspaceChipFolder = {
  id: string
  name: string
  path: string
  workspace: boolean
  /** Set on a folder of the picked Agent's own, which its runs mount beside the Workspace. */
  agentId?: string
}

/** The Agent picked in the prompt bar: its run sees the Workspace and these folders only. */
export type WorkspaceChipAgent = { id: string; name: string; folders: readonly MountedFolder[] }

export type WorkspaceChip = {
  name: string
  path: string
  folderId: string
  folders: WorkspaceChipFolder[]
}

function chipFolder(entry: SessionFolderEntry, workspace: boolean): WorkspaceChipFolder {
  const name = folderBaseName(entry.hostPath) || entry.hostPath
  return { id: entry.id, name, path: entry.hostPath, workspace }
}

/** The Session's starred folder for the chip above the prompt bar; games presets have their game bar. */
export function workspaceChipOf(input: {
  games: boolean
  folderList: SessionFolderList | undefined
  agent?: WorkspaceChipAgent
}): WorkspaceChip | undefined {
  if (input.games || !input.folderList) return undefined
  const workspace = workspaceEntryOf(input.folderList)
  if (!workspace) return undefined
  const starred = chipFolder(workspace, true)
  const beside = input.agent
    ? agentFolders(input.agent)
    : input.folderList.folders
        .filter((entry) => entry.id !== workspace.id)
        .map((entry) => chipFolder(entry, false))
  return {
    name: starred.name,
    path: starred.path,
    folderId: workspace.id,
    folders: [starred, ...beside],
  }
}

function agentFolders(agent: WorkspaceChipAgent): WorkspaceChipFolder[] {
  return agent.folders.map((folder) => ({
    id: `${agent.id}:${folder.hostPath}`,
    name: folderBaseName(folder.hostPath) || folder.hostPath,
    path: folder.hostPath,
    workspace: false,
    agentId: agent.id,
  }))
}
