import { OVERVIEW_SUMMARY_CHUNK_TOKENS, OVERVIEW_SUMMARY_MAX_CHARS } from './overviewContract'
import type { OverviewCover } from './overviewCovers'
import { autoTitle } from './sessionTitle'
import type { HistoryEntry, SessionFile } from '@/types/sessionIpc'

// The prompts an Overview Summary update sends: fixed instructions, the Session's
// Title and History Entries, the optional picture judgement, and the token-budget
// chunking that keeps a long history inside one prompt pass.

const ENTRY_RESPONSE_CHARS = 1200
const CANDIDATE_PROMPT_CHARS = 800

const TITLE_FALLBACK = 'Untitled Session'

const SUMMARY_RULES =
  `Write two to four sentences, at most ${OVERVIEW_SUMMARY_MAX_CHARS} characters, saying what ` +
  'this Session is about and what it has done. Include failures and results. Never list turns ' +
  'or transcribe the transcript.'

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

/**
 * No tokenizer is available in main, so a token is approximated as four characters
 * (the usual English ratio). It is a budget, not a hard limit.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function chunkInto(blocks: string[], budgetTokens: number): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let size = 0
  for (const block of blocks) {
    const tokens = estimateTokens(block) + 1
    if (current.length > 0 && size + tokens > budgetTokens) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(block)
    size += tokens
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

export function sessionTitle(file: SessionFile, entries: HistoryEntry[]): string {
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
  const total = blocks.reduce((sum, block) => sum + estimateTokens(block) + 1, 0)
  const header = `Session title: ${title}\nReply language: ${language}\n`
  if (total <= OVERVIEW_SUMMARY_CHUNK_TOKENS) {
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
  const chunks = chunkInto(blocks, OVERVIEW_SUMMARY_CHUNK_TOKENS)
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
  const total = blocks.reduce((sum, block) => sum + estimateTokens(block) + 1, 0)
  const header =
    `Session title: ${title}\nReply language: ${language}\n\n` +
    `Current account:\n${previousText}\n`
  if (total <= OVERVIEW_SUMMARY_CHUNK_TOKENS) {
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
  const chunks = chunkInto(blocks, OVERVIEW_SUMMARY_CHUNK_TOKENS)
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
