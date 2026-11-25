import { emitFailure, emitSessionChanged } from '../kernel/kernelBus'
import { appLoggerInstance } from '../observability/logger'
import { artifactReferenceOf } from './historyArtifacts'
import { createRecordsLookup, newestVisualCover, type OverviewCover } from './overviewCovers'
import { relativeInside } from './overviewPicture'
import {
  estimateTokens,
  incrementalOverviewSummaryPrompts,
  overviewSummaryPrompts,
  parseOverviewSummaryReply,
  sessionTitle,
  type OverviewSummaryCompletion,
} from './overviewSummaryPrompts'
import { readHistoryEntries, updateHistoryEntry } from './sessionHistory'
import {
  listSessions,
  mutateSession,
  readSession,
  sessionDocumentOf,
  sessionPaths,
} from './sessions'
import { readSessionFolders } from './sessionFolders'
import {
  OVERVIEW_SUMMARY_CHUNK_TOKENS,
  OVERVIEW_SUMMARY_CONTRACT_VERSION,
  OVERVIEW_SUMMARY_MAX_CHARS,
  OVERVIEW_SUMMARY_REBUILD_EVERY,
} from './overviewContract'
import { localSummaryModel, summariserModelName } from '@/lib/summariser'
import type { ChatModelConfig } from '@/types/chatIpc'
import type {
  HistoryEntry,
  OverviewSummary,
  OverviewSummaryPicture,
  Summariser,
  OverviewSummaryUpdate,
  SessionDocument,
} from '@/types/sessionIpc'

// The Overview Summary update: the whole Session's history (or a chunked read of
// it) becomes one stored account. It has no tools, no harness messages and writes
// nothing but `session.json`; the model call is injected so the tests drive it
// with a fake completion and main wires the real one.

export {
  OVERVIEW_SUMMARY_CHUNK_TOKENS,
  OVERVIEW_SUMMARY_CONTRACT_VERSION,
  OVERVIEW_SUMMARY_MAX_CHARS,
  OVERVIEW_SUMMARY_REBUILD_EVERY,
}
export {
  estimateTokens,
  incrementalOverviewSummaryPrompts,
  overviewSummaryPrompts,
  parseOverviewSummaryReply,
  type OverviewSummaryCompletion,
}
export type OverviewSummaryCompleteInput = {
  prompt: string
  model: ChatModelConfig
  signal: AbortSignal
  /** True for the answer that is stored; false for an intermediate chunk read. */
  final: boolean
  sessionId: string
  /**
   * The caller already holds the Turn Queue's place (a panel media run settling),
   * so the runner loads the model instead of taking a second place.
   */
  admitted?: boolean
}

export type OverviewSummaryComplete = (
  input: OverviewSummaryCompleteInput,
) => Promise<OverviewSummaryCompletion>

let completeImpl: OverviewSummaryComplete | null = null

export function setOverviewSummaryComplete(complete: OverviewSummaryComplete): void {
  completeImpl = complete
}

export function resetOverviewSummaryForTest(): void {
  completeImpl = null
  activeRuns.clear()
  tokenSeq = 0
}

type ActiveRun = { controller: AbortController; token: number }
const activeRuns = new Map<string, ActiveRun>()
let tokenSeq = 0

function beginRun(sessionId: string): ActiveRun {
  activeRuns.get(sessionId)?.controller.abort()
  const run = { controller: new AbortController(), token: ++tokenSeq }
  activeRuns.set(sessionId, run)
  return run
}

function isCurrentRun(sessionId: string, token: number): boolean {
  return activeRuns.get(sessionId)?.token === token
}

function cancelRun(sessionId: string): void {
  const run = activeRuns.get(sessionId)
  if (!run) return
  run.controller.abort()
  activeRuns.delete(sessionId)
}

function capSummary(text: string): string {
  const trimmed = text.replace(/\r\n/g, '\n').trim()
  return trimmed.length > OVERVIEW_SUMMARY_MAX_CHARS
    ? `${trimmed.slice(0, OVERVIEW_SUMMARY_MAX_CHARS - 1)}…`
    : trimmed
}

function pictureOf(
  sessionId: string,
  cover: OverviewCover,
  list: Parameters<typeof artifactReferenceOf>[1],
): OverviewSummaryPicture {
  const reference = artifactReferenceOf(cover.path, list)
  if (reference) {
    return { ...reference, mediaType: cover.mediaType, source: cover.source }
  }
  const inside = relativeInside(sessionPaths(sessionId).artifactRoot, cover.path)
  return {
    ...(inside ? { path: inside } : { path: cover.path }),
    mediaType: cover.mediaType,
    source: cover.source,
  }
}

