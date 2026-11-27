import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { freeFolderPath } from '../persist/fileOps'
import { appWorkspacesRoot, serializeSession } from '../persist/sessionFiles'
import {
  legacyFilesOf,
  moveLegacyFilesInto,
  removeLegacyFilesFolder,
  removeLegacySessionsRoot,
} from '../persist/sessionLegacyFiles'
import { appWorkspaceName } from './appWorkspaceName'
import { newFolderId, sessionFolderListOf, withSessionFolderList } from './sessionFolderList'
import { migrateSessionAttachments } from './sessionAttachments'
import { migrateSessionFolderLists } from './sessionFolders'
import { readHistoryEntries, rewriteHistoryArtifacts } from './sessionHistory'
import { listSessions, mutateSession, readSession, sessionPaths } from './sessions'
import { sessionFolderMediaUrl, sessionMediaUrl } from '@/lib/comfyWorkflow'
import { assignSlug } from '@/lib/mountedFolders'
import type { SessionFile, SessionFolderEntry } from '@/types/sessionIpc'

const LOG_SCOPE = 'session-layout'
const LEGACY_FILES = 'files/'

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Rewrites every string in `value` that names one of `prefixes` as a whole path segment. */
export function rewriteMediaUrls(value: unknown, prefixes: Map<string, string>): unknown {
  if (prefixes.size === 0) return value
  const pattern = new RegExp(
    `(${[...prefixes.keys()].map(escapeRegExp).join('|')})(?![A-Za-z0-9%._~*'!(-])`,
    'g',
  )
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return node.replace(pattern, (match) => prefixes.get(match)!)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, inner]) => [key, walk(inner)]))
    }
    return node
  }
  return walk(value)
}

/** A History path into the old `files/`, as a path inside it; null for anything else. */
function insideLegacyFiles(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/')
  if (!normalized.startsWith(LEGACY_FILES) || normalized === LEGACY_FILES) return null
  return normalized.slice(LEGACY_FILES.length)
}

/** The top-level names a timeline URL into `files/` can start with: on disk, or only in History. */
async function legacyTopNames(sessionId: string, onDisk: string[]): Promise<string[]> {
  const recorded = (await readHistoryEntries(sessionId)).flatMap((entry) =>
    entry.artifacts.flatMap((artifact) => {
      const inside = artifact.folderId ? null : insideLegacyFiles(artifact.path)
      return inside ? [inside.split('/')[0]] : []
    }),
  )
  return [...new Set([...onDisk, ...recorded])]
}

/** The timeline's `aipg-media://sessions/<id>/files/…` URLs, pointed at the folder entry instead. */
function timelineInFolder(file: SessionFile, folderId: string, names: string[]): unknown[] {
  const prefixes = new Map(
    names.map((name) => [
      sessionMediaUrl(file.id, `${LEGACY_FILES}${name}`),
      sessionFolderMediaUrl(file.id, folderId, name),
    ]),
  )
  return rewriteMediaUrls(file.timeline, prefixes) as unknown[]
}

/** Records where `files/` goes before anything moves, so a crash resumes into the same folder. */
async function withFilesRelocated(
  current: SessionFile,
  hasFiles: boolean,
  names: string[],
): Promise<SessionFile> {
  const listed = withSessionFolderList(current)
  const { folders, workspaceId } = sessionFolderListOf(listed)
  const filesDir = path.resolve(sessionPaths(current.id).filesDir)
  const atFiles = (entry: SessionFolderEntry) => path.resolve(entry.hostPath) === filesDir
  let entry =
    folders.find((folder) => folder.id === listed.legacyFilesFolderId) ?? folders.find(atFiles)
  let list = folders
  if (!entry) {
    if (!hasFiles) return listed
    entry = {
      id: newFolderId(),
      hostPath: filesDir,
      access: 'read-write',
      slug: assignSlug(
        'session',
        folders.map((folder) => folder.slug),
      ),
      appCreated: true,
    }
    list = [...folders, entry]
  }
  if (atFiles(entry)) {
    const root = appWorkspacesRoot()
    const name = appWorkspaceName(current.createdAt, current.title, root)
    const { planned: _planned, ...kept } = entry
    let moved: SessionFolderEntry | null
    if (hasFiles) moved = { ...kept, appCreated: true, hostPath: await freeFolderPath(root, name) }
    else if (entry.id === workspaceId) {
      moved = { ...kept, appCreated: true, planned: true, hostPath: path.join(root, name) }
    } else moved = null
    const id = entry.id
    if (!moved) return { ...listed, folders: list.filter((folder) => folder.id !== id) }
    list = list.map((folder) => (folder.id === id ? moved : folder))
  }
  return {
    ...listed,
    folders: list,
    legacyFilesFolderId: entry.id,
    timeline: timelineInFolder(listed, entry.id, names),
  }
}

async function relocateFilesOf(sessionId: string): Promise<void> {
  const { hasFiles, attachmentsLeft, topNames } = await legacyFilesOf(sessionId)
  if (attachmentsLeft) {
    appLoggerInstance.warn(`attachments of ${sessionId} are still in files/`, LOG_SCOPE)
    return
  }
  const names = await legacyTopNames(sessionId, topNames)
  const file = await mutateSession(sessionId, (current) =>
    withFilesRelocated(current, hasFiles, names),
  )
  const entry = sessionFolderListOf(file).folders.find(
    (folder) => folder.id === file.legacyFilesFolderId,
  )
  if (hasFiles) {
    if (!entry || entry.planned) return
    await moveLegacyFilesInto(sessionId, entry.hostPath)
  }
  if (entry) {
    await serializeSession(sessionId, () =>
      rewriteHistoryArtifacts(sessionId, (artifact) => {
        const inside = artifact.folderId ? null : insideLegacyFiles(artifact.path)
        return inside ? { ...artifact, folderId: entry.id, path: inside } : artifact
      }),
    )
  }
  await removeLegacyFilesFolder(sessionId)
}

/** Moves each older Session's `files/` to its readable Workspace; idempotent and resumable. */
export async function relocateSessionFiles(): Promise<void> {
  const sessions = (await listSessions()).filter((session) => !session.unreadable)
  const files = await Promise.all(sessions.map((session) => readSession(session.id)))
  // Sessions a crash left half-way first, so their recorded folder names stay theirs.
  const ordered = [
    ...files.filter((file) => file.legacyFilesFolderId),
    ...files.filter((file) => !file.legacyFilesFolderId),
  ]
  for (const file of ordered) {
    try {
      await relocateFilesOf(file.id)
    } catch (error) {
      appLoggerInstance.warn(`could not move the files of ${file.id}: ${String(error)}`, LOG_SCOPE)
    }
  }
  await removeLegacySessionsRoot()
}

/** ADR 0013's layout for older Sessions; each step needs the one before it. */
export async function migrateSessionLayout(): Promise<void> {
  const steps: [string, () => Promise<void>][] = [
    ['folder list', migrateSessionFolderLists],
    ['attachment', migrateSessionAttachments],
    ['files', relocateSessionFiles],
  ]
  for (const [name, step] of steps) {
    try {
      await step()
    } catch (error) {
      appLoggerInstance.error(`session ${name} migration failed: ${String(error)}`, LOG_SCOPE)
    }
  }
}
