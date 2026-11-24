import fs from 'node:fs/promises'
import { isRecord } from '@/lib/isRecord'
import { readGame } from '../agent/games/gameLibrary'
import { bootstrapMediaItems } from '../persist/mediaItemFiles'
import { artifactHostPath } from './historyArtifacts'
import { artifactFoldersOf } from './sessionFolderList'
import { sessionFolderMediaFile, sessionLegacyMediaFile } from './sessionFolderMedia'
import { isInGamesLibrary } from './sessionWorkspace'
import { sessionMediaPathOf } from '@/lib/comfyWorkflow'
import type { MediaItem } from '@/types/mediaItem'
import type {
  ArtifactMediaType,
  HistoryArtifact,
  HistoryEntry,
  SessionFile,
  SessionFolderList,
} from '@/types/sessionIpc'

/** One picture that could represent a Session; an image file, whatever produced it. */
export type OverviewCover = {
  path: string
  /** What the file is: a video's poster is an image. */
  mediaType: ArtifactMediaType
  /** The prompt that produced it (a game icon: what started the game). */
  prompt: string
  time: number
  source: 'artifact' | 'video-thumbnail' | 'game-icon'
}

export const OVERVIEW_COVER_CAP = 8

async function isFile(candidate: string): Promise<boolean> {
  return (await fs.stat(candidate).catch(() => null))?.isFile() ?? false
}

function normalizeInside(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.?\//, '')
}

/** Whether a media URL names the same file the History Entry's Artifact does. */
function sameArtifact(url: unknown, sessionId: string, artifact: HistoryArtifact): boolean {
  if (typeof url !== 'string') return false
  const target = sessionMediaPathOf(url)
  if (!target || target.sessionId !== sessionId) return false
  if (target.folderId !== artifact.folderId) return false
  return normalizeInside(target.path) === normalizeInside(artifact.path)
}

type TimelineVideoItem = Record<string, unknown> & { id?: unknown; videoUrl?: unknown }

function timelineVideoItems(timeline: unknown[]): TimelineVideoItem[] {
  const items: TimelineVideoItem[] = []
  for (const message of timeline) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== 'data-media' || !isRecord(part.data)) continue
      const dataItems = part.data.items
      if (!Array.isArray(dataItems)) continue
      for (const item of dataItems) {
        if (isRecord(item) && item.type === 'video') items.push(item)
      }
    }
  }
  return items
}

/** An `aipg-media` URL as the file it serves, when it serves one of the Session's files. */
function mediaHostPath(url: unknown): string | null {
  if (typeof url !== 'string') return null
  if (url.startsWith('aipg-media://folders/')) return sessionFolderMediaFile(url)
  if (url.startsWith('aipg-media://sessions/')) return sessionLegacyMediaFile(url)
  return null
}

export type RecordsLookup = () => Promise<Map<string, MediaItem>>

async function mediaRecordsByItemId(): Promise<Map<string, MediaItem>> {
  try {
    const boot = await bootstrapMediaItems()
    return boot.status === 'ok' ? new Map(boot.items.map((item) => [item.id, item])) : new Map()
  } catch {
    return new Map()
  }
}

/** A lazy lookup shared by every Session in one Overview, so records load at most once. */
export function createRecordsLookup(): RecordsLookup {
  let records: Promise<Map<string, MediaItem>> | undefined
  return () => (records ??= mediaRecordsByItemId())
}

/**
 * A video's picture is its adopted timeline thumbnail. Media Records are only a
 * fallback: nothing writes them any more, so a new video's poster lives nowhere else.
 */
async function videoCoverOf(
  sessionId: string,
  file: SessionFile,
  artifact: HistoryArtifact,
  recordsOf: RecordsLookup,
): Promise<string | null> {
  const item = timelineVideoItems(file.timeline).find((candidate) =>
    sameArtifact(candidate.videoUrl, sessionId, artifact),
  )
  if (!item) return null
  const own = mediaHostPath(item.thumbnailUrl)
  if (own && (await isFile(own))) return own
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  const recorded = (await recordsOf()).get(id)
  const recordedThumbnail =
    recorded && 'thumbnailUrl' in recorded ? recorded.thumbnailUrl : undefined
  const fallback = mediaHostPath(recordedThumbnail)
  return fallback && (await isFile(fallback)) ? fallback : null
}

type GameCover = { iconPath: string; prompt: string; time: number }

function gameCoversOf(file: SessionFile, list: SessionFolderList): GameCover[] {
  const dirs = new Set(Object.values(file.harnessWorkspaces ?? {}).filter(Boolean))
  const starred = artifactFoldersOf(list).find((folder) => folder.id === list.workspaceId)
  if (starred && isInGamesLibrary(starred.hostPath)) dirs.add(starred.hostPath)
  const covers: GameCover[] = []
  for (const dir of dirs) {
    const game = readGame(dir)
    if (!game?.iconPath) continue
    covers.push({
      iconPath: game.iconPath,
      prompt: game.initialPrompt?.trim() || game.description?.trim() || game.name,
      time: game.updatedAt || game.createdAt,
    })
  }
  return covers
}

export async function collectCovers(
  sessionId: string,
  file: SessionFile,
  list: SessionFolderList,
  entries: readonly HistoryEntry[],
  recordsOf: RecordsLookup,
): Promise<{ covers: OverviewCover[]; total: number; truncated: boolean }> {
  const candidates: OverviewCover[] = []
  const seen = new Set<string>()
  const push = (cover: OverviewCover) => {
    if (seen.has(cover.path)) return
    seen.add(cover.path)
    candidates.push(cover)
  }
  for (const entry of entries) {
    for (const artifact of entry.artifacts) {
      if (artifact.mediaType === 'image') {
        const host = artifactHostPath(sessionId, artifact, list)
        if (host && (await isFile(host))) {
          push({
            path: host,
            mediaType: 'image',
            prompt: entry.prompt,
            time: entry.timestamp,
            source: 'artifact',
          })
        }
      } else if (artifact.mediaType === 'video') {
        const host = await videoCoverOf(sessionId, file, artifact, recordsOf)
        if (host) {
          push({
            path: host,
            mediaType: 'image',
            prompt: entry.prompt,
            time: entry.timestamp,
            source: 'video-thumbnail',
          })
        }
      }
    }
  }
  for (const game of gameCoversOf(file, list)) {
    push({
      path: game.iconPath,
      mediaType: 'image',
      prompt: game.prompt,
      time: game.time,
      source: 'game-icon',
    })
  }
  candidates.sort((a, b) => b.time - a.time)
  return {
    covers: candidates.slice(0, OVERVIEW_COVER_CAP),
    total: candidates.length,
    truncated: candidates.length > OVERVIEW_COVER_CAP,
  }
}