function pendingSummary(previous: OverviewSummary | undefined): OverviewSummary {
  return {
    ...(previous ?? {}),
    state: 'pending',
    contractVersion: previous?.contractVersion ?? OVERVIEW_SUMMARY_CONTRACT_VERSION,
  }
}

/** The Session's reply language, frozen once so a UI language change never retranslates it. */
async function sessionLanguage(
  sessionId: string,
  requested: string,
  freeze: boolean,
): Promise<string> {
  const file = await readSession(sessionId)
  const known = file.responseLocale ?? file.overviewSummary?.language
  if (known) return known
  const language = requested || 'en-US'
  if (!freeze) return language
  await mutateSession(sessionId, (current) =>
    current.responseLocale ? current : { ...current, responseLocale: language },
  )
  return language
}

async function withSessionLanguage(sessionId: string, request: Summariser): Promise<Summariser> {
  const language = await sessionLanguage(sessionId, request.language, !!localSummaryModel(request))
  return { ...request, language }
}

async function writeSummary(
  sessionId: string,
  token: number,
  summary: OverviewSummary,
): Promise<SessionDocument | null> {
  if (!isCurrentRun(sessionId, token)) return null
  const file = await mutateSession(sessionId, (current) => {
    if (!current.includedInOverviews || !isCurrentRun(sessionId, token)) return current
    return { ...current, overviewSummary: summary }
  })
  emitSessionChanged(sessionDocumentOf(file))
  return sessionDocumentOf(file)
}

/** The durable marker a run leaves if it is interrupted: the next launch or turn resumes it. */
async function markPendingForRun(sessionId: string, token: number): Promise<void> {
  const file = await mutateSession(sessionId, (current) =>
    current.includedInOverviews && isCurrentRun(sessionId, token)
      ? { ...current, overviewSummary: pendingSummary(current.overviewSummary) }
      : current,
  )
  emitSessionChanged(sessionDocumentOf(file))
}

type OverviewSummaryUpdateRun = { summary: OverviewSummary; tokens?: number }
type UpdateSettlement = { patch: OverviewSummaryUpdate; summary: OverviewSummary }

async function performUpdate(
  sessionId: string,
  request: Summariser,
  run: ActiveRun,
  admitted: boolean,
): Promise<OverviewSummaryUpdateRun | null> {
  const model = localSummaryModel(request)
  if (!model) return null
  const file = await readSession(sessionId)
  if (!file.includedInOverviews) return null
  const entries = await readHistoryEntries(sessionId)
  if (entries.length === 0) return null
  if (!completeImpl) {
    appLoggerInstance.warn(
      `Overview Summary update has no model runner wired (${sessionId})`,
      'sessions',
    )
    return null
  }

  const previous = file.overviewSummary
  const newest = entries.at(-1)
  if (!newest) return null
  const coveredIndex = previous?.coveredEntryId
    ? entries.findIndex((entry) => entry.id === previous.coveredEntryId)
    : -1
  const sinceRebuild = (previous?.updatesSinceRebuild ?? 0) + 1
  const missingCover = previous?.coveredEntryId !== undefined && coveredIndex < 0
  const contractChanged =
    previous !== undefined && previous.contractVersion !== OVERVIEW_SUMMARY_CONTRACT_VERSION
  const periodic = previous !== undefined && sinceRebuild >= OVERVIEW_SUMMARY_REBUILD_EVERY
  const newEntries = coveredIndex >= 0 ? entries.slice(coveredIndex + 1) : []
  const incremental =
    previous?.text !== undefined &&
    previous.text !== '' &&
    coveredIndex >= 0 &&
    newEntries.length > 0 &&
    !missingCover &&
    !contractChanged &&
    !periodic

  const list = await readSessionFolders(sessionId)
  const cover = await newestVisualCover(sessionId, file, list, entries, createRecordsLookup())
  const title = sessionTitle(file, entries)
  const passes = incremental
    ? incrementalOverviewSummaryPrompts(
        title,
        previous.text ?? '',
        newEntries,
        request.language,
        cover ?? undefined,
      )
    : overviewSummaryPrompts(title, entries, request.language, cover ?? undefined)
  const chunkSummaries: string[] = []
  let finalText = ''
  let pictureMatches = false
  let tokens: number | undefined

  for (const pass of passes) {
    const prompt = pass.final
      ? pass.prompt.replace('\n{CHUNK_SUMMARIES}', `\n${chunkSummaries.join('\n')}`)
      : pass.prompt
    const completion = await completeImpl({
      prompt,
      model,
      signal: run.controller.signal,
      final: pass.final,
      sessionId,
      ...(admitted ? { admitted } : {}),
    })
    if (!isCurrentRun(sessionId, run.token) || run.controller.signal.aborted) return null
    if (completion.tokens !== undefined) tokens = (tokens ?? 0) + completion.tokens
    if (pass.final) {
      finalText = completion.text
      pictureMatches = completion.pictureMatches
    } else {
      chunkSummaries.push(completion.text)
    }
  }

  const summary: OverviewSummary = {
    state: 'ready',
    text: capSummary(finalText),
    coveredEntryId: newest.id,
    model: summariserModelName(model),
    language: request.language,
    contractVersion: OVERVIEW_SUMMARY_CONTRACT_VERSION,
    writtenAt: Date.now(),
    updatesSinceRebuild: incremental ? sinceRebuild : 0,
    ...(pictureMatches && cover ? { picture: pictureOf(sessionId, cover, list) } : {}),
  }
  const written = await writeSummary(sessionId, run.token, summary)
  return written ? { summary, ...(tokens !== undefined ? { tokens } : {}) } : null
}

