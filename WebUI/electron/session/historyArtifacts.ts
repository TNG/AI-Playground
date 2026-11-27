import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { ensureReaderCopy } from '../persist/sessionMediaFiles'
import { artifactFoldersOf } from './sessionFolderList'
import { readSessionFolders } from './sessionFolders'
import { readHistoryEntries } from './sessionHistory'
import { sessionPaths } from './sessions'
import type {
  ArtifactMediaType,
  HistoryArtifact,
  HistoryEntry,
  SessionFolderList,
} from '@/types/sessionIpc'

export const READER_COPY_CAP_BYTES = 100 * 1024 * 1024

const COPYABLE_MEDIA: ReadonlySet<ArtifactMediaType> = new Set(['image', 'video', 'audio'])

/** Who reads the History: the folders it can open, and how it opens each. */
export type HistoryReader = {
  /** Artifacts inside it are shown relative to it; unreachable media is copied into it. */
  workspaceDir: string
  /** Its other folders, each at the path the reader opens it by (`/mnt/<slug>`, or the real path). */
  folders?: { hostPath: string; path: string }[]
  /** `any` (games): every unreachable Artifact is copied, whatever its type or size. */
  copies?: 'media' | 'any'
}

export type SeenArtifact =
  | { path: string; mediaType: ArtifactMediaType }
  | { mediaType: ArtifactMediaType; notAccessible: true }

export type SeenHistoryEntry = Omit<HistoryEntry, 'artifacts'> & { artifacts: SeenArtifact[] }

function relativeInside(root: string, candidate: string): string | null {
  const relative = path.relative(root, candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

/** Where the Artifact's file is, in a listed or a detached folder. */
export function artifactHostPath(
  sessionId: string,
  artifact: HistoryArtifact,
  list: SessionFolderList,
): string | null {
  const base = artifact.folderId
    ? artifactFoldersOf(list).find((folder) => folder.id === artifact.folderId)?.hostPath
    : sessionPaths(sessionId).artifactRoot
  if (!base) return null
  const file = path.resolve(base, artifact.path)
  return relativeInside(base, file) === null ? null : file
}

/** The Artifact relative to the Session Folder, as today's media URLs address it. */
export function artifactSessionPath(
  sessionId: string,
  artifact: HistoryArtifact,
  list: SessionFolderList,
): string | null {
  const file = artifactHostPath(sessionId, artifact, list)
  return file ? relativeInside(sessionPaths(sessionId).artifactRoot, file) : null
}

/** How `dir` sits inside `root`, '' when they are the same; null when it does not. */
function dirInside(root: string, dir: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(dir))
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

/**
 * The names in `dir` the Session's History still records as Artifacts, whether or not a file
 * sits at them: a recorded artifact holds its name even after the file behind it was moved away
 * or deleted, so a new generation must not take it and show up as the old record's file.
 */
export async function recordedArtifactNamesIn(
  sessionId: string,
  dir: string,
): Promise<Set<string>> {
  const reserved = new Set<string>()
  let entries: HistoryEntry[]
  try {
    entries = await readHistoryEntries(sessionId)
  } catch (error) {
    appLoggerInstance.warn(
      `could not read the History of ${sessionId} for name reservations: ${String(error)}`,
      'sessions',
    )
    return reserved
  }
  if (entries.every((entry) => entry.artifacts.length === 0)) return reserved
  const list = await readSessionFolders(sessionId)
  for (const entry of entries) {
    for (const artifact of entry.artifacts) {
      const base = artifact.folderId
        ? artifactFoldersOf(list).find((folder) => folder.id === artifact.folderId)?.hostPath
        : null
      if (!base) continue
      const inside = dirInside(base, dir)
      if (inside === null) continue
      const prefix = inside === '' ? '' : `${inside}/`
      if (artifact.path.startsWith(prefix)) reserved.add(artifact.path.slice(prefix.length))
    }
  }
  return reserved
}

/** The folder entry holding `file`, and its path there: a new History reference. */
export function artifactReferenceOf(
  file: string,
  list: SessionFolderList,
): { folderId: string; path: string } | null {
  const ordered = [
    ...list.folders.filter((folder) => folder.id === list.workspaceId),
    ...(list.agentOwned ?? []),
    ...list.folders.filter((folder) => folder.id !== list.workspaceId),
  ]
  for (const folder of ordered.filter((entry) => !entry.planned)) {
    const inside = relativeInside(path.resolve(folder.hostPath), path.resolve(file))
    if (inside) return { folderId: folder.id, path: inside }
  }
  return null
}

async function real(file: string): Promise<string> {
  try {
    return await fs.realpath(file)
  } catch {
    return path.resolve(file)
  }
}

async function copyable(file: string, mediaType: ArtifactMediaType, reader: HistoryReader) {
  if (reader.copies === 'any') return true
  if (!COPYABLE_MEDIA.has(mediaType)) return false
  try {
    return (await fs.stat(file)).size <= READER_COPY_CAP_BYTES
  } catch {
    return false
  }
}

async function seenBy(
  reader: HistoryReader,
  host: string | null,
  mediaType: ArtifactMediaType,
): Promise<SeenArtifact> {
  const unreachable = { mediaType, notAccessible: true as const }
  if (!host) return unreachable
  const file = await real(host)
  const within = async (dir: string) =>
    relativeInside(path.resolve(dir), path.resolve(host)) ?? relativeInside(await real(dir), file)
  const inWorkspace = await within(reader.workspaceDir)
  if (inWorkspace) return { path: inWorkspace, mediaType }
  for (const folder of reader.folders ?? []) {
    const inside = await within(folder.hostPath)
    if (inside) return { path: `${folder.path.replace(/[\\/]+$/, '')}/${inside}`, mediaType }
  }
  if (!(await copyable(file, mediaType, reader))) return unreachable
  const copy = await ensureReaderCopy(file, reader.workspaceDir)
  return copy ? { path: copy, mediaType } : unreachable
}

/** `entries` with their Artifacts as `reader` sees them; without one, Session Folder or real paths. */
export async function historyAsSeenBy(
  sessionId: string,
  entries: HistoryEntry[],
  reader?: HistoryReader,
): Promise<SeenHistoryEntry[]> {
  if (entries.every((entry) => entry.artifacts.length === 0)) return entries
  const list = await readSessionFolders(sessionId)
  const see = async (artifact: HistoryArtifact): Promise<SeenArtifact> => {
    const { mediaType } = artifact
    if (reader) return seenBy(reader, artifactHostPath(sessionId, artifact, list), mediaType)
    const shown =
      artifactSessionPath(sessionId, artifact, list) ?? artifactHostPath(sessionId, artifact, list)
    return shown ? { path: shown, mediaType } : { mediaType, notAccessible: true }
  }
  // One at a time: two copies racing for a free name in `generated/` could take the same one.
  const seen: SeenHistoryEntry[] = []
  for (const entry of entries) {
    const artifacts: SeenArtifact[] = []
    for (const artifact of entry.artifacts) artifacts.push(await see(artifact))
    seen.push({ ...entry, artifacts })
  }
  return seen
}
