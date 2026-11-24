import fs from 'node:fs/promises'
import path from 'node:path'
import { nativeImage } from 'electron'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  collectOverviewData,
  type OverviewData,
  type OverviewSessionData,
} from '../../session/overviewData.ts'
import { OVERVIEW_NAMED_RANGES, type OverviewRangeInput } from '../../session/overviewRange.ts'
import {
  overviewFileName,
  renderOverviewHtml,
  type OverviewDocument,
} from '../../session/overviewHtml.ts'
import { resolvePreviewUrl, sameFolder, workspacePreviewRoot } from '../piWorkspaceRuntime.ts'
import { jsonResult, jsonSchemaParameters, textResult } from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import { isRecord } from '@/lib/isRecord'
import type { AgentCapability, CapabilityHost } from './types.ts'
import { OVERVIEW_CAPABILITY_ID } from '@/types/agentCapabilities'
import type { OverviewChrome } from '@/types/overviewChrome'

// One range in, the included Sessions' History out, and one HTML file back.

const OVERVIEW_DATA_TOOL = 'overview_data'
const OVERVIEW_WRITE_TOOL = 'overview_write'

/** One Session's summary is aimed at two to four sentences and never longer than this. */
export const OVERVIEW_SUMMARY_CAP = 600

const RANGE_SCHEMA: Record<string, unknown> = {
  description:
    'The window to report on: one of the named ranges, or an explicit window. ' +
    '"last-24h" rolls back 24 hours from now; "today" and "yesterday" are local calendar ' +
    'days; "last-7-days" and "last-30-days" start at local midnight. An explicit window ' +
    'takes local dates (YYYY-MM-DD) or ISO timestamps, includes "from" and excludes "to".',
  anyOf: [
    { type: 'string', enum: [...OVERVIEW_NAMED_RANGES] },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: 'Start of the window, inclusive.' },
        to: { type: 'string', description: 'End of the window, exclusive.' },
      },
      required: ['from', 'to'],
    },
  ],
}

const OVERVIEW_DATA_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: { range: RANGE_SCHEMA },
  required: ['range'],
}

const OVERVIEW_WRITE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    range: RANGE_SCHEMA,
    summaries: {
      type: 'object',
      description:
        'One short summary per Session the Overview shows, keyed by that Session’s id from ' +
        '`overview_data`: a few sentences (two to four, at most 600 characters) saying what the ' +
        'Session did in the range. Every shown Session needs one; there is no opening paragraph.',
      additionalProperties: { type: 'string' },
    },
    covers: {
      type: 'object',
      description:
        'Optional. Maps a Session id from `overview_data` to one of the cover paths it returned ' +
        'for that Session, to choose the picture that fits what you wrote. Leave a Session out ' +
        'and its newest picture is used. A path from another Session, from outside the range, ' +
        'or a Session the Overview does not show is refused.',
      additionalProperties: { type: 'string' },
    },
  },
  required: ['range', 'summaries'],
}

function overviewMissingSession(): string {
  return (
    'This turn is not attached to a Session, so it cannot leave its own Session out of the ' +
    'Overview. Start the Overview from a Session rather than a Trial Run, then try again.'
  )
}

function overviewMissingChrome(): string {
  return (
    'The Overview language did not reach this turn. Ask again from the desktop app so its ' +
    'strings can be resolved for your language.'
  )
}

function rangeOf(value: unknown): OverviewRangeInput | null {
  if (typeof value === 'string') {
    return (OVERVIEW_NAMED_RANGES as readonly string[]).includes(value)
      ? (value as OverviewRangeInput)
      : null
  }
  if (isRecord(value) && typeof value.from === 'string' && typeof value.to === 'string') {
    return { from: value.from, to: value.to }
  }
  return null
}

function invalidRange(): string {
  return (
    `"range" must be one of ${OVERVIEW_NAMED_RANGES.join(', ')} or an object with ` +
    '"from" and "to" (local dates or ISO timestamps).'
  )
}

