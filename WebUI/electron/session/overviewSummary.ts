import path from 'node:path'
import { emitFailure, emitSessionChanged } from '../kernel/kernelBus'
import { appLoggerInstance } from '../observability/logger'
import { artifactReferenceOf } from './historyArtifacts'
import { createRecordsLookup, newestVisualCover, type OverviewCover } from './overviewCovers'
import { readHistoryEntries, updateHistoryEntry } from './sessionHistory'
import {
  listSessions,
  mutateSession,
  readSession,
  sessionDocumentOf,
  sessionPaths,
} from './sessions'
import { readSessionFolders } from './sessionFolders'
import { autoTitle } from './sessionTitle'
import type { ChatModelConfig } from '@/types/chatIpc'
import type {
  HistoryEntry,
  OverviewSummary,
  OverviewSummaryPicture,
  OverviewSummaryRequest,
  OverviewSummaryUpdate,
  SessionDocument,
  SessionFile,
} from '@/types/sessionIpc'

// The Overview Summary update: the whole Session's history (or a chunked read of
// it) becomes one stored account. It has no tools, no harness messages and writes
// nothing but `session.json`; the model call is injected so the tests drive it
// with a fake completion and main wires the real one.

export const OVERVIEW_SUMMARY_CONTRACT_VERSION = 1
export const OVERVIEW_SUMMARY_MAX_CHARS = 600
/** An entry block is kept short; the whole read is what has to fit a prompt. */
export const OVERVIEW_SUMMARY_CHUNK_CHARS = 6000
/** Incremental updates before a full rebuild bounds drift (an implementation constant). */
export const OVERVIEW_SUMMARY_REBUILD_EVERY = 10
const ENTRY_RESPONSE_CHARS = 1200
const CANDIDATE_PROMPT_CHARS = 800

const TITLE_FALLBACK = 'Untitled Session'

const SUMMARY_RULES =
  'Write two to four sentences, at most 600 characters, saying what this Session is about ' +
  'and what it has done. Include failures and results. Never list turns or transcribe the ' +
  'transcript.'

const CHUNK_INSTRUCTION =
  'You are reading part of one Session of a desktop AI app. Summarise the work in these ' +
  'History Entries for a later combined account. Keep what was attempted, what failed and ' +
  'what was produced.\n'

const COMBINE_INSTRUCTION =
  'You write the Overview Summary of one Session of a desktop AI app: a short account of ' +
  'its whole work from the summaries of its history.\n' +
  `${SUMMARY_RULES}\n`

const INCREMENTAL_INSTRUCTION =
  'You update the Overview Summary of one Session of a desktop AI app: rewrite the current ' +
  'account so it also covers the History Entries listed after it, and still describes the ' +
  'whole Session.\n' +
  `${SUMMARY_RULES}\n`

const COMBINE_INCREMENTAL_INSTRUCTION =
  'You update the Overview Summary of one Session of a desktop AI app from the summaries of ' +
  'the History Entries the current account did not cover.\n' +
  `${SUMMARY_RULES}\n`

const SINGLE_INSTRUCTION =
  'You write the Overview Summary of one Session of a desktop AI app.\n' + `${SUMMARY_RULES}\n`

const FORMAT_INSTRUCTION =
  '\nIf a newest visual result is given, decide whether it still matches the account you ' +
  'wrote; the pixels are not needed. Reply in exactly this form:\nMATCH: yes or no\n' +
  'SUMMARY:\n<the summary>\n'

export type OverviewSummaryCompletion = {
  text: string
  /** The update's judgement of the newest visual Artifact; false means no picture. */
  pictureMatches: boolean
  /** Total tokens the model reported for this pass, when it reported any. */
  tokens?: number
}

const MATCH_LINE = /^MATCH:\s*(yes|no)\b/im
const SUMMARY_MARKER = /^SUMMARY:[ \t]*$/im

