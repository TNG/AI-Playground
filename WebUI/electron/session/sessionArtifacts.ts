import fs from 'node:fs/promises'
import { serializeSession } from '../persist/sessionFiles'
import { discardRegularFile } from '../persist/sessionMediaFiles'
import { artifactHostPath } from './historyArtifacts'
import { readSessionFolders } from './sessionFolders'
import { readHistoryEntries } from './sessionHistory'
import { listSessions } from './sessions'
import { sessionLegacyMediaFile } from './sessionFolderMedia'
import { sessionFolderMediaUrl, sessionMediaPathOf, sessionMediaUrl } from '@/lib/comfyWorkflow'
import type {
  ArtifactMediaType,
  HistoryEntry,
  NewestArtifact,
  SessionArtifact,
  SessionSummary,
} from '@/types/sessionIpc'

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

/** A recorded Artifact with its file and the URL its writer gave it. */
type LocatedArtifact = { entry: HistoryEntry; file: string; path: string; url: string } & {
  mediaType: ArtifactMediaType
}

/** Every History Artifact still in a listed folder (or the Session Folder), oldest first. */
async function locatedArtifacts(sessionId: string): Promise<LocatedArtifact[]> {
  const entries = await readHistoryEntries(sessionId)
  if (entries.every((entry) => entry.artifacts.length === 0)) return []
  const list = await readSessionFolders(sessionId)
  return entries.flatMap((entry) =>
    entry.artifacts.flatMap((artifact) => {
      const file = artifactHostPath(sessionId, artifact, list)
      if (!file) return []
      const url = artifact.folderId
        ? sessionFolderMediaUrl(sessionId, artifact.folderId, artifact.path)
        : sessionMediaUrl(sessionId, artifact.path)
      return [{ entry, file, path: artifact.path, url, mediaType: artifact.mediaType }]
    }),
  )
}

async function artifactsOf(session: SessionSummary): Promise<SessionArtifact[]> {
  const located = await locatedArtifacts(session.id)
  const present = await Promise.all(located.map((artifact) => isFile(artifact.file)))
  return located
    .filter((_artifact, index) => present[index])
    .map(({ entry, path: artifactPath, url, mediaType }) => ({
      sessionId: session.id,
      sessionTitle: session.title,
      entryId: entry.id,
      timestamp: entry.timestamp,
      preset: entry.preset,
      kind: entry.kind,
      prompt: entry.prompt,
      path: artifactPath,
      mediaType,
      url,
    }))
}

/** Every artifact of every Session whose file still exists, newest History Entry first. */
export async function listAllArtifacts(): Promise<SessionArtifact[]> {
  const sessions = await listSessions()
  const perSession = await Promise.all(sessions.map(artifactsOf))
  return perSession.flat().sort((a, b) => b.timestamp - a.timestamp)
}

/** URLs of the Session's recorded artifacts whose file is gone; the timeline shows them as deleted. */
export async function missingArtifactUrls(sessionId: string): Promise<string[]> {
  const located = await locatedArtifacts(sessionId)
  const present = await Promise.all(located.map((artifact) => isFile(artifact.file)))
  return located.filter((_artifact, index) => !present[index]).map((artifact) => artifact.url)
}

/** The file behind an artifact URL: one the Session recorded, or one in its own `files/`. */
async function artifactFileOf(sessionId: string, url: string): Promise<string> {
  const target = sessionMediaPathOf(url)
  if (!target || target.sessionId !== sessionId) {
    throw new Error(`not an artifact of ${sessionId}: ${url}`)
  }
  if (!target.folderId) {
    const legacy = sessionLegacyMediaFile(url)
    if (!legacy) throw new Error(`not an artifact of ${sessionId}: ${url}`)
    return legacy
  }
  const recorded = (await locatedArtifacts(sessionId)).find((artifact) => artifact.url === url)
  if (!recorded) throw new Error(`not an artifact of ${sessionId}: ${url}`)
  return recorded.file
}

/** Moves the artifact's file to the Trash: its History Entry stays, so the Session still remembers it. */
export async function deleteArtifact(sessionId: string, url: string): Promise<void> {
  const file = await artifactFileOf(sessionId, url)
  await serializeSession(sessionId, () => discardRegularFile(file))
}

/** The Session's newest artifact of a media type, from any preset, whose file still exists. */
export async function newestArtifact(
  sessionId: string,
  mediaType: ArtifactMediaType,
): Promise<NewestArtifact | null> {
  const located = (await locatedArtifacts(sessionId)).filter(
    (artifact) => artifact.mediaType === mediaType,
  )
  for (let i = located.length - 1; i >= 0; i--) {
    const artifact = located[i]
    if (!(await isFile(artifact.file))) continue
    return { entryId: artifact.entry.id, path: artifact.path, url: artifact.url }
  }
  return null
}