function overviewOf(
  data: OverviewData,
  summaries: ReadonlyMap<string, string>,
  chrome: OverviewChrome,
  pictures: Map<string, string>,
): OverviewDocument {
  return {
    window: data.window,
    locale: chrome.locale,
    sessions: data.sessions.map((session) => {
      const picture = pictures.get(session.id)
      return {
        title: session.title,
        summary: summaries.get(session.id) ?? '',
        ...(picture ? { picture } : {}),
      }
    }),
    shownEntries: data.sessions.reduce((sum, session) => sum + session.entries.length, 0),
    totalEntries: data.totalEntries,
    truncated: data.truncated,
  }
}

function sessionLabel(session: { id: string; title: string }): string {
  return session.title.trim() ? `"${session.title}" (${session.id})` : session.id
}

type SummarySelection =
  { ok: true; bySession: Map<string, string> } | { ok: false; message: string }

/**
 * Exactly one usable summary per shown Session: no filler, no transcript, no
 * summary for a Session this range did not show.
 */
function summarySelectionOf(data: OverviewData, value: unknown): SummarySelection {
  if (!isRecord(value) || Array.isArray(value)) {
    return {
      ok: false,
      message:
        '"summaries" must map each Session id from `overview_data` to the text you wrote for ' +
        'that Session. Nothing was written.',
    }
  }
  const bySession = new Map<string, string>()
  const unknown: string[] = []
  const missing: OverviewSessionData[] = []
  const blank: OverviewSessionData[] = []
  const tooLong: OverviewSessionData[] = []
  for (const session of data.sessions) {
    const raw = value[session.id]
    if (raw === undefined || typeof raw !== 'string') {
      missing.push(session)
      continue
    }
    const text = raw.trim()
    if (!text) blank.push(session)
    else if (text.length > OVERVIEW_SUMMARY_CAP) tooLong.push(session)
    else bySession.set(session.id, text)
  }
  for (const sessionId of Object.keys(value)) {
    if (!data.sessions.some((session) => session.id === sessionId)) unknown.push(sessionId)
  }

  const problems: string[] = []
  if (missing.length > 0) {
    problems.push(`no summary for ${missing.map(sessionLabel).join(', ')}`)
  }
  if (blank.length > 0) {
    problems.push(`an empty summary for ${blank.map(sessionLabel).join(', ')}`)
  }
  if (tooLong.length > 0) {
    problems.push(
      `a summary over ${OVERVIEW_SUMMARY_CAP} characters for ${tooLong
        .map(sessionLabel)
        .join(', ')}`,
    )
  }
  if (unknown.length > 0) {
    problems.push(
      `a summary for no Session in this Overview: ${unknown.map((id) => `"${id}"`).join(', ')}`,
    )
  }
  if (problems.length === 0) return { ok: true, bySession }
  return {
    ok: false,
    message:
      `The Overview cannot be written: it needs one summary per Session it shows, and the ` +
      `request has ${problems.join('; ')}. A summary is two to four sentences, at most ` +
      `${OVERVIEW_SUMMARY_CAP} characters. Nothing was written; fix those Sessions and call ` +
      'overview_write again.',
  }
}

type CoverSelection = { ok: true; bySession: Map<string, string> } | { ok: false; message: string }

