import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { readSessionFileSync, sessionFolderPaths } from '../persist/sessionFiles'
import { copyIntoFolder, moveIntoFolder, writeNewFile } from '../persist/sessionMediaFiles'
import { getGamesDir } from '../persist/userDataPaths'
import { sessionFolderListOf } from './sessionFolderList'
import { ensureWorkspaceEntry } from './appWorkspace'
import { sessionFolderMediaUrl } from '@/lib/comfyWorkflow'
import { workspaceEntryOf } from '@/lib/mountedFolders'
import type { MissingWorkspace, SessionFolderEntry } from '@/types/sessionIpc'

/** An older Session's app-created Workspace, its `files/` folder. */
export function appCreatedWorkspaceDir(sessionId: string): string {
  return sessionFolderPaths(sessionId).filesDir
}

/** The Session's starred entry, read without waiting; undefined for an unknown Session. */
export function currentWorkspaceEntry(sessionId: string): SessionFolderEntry | undefined {
  const file = readSessionFileSync(sessionId)
  return file ? workspaceEntryOf(sessionFolderListOf(file)) : undefined
}

/** The Session's starred Workspace, which may not exist yet. */
export function sessionWorkspaceDir(sessionId: string): string {
  return currentWorkspaceEntry(sessionId)?.hostPath ?? appCreatedWorkspaceDir(sessionId)
}

/** Whether `workspaceDir` is the Session's Workspace, as opposed to a game folder. */
export function isSessionWorkspace(sessionId: string, workspaceDir: string): boolean {
  const workspace = sessionWorkspaceDir(sessionId)
  if (path.resolve(workspace) === path.resolve(workspaceDir)) return true
  try {
    return fs.realpathSync(workspace) === fs.realpathSync(workspaceDir)
  } catch {
    return false
  }
}

/** The Session's current Workspace; the app-created one is created at first use. */
export async function ensureSessionWorkspace(sessionId: string): Promise<string> {
  return (await ensureWorkspaceEntry(sessionId)).hostPath
}

/**
 * A Session turn's working folder, followed through a rename: a folder that no longer exists,
 * outside the games library, while the ★ is app-created, is that Workspace under its old name.
 */
export async function turnWorkspaceDir(sessionId: string, workspaceDir: string): Promise<string> {
  if (!workspaceDir || fs.existsSync(workspaceDir)) return workspaceDir
  const inGames = path.relative(path.resolve(getGamesDir()), path.resolve(workspaceDir))
  if (!inGames.startsWith('..') && !path.isAbsolute(inGames)) return workspaceDir
  if (!currentWorkspaceEntry(sessionId)?.appCreated) return workspaceDir
  return ensureSessionWorkspace(sessionId)
}

async function isFolder(hostPath: string): Promise<boolean> {
  try {
    return (await fsp.stat(hostPath)).isDirectory()
  } catch {
    return false
  }
}

function missingOf(entry: SessionFolderEntry): MissingWorkspace {
  return { folderId: entry.id, hostPath: entry.hostPath, name: path.basename(entry.hostPath) }
}

/**
 * A starred user folder that no longer exists; an app-created Workspace, or an unknown Session,
 * is never missing.
 */
export async function missingSessionWorkspace(sessionId: string): Promise<MissingWorkspace | null> {
  const entry = currentWorkspaceEntry(sessionId)
  if (!entry || entry.appCreated || (await isFolder(entry.hostPath))) return null
  const fallback = await ownFolderToReturnTo(sessionId)
  const missing = missingOf(entry)
  return fallback ? { ...missing, fallback: { folderId: fallback.id } } : missing
}

/** The folder created for the Session, while it is still on disk to go back to. */
export async function ownFolderToReturnTo(
  sessionId: string,
): Promise<SessionFolderEntry | undefined> {
  const file = readSessionFileSync(sessionId)
  if (!file) return undefined
  const list = sessionFolderListOf(file)
  for (const folder of list.folders) {
    if (folder.id === list.workspaceId || !folder.appCreated || folder.planned) continue
    if (await isFolder(folder.hostPath)) return folder
  }
  return undefined
}

export function missingWorkspaceMessage(missing: MissingWorkspace): string {
  return (
    `The Workspace folder "${missing.name}" is missing: ${missing.hostPath} no longer exists ` +
    'or is not a folder. Locate it or start a new Workspace in the Session’s folders.'
  )
}

/**
 * Refuses a turn whose Workspace is missing. A turn working in another folder (`workingIn`,
 * a game's) does not use the Workspace and is let through.
 */
export async function assertSessionWorkspacePresent(
  sessionId: string,
  workingIn?: string,
): Promise<void> {
  const missing = await missingSessionWorkspace(sessionId)
  if (!missing) return
  if (workingIn !== undefined && path.resolve(workingIn) !== path.resolve(missing.hostPath)) return
  throw new Error(missingWorkspaceMessage(missing))
}

/** A file adopted into the Workspace: its History reference and its media URL. */
export type WorkspaceFile = { artifact: { folderId: string; path: string }; url: string }

async function intoWorkspace(
  sessionId: string,
  place: (dir: string) => Promise<string | null>,
): Promise<WorkspaceFile | null> {
  const entry = await ensureWorkspaceEntry(sessionId)
  if (!entry.appCreated && !(await isFolder(entry.hostPath))) {
    throw new Error(missingWorkspaceMessage(missingOf(entry)))
  }
  const name = await place(entry.hostPath)
  if (name === null) return null
  return {
    artifact: { folderId: entry.id, path: name },
    url: sessionFolderMediaUrl(sessionId, entry.id, name),
  }
}

/** Moves a regular file into the Workspace under a free name. */
export function moveIntoWorkspace(
  sessionId: string,
  source: string,
): Promise<WorkspaceFile | null> {
  return intoWorkspace(sessionId, (dir) => moveIntoFolder(dir, source))
}

export function copyIntoWorkspace(
  sessionId: string,
  source: string,
): Promise<WorkspaceFile | null> {
  return intoWorkspace(sessionId, (dir) => copyIntoFolder(dir, source))
}

/** Writes new bytes into the Workspace under a free name. */
export async function writeIntoWorkspace(
  sessionId: string,
  preferredName: string,
  bytes: Buffer,
): Promise<WorkspaceFile> {
  const file = await intoWorkspace(sessionId, (dir) => writeNewFile(dir, preferredName, bytes))
  if (!file) throw new Error('could not write into the Workspace')
  return file
}
