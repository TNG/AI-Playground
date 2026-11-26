import {
  resolveOverviewWindow,
  type OverviewRangeInput,
  type OverviewWindow,
} from './overviewRange'
import { readHistoryEntries } from './sessionHistory'
import { foldOverviewWorkCounts, type OverviewWorkCounts } from './overviewCounts'
import { storedPictureHostPath } from './overviewPicture'
import { autoTitle } from './sessionTitle'
import { listSessions, readSession } from './sessions'
import { OVERVIEW_SUMMARY_CONTRACT_VERSION } from './overviewContract'
import type { ArtifactMediaType, HistoryEntry, OverviewSummary } from '@/types/sessionIpc'

// Read side of an Overview: only Sessions included in Overviews, never the reporting
// Session, and a window that selects by each Session's newest History Entry.

/** One Session's card as the page needs it; the stored summary is the Session's own account. */
export type OverviewSessionCard = {
  id: string
  title: string
  summary: string
  /** What the Session worked on, from its stored picture or its newest turn's output. */
  icon: string
  /** The whole Session's work, folded from its History and never from the window. */
  counts: OverviewWorkCounts
  /** The stored picture's file on disk; the tool inlines it under the page budget. */
  picturePath?: string
}

export type OverviewSelection = {
  window: OverviewWindow
  /** Included, readable Sessions other than the reporting one, before the window filter. */
  includedSessions: number
  outcome: 'ok' | 'none-included' | 'none-in-range' | 'none-usable'
  /** Newest activity first; the app's order, never the model's. */
  sessions: OverviewSessionCard[]
  /** Titles of active included Sessions left off the page because they have no usable summary. */
  omitted: string[]
  /** Titles of cards whose summary stops before their newest History Entry. */
  behind: string[]
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
      omitted: [],
      behind: [],
      message:
        'No Session is included in Overviews. Turn on "Included in Overviews" in the Session ' +
        'the Overview should cover, then ask again.',
    }
  }

  type Active = OverviewSessionCard & {
    newest: number
    /** A summary with text is usable; only one with no text leaves the Session off the page. */
    usable: boolean
    /** A summary that is not current with the newest entry is behind it. */
    behind: boolean
  }
  const found: Active[] = []
  for (const row of included) {
    const entries = await readHistoryEntries(row.id)
    const newest = newestEntry(entries)
    if (!newest || newest.timestamp < window.from || newest.timestamp >= window.to) continue
    const file = await readSession(row.id)
    const stored = file.overviewSummary
    const summary = stored?.text?.trim() ?? ''
    const usable = summary !== ''
    const current =
      stored?.state === 'ready' &&
      stored.coveredEntryId === newest.id &&
      stored.contractVersion === OVERVIEW_SUMMARY_CONTRACT_VERSION
    const picturePath =
      usable && stored?.picture ? await storedPictureHostPath(row.id, stored.picture) : undefined
    found.push({
      id: row.id,
      title: row.title.trim() || autoTitle(newest),
      summary: usable ? summary : '',
      icon: iconOf(stored, newest),
      counts: foldOverviewWorkCounts(entries),
      ...(picturePath ? { picturePath } : {}),
      newest: newest.timestamp,
      usable,
      behind: usable && !current,
    })
  }

  if (found.length === 0) {
    return {
      ...base,
      outcome: 'none-in-range',
      sessions: [],
      omitted: [],
      behind: [],
      message: `None of the ${included.length} included Sessions was active in this range.`,
    }
  }

  found.sort((a, b) => b.newest - a.newest || a.id.localeCompare(b.id))
  const usable = found.filter((session) => session.usable)
  const omitted = found.filter((session) => !session.usable).map((session) => session.title)

  if (usable.length === 0) {
    return {
      ...base,
      outcome: 'none-usable',
      sessions: [],
      omitted,
      behind: [],
      message:
        `None of the ${found.length} Sessions active in this range has a usable Overview Summary ` +
        'yet, so there is nothing to write. A summary is written when a Session has its next ' +
        'turn.',
    }
  }

  return {
    ...base,
    outcome: 'ok',
    sessions: usable.map(({ newest: _newest, usable: _usable, behind: _behind, ...card }) => card),
    omitted,
    behind: usable.filter((session) => session.behind).map((session) => session.title),
  }
}
