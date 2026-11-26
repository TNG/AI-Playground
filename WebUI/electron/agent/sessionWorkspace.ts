import fs from 'node:fs'
import path from 'node:path'
import { active, agentTurns } from './piAgentState.ts'
import { readSessionStore } from './piSessionStore.ts'
import {
  readAgentSessionSessionRef,
  readAgentSessionWorkspaceDir,
} from '../persist/agentSessionFiles.ts'
import { readSessionFolders } from '../session/sessionFolders'
import { isInGamesLibrary } from '../session/sessionWorkspace.ts'
import {
  mountedFolderSandboxPath,
  mountedFoldersBesideWorkspace,
  workspaceEntryOf,
} from '@/lib/mountedFolders'
import type { SessionFolderEntry } from '@/types/sessionIpc'

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

/**
 * A recorded workspace dir that no longer exists, outside the games library, while the ★ is
 * app-created, is that Workspace under its pre-rename name — the record only catches up at
 * the next turn (`turnWorkspaceDir`, `followSessionWorkspace`).
 */
function followedWorkspaceDir(recorded: string, entry: SessionFolderEntry): string {
  if (entry.appCreated && !fs.existsSync(recorded) && !isInGamesLibrary(recorded)) {
    return entry.hostPath
  }
  return recorded
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

/**
 * The mounts the conversation's own turns ran with, as the session pointer
 * recorded them. The live branch is only reachable while this session holds
 * `active` or an open turn — which another session's turn takes away — so the
 * pointer, written when the Pi session is built, is what keeps an idle
 * session's file resolution stable (and true to the scheme its transcript's
 * references were written under). Null when the pointer is absent, older than
 * the recorded `workdir`, or for a workspace it no longer names.
 */
function pointerMounts(sessionId: string, workspaceDir: string): SessionFileMounts | null {
  const pointer = readSessionStore()[sessionId]
  if (!pointer?.workdir || !pointer.mountedFolders) return null
  if (!sameFolder(pointer.workspaceDir, workspaceDir)) return null
  // The pointer's folder list includes the Workspace itself once at `/mnt`;
  // `SessionFileMounts.mounted` is every folder but the Workspace.
  return {
    workspaceDir,
    workdir: pointer.workdir,
    mounted: pointer.mountedFolders
      .filter((folder) => !sameFolder(folder.hostPath, workspaceDir))
      .map(({ hostPath, name }) => ({ hostPath, name })),
  }
}

/**
 * A live session's mounts are authoritative while its workspace still exists — a rename
 * retargets only the preview server, so a live dir can be the pre-rename name; a saved
 * session's mounts are its pointer's when it has ones (above), else rebuilt from its
 * record and folder list, the stale record followed.
 */
export async function sessionFileMounts(sessionId: string): Promise<SessionFileMounts | null> {
  const live = agentTurns.get(sessionId)?.live ?? (active?.sessionId === sessionId ? active : null)
  if (live && fs.existsSync(live.workspaceDir)) {
    return { workspaceDir: live.workspaceDir, workdir: live.workdir, mounted: live.folders.mounted }
  }
  const workspaceDir = await readAgentSessionWorkspaceDir(sessionId)
  if (!workspaceDir) return null
  const sessionRef = await readAgentSessionSessionRef(sessionId)
  const list = sessionRef ? await readSessionFolders(sessionRef).catch(() => null) : null
  const entry = list && workspaceEntryOf(list)
  const followed = entry ? followedWorkspaceDir(workspaceDir, entry) : workspaceDir
  const pointer = pointerMounts(sessionId, followed)
  if (pointer) return pointer
  if (!list || !entry) return { workspaceDir, workdir: '/workspace', mounted: [] }
  return {
    workspaceDir: followed,
    workdir: mountedFolderSandboxPath({ name: entry.slug }),
    mounted: mountedFoldersBesideWorkspace(list),
  }
}
