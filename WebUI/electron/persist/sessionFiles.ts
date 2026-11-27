import type { Dirent } from 'node:fs'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { moveToTrash } from '../adapters/trash'
import { appLoggerInstance } from '../observability/logger'
import {
  getAppWorkspacesDemoDir,
  getAppWorkspacesDir,
  getLegacySessionsDemoDir,
  getLegacySessionsDir,
  getSessionsDemoDir,
  getSessionsDir,
} from './userDataPaths.ts'
import { atomicWriteJson, isSafeFileId, makeWriteChains, readJson } from './fsJsonStore'
import { SessionFileSchema, type SessionFile } from '@/types/sessionIpc'

/**
 * The on-disk side of a Session Folder. Only the Session module calls this;
 * every mutation of one Session runs on that Session's write chain, so later
 * writers (History Entries, Session Settings) serialize with rename and delete.
 */

const appLogger = appLoggerInstance
const LOG_SCOPE = 'sessions'

export const SESSION_FILE = 'session.json'
export const SESSION_HISTORY_FILE = 'session-history.jsonl'
export const SESSION_FILES_DIR = 'files'
export const SESSION_ATTACHMENTS_DIR = 'attachments'

export type SessionFileDeps = {
  isDemoMode: () => boolean
}

let deps: SessionFileDeps | null = null

export function setSessionFileDeps(next: SessionFileDeps): void {
  deps = next
}

const chains = makeWriteChains()

export const serializeSession = chains.serialize

export function sessionsRoot(): string {
  return deps?.isDemoMode() ? getSessionsDemoDir() : getSessionsDir()
}

/** Where older Sessions' `files/` live, and what their Session-relative Artifact paths resolve against. */
export function sessionArtifactsRoot(): string {
  return deps?.isDemoMode() ? getLegacySessionsDemoDir() : getLegacySessionsDir()
}

/** The folder the app creates readable Workspaces in. */
export function appWorkspacesRoot(): string {
  return deps?.isDemoMode() ? getAppWorkspacesDemoDir() : getAppWorkspacesDir()
}

export type SessionFolderPaths = {
  /** Internal storage: record, History, attachments. */
  root: string
  /** What a History Artifact without a folder entry is relative to; holds `files/`. */
  artifactRoot: string
  sessionFile: string
  historyFile: string
  filesDir: string
  attachmentsDir: string
}

/** A Session id names a folder, so unlike a file stem it must never be `.` or `..`. */
export function isSessionId(id: string): boolean {
  return isSafeFileId(id) && !id.startsWith('.')
}

export function assertSessionId(id: string): void {
  if (!isSessionId(id)) throw new Error(`invalid session id: ${id}`)
}

export function sessionFolderPaths(id: string): SessionFolderPaths {
  assertSessionId(id)
  const root = path.join(sessionsRoot(), id)
  const artifactRoot = path.join(sessionArtifactsRoot(), id)
  return {
    root,
    artifactRoot,
    sessionFile: path.join(root, SESSION_FILE),
    historyFile: path.join(root, SESSION_HISTORY_FILE),
    filesDir: path.join(artifactRoot, SESSION_FILES_DIR),
    attachmentsDir: path.join(root, SESSION_ATTACHMENTS_DIR),
  }
}

export type SessionFileRead =
  { status: 'ok'; file: SessionFile } | { status: 'missing' } | { status: 'corrupt' }

export async function readSessionFile(id: string): Promise<SessionFileRead> {
  const read = await readJson(sessionFolderPaths(id).sessionFile, LOG_SCOPE)
  if (read.status !== 'ok') return read
  const parsed = SessionFileSchema.safeParse(read.value)
  if (parsed.success && parsed.data.id === id) return { status: 'ok', file: parsed.data }
  appLogger.warn(`session file failed schema (${id})`, LOG_SCOPE)
  return { status: 'corrupt' }
}

const syncReads = new Map<string, { stamp: string; file: SessionFile }>()

/**
 * The `session.json` for callers that cannot wait (the media scheme), re-parsed only when the
 * file changed; null when missing or unreadable.
 */
export function readSessionFileSync(id: string): SessionFile | null {
  const { sessionFile } = sessionFolderPaths(id)
  let stamp: string
  try {
    const stat = fsSync.statSync(sessionFile)
    stamp = `${sessionFile}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
  const cached = syncReads.get(id)
  if (cached?.stamp === stamp) return cached.file
  try {
    const parsed = SessionFileSchema.safeParse(JSON.parse(fsSync.readFileSync(sessionFile, 'utf8')))
    if (!parsed.success || parsed.data.id !== id) return null
    syncReads.set(id, { stamp, file: parsed.data })
    return parsed.data
  } catch {
    return null
  }
}

export async function writeSessionFile(file: SessionFile): Promise<void> {
  await atomicWriteJson(sessionFolderPaths(file.id).sessionFile, file)
}

export async function createSessionFolder(file: SessionFile): Promise<void> {
  const paths = sessionFolderPaths(file.id)
  await fs.mkdir(paths.root, { recursive: true })
  await fs.writeFile(paths.historyFile, '', { flag: 'wx' })
  await writeSessionFile(file)
}

export async function appendHistoryLine(id: string, line: string): Promise<void> {
  await fs.appendFile(sessionFolderPaths(id).historyFile, `${line}\n`)
}

/** Rewrites the history file from its lines; a crash mid-write leaves the old file intact. */
export async function writeHistoryLines(id: string, lines: readonly string[]): Promise<void> {
  const file = sessionFolderPaths(id).historyFile
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, lines.map((line) => `${line}\n`).join(''), 'utf8')
  await fs.rename(tmp, file)
}

/** The raw history file; empty when the Session has none yet. */
export async function readHistoryFile(id: string): Promise<string> {
  try {
    return await fs.readFile(sessionFolderPaths(id).historyFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Removes internal storage; the older `files/` folder beside it only goes if already trashed. */
export async function removeSessionFolder(id: string): Promise<void> {
  const { root, artifactRoot } = sessionFolderPaths(id)
  await fs.rm(root, { recursive: true, force: true })
  if (path.resolve(artifactRoot) === path.resolve(root)) return
  await fs.rmdir(artifactRoot).catch(() => undefined)
}

export function isDemoSessions(): boolean {
  return deps?.isDemoMode() ?? false
}

/** To the OS Trash, or deleted outright in demo mode so a visitor's files never reach the host's. */
export async function discardPath(target: string): Promise<void> {
  if (isDemoSessions()) await fs.rm(target, { recursive: true, force: true })
  else await moveToTrash(target)
}

/** Every Session Folder under the active root; stray files and unsafe names are skipped. */
export async function listSessionFolders(): Promise<{ id: string; mtimeMs: number }[]> {
  const root = sessionsRoot()
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const folders = entries.filter((entry) => entry.isDirectory() && isSessionId(entry.name))
  return Promise.all(
    folders.map(async (entry) => ({
      id: entry.name,
      mtimeMs: (await fs.stat(path.join(root, entry.name))).mtimeMs,
    })),
  )
}

/** Demo Sessions are session-scoped (§6.1): wiped on exit, and on boot for a crash tail. */
export async function wipeDemoSessionFolders(): Promise<void> {
  try {
    for (const dir of [
      getSessionsDemoDir(),
      getLegacySessionsDemoDir(),
      getAppWorkspacesDemoDir(),
    ]) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  } catch (error) {
    appLogger.warn(`demo session wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetSessionFilesForTest(): void {
  deps = null
  chains.clear()
  syncReads.clear()
}
