import fs from 'node:fs/promises'
import os from 'node:os'
import { openDirectory } from '../adapters/osFileActions'
import { emitSessionChanged } from '../kernel/kernelBus'
import { appLoggerInstance } from '../observability/logger'
import { ensureFolderEntry, ensureWorkspaceEntry, plannedWorkspaceEntry } from './appWorkspace'
import { isDemoSessions } from '../persist/sessionFiles'
import {
  newFolderId,
  sessionFolderListOf,
  takenSlugsOf,
  withSessionFolderList,
} from './sessionFolderList'
import { listSessions, mutateSession, readSession, sessionDocumentOf } from './sessions'
import { sessionTurnOf } from './sessionTurns'
import {
  assignSlug,
  sameHostPath,
  sessionFolderRefusal,
  uniqueName,
  workspaceEntryOf,
  type MountedFolderRefusal,
} from '@/lib/mountedFolders'
import type { AgentWorkspaceEntry, MountedFolderAccess } from '@/types/agentSessionIpc'
import type {
  AgentOwnedFolderEntry,
  SessionFile,
  SessionFolderEntry,
  SessionFolderList,
} from '@/types/sessionIpc'

// A Session's folder list (ADR-0013): its folders, one of them starred as the Workspace.

export async function readSessionFolders(id: string): Promise<SessionFolderList> {
  return sessionFolderListOf(await readSession(id))
}

/** The listed folder to show in Explorer, the Workspace when none is named; never an unlisted one. */
export async function sessionFolderToOpen(sessionId: string, folderId?: string): Promise<string> {
  const id = folderId ?? (await readSessionFolders(sessionId)).workspaceId
  return (await ensureFolderEntry(sessionId, id)).hostPath
}

export async function openSessionFolder(sessionId: string, folderId?: string): Promise<void> {
  await openDirectory(await sessionFolderToOpen(sessionId, folderId))
}

export async function sessionWorkspaceEntry(id: string): Promise<SessionFolderEntry> {
  const workspace = workspaceEntryOf(await readSessionFolders(id))
  if (!workspace) throw new Error(`session ${id} has no Workspace`)
  return workspace
}

async function changeFolders(
  id: string,
  change: (list: SessionFolderList) => SessionFolderEntry[],
): Promise<SessionFolderList> {
  const file = await mutateSession(id, (current) => {
    const listed = withSessionFolderList(current)
    return { ...listed, folders: change(sessionFolderListOf(listed)) }
  })
  emitSessionChanged(sessionDocumentOf(file))
  return sessionFolderListOf(file)
}

function requireEntry(list: SessionFolderList, folderId: string): SessionFolderEntry {
  const entry = list.folders.find((folder) => folder.id === folderId)
  if (!entry) throw new Error(`no such folder in this session: ${folderId}`)
  return entry
}

/**
 * Adds a folder, read-only (never in demo mode), under a slug it keeps; a folder taken off the
 * list before comes back as the same entry. A refused folder leaves the list as it was.
 */
export async function addSessionFolder(
  id: string,
  hostPath: string,
): Promise<{ list: SessionFolderList; refusal?: MountedFolderRefusal }> {
  if (isDemoSessions()) throw new Error(DEMO_USER_FOLDER_MESSAGE)
  let refusal: MountedFolderRefusal | undefined
  const file = await mutateSession(id, (current) => {
    const listed = withSessionFolderList(current)
    const { folders, detached = [], agentOwned = [] } = sessionFolderListOf(listed)
    refusal = sessionFolderRefusal(hostPath, { homeFolder: os.homedir(), folders })
    if (refusal) return current
    const previous = detached.find((folder) => sameHostPath(folder.hostPath, hostPath))
    const taken = [...folders, ...detached, ...agentOwned]
      .filter((folder) => folder !== previous)
      .map((folder) => folder.slug)
    const slug =
      previous && !taken.some((name) => name.toLowerCase() === previous.slug.toLowerCase())
        ? previous.slug
        : assignSlug(hostPath, taken)
    const entry = { id: previous?.id ?? newFolderId(), hostPath, access: 'read-only' as const }
    return {
      ...listed,
      folders: [...folders, { ...previous, ...entry, slug }],
      detachedFolders: detached.filter((folder) => folder !== previous),
    }
  })
  emitSessionChanged(sessionDocumentOf(file))
  const list = sessionFolderListOf(file)
  return refusal ? { list, refusal } : { list }
}

