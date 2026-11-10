import path from 'node:path'
import { ensureGameMediaCopy } from '../persist/sessionMediaFiles'
import { readHistoryEntries } from './sessionHistory'
import { mutateSession, readSession, sessionPaths } from './sessions'
import type { HistoryEntry } from '@/types/sessionIpc'

const UPDATE_CAP = 1500
const EXCERPT_CHARS = 120
const LIST_PROMPT_CHARS = 80
const HEADER = 'Session Update — what happened in this Session since your last turn:'

/** A reader of Session Updates: an agent preset's Harness Session, or the Session's chat. */
export type SessionUpdateConsumer = {
  /** Its cursor's key in `session.json` `updateCursors`. */
  key: string
  /**
   * This preset's harness turns are the consumer's own — not Agent Run Steps, Follow-ups, or
   * chat-engine turns, which a Harness Session holds only once replayed into it (`isOwn`).
   */
  ownPreset?: string
  /** Entries of this Harness Session are its own: an Agent Run's Steps and its Follow-ups. */
  harnessSessionId?: string
  /** A Follow-up's run, whose Steps may predate `harnessSessionId` and Session Update cursors. */
  run?: { taskName: string; startedAt: number }
  isOwn?: (entry: HistoryEntry) => boolean
  /** Where the consumer opens files from; Session Folder paths inside it are shown relative to it. */
  workspaceDir?: string
}

export type SessionUpdateOptions = {
  artifactPath?: (sessionRelativePath: string) => string
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function clock(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function outcomeOf(entry: HistoryEntry, artifactPath: (p: string) => string): string {
  if (entry.artifacts.length > 0) return entry.artifacts.map((a) => artifactPath(a.path)).join(', ')
  if (entry.response) return `"${excerpt(entry.response, EXCERPT_CHARS)}"`
  return `(${entry.status})`
}

function updateLine(entry: HistoryEntry, artifactPath: (p: string) => string): string {
  const prompt = excerpt(entry.prompt, EXCERPT_CHARS)
  return `[${clock(entry.timestamp)}] ${entry.agentName ?? entry.preset}: "${prompt}" → ${outcomeOf(entry, artifactPath)}`
}

const omittedLine = (count: number) => `${count} earlier entries omitted — use \`session_history\``

/** The templated digest of `entries` (oldest first), capped keeping the newest; null when empty. */
export function buildSessionUpdate(
  entries: HistoryEntry[],
  options: SessionUpdateOptions = {},
): string | null {
  if (entries.length === 0) return null
  const artifactPath = options.artifactPath ?? ((p: string) => p)
  const kept: string[] = []
  let length = HEADER.length
  for (let index = entries.length - 1; index >= 0; index--) {
    const line = updateLine(entries[index], artifactPath)
    const omitted = index > 0 ? omittedLine(index).length + 1 : 0
    if (kept.length > 0 && length + line.length + 1 + omitted > UPDATE_CAP) break
    kept.unshift(line)
    length += line.length + 1
  }
  const omitted = entries.length - kept.length
  return [HEADER, ...kept, ...(omitted > 0 ? [omittedLine(omitted)] : [])].join('\n')
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** A games preset works outside the Session Folder, so its files reach it as game-folder copies. */
function workspacePathView(sessionId: string, workspaceDir: string | undefined) {
  if (!workspaceDir) return async (p: string) => p
  const { root, filesDir } = sessionPaths(sessionId)
  return async (sessionRelative: string) => {
    const absolute = path.resolve(root, sessionRelative)
    if (isInside(workspaceDir, absolute)) {
      return path.relative(workspaceDir, absolute).split(path.sep).join('/')
    }
    if (!isInside(filesDir, absolute)) return sessionRelative
    return (await ensureGameMediaCopy(absolute, workspaceDir)) ?? sessionRelative
  }
}

/** `entries` with their artifact paths as a consumer working in `workspaceDir` sees them. */
export async function historyAsSeenFrom(
  sessionId: string,
  entries: HistoryEntry[],
  workspaceDir: string | undefined,
): Promise<HistoryEntry[]> {
  const view = workspacePathView(sessionId, workspaceDir)
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      artifacts: await Promise.all(
        entry.artifacts.map(async (artifact) => ({ ...artifact, path: await view(artifact.path) })),
      ),
    })),
  )
}

