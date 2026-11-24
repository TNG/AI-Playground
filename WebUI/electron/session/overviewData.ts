import fs from 'node:fs/promises'
import { readGame } from '../agent/games/gameLibrary'
import { bootstrapMediaItems } from '../persist/mediaItemFiles'
import { artifactHostPath } from './historyArtifacts'
import { readSessionFolders } from './sessionFolders'
import { readHistoryEntries } from './sessionHistory'
import { artifactFoldersOf } from './sessionFolderList'
import { sessionFolderMediaFile, sessionLegacyMediaFile } from './sessionFolderMedia'
import { isInGamesLibrary } from './sessionWorkspace'
import { listSessions, readSession } from './sessions'
import { sessionMediaPathOf } from '@/lib/comfyWorkflow'
import type { MediaItem } from '@/types/mediaItem'
import type {
  ArtifactMediaType,
  HistoryArtifact,
  HistoryEntry,
  SessionFile,
  SessionFolderList,
} from '@/types/sessionIpc'

// ── Overviews: the data an Overview Agent reads ──────────────────────────────
//
// One range in, the History of the Sessions the user included out. The flag is
// the boundary — not an instruction the agent is asked to respect (ADR-0019) —
// so this module reads only `includedInOverviews` Sessions, never the reporting
// Session, and treats an Agent Run's Steps as entries of the Session they ran in.

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** A named range, or an explicit local-date / ISO-timestamp window. */
export type OverviewRangeInput =
  'last-24h' | 'today' | 'yesterday' | 'last-7-days' | 'last-30-days' | { from: string; to: string }

export type OverviewWindow = { from: number; to: number }

export const OVERVIEW_NAMED_RANGES = [
  'last-24h',
  'today',
  'yesterday',
  'last-7-days',
  'last-30-days',
] as const satisfies readonly OverviewRangeInput[]

/** A span wider than this is reported, not refused. */
export const OVERVIEW_WIDE_RANGE_MS = 30 * DAY_MS

function startOfLocalDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Adds calendar days in local time, so a DST change does not stretch a day. */
function addLocalDays(ms: number, days: number): number {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function parsePoint(value: string): number | null {
  const trimmed = value.trim()
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (dateOnly) {
    const [, year, month, day] = dateOnly
    return new Date(Number(year), Number(month) - 1, Number(day)).getTime()
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * The concrete window a range names. `last-24h` rolls from now; `today` and
 * `yesterday` are local calendar days; the day ranges are local-midnight aligned
 * and end at now. Everything is the machine's local timezone.
 */
export function resolveOverviewWindow(
  range: OverviewRangeInput,
  now: number = Date.now(),
): OverviewWindow {
  switch (range) {
    case 'last-24h':
      return { from: now - DAY_MS, to: now }
    case 'today': {
      const start = startOfLocalDay(now)
      return { from: start, to: addLocalDays(start, 1) }
    }
    case 'yesterday': {
      const today = startOfLocalDay(now)
      return { from: addLocalDays(today, -1), to: today }
    }
    case 'last-7-days':
      return { from: addLocalDays(startOfLocalDay(now), -6), to: now }
    case 'last-30-days':
      return { from: addLocalDays(startOfLocalDay(now), -29), to: now }
  }
  if (typeof range === 'object' && range !== null) {
    const from = parsePoint(range.from)
    const to = parsePoint(range.to)
    if (from === null) throw new Error(`Not a date: ${range.from}`)
    if (to === null) throw new Error(`Not a date: ${range.to}`)
    if (from >= to) throw new Error('The range must start before it ends.')
    return { from, to }
  }
  throw new Error(`Unknown range: ${String(range)}`)
}

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

/** One picture that could represent a Session; an image file, whatever produced it. */
export type OverviewCover = {
  /** Absolute file path. */
  path: string
  /** What the file is: a video's poster is an image. */
  mediaType: ArtifactMediaType
  /** The prompt that produced it (a game icon: what started the game). */
  prompt: string
  time: number
  source: 'artifact' | 'video-thumbnail' | 'game-icon'
}

export type OverviewSessionData = {
  id: string
  title: string
  /** Newest first, capped per Session and by the report-wide line budget. */
  entries: OverviewEntry[]
  totalEntries: number
  truncated: boolean
  /** Newest first, capped. */
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
export const OVERVIEW_COVER_CAP = 8
const RESPONSE_EXCERPT_LENGTH = 280

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

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

type RecordsLookup = () => Promise<Map<string, MediaItem>>

async function mediaRecordsByItemId(): Promise<Map<string, MediaItem>> {
  try {
    const boot = await bootstrapMediaItems()
    return boot.status === 'ok' ? new Map(boot.items.map((item) => [item.id, item])) : new Map()
  } catch {
    return new Map()
  }
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

async function collectCovers(
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
  const base = { window, wideRange, includedSessions: included.length }

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
  const sessions: OverviewSessionData[] = []
  let records: Promise<Map<string, MediaItem>> | undefined
  const recordsOf: RecordsLookup = () => (records ??= mediaRecordsByItemId())

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

    const shown = inRange.slice(0, Math.max(0, Math.min(OVERVIEW_ENTRY_CAP, lineBudget)))
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

  return { ...base, outcome: 'ok', truncated, sessions }
}
