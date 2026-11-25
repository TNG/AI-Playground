import path from 'node:path'
import {
  resolveOverviewWindow,
  type OverviewRangeInput,
  type OverviewWindow,
} from './overviewRange'
import { artifactHostPath } from './historyArtifacts'
import { readHistoryEntries } from './sessionHistory'
import { readSessionFolders } from './sessionFolders'
import { autoTitle } from './sessionTitle'
import { listSessions, readSession, sessionPaths } from './sessions'
import type {
  ArtifactMediaType,
  HistoryEntry,
  OverviewSummary,
  OverviewSummaryPicture,
} from '@/types/sessionIpc'

// Read side of an Overview: only Sessions included in Overviews, never the reporting
// Session, and a window that selects by each Session's newest History Entry.

/** One Session's card as the page needs it; the stored summary is the Session's own account. */
export type OverviewSessionCard = {
  id: string
  title: string
  summary: string
  /** What the Session worked on, from its stored picture or its newest turn's output. */
  icon: string
  /** The stored picture's file on disk; the tool inlines it under the page budget. */
  picturePath?: string
}

export type OverviewSelection = {
  window: OverviewWindow
  /** Included, readable Sessions other than the reporting one, before the window filter. */
  includedSessions: number
  outcome: 'ok' | 'none-included' | 'none-in-range'
  /** Newest activity first; the app's order, never the model's. */
  sessions: OverviewSessionCard[]
  /** What to tell the user when the outcome is an empty case. */
  message?: string
}

export type OverviewQuery = {
  range: OverviewRangeInput
  /** The reporting Session, which never appears in its own Overview. */
  excludingSessionId?: string
  /** Injectable clock, so tests resolve the same window every run. */
  now?: number
}

const MEDIA_ICONS: Record<ArtifactMediaType, string> = {
  image: '🎨',
  video: '🎬',
  audio: '🔊',
  model3d: '🧊',
}

function iconOf(summary: OverviewSummary | undefined, newest: HistoryEntry): string {
  const picture = summary?.picture
  if (picture) {
    if (picture.source === 'game-icon') return '🎮'
    if (picture.source === 'video-thumbnail') return '🎬'
    return MEDIA_ICONS[picture.mediaType]
  }
  const artifact = newest.artifacts[0]
  if (artifact) return MEDIA_ICONS[artifact.mediaType]
  switch (newest.kind) {
    case 'image':
    case 'edit':
      return MEDIA_ICONS.image
    case 'video':
      return MEDIA_ICONS.video
    case 'tts':
    case 'stt':
      return MEDIA_ICONS.audio
    default:
      return '💬'
  }
}

/**
 * The file the stored picture names: relative to its folder, the Session's
 * artifact root, or absolute for a game icon outside every Session folder.
 */
async function storedPicturePath(
  sessionId: string,
  picture: OverviewSummaryPicture,
): Promise<string | undefined> {
  if (picture.folderId) {
    const list = await readSessionFolders(sessionId)
    return (
      artifactHostPath(
        sessionId,
        { folderId: picture.folderId, path: picture.path, mediaType: picture.mediaType },
        list,
      ) ?? undefined
    )
  }
  if (path.isAbsolute(picture.path)) return path.resolve(picture.path)
  const root = sessionPaths(sessionId).artifactRoot
  const file = path.resolve(root, picture.path)
  const relative = path.relative(root, file)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? file : undefined
}

/** The newest entry by timestamp, and the later-appended one when two share a millisecond. */
function newestEntry(entries: readonly HistoryEntry[]): HistoryEntry | undefined {
  return entries.reduce<HistoryEntry | undefined>(
    (newest, entry) => (!newest || entry.timestamp >= newest.timestamp ? entry : newest),
    undefined,
  )
}

/**
 * One range's Overview: every readable, included Session whose newest History
 * Entry falls inside it, excluding the Session that asked. The range is echoed
 * whether or not anything was found, and the two empty cases stay distinct so the
 * agent can say whether a setting or a quiet window is the reason.
 */
export async function selectOverviewSessions(query: OverviewQuery): Promise<OverviewSelection> {
  const now = query.now ?? Date.now()
  const window = resolveOverviewWindow(query.range, now)
  const included = (await listSessions()).filter(
    (session) =>
      !session.unreadable && session.includedInOverviews && session.id !== query.excludingSessionId,
  )
  const base = { window, includedSessions: included.length }

  if (included.length === 0) {
    return {
      ...base,
      outcome: 'none-included',
      sessions: [],
      message:
        'No Session is included in Overviews. Turn on "Included in Overviews" in the Session ' +
        'the Overview should cover, then ask again.',
    }
  }

  const found: (OverviewSessionCard & { newest: number })[] = []
  for (const row of included) {
    const entries = await readHistoryEntries(row.id)
    const newest = newestEntry(entries)
    if (!newest || newest.timestamp < window.from || newest.timestamp >= window.to) continue
    const file = await readSession(row.id)
    const stored = file.overviewSummary
    const picturePath = stored?.picture
      ? await storedPicturePath(row.id, stored.picture)
      : undefined
    found.push({
      id: row.id,
      title: row.title.trim() || autoTitle(newest),
      summary: stored?.text ?? '',
      icon: iconOf(stored, newest),
      ...(picturePath ? { picturePath } : {}),
      newest: newest.timestamp,
    })
  }

  if (found.length === 0) {
    return {
      ...base,
      outcome: 'none-in-range',
      sessions: [],
      message: `None of the ${included.length} included Sessions was active in this range.`,
    }
  }

  found.sort((a, b) => b.newest - a.newest || a.id.localeCompare(b.id))
  return {
    ...base,
    outcome: 'ok',
    sessions: found.map(({ newest: _newest, ...card }) => card),
  }
}