/** A turn the user ran with this preset, not an Agent Run's. */
export function isPresetTurn(entry: HistoryEntry, preset: string | undefined): boolean {
  return !!preset && entry.preset === preset && !entry.taskName && !entry.agentId
}

function isOwnTurn(entry: HistoryEntry, consumer: SessionUpdateConsumer): boolean {
  if (entry.kind !== 'chat' && isPresetTurn(entry, consumer.ownPreset)) return true
  if (consumer.harnessSessionId && entry.harnessSessionId === consumer.harnessSessionId) return true
  if (isLegacyStepOf(entry, consumer.run)) return true
  return consumer.isOwn?.(entry) ?? false
}

function isLegacyStepOf(entry: HistoryEntry, run: SessionUpdateConsumer['run']): boolean {
  return (
    !!run &&
    !entry.harnessSessionId &&
    entry.taskName === run.taskName &&
    entry.timestamp >= run.startedAt
  )
}

function firstUnseen(entries: HistoryEntry[], consumer: SessionUpdateConsumer, cursor?: string) {
  if (cursor) return entries.findIndex((entry) => entry.id === cursor) + 1
  if (!consumer.run) return 0
  const since = consumer.run.startedAt
  const index = entries.findIndex((entry) => entry.timestamp >= since)
  return index < 0 ? entries.length : index
}

async function advanceCursor(
  sessionId: string,
  key: string,
  entries: HistoryEntry[],
  cursor?: string,
) {
  const newest = entries.at(-1)
  if (!newest || newest.id === cursor) return
  await mutateSession(sessionId, (current) => ({
    ...current,
    updateCursors: { ...current.updateCursors, [key]: newest.id },
  }))
}

/** Mark everything so far as seen without reporting it: an Agent Run starts with no context. */
export async function skipSessionUpdate(
  sessionId: string,
  consumer: Pick<SessionUpdateConsumer, 'key'>,
): Promise<void> {
  const [file, entries] = await Promise.all([readSession(sessionId), readHistoryEntries(sessionId)])
  await advanceCursor(sessionId, consumer.key, entries, file.updateCursors[consumer.key])
}

/**
 * The consumer's Session Update since its last turn, advancing its cursor to the
 * newest entry read — call it once when the turn starts.
 */
export async function takeSessionUpdate(
  sessionId: string,
  consumer: SessionUpdateConsumer,
): Promise<string | null> {
  const [file, entries] = await Promise.all([readSession(sessionId), readHistoryEntries(sessionId)])
  const cursor = file.updateCursors[consumer.key]
  const missed = entries
    .slice(firstUnseen(entries, consumer, cursor))
    .filter((entry) => !isOwnTurn(entry, consumer))
  await advanceCursor(sessionId, consumer.key, entries, cursor)
  return buildSessionUpdate(await historyAsSeenFrom(sessionId, missed, consumer.workspaceDir))
}

export type SessionHistoryRow = { id: string; time: string; preset: string; prompt: string }

/** `session_history list`: newest first, optionally one preset's entries, paged. */
export async function listSessionHistory(
  sessionId: string,
  query: { preset?: string; limit?: number; offset?: number },
): Promise<SessionHistoryRow[]> {
  const offset = Math.max(0, query.offset ?? 0)
  const limit = Math.max(1, query.limit ?? 20)
  return (await readHistoryEntries(sessionId))
    .filter((entry) => !query.preset || entry.preset === query.preset)
    .reverse()
    .slice(offset, offset + limit)
    .map((entry) => ({
      id: entry.id,
      time: new Date(entry.timestamp).toISOString(),
      preset: entry.preset,
      prompt: excerpt(entry.prompt, LIST_PROMPT_CHARS),
    }))
}

/** `session_history get`: one entry in full, artifact paths as `workspaceDir` sees them. */
export async function getSessionHistoryEntry(
  sessionId: string,
  id: string,
  workspaceDir?: string,
): Promise<HistoryEntry | null> {
  const entry = (await readHistoryEntries(sessionId)).find((candidate) => candidate.id === id)
  if (!entry) return null
  const [seen] = await historyAsSeenFrom(sessionId, [entry], workspaceDir)
  return seen
}