/**
 * Takes a folder off the list: it is no longer mounted or shown, its files stay where they are,
 * and the Artifacts the Session made there still resolve.
 */
export async function removeSessionFolder(
  id: string,
  folderId: string,
): Promise<SessionFolderList> {
  const file = await mutateSession(id, (current) => {
    const listed = withSessionFolderList(current)
    const list = sessionFolderListOf(listed)
    const entry = requireEntry(list, folderId)
    if (folderId === list.workspaceId) throw new Error('The Workspace cannot be removed')
    if (entry.appCreated) throw new Error(APP_CREATED_FOLDER_MESSAGE)
    return detachFolder(listed, list, entry)
  })
  emitSessionChanged(sessionDocumentOf(file))
  return sessionFolderListOf(file)
}

function detachFolder(
  file: SessionFile,
  list: SessionFolderList,
  entry: SessionFolderEntry,
): SessionFile {
  const detached = (list.detached ?? []).filter((folder) => folder.id !== entry.id)
  return {
    ...file,
    folders: list.folders.filter((folder) => folder.id !== entry.id),
    detachedFolders: entry.planned ? detached : [...detached, entry],
  }
}

export async function setSessionFolderAccess(
  id: string,
  folderId: string,
  access: MountedFolderAccess,
): Promise<SessionFolderList> {
  return changeFolders(id, (list) => {
    requireEntry(list, folderId)
    if (folderId === list.workspaceId && access !== 'read-write') {
      throw new Error('The Workspace is always read-write')
    }
    return list.folders.map((folder) => (folder.id === folderId ? { ...folder, access } : folder))
  })
}

/**
 * An Agent's own Workspace as an entry of the Session, registered at its first run there under a
 * slug no other entry has, and kept, so its sandbox path and History references never move.
 */
export async function registerAgentFolder(
  id: string,
  owner: { agentId?: string; folder: AgentWorkspaceEntry },
): Promise<AgentOwnedFolderEntry> {
  const { folder, agentId } = owner
  const ownedBy = (list: SessionFolderList) =>
    (list.agentOwned ?? []).find((entry) => entry.id === folder.id)
  const already = ownedBy(await readSessionFolders(id))
  if (already && sameHostPath(already.hostPath, folder.hostPath)) return already
  const file = await mutateSession(id, (current) => {
    const listed = withSessionFolderList(current)
    const list = sessionFolderListOf(listed)
    const owned = list.agentOwned ?? []
    const known = ownedBy(list)
    const taken = new Set(
      takenSlugsOf(list)
        .filter((slug) => slug !== known?.slug)
        .map((slug) => slug.toLowerCase()),
    )
    const entry: AgentOwnedFolderEntry = {
      id: folder.id,
      hostPath: folder.hostPath,
      access: 'read-write',
      slug: known?.slug ?? uniqueName(folder.slug, taken),
      ...(agentId ? { agentId } : {}),
    }
    const others = owned.filter((entry) => entry.id !== folder.id)
    return { ...listed, agentFolders: [...others, entry] }
  })
  emitSessionChanged(sessionDocumentOf(file))
  const registered = ownedBy(sessionFolderListOf(file))
  if (!registered) throw new Error(`Agent folder ${folder.id} was not registered in ${id}.`)
  return registered
}

export const DEMO_USER_FOLDER_MESSAGE = 'Demo Sessions work only in the folder the app creates.'

export const APP_CREATED_FOLDER_MESSAGE =
  'The folder created for this Session stays on its list, so its results are always found.'

export const WORKSPACE_BUSY_MESSAGE =
  'The Workspace cannot change while something is running in this Session.'

/** The file with `folderId` starred, and read-write, as the Workspace always is. */
function withStar(file: SessionFile, folderId: string): SessionFile {
  return {
    ...file,
    workspaceFolderId: folderId,
    folders: (file.folders ?? []).map((folder) =>
      folder.id === folderId ? { ...folder, access: 'read-write' as const } : folder,
    ),
  }
}

/**
 * Stars a listed folder as the Workspace: new Artifacts land there from now on. Nothing already
 * written moves, and the old Workspace stays listed, read-write, so its Artifacts keep resolving.
 */
