import path from 'node:path'
import { emitSessionChanged } from '../kernel/kernelBus'
import { appLoggerInstance } from '../observability/logger'
import { createFreeFolder, ensureFolder, renameToFree } from '../persist/fileOps'
import { appWorkspacesRoot } from '../persist/sessionFiles'
import { appWorkspaceName } from './appWorkspaceName'
import { newFolderId, sessionFolderListOf, withSessionFolderList } from './sessionFolderList'
import { mutateSession, readSession, sessionDocumentOf } from './sessions'
import { onSessionTurnReleased, sessionTurnOf } from './sessionTurns'
import { emitWorkspaceRenamed } from './workspaceRenames'
import { assignSlug, workspaceEntryOf } from '@/lib/mountedFolders'
import type { SessionFile, SessionFolderEntry } from '@/types/sessionIpc'

// The readable Workspace the app creates for a Session: `Sessions/<date> <title>/`, made at
// first use and renamed with the Session while nothing runs in it.

// Not 'workspace', which reads like the /workspace mount it replaced.
const WORKSPACE_SLUG = 'session'
const LOG_SCOPE = 'app-workspace'

function nameFor(file: Pick<SessionFile, 'createdAt' | 'title'>): string {
  return appWorkspaceName(file.createdAt, file.title, appWorkspacesRoot())
}

/** A new Session's Workspace: named and listed, but not on disk until first used. */
export function plannedWorkspaceEntry(
  file: Pick<SessionFile, 'createdAt' | 'title'>,
  takenSlugs: readonly string[],
): SessionFolderEntry {
  return {
    id: newFolderId(),
    hostPath: path.join(appWorkspacesRoot(), nameFor(file)),
    access: 'read-write',
    slug: assignSlug(WORKSPACE_SLUG, takenSlugs),
    appCreated: true,
    planned: true,
  }
}

/** Whether the app names this folder after the Session (its older `files/` folders it does not). */
function followsTitle(entry: SessionFolderEntry): boolean {
  if (!entry.appCreated) return false
  if (entry.planned) return true
  return path.dirname(path.resolve(entry.hostPath)) === path.resolve(appWorkspacesRoot())
}

function isSuffixed(base: string, name: string): boolean {
  if (base === name) return true
  const suffix = base.startsWith(`${name} (`) ? base.slice(name.length) : ''
  return /^ \(\d+\)$/.test(suffix)
}

async function created(entry: SessionFolderEntry): Promise<SessionFolderEntry> {
  const { planned: _planned, ...rest } = entry
  const parent = path.dirname(entry.hostPath)
  return { ...rest, hostPath: await createFreeFolder(parent, path.basename(entry.hostPath)) }
}

async function changeEntries(
  sessionId: string,
  change: (file: SessionFile) => Promise<SessionFolderEntry[] | null>,
): Promise<SessionFile> {
  let changed = false
  const file = await mutateSession(sessionId, async (current) => {
    const listed = withSessionFolderList(current)
    const folders = await change(listed)
    if (!folders) return current
    changed = true
    return { ...listed, folders }
  })
  if (changed) emitSessionChanged(sessionDocumentOf(file))
  return file
}

/** The folder entry, its folder made first when the app has not made it yet. */
export async function ensureFolderEntry(
  sessionId: string,
  folderId: string,
): Promise<SessionFolderEntry> {
  const find = (file: SessionFile) => {
    const entry = sessionFolderListOf(file).folders.find((folder) => folder.id === folderId)
    if (!entry) throw new Error(`no such folder in this session: ${folderId}`)
    return entry
  }
  const before = find(await readSession(sessionId))
  if (!before.planned) {
    if (before.appCreated) await ensureFolder(before.hostPath)
    return before
  }
  const file = await changeEntries(sessionId, async (current) => {
    const entry = find(current)
    if (!entry.planned) return null
    const named = { ...entry, hostPath: path.join(path.dirname(entry.hostPath), nameFor(current)) }
    const made = await created(named)
    return sessionFolderListOf(current).folders.map((folder) =>
      folder.id === folderId ? made : folder,
    )
  })
  return find(file)
}

/** The Session's Workspace entry, its folder made at first use. */
export async function ensureWorkspaceEntry(sessionId: string): Promise<SessionFolderEntry> {
  const workspace = workspaceEntryOf(sessionFolderListOf(await readSession(sessionId)))
  if (!workspace) throw new Error(`session ${sessionId} has no Workspace`)
  return ensureFolderEntry(sessionId, workspace.id)
}

async function followed(entry: SessionFolderEntry, name: string): Promise<SessionFolderEntry> {
  if (!followsTitle(entry) || isSuffixed(path.basename(entry.hostPath), name)) return entry
  if (entry.planned) return { ...entry, hostPath: path.join(path.dirname(entry.hostPath), name) }
  try {
    return { ...entry, hostPath: await renameToFree(entry.hostPath, name) }
  } catch (error) {
    appLoggerInstance.warn(`could not rename ${entry.hostPath}: ${String(error)}`, LOG_SCOPE)
    return entry
  }
}

/**
 * Names the Session's app-created Workspace after its title; an earlier one left in the list
 * keeps its name. Nothing happens while a turn or run is in flight in the Session; the release
 * of that turn calls this again.
 */
export async function followSessionTitle(sessionId: string): Promise<void> {
  if (sessionTurnOf(sessionId)) return
  const moved: { from: string; to: string }[] = []
  await changeEntries(sessionId, async (current) => {
    if (sessionTurnOf(sessionId)) return null
    const list = sessionFolderListOf(current)
    const workspace = workspaceEntryOf(list)
    if (!workspace) return null
    const renamed = await followed(workspace, nameFor(current))
    if (renamed === workspace) return null
    if (!workspace.planned) moved.push({ from: workspace.hostPath, to: renamed.hostPath })
    return list.folders.map((folder) => (folder === workspace ? renamed : folder))
  })
  const [rename] = moved
  if (rename) emitWorkspaceRenamed(rename.from, rename.to)
}

const pendingRenames = new Set<Promise<void>>()

onSessionTurnReleased((sessionId) => {
  const rename = followSessionTitle(sessionId)
    .catch((error) =>
      appLoggerInstance.warn(
        `could not follow the title of ${sessionId}: ${String(error)}`,
        LOG_SCOPE,
      ),
    )
    .finally(() => pendingRenames.delete(rename))
  pendingRenames.add(rename)
})

/** Waits for the renames that idle Sessions started in the background. */
export async function settleWorkspaceRenames(): Promise<void> {
  while (pendingRenames.size > 0) await Promise.all(pendingRenames)
}
