import { active, agentTurns } from './piAgentState.ts'
import {
  readAgentSessionSessionRef,
  readAgentSessionWorkspaceDir,
} from '../persist/agentSessionFiles.ts'
import { readSessionFolders } from '../session/sessionFolders'
import {
  mountedFolderSandboxPath,
  mountedFoldersBesideWorkspace,
  workspaceEntryOf,
} from '@/lib/mountedFolders'

/** A session's workspace: its live Pi session's, else its saved record's (a first turn has none yet). */
export async function sessionWorkspaceDir(sessionId: string): Promise<string | null> {
  const live = agentTurns.get(sessionId)?.live ?? (active?.sessionId === sessionId ? active : null)
  return live?.workspaceDir || (await readAgentSessionWorkspaceDir(sessionId))
}

/** How a session's answers address files: its workspace host folder, its sandbox mount, and its mounted folders. */
export type SessionFileMounts = {
  workspaceDir: string
  /** The workspace's sandbox mount — `/workspace`, `/mnt/<slug>` — or its real path under the real shell. */
  workdir: string
  mounted: readonly { hostPath: string; name: string }[]
}

/** A live session's mounts are authoritative; a saved session's are rebuilt from its record and folder list. */
export async function sessionFileMounts(sessionId: string): Promise<SessionFileMounts | null> {
  const live = agentTurns.get(sessionId)?.live ?? (active?.sessionId === sessionId ? active : null)
  if (live) {
    return { workspaceDir: live.workspaceDir, workdir: live.workdir, mounted: live.folders.mounted }
  }
  const workspaceDir = await readAgentSessionWorkspaceDir(sessionId)
  if (!workspaceDir) return null
  const sessionRef = await readAgentSessionSessionRef(sessionId)
  if (!sessionRef) return { workspaceDir, workdir: '/workspace', mounted: [] }
  const list = await readSessionFolders(sessionRef).catch(() => null)
  const entry = list && workspaceEntryOf(list)
  if (!list || !entry) return { workspaceDir, workdir: '/workspace', mounted: [] }
  return {
    workspaceDir,
    workdir: mountedFolderSandboxPath({ name: entry.slug }),
    mounted: mountedFoldersBesideWorkspace(list),
  }
}