async function failUpdate(
  sessionId: string,
  token: number,
  error: unknown,
  language: string,
): Promise<OverviewSummary | null> {
  if (!isCurrentRun(sessionId, token)) return null
  const reason = error instanceof Error ? error.message : String(error)
  const file = await readSession(sessionId).catch(() => null)
  if (!file || !file.includedInOverviews) return null
  const previous = file.overviewSummary
  const failed: OverviewSummary = {
    ...(previous ?? { contractVersion: OVERVIEW_SUMMARY_CONTRACT_VERSION }),
    state: 'failed',
    failureReason: reason,
    language: previous?.language ?? language,
    contractVersion: previous?.contractVersion ?? OVERVIEW_SUMMARY_CONTRACT_VERSION,
  }
  const written = await writeSummary(sessionId, token, failed)
  if (!written) return null
  emitFailure({
    code: 'overviews/summary-update-failed',
    category: 'inference',
    severity: 'warning',
    surface: 'toast',
    userMessage: 'The Overview Summary could not be written.',
    technicalMessage: reason,
    context: { sessionId },
    recoverable: true,
  })
  return failed
}

/**
 * One update's whole run: begin, perform, catch into a failure, turn it into the
 * entry patch, and release the run. Turn, retry and resume all settle this way.
 */
async function runUpdateToPatch(
  sessionId: string,
  request: Summariser,
  options: {
    admitted?: boolean
    external?: AbortSignal
    prepare?: (run: ActiveRun) => Promise<void>
  } = {},
): Promise<UpdateSettlement | null> {
  const startedAt = Date.now()
  const run = beginRun(sessionId)
  const onAbort = () => run.controller.abort()
  options.external?.addEventListener('abort', onAbort, { once: true })
  if (options.external?.aborted) run.controller.abort()
  try {
    if (options.prepare) await options.prepare(run)
    const result = await performUpdate(sessionId, request, run, options.admitted === true)
    if (!result) return null
    return {
      patch: overviewOutcomePatch({
        state: 'ready',
        summary: result.summary,
        durationMs: Date.now() - startedAt,
        ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
      }),
      summary: result.summary,
    }
  } catch (error) {
    if (run.controller.signal.aborted) return null
    const summary = await failUpdate(sessionId, run.token, error, request.language)
    if (!summary) return null
    return {
      patch: overviewOutcomePatch({
        state: 'failed',
        summary,
        durationMs: Date.now() - startedAt,
        failureReason: error instanceof Error ? error.message : String(error),
      }),
      summary,
    }
  } finally {
    options.external?.removeEventListener('abort', onAbort)
    if (activeRuns.get(sessionId)?.token === run.token) activeRuns.delete(sessionId)
  }
}

function startUpdate(sessionId: string, request: Summariser): void {
  if (!localSummaryModel(request)) return
  void runUpdateToPatch(sessionId, request)
}

/** What one settled turn's Overview Summary update did, for its History Entry. */
export type OverviewSummaryUpdateResult = {
  state: 'ready' | 'failed'
  summary: OverviewSummary
  durationMs: number
  tokens?: number
  failureReason?: string
}

