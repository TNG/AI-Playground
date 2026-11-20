import { agentOverridesOf, effectiveFolders, type EffectiveFolder } from '@/lib/effectiveFolders'
import { folderBaseName } from '@/lib/mountedFolders'
import type { AgentFolderOverrides } from '@/types/agentSessionIpc'
import type { SessionFolderList } from '@/types/sessionIpc'

export type WorkspaceChipFolder = {
  id: string
  name: string
  path: string
  workspace: boolean
  /** Set on a folder the picked Agent puts in place of the Session's; changed in the Agent. */
  agentId?: string
}

/** The Agent picked in the prompt bar; absent overrides inherit the Session's folders. */
export type WorkspaceChipAgent = { id: string; name: string; overrides?: AgentFolderOverrides }

export type WorkspaceChip = {
  name: string
  path: string
  folderId: string
  folders: WorkspaceChipFolder[]
}

function chipFolder(
  folder: EffectiveFolder,
  workspace: boolean,
  agent: WorkspaceChipAgent | undefined,
): WorkspaceChipFolder {
  const name = folderBaseName(folder.hostPath) || folder.hostPath
  const shown = { name, path: folder.hostPath, workspace }
  if (folder.source === 'session' || !agent) return { id: folder.id ?? folder.hostPath, ...shown }
  return { id: `${agent.id}:${folder.hostPath}`, ...shown, agentId: agent.id }
}

/** The folders in effect for the chip above the prompt bar; games presets have their game bar. */
export function workspaceChipOf(input: {
  games: boolean
  folderList: SessionFolderList | undefined
  agent?: WorkspaceChipAgent
}): WorkspaceChip | undefined {
  if (input.games || !input.folderList) return undefined
  const { agent } = input
  const resolved = effectiveFolders({
    session: input.folderList,
    agent: agentOverridesOf(agent?.overrides),
  })
  if (!resolved) return undefined
  const starred = chipFolder(resolved.workspace, true, agent)
  return {
    name: starred.name,
    path: starred.path,
    folderId: starred.id,
    folders: [starred, ...resolved.others.map((folder) => chipFolder(folder, false, agent))],
  }
}