/** Only a path this range's data result offered for that Session may be chosen. */
function coverSelectionOf(data: OverviewData, value: unknown): CoverSelection {
  if (value === undefined || value === null) return { ok: true, bySession: new Map() }
  if (!isRecord(value) || Array.isArray(value)) {
    return {
      ok: false,
      message:
        '"covers" must be an object mapping a Session id to one of the picture paths ' +
        '`overview_data` returned for that Session. Leave it out to use each Session’s newest picture.',
    }
  }
  const bySession = new Map<string, string>()
  for (const [sessionId, chosen] of Object.entries(value)) {
    if (typeof chosen !== 'string') {
      return {
        ok: false,
        message: `The picture for Session "${sessionId}" must be one of the paths overview_data returned.`,
      }
    }
    const session = data.sessions.find((candidate) => candidate.id === sessionId)
    if (!session) {
      const offered = data.sessions.map((entry) => `"${entry.title}" (${entry.id})`).join(', ')
      return {
        ok: false,
        message:
          `No Session "${sessionId}" is in this Overview, so its picture cannot be used. ` +
          (offered
            ? `Choose among the Sessions overview_data returned: ${offered}.`
            : 'Do not pass a picture for it.'),
      }
    }
    if (session.covers.some((candidate) => candidate.path === chosen)) {
      bySession.set(sessionId, chosen)
      continue
    }
    const owner = data.sessions.find((candidate) =>
      candidate.covers.some((cover) => cover.path === chosen),
    )
    if (owner) {
      return {
        ok: false,
        message:
          `That picture ("${chosen}") belongs to "${owner.title}", not "${session.title}". ` +
          `Pick one of "${session.title}"’s paths from overview_data, or leave it out to use ` +
          'its newest picture.',
      }
    }
    if (session.covers.length === 0) {
      return {
        ok: false,
        message:
          `"${session.title}" has no picture candidate in this range, so "${chosen}" cannot be used. ` +
          'Leave it out and the Session will have no picture.',
      }
    }
    return {
      ok: false,
      message:
        `"${session.title}" has no candidate at "${chosen}". Choose one of the paths ` +
        `overview_data returned for it (${session.covers.map((cover) => cover.path).join(', ')}), ` +
        'or leave it out to use its newest picture.',
    }
  }
  return { ok: true, bySession }
}

/** The live preview URL, but only when that server is serving the folder the file went into. */
function previewUrlOf(workspaceDir: string, fileName: string): string | undefined {
  const root = workspacePreviewRoot()
  return root && sameFolder(root, workspaceDir) ? resolvePreviewUrl(fileName) : undefined
}

/** Longest edge a Session's picture is scaled to before it is inlined. */
export const OVERVIEW_PICTURE_EDGE = 480

/** Encoded bytes one page may carry in total; later Sessions lose their pictures past it. */
export const OVERVIEW_PICTURE_BUDGET_BYTES = 4 * 1024 * 1024

async function pictureDataUri(filePath: string): Promise<string | null> {
  try {
    const decoded = nativeImage.createFromBuffer(await fs.readFile(filePath))
    if (decoded.isEmpty()) return null
    const { width, height } = decoded.getSize()
    const picture =
      Math.max(width, height) > OVERVIEW_PICTURE_EDGE
        ? decoded.resize(
            width >= height ? { width: OVERVIEW_PICTURE_EDGE } : { height: OVERVIEW_PICTURE_EDGE },
          )
        : decoded
    const dataUri = picture.toDataURL()
    return dataUri.startsWith('data:image/') ? dataUri : null
  } catch {
    return null
  }
}

type OverviewPictures = { bySession: Map<string, string>; omitted: number }

/**
 * Each Session's newest usable candidate, newest-updated Session first. Once the
 * page budget binds nothing later is decoded, so a wide range stays a small file.
 */
async function resolvePictures(
  sessions: readonly OverviewSessionData[],
  chosen: ReadonlyMap<string, string>,
): Promise<OverviewPictures> {
  const bySession = new Map<string, string>()
  let remaining = OVERVIEW_PICTURE_BUDGET_BYTES
  let budgetBound = false
  let omitted = 0
  for (const session of sessions) {
    const wanted = chosen.get(session.id)
    const candidate =
      (wanted && session.covers.find((cover) => cover.path === wanted)) || session.covers[0]
    if (!candidate) continue
    if (budgetBound) {
      omitted += 1
      continue
    }
    const dataUri = await pictureDataUri(candidate.path)
    if (!dataUri) continue
    const size = Buffer.byteLength(dataUri)
    if (size > remaining) {
      budgetBound = true
      omitted += 1
      continue
    }
    remaining -= size
    bySession.set(session.id, dataUri)
  }
  return { bySession, omitted }
}