/** Split the model's answer into the summary and its picture judgement. */
export function parseOverviewSummaryReply(
  reply: string,
  final: boolean,
): OverviewSummaryCompletion {
  const text = reply.trim()
  if (!final) return { text, pictureMatches: false }
  const match = MATCH_LINE.exec(text)
  const marker = SUMMARY_MARKER.exec(text)
  const summary =
    marker === null
      ? text.replace(/^MATCH:[^\n]*(\n|$)/i, '').trim()
      : text.slice(marker.index + marker[0].length).trim()
  return {
    text: summary || text,
    pictureMatches: match?.[1]?.toLowerCase() === 'yes',
  }
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

function entryText(entry: HistoryEntry): string {
  const agent = entry.agentName ?? entry.taskName
  const who = agent ? `${entry.preset} (${agent})` : entry.preset
  const response = entry.response?.replace(/\s+/g, ' ').trim()
  const artifacts =
    entry.artifacts.length > 0
      ? ` — produced: ${entry.artifacts.map((artifact) => `${artifact.mediaType} ${artifact.path}`).join(', ')}`
      : ''
  const answer = response
    ? ` — answered: ${
        response.length > ENTRY_RESPONSE_CHARS
          ? `${response.slice(0, ENTRY_RESPONSE_CHARS - 1)}…`
          : response
      }`
    : ''
  const prompt =
    entry.prompt.length > ENTRY_RESPONSE_CHARS
      ? `${entry.prompt.slice(0, ENTRY_RESPONSE_CHARS - 1)}…`
      : entry.prompt
  return `[${new Date(entry.timestamp).toISOString()}] ${who} (${entry.status}) — asked: ${prompt}${answer}${artifacts}`
}

function chunkInto(blocks: string[], budget: number): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let size = 0
  for (const block of blocks) {
    const nextSize = size + block.length + 1
    if (current.length > 0 && nextSize > budget) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(block)
    size += block.length + 1
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function candidateText(cover: OverviewCover): string {
  const prompt =
    cover.prompt.length > CANDIDATE_PROMPT_CHARS
      ? `${cover.prompt.slice(0, CANDIDATE_PROMPT_CHARS - 1)}…`
      : cover.prompt
  return `\nNewest visual result: ${cover.source} produced for "${prompt}".\n`
}

function sessionTitle(file: SessionFile, entries: HistoryEntry[]): string {
  if (file.title.trim()) return file.title
  const first = entries[0]
  return first ? autoTitle(first) : TITLE_FALLBACK
}

type PromptPass = { prompt: string; final: boolean }

/** Every prompt this update sends: chunk reads first, then one answer to store. */
export function overviewSummaryPrompts(
  title: string,
  entries: HistoryEntry[],
  language: string,
  candidate?: OverviewCover,
): PromptPass[] {
  const blocks = entries.map(entryText)
  const total = blocks.reduce((sum, block) => sum + block.length + 1, 0)
  const header = `Session title: ${title}\nReply language: ${language}\n`
  if (total <= OVERVIEW_SUMMARY_CHUNK_CHARS) {
    return [
      {
        prompt:
          `${SINGLE_INSTRUCTION}${header}\nHistory Entries (oldest first):\n${blocks.join('\n')}` +
          (candidate ? candidateText(candidate) : '') +
          FORMAT_INSTRUCTION,
        final: true,
      },
    ]
  }
  const chunks = chunkInto(blocks, OVERVIEW_SUMMARY_CHUNK_CHARS)
  const passes: PromptPass[] = chunks.map((chunk, index) => ({
    prompt:
      `${CHUNK_INSTRUCTION}${header}Part ${index + 1} of ${chunks.length}.\n\n` + chunk.join('\n'),
    final: false,
  }))
  passes.push({
    prompt:
      `${COMBINE_INSTRUCTION}${header}\n` +
      chunks.map((_chunk, index) => `Part ${index + 1} summary:`).join('\n') +
      '\n{CHUNK_SUMMARIES}' +
      (candidate ? candidateText(candidate) : '') +
      FORMAT_INSTRUCTION,
    final: true,
  })
  return passes
}

/** The incremental form: the previous account plus only the entries it does not cover. */
export function incrementalOverviewSummaryPrompts(
  title: string,
  previousText: string,
  entries: HistoryEntry[],
  language: string,
  candidate?: OverviewCover,
): PromptPass[] {
  const blocks = entries.map(entryText)
  const total = blocks.reduce((sum, block) => sum + block.length + 1, 0)
  const header =
    `Session title: ${title}\nReply language: ${language}\n\n` +
    `Current account:\n${previousText}\n`
  if (total <= OVERVIEW_SUMMARY_CHUNK_CHARS) {
    return [
      {
        prompt:
          `${INCREMENTAL_INSTRUCTION}${header}\nHistory Entries the account does not cover ` +
          `(oldest first):\n${blocks.join('\n')}` +
          (candidate ? candidateText(candidate) : '') +
          FORMAT_INSTRUCTION,
        final: true,
      },
    ]
  }
  const chunks = chunkInto(blocks, OVERVIEW_SUMMARY_CHUNK_CHARS)
  const passes: PromptPass[] = chunks.map((chunk, index) => ({
    prompt:
      `${CHUNK_INSTRUCTION}${header}Part ${index + 1} of ${chunks.length}.\n\n` + chunk.join('\n'),
    final: false,
  }))
  passes.push({
    prompt:
      `${COMBINE_INCREMENTAL_INSTRUCTION}${header}\n` +
      chunks.map((_chunk, index) => `Part ${index + 1} summary:`).join('\n') +
      '\n{CHUNK_SUMMARIES}' +
      (candidate ? candidateText(candidate) : '') +
      FORMAT_INSTRUCTION,
    final: true,
  })
  return passes
}

function capSummary(text: string): string {
  const trimmed = text.replace(/\r\n/g, '\n').trim()
  return trimmed.length > OVERVIEW_SUMMARY_MAX_CHARS
    ? `${trimmed.slice(0, OVERVIEW_SUMMARY_MAX_CHARS - 1)}…`
    : trimmed
}

function modelNameOf(model: ChatModelConfig): string {
  return model.readiness?.llmModelName ?? model.modelId
}

/** Summaries are local work: a cloud setup, or a local backend with no model, sends no model. */
function localModelOf(request: OverviewSummaryRequest): ChatModelConfig | null {
  const model = request.model
  if (!model || model.backend === 'cloud' || !model.readiness?.llmModelName) return null
  return model
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
  const relative = path.relative(sessionPaths(sessionId).artifactRoot, cover.path)
  const inside =
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : null
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

type UpdateRunResult = { summary: OverviewSummary; tokens?: number }

async function performUpdate(
  sessionId: string,
  request: OverviewSummaryRequest,
  run: ActiveRun,
  admitted: boolean,
): Promise<UpdateRunResult | null> {
  const model = localModelOf(request)
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
    model: modelNameOf(model),
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

function startUpdate(sessionId: string, request: OverviewSummaryRequest): void {
  if (!localModelOf(request)) return
  const run = beginRun(sessionId)
  void performUpdate(sessionId, request, run, false)
    .catch((error: unknown) => {
      if (run.controller.signal.aborted) return null
      return failUpdate(sessionId, run.token, error, request.language)
    })
    .finally(() => {
      if (activeRuns.get(sessionId)?.token === run.token) activeRuns.delete(sessionId)
    })
}

/** What one settled turn's Overview Summary update did, for its History Entry. */
export type OverviewSummaryUpdateOutcome = {
  state: 'ready' | 'failed'
  summary: OverviewSummary
  durationMs: number
  tokens?: number
  failureReason?: string
}

/** The History Entry outcome a settled update records, for the turn's details row. */
export function overviewOutcomePatch(outcome: OverviewSummaryUpdateOutcome): OverviewSummaryUpdate {
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
  request: OverviewSummaryRequest,
  external?: AbortSignal,
  options: { admitted?: boolean } = {},
): Promise<OverviewSummaryUpdateOutcome | null> {
  const startedAt = Date.now()
  const file = await readSession(sessionId).catch(() => null)
  if (!file?.includedInOverviews) return null
  if (!localModelOf(request)) {
    await markPending(sessionId)
    return null
  }
  const entries = await readHistoryEntries(sessionId)
  if (entries.length === 0) return null

  const run = beginRun(sessionId)
  const onAbort = () => run.controller.abort()
  external?.addEventListener('abort', onAbort, { once: true })
  if (external?.aborted) run.controller.abort()
  try {
    await markPendingForRun(sessionId, run.token)
    const result = await performUpdate(sessionId, request, run, options.admitted === true)
    if (!result) return null
    return {
      state: 'ready',
      summary: result.summary,
      durationMs: Date.now() - startedAt,
      ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
    }
  } catch (error) {
    if (run.controller.signal.aborted) return null
    const summary = await failUpdate(sessionId, run.token, error, request.language)
    if (!summary) return null
    return {
      state: 'failed',
      summary,
      durationMs: Date.now() - startedAt,
      failureReason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    external?.removeEventListener('abort', onAbort)
    if (activeRuns.get(sessionId)?.token === run.token) activeRuns.delete(sessionId)
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

/** Enabling starts the first update; opting out cancels and deletes the summary. */
export async function applyOverviewInclusion(
  sessionId: string,
  included: boolean,
  request: OverviewSummaryRequest,
): Promise<SessionDocument> {
  if (!included) {
    cancelRun(sessionId)
    const file = await mutateSession(sessionId, (current) => {
      const { overviewSummary: _removed, ...rest } = current
      return { ...rest, includedInOverviews: false }
    })
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

  const localModel = localModelOf(request)
  if (!localModel) {
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
  request: OverviewSummaryRequest,
): Promise<SessionDocument> {
  const file = await readSession(sessionId)
  if (!file.includedInOverviews) return sessionDocumentOf(file)
  const entries = await readHistoryEntries(sessionId)
  if (entries.length === 0) return sessionDocumentOf(file)
  const localModel = localModelOf(request)
  if (!localModel) return markPending(sessionId, file.overviewSummary)
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
  request: OverviewSummaryRequest,
): Promise<SessionDocument> {
  const startedAt = Date.now()
  const file = await readSession(sessionId)
  if (!file.includedInOverviews) return sessionDocumentOf(file)
  const entries = await readHistoryEntries(sessionId)
  if (!entries.some((entry) => entry.id === entryId)) return sessionDocumentOf(file)
  if (!localModelOf(request)) return sessionDocumentOf(file)
  // The account keeps the language it was written in; a UI language change does not retranslate it.
  const retryRequest = { ...request, language: file.overviewSummary?.language ?? request.language }

  const retrying = await updateHistoryEntry(sessionId, entryId, {
    overviewUpdate: { state: 'pending' },
  })
  if (!retrying) return sessionDocumentOf(file)
  await markPending(sessionId, file.overviewSummary)

  const run = beginRun(sessionId)
  let patch: OverviewSummaryUpdate | null = null
  try {
    const result = await performUpdate(sessionId, retryRequest, run, false)
    if (result) {
      patch = overviewOutcomePatch({
        state: 'ready',
        summary: result.summary,
        durationMs: Date.now() - startedAt,
        ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
      })
    }
  } catch (error) {
    if (!run.controller.signal.aborted) {
      const summary = await failUpdate(sessionId, run.token, error, retryRequest.language)
      if (summary) {
        patch = overviewOutcomePatch({
          state: 'failed',
          summary,
          durationMs: Date.now() - startedAt,
          failureReason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } finally {
    if (activeRuns.get(sessionId)?.token === run.token) activeRuns.delete(sessionId)
  }

  if (patch) await recordOverviewOutcome(sessionId, patch, entryId)
  return sessionDocumentOf(await readSession(sessionId))
}

/**
 * Resumes the pending markers a crash left behind: every pending History Entry an
 * included Session still has is covered by one update, whose outcome then replaces
 * all of them. Nothing is retried unless a marker is pending, so a failure waits.
 */
export async function resumePendingOverviewUpdates(
  request: OverviewSummaryRequest,
): Promise<string[]> {
  const resumed: string[] = []
  if (!localModelOf(request)) return resumed
  const sessions = await listSessions()
  for (const session of sessions) {
    if (!session.includedInOverviews) continue
    const pending = (await readHistoryEntries(session.id)).filter(
      (entry) => entry.overviewUpdate?.state === 'pending',
    )
    if (pending.length === 0) continue

    const startedAt = Date.now()
    const file = await readSession(session.id).catch(() => null)
    if (!file?.includedInOverviews) continue
    const sessionRequest = {
      ...request,
      language: file.overviewSummary?.language ?? request.language,
    }
    const run = beginRun(session.id)
    let patch: OverviewSummaryUpdate | null = null
    try {
      const result = await performUpdate(session.id, sessionRequest, run, false)
      if (result) {
        patch = overviewOutcomePatch({
          state: 'ready',
          summary: result.summary,
          durationMs: Date.now() - startedAt,
          ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
        })
      }
    } catch (error) {
      if (!run.controller.signal.aborted) {
        const summary = await failUpdate(session.id, run.token, error, sessionRequest.language)
        if (summary) {
          patch = overviewOutcomePatch({
            state: 'failed',
            summary,
            durationMs: Date.now() - startedAt,
            failureReason: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      if (activeRuns.get(session.id)?.token === run.token) activeRuns.delete(session.id)
    }

    if (!patch) continue
    await recordOverviewOutcome(session.id, patch)
    resumed.push(session.id)
  }
  return resumed
}
