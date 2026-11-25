import path from 'node:path'
import { emitFailure, emitSessionChanged } from '../kernel/kernelBus'
import { appLoggerInstance } from '../observability/logger'
import { artifactReferenceOf } from './historyArtifacts'
import { createRecordsLookup, newestVisualCover, type OverviewCover } from './overviewCovers'
import { readHistoryEntries } from './sessionHistory'
import { mutateSession, readSession, sessionDocumentOf, sessionPaths } from './sessions'
import { readSessionFolders } from './sessionFolders'
import { autoTitle } from './sessionTitle'
import type { ChatModelConfig } from '@/types/chatIpc'
import type {
  HistoryEntry,
  OverviewSummary,
  OverviewSummaryPicture,
  OverviewSummaryRequest,
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

async function performUpdate(
  sessionId: string,
  request: OverviewSummaryRequest,
  run: ActiveRun,
): Promise<void> {
  const model = localModelOf(request)
  if (!model) return
  const file = await readSession(sessionId)
  if (!file.includedInOverviews) return
  const entries = await readHistoryEntries(sessionId)
  if (entries.length === 0) return
  if (!completeImpl) {
    appLoggerInstance.warn(
      `Overview Summary update has no model runner wired (${sessionId})`,
      'sessions',
    )
    return
  }

  const list = await readSessionFolders(sessionId)
  const cover = await newestVisualCover(sessionId, file, list, entries, createRecordsLookup())
  const title = sessionTitle(file, entries)
  const passes = overviewSummaryPrompts(title, entries, request.language, cover ?? undefined)
  const chunkSummaries: string[] = []
  let finalText = ''
  let pictureMatches = false

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
    })
    if (!isCurrentRun(sessionId, run.token) || run.controller.signal.aborted) return
    if (pass.final) {
      finalText = completion.text
      pictureMatches = completion.pictureMatches
    } else {
      chunkSummaries.push(completion.text)
    }
  }

  const newest = entries.at(-1)
  if (!newest) return
  const summary: OverviewSummary = {
    state: 'ready',
    text: capSummary(finalText),
    coveredEntryId: newest.id,
    model: modelNameOf(model),
    language: request.language,
    contractVersion: OVERVIEW_SUMMARY_CONTRACT_VERSION,
    writtenAt: Date.now(),
    ...(pictureMatches && cover ? { picture: pictureOf(sessionId, cover, list) } : {}),
  }
  await writeSummary(sessionId, run.token, summary)
}

async function failUpdate(
  sessionId: string,
  token: number,
  error: unknown,
  language: string,
): Promise<void> {
  if (!isCurrentRun(sessionId, token)) return
  const reason = error instanceof Error ? error.message : String(error)
  const file = await readSession(sessionId).catch(() => null)
  if (!file || !file.includedInOverviews) return
  const previous = file.overviewSummary
  await writeSummary(sessionId, token, {
    ...(previous ?? { contractVersion: OVERVIEW_SUMMARY_CONTRACT_VERSION }),
    state: 'failed',
    failureReason: reason,
    language,
    contractVersion: previous?.contractVersion ?? OVERVIEW_SUMMARY_CONTRACT_VERSION,
  })
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
}

function startUpdate(sessionId: string, request: OverviewSummaryRequest): void {
  if (!localModelOf(request)) return
  const run = beginRun(sessionId)
  void performUpdate(sessionId, request, run)
    .catch((error: unknown) => {
      if (run.controller.signal.aborted) return
      return failUpdate(sessionId, run.token, error, request.language)
    })
    .finally(() => {
      if (activeRuns.get(sessionId)?.token === run.token) activeRuns.delete(sessionId)
    })
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

/** Run the same update again without a turn (a Retry, or a refresh after a failure). */
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