async function buildOverviewTools(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    pi.defineTool({
      name: OVERVIEW_DATA_TOOL,
      label: OVERVIEW_DATA_TOOL,
      description:
        'Read the turns that happened in a time range across the Sessions the user marked ' +
        '"Included in Overviews". Returns the resolved window, each included Session that has ' +
        'turns in it with those turns newest first, per-Session totals and truncation, and the ' +
        'pictures that could represent each Session. Sessions without the switch never appear, ' +
        'and neither does the Session asking. Call it before writing anything, and quote the ' +
        'resolved window and any truncation in your answer.',
      parameters: jsonSchemaParameters(OVERVIEW_DATA_SCHEMA),
      execute: async (_toolCallId, params) => {
        if (!host.sessionRef) return textResult(overviewMissingSession())
        const { range } = params as { range?: unknown }
        const input = rangeOf(range)
        if (!input) return textResult(invalidRange())
        try {
          const data = await collectOverviewData({
            range: input,
            excludingSessionId: host.sessionRef,
          })
          return jsonResult(data)
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error))
        }
      },
    }) as ToolDefinition,
    pi.defineTool({
      name: OVERVIEW_WRITE_TOOL,
      label: OVERVIEW_WRITE_TOOL,
      description:
        'Render the Overview for a time range and write it into this Session’s Workspace as ' +
        'one self-contained HTML file, then return its link. Call it after `overview_data`, ' +
        'with the same range, a `summaries` object holding one short summary for every Session ' +
        'the Overview shows (a few sentences each, at most 600 characters), and optionally ' +
        '`covers` to pick each Session’s picture that fits the text (a Session left out uses ' +
        'its newest picture). It re-reads the range itself, so you cannot disagree with the ' +
        'page, and it refuses a missing or over-long summary, naming the Sessions, without ' +
        'writing anything. It accepts no picture it did not offer for that Session. When the ' +
        'range has nothing to show it writes no file and tells you why. Never write the HTML ' +
        'yourself: this tool owns the page.',
      parameters: jsonSchemaParameters(OVERVIEW_WRITE_SCHEMA),
      execute: async (_toolCallId, params) => {
        if (!host.sessionRef) return textResult(overviewMissingSession())
        const { range, summaries, covers } = params as {
          range?: unknown
          summaries?: unknown
          covers?: unknown
        }
        const input = rangeOf(range)
        if (!input) return textResult(invalidRange())
        const chrome = host.overviewChrome
        if (!chrome) return textResult(overviewMissingChrome())
        try {
          const data = await collectOverviewData({
            range: input,
            excludingSessionId: host.sessionRef,
          })
          if (data.outcome !== 'ok') {
            return jsonResult({
              written: false,
              outcome: data.outcome,
              window: data.window,
              message: data.message,
            })
          }
          const summarySelection = summarySelectionOf(data, summaries)
          if (!summarySelection.ok) return textResult(summarySelection.message)
          const selection = coverSelectionOf(data, covers)
          if (!selection.ok) return textResult(selection.message)
          const pictures = await resolvePictures(data.sessions, selection.bySession)
          const overview = overviewOf(data, summarySelection.bySession, chrome, pictures.bySession)
          const fileName = overviewFileName(data.window)
          await fs.mkdir(host.workspaceDir, { recursive: true })
          await fs.writeFile(
            path.join(host.workspaceDir, fileName),
            renderOverviewHtml(overview, chrome),
            'utf8',
          )
          const url = previewUrlOf(host.workspaceDir, fileName)
          return jsonResult({
            written: true,
            path: fileName,
            ...(url ? { url } : {}),
            window: data.window,
            sessions: data.sessions.length,
            sessionsOmitted: data.sessionsOmitted,
            shownEntries: overview.shownEntries,
            totalEntries: overview.totalEntries,
            truncated: overview.truncated,
            pictures: pictures.bySession.size,
            picturesOmitted: pictures.omitted,
          })
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error))
        }
      },
    }) as ToolDefinition,
  ]
}

export const overviewCapability: AgentCapability = {
  id: OVERVIEW_CAPABILITY_ID,
  label: 'Overviews',
  summary:
    'Reads the turns and results of the Sessions marked "Included in Overviews" over a time ' +
    'range and writes the Overview as one HTML file in this Session’s Workspace. Activate it ' +
    'when the user asks what happened across their Sessions.',
  buildTools: buildOverviewTools,
  // The data call is the first step of the whole task; deferring it would cost a
  // round trip before anything else can happen.
  lazyEligible: false,
}