export async function starSessionFolder(
  id: string,
  folderId: string,
): Promise<{ list: SessionFolderList; madeReadWrite: boolean }> {
  let madeReadWrite = false
  const file = await mutateSession(id, (current) => {
    if (sessionTurnOf(id)) throw new Error(WORKSPACE_BUSY_MESSAGE)
    const listed = withSessionFolderList(current)
    const list = sessionFolderListOf(listed)
    const target = requireEntry(list, folderId)
    if (isDemoSessions() && !target.appCreated) throw new Error(DEMO_USER_FOLDER_MESSAGE)
    madeReadWrite = target.access !== 'read-write'
    return withStar(listed, folderId)
  })
  emitSessionChanged(sessionDocumentOf(file))
  return { list: sessionFolderListOf(file), madeReadWrite }
}

async function requireFolder(hostPath: string): Promise<void> {
  const stat = await fs.stat(hostPath).catch(() => null)
  if (!stat?.isDirectory()) throw new Error(`${hostPath} is not a folder`)
}

/** Re-points the Workspace entry at a folder the user located; its id and slug stay. */
export async function locateSessionWorkspace(
  id: string,
  hostPath: string,
): Promise<{ list: SessionFolderList; refusal?: MountedFolderRefusal }> {
  if (isDemoSessions()) throw new Error(DEMO_USER_FOLDER_MESSAGE)
  await requireFolder(hostPath)
  let refusal: MountedFolderRefusal | undefined
  const file = await mutateSession(id, (current) => {
    if (sessionTurnOf(id)) throw new Error(WORKSPACE_BUSY_MESSAGE)
    const listed = withSessionFolderList(current)
    const { folders, workspaceId } = sessionFolderListOf(listed)
    const others = folders.filter((folder) => folder.id !== workspaceId)
    refusal = sessionFolderRefusal(hostPath, { homeFolder: os.homedir(), folders: others })
    if (refusal) return current
    return {
      ...listed,
      folders: folders.map((folder) =>
        folder.id === workspaceId ? { ...folder, hostPath } : folder,
      ),
    }
  })
  emitSessionChanged(sessionDocumentOf(file))
  const list = sessionFolderListOf(file)
  return refusal ? { list, refusal } : { list }
}

async function isFolder(hostPath: string): Promise<boolean> {
  return (await fs.stat(hostPath).catch(() => null))?.isDirectory() ?? false
}

/**
 * Replaces a missing Workspace, which is detached: listed, it would only fail the next turn as a
 * missing Mounted Folder. The folder created for the Session is starred again while it is still
 * on disk; otherwise it is detached too, and a fresh app-created Workspace is made at once.
 */
export async function startNewSessionWorkspace(id: string): Promise<{ list: SessionFolderList }> {
  await mutateSession(id, async (current) => {
    if (sessionTurnOf(id)) throw new Error(WORKSPACE_BUSY_MESSAGE)
    const listed = withSessionFolderList(current)
    const list = sessionFolderListOf(listed)
    let next = detachFolder(listed, list, requireEntry(list, list.workspaceId))
    for (const folder of sessionFolderListOf(next).folders.filter((entry) => entry.appCreated)) {
      if (!folder.planned && (await isFolder(folder.hostPath))) return withStar(next, folder.id)
      if (!folder.planned) next = detachFolder(next, sessionFolderListOf(next), folder)
    }
    const kept = next.folders ?? []
    const planned = kept.find((folder) => folder.appCreated && folder.planned)
    if (planned) return withStar(next, planned.id)
    const owned = sessionFolderListOf(next).agentOwned ?? []
    const fresh = plannedWorkspaceEntry(
      listed,
      [...kept, ...owned].map((folder) => folder.slug),
    )
    return { ...next, workspaceFolderId: fresh.id, folders: [...kept, fresh] }
  })
  await ensureWorkspaceEntry(id)
  const file = await readSession(id)
  emitSessionChanged(sessionDocumentOf(file))
  return { list: sessionFolderListOf(file) }
}

/** Writes every Session's folder list, moving in agent-settings Mounted Folders; idempotent. */
export async function migrateSessionFolderLists(): Promise<void> {
  let moved = 0
  for (const session of await listSessions()) {
    if (session.unreadable) continue
    const before = await readSession(session.id)
    if (withSessionFolderList(before) === before) continue
    await mutateSession(session.id, withSessionFolderList)
    moved += 1
  }
  appLoggerInstance.info(`wrote the folder list of ${moved} session(s)`, 'session-folders')
}