/** The History Entry outcome a settled update records, for the turn's details row. */
export function overviewOutcomePatch(outcome: OverviewSummaryUpdateResult): OverviewSummaryUpdate {
  if (outcome.state === 'ready') {
    return {
      state: 'ready',
      ...(outcome.summary.model ? { model: outcome.summary.model } : {}),
      ...(outcome.summary.writtenAt !== undefined ? { writtenAt: outcome.summary.writtenAt } : {}),
      durationMs: outcome.durationMs,
      ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
      ...(outcome.summary.coveredEntryId ? { coveredEntryId: outcome.summary.coveredEntryId } : {}),
      ...(outcome.summary.text ? { text: outcome.summary.text } : {}),
    }
  }
  return {
    state: 'failed',
    ...(outcome.summary.model ? { model: outcome.summary.model } : {}),
    writtenAt: Date.now(),
    durationMs: outcome.durationMs,
    ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
    ...(outcome.summary.coveredEntryId ? { coveredEntryId: outcome.summary.coveredEntryId } : {}),
    ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
  }
}

/**
 * Writes one update's outcome back onto the entries still waiting for it: the turn
 * that was interrupted, a crashed run, or (with `entryId`) the one row a Retry names.
 * A failure never touches earlier failed entries.
 */
export async function recordOverviewOutcome(
  sessionId: string,
  patch: OverviewSummaryUpdate,
  entryId?: string,
): Promise<HistoryEntry[]> {
  const entries = await readHistoryEntries(sessionId)
  const updated: HistoryEntry[] = []
  for (const entry of entries) {
    const waiting = entry.overviewUpdate?.state === 'pending'
    if (entryId !== undefined ? entry.id !== entryId : !waiting) continue
    const next = await updateHistoryEntry(sessionId, entry.id, { overviewUpdate: patch })
    if (next) updated.push(next)
  }
  const file = await readSession(sessionId).catch(() => null)
  if (file) emitSessionChanged(sessionDocumentOf(file))
  return updated
}

/**
 * The turn-settlement entry point: run the update and report what happened, or
 * null when there is nothing to update (not included, no entries, no local model).
 * A failure is recorded on the Session and reported here, never thrown to the turn.
 */
export async function updateOverviewSummaryForTurn(
  sessionId: string,
  initialRequest: Summariser,
  external?: AbortSignal,
  options: { admitted?: boolean } = {},
): Promise<OverviewSummaryUpdateResult | null> {
  const file = await readSession(sessionId).catch(() => null)
  if (!file?.includedInOverviews) return null
  const request = await withSessionLanguage(sessionId, initialRequest)
  if (!localSummaryModel(request)) {
    await markPending(sessionId)
    return null
  }
  const entries = await readHistoryEntries(sessionId)
  if (entries.length === 0) return null

  const settled = await runUpdateToPatch(sessionId, request, {
    admitted: options.admitted,
    external,
    prepare: (run) => markPendingForRun(sessionId, run.token),
  })
  if (!settled) return null
  return {
    state: settled.patch.state === 'ready' ? 'ready' : 'failed',
    summary: settled.summary,
    durationMs: settled.patch.durationMs ?? 0,
    ...(settled.patch.tokens !== undefined ? { tokens: settled.patch.tokens } : {}),
    ...(settled.patch.failureReason ? { failureReason: settled.patch.failureReason } : {}),
  }
}

async function markPending(
  sessionId: string,
  previous?: OverviewSummary,
): Promise<SessionDocument> {
  cancelRun(sessionId)
  const file = await mutateSession(sessionId, (current) =>
    current.includedInOverviews
      ? { ...current, overviewSummary: pendingSummary(previous ?? current.overviewSummary) }
      : current,
  )
  emitSessionChanged(sessionDocumentOf(file))
  return sessionDocumentOf(file)
}

