import { collectCovers, createRecordsLookup, type OverviewCover } from './overviewCovers'
import {
  OVERVIEW_WIDE_RANGE_MS,
  resolveOverviewWindow,
  type OverviewRangeInput,
  type OverviewWindow,
} from './overviewRange'
import { readSessionFolders } from './sessionFolders'
import { readHistoryEntries } from './sessionHistory'
import { listSessions, readSession } from './sessions'
import type { ArtifactMediaType, HistoryEntry } from '@/types/sessionIpc'

// Read side of an Overview: only Sessions included in Overviews, never the reporting Session.

export type OverviewEntryArtifact = { path: string; mediaType: ArtifactMediaType }

export type OverviewEntry = {
  time: number
  preset: string
  /** The Agent that ran the turn, when one did (an Agent Run's Step or a Follow-up). */
  agent?: string
  prompt: string
  status: 'completed' | 'failed' | 'cancelled'
  artifacts: OverviewEntryArtifact[]
  /** A short excerpt of what a non-media turn answered. */
  response?: string
}

export type OverviewSessionData = {
  id: string
  title: string
  /** Newest first, capped per Session and by the Overview-wide line budget. */
  entries: OverviewEntry[]
  totalEntries: number
  truncated: boolean
  covers: OverviewCover[]
  totalCovers: number
  coversTruncated: boolean
}

export type OverviewData = {
  window: OverviewWindow
  wideRange: boolean
  /** Sessions with the opt-in, excluding the reporting Session, before range filtering. */
  includedSessions: number
  outcome: 'ok' | 'none-included' | 'none-in-range'
  truncated: boolean
  sessions: OverviewSessionData[]
  /** Every turn in range across the included Sessions, including those the line budget left out. */
  totalEntries: number
  /** Sessions with turns in range that the Overview-wide line budget left out entirely. */
  sessionsOmitted: number
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

export const OVERVIEW_ENTRY_CAP = 40
export const OVERVIEW_LINE_CAP = 400
const RESPONSE_EXCERPT_LENGTH = 280

function excerpt(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > RESPONSE_EXCERPT_LENGTH
    ? `${trimmed.slice(0, RESPONSE_EXCERPT_LENGTH)}…`
    : trimmed
}

function overviewEntryOf(entry: HistoryEntry): OverviewEntry {
  const agent = entry.agentName ?? entry.taskName
  const response = entry.response?.trim()
  return {
    time: entry.timestamp,
    preset: entry.preset,
    ...(agent ? { agent } : {}),
    prompt: entry.prompt,
    status: entry.status,
    artifacts: entry.artifacts.map(({ path: artifactPath, mediaType }) => ({
      path: artifactPath,
      mediaType,
    })),
    ...(response ? { response: excerpt(response) } : {}),
  }
}

/**
 * One range's Overview data: the included Sessions that have turns in it, their
 * turns newest first, and the pictures that could represent each of them.
 *
 * The range is echoed whether or not anything was found, and the two empty cases
 * stay distinct so the agent can say whether a setting or a quiet day is the
 * reason.
 */
export async function collectOverviewData(query: OverviewQuery): Promise<OverviewData> {
  const now = query.now ?? Date.now()
  const window = resolveOverviewWindow(query.range, now)
  const wideRange = window.to - window.from > OVERVIEW_WIDE_RANGE_MS
  const included = (await listSessions()).filter(
    (session) =>
      !session.unreadable && session.includedInOverviews && session.id !== query.excludingSessionId,
  )
  const base = {
    window,
    wideRange,
    includedSessions: included.length,
    totalEntries: 0,
    sessionsOmitted: 0,
  }

  if (included.length === 0) {
    return {
      ...base,
      outcome: 'none-included',
      truncated: false,
      sessions: [],
      message:
        'No Session is included in Overviews. Turn on "Included in Overviews" in the Session ' +
        'the Overview should cover, then ask again.',
    }
  }

  let lineBudget = OVERVIEW_LINE_CAP
  let truncated = false
  let totalEntries = 0
  let sessionsOmitted = 0
  const sessions: OverviewSessionData[] = []
  const recordsOf = createRecordsLookup()

  for (const summary of included) {
    // `updatedAt` is earlier than the window only when nothing at all happened since it started.
    if (summary.updatedAt < window.from) continue
    const [file, list] = await Promise.all([
      readSession(summary.id),
      readSessionFolders(summary.id),
    ])
    const inRange = (await readHistoryEntries(summary.id))
      .filter((entry) => entry.timestamp >= window.from && entry.timestamp < window.to)
      .sort((a, b) => b.timestamp - a.timestamp)
    if (inRange.length === 0) continue
    totalEntries += inRange.length

    const shown = inRange.slice(0, Math.max(0, Math.min(OVERVIEW_ENTRY_CAP, lineBudget)))
    if (shown.length === 0) {
      sessionsOmitted += 1
      truncated = true
      continue
    }
    lineBudget -= shown.length
    const sessionTruncated = shown.length < inRange.length
    if (sessionTruncated) truncated = true
    const covers = await collectCovers(summary.id, file, list, inRange, recordsOf)
    sessions.push({
      id: summary.id,
      title: summary.title,
      entries: shown.map(overviewEntryOf),
      totalEntries: inRange.length,
      truncated: sessionTruncated,
      covers: covers.covers,
      totalCovers: covers.total,
      coversTruncated: covers.truncated,
    })
  }

  if (sessions.length === 0) {
    return {
      ...base,
      outcome: 'none-in-range',
      truncated: false,
      sessions: [],
      message: `There is no turn from an included Session in this range (${base.includedSessions} included).`,
    }
  }

  return { ...base, outcome: 'ok', truncated, sessions, totalEntries, sessionsOmitted }
}