/** Enabling reuses a current summary; opting out keeps it, unused, for the next enable. */
export async function applyOverviewInclusion(
  sessionId: string,
  included: boolean,
  initialRequest: Summariser,
): Promise<SessionDocument> {
  if (!included) {
    cancelRun(sessionId)
    const file = await mutateSession(sessionId, (current) => ({
      ...current,
      includedInOverviews: false,
    }))
    emitSessionChanged(sessionDocumentOf(file))
    return sessionDocumentOf(file)
  }

  let file = await readSession(sessionId)
  if (!file.includedInOverviews) {
    file = await mutateSession(sessionId, (current) => ({
      ...current,
      includedInOverviews: true,
    }))
    emitSessionChanged(sessionDocumentOf(file))
  }
  const entries = await readHistoryEntries(sessionId)
  if (entries.length === 0) return sessionDocumentOf(file)

  const newest = entries.at(-1)
  const summary = file.overviewSummary
  const currentSummary =
    newest !== undefined &&
    summary !== undefined &&
    summary.text !== undefined &&
    summary.text.trim() !== '' &&
    summary.contractVersion === OVERVIEW_SUMMARY_CONTRACT_VERSION &&
    summary.coveredEntryId !== undefined &&
    summary.coveredEntryId === newest.id
  if (currentSummary && summary) {
    if (summary.state === 'ready' && summary.failureReason === undefined) {
      return sessionDocumentOf(file)
    }
    const updated = await mutateSession(sessionId, (currentFile) => {
      const kept = currentFile.overviewSummary
      if (!kept) return currentFile
      const { failureReason: _failure, ...rest } = kept
      return { ...currentFile, overviewSummary: { ...rest, state: 'ready' } }
    })
    emitSessionChanged(sessionDocumentOf(updated))
    return sessionDocumentOf(updated)
  }

  const request = await withSessionLanguage(sessionId, initialRequest)
  if (!localSummaryModel(request)) {
    return markPending(sessionId, file.overviewSummary)
  }
  const pending = await markPending(sessionId, file.overviewSummary)
  startUpdate(sessionId, request)
  return pending
}

/**
 * Run the update again without a turn, from the chip: only the Session's summary
 * state moves. A turn's own details row is left exactly as that turn recorded it.
 */
export async function refreshOverviewSummary(
  sessionId: string,
  initialRequest: Summariser,
): Promise<SessionDocument> {
  const file = await readSession(sessionId)
  if (!file.includedInOverviews) return sessionDocumentOf(file)
  const entries = await readHistoryEntries(sessionId)
  if (entries.length === 0) return sessionDocumentOf(file)
  const request = await withSessionLanguage(sessionId, initialRequest)
  if (!localSummaryModel(request)) return markPending(sessionId, file.overviewSummary)
  const pending = await markPending(sessionId, file.overviewSummary)
  startUpdate(sessionId, request)
  return pending
}

/**
 * A turn's failed row runs the update again without a new turn, and the new outcome
 * is written back onto that same History Entry. Resolves once it has settled.
 */
export async function retryOverviewUpdate(
  sessionId: string,
  entryId: string,
  initialRequest: Summariser,
): Promise<SessionDocument> {
  const file = await readSession(sessionId)
  if (!file.includedInOverviews) return sessionDocumentOf(file)
  const entries = await readHistoryEntries(sessionId)
  if (!entries.some((entry) => entry.id === entryId)) return sessionDocumentOf(file)
  const request = await withSessionLanguage(sessionId, initialRequest)
  if (!localSummaryModel(request)) return sessionDocumentOf(file)

  const retrying = await updateHistoryEntry(sessionId, entryId, {
    overviewUpdate: { state: 'pending', pendingReason: 'local' },
  })
  if (!retrying) return sessionDocumentOf(file)
  await markPending(sessionId, file.overviewSummary)

  const settled = await runUpdateToPatch(sessionId, request)
  if (settled) await recordOverviewOutcome(sessionId, settled.patch, entryId)
  return sessionDocumentOf(await readSession(sessionId))
}

/**
 * Resumes the local pending markers a crash left behind: every pending History Entry
 * an included Session still has is covered by one update, whose outcome then replaces
 * all of them. A cloud or no-local marker waits for the next local turn instead, and
 * a failure is never retried by itself.
 */
export async function resumePendingOverviewUpdates(request: Summariser): Promise<string[]> {
  const resumed: string[] = []
  if (!localSummaryModel(request)) return resumed
  const sessions = await listSessions()
  for (const session of sessions) {
    if (!session.includedInOverviews) continue
    const pending = (await readHistoryEntries(session.id)).filter(
      (entry) =>
        entry.overviewUpdate?.state === 'pending' && entry.overviewUpdate.pendingReason === 'local',
    )
    if (pending.length === 0) continue

    const file = await readSession(session.id).catch(() => null)
    if (!file?.includedInOverviews) continue
    const sessionRequest = await withSessionLanguage(session.id, request)
    const settled = await runUpdateToPatch(session.id, sessionRequest)
    if (!settled) continue
    await recordOverviewOutcome(session.id, settled.patch)
    resumed.push(session.id)
  }
  return resumed
}
