import fs from 'node:fs/promises'
import path from 'node:path'
import { nativeImage } from 'electron'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { selectOverviewSessions, type OverviewSessionCard } from '../../session/overviewData.ts'
import {
  OVERVIEW_MAX_LAST_HOURS,
  OVERVIEW_NAMED_RANGES,
  OverviewRangeError,
  type OverviewRangeInput,
  type OverviewWindow,
} from '../../session/overviewRange.ts'
import {
  overviewFileName,
  renderOverviewHtml,
  type OverviewSection,
} from '../../session/overviewHtml.ts'
import { resolvePreviewUrl, sameFolder, workspacePreviewRoot } from '../piWorkspaceRuntime.ts'
import { jsonResult, jsonSchemaParameters, textResult } from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import { isRecord } from '@/lib/isRecord'
import { appLoggerInstance } from '../../observability/logger.ts'
import type { AgentCapability, CapabilityHost } from './types.ts'
import { OVERVIEW_CAPABILITY_ID } from '@/types/agentCapabilities'

// One range in, the included Sessions' stored summaries out, and one HTML file back.

const OVERVIEW_TOOL = 'overview'

/**
 * Flat on purpose: a local model's grammar handles three sibling fields far better
 * than an `anyOf`, so the window is given as `range`, or `lastHours`, or `from`+`to`.
 */
const RANGE_PROPERTIES: Record<string, unknown> = {
  range: {
    // Deliberately not an `enum`: a grammar-constrained model reads the sibling fields as a
    // kind tag ("range": "lastHours") and an enum turns that into a hard validation failure
    // it cannot learn from. An unknown value is ignored and the siblings are used.
    type: 'string',
    description:
      'The name of a range: "last-24h" (24 hours back from now), "today", "yesterday", ' +
      '"last-7-days" or "last-30-days" (those two start at local midnight). Leave it out when ' +
      'you pass lastHours or from+to; it is not a tag for which field you used.',
  },
  lastHours: {
    type: 'integer',
    minimum: 1,
    maximum: OVERVIEW_MAX_LAST_HOURS,
    description:
      'N whole hours back from now, up to now. Use this for "the last N hours"; do not compute ' +
      'or pass timestamps for it.',
  },
  from: {
    type: 'string',
    description:
      'Start of an explicit window, inclusive: a local date (YYYY-MM-DD) or an ISO timestamp. ' +
      'Use only with to.',
  },
  to: {
    type: 'string',
    description:
      'End of an explicit window, exclusive: a local date (YYYY-MM-DD) or an ISO timestamp. ' +
      'Use only with from.',
  },
}

const OVERVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: { ...RANGE_PROPERTIES },
}

function overviewMissingSession(): string {
  return (
    'This turn is not attached to a Session, so it has no Workspace to write the Overview into ' +
    'and no Session to leave out of it. Start the Overview from a Session rather than a Trial ' +
    'Run, then try again.'
  )
}

function overviewMissingChrome(): string {
  return (
    'The Overview language did not reach this turn. Ask again from the desktop app so its ' +
    'strings can be resolved for your language.'
  )
}

/** Parse a JSON-encoded window a model occasionally sends instead of an object. */
function jsonObjectOf(value: string): Record<string, unknown> | null {
  if (!value.trim().startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** A whole hour count, tolerating the string a model sometimes sends for a number. */
function hoursOf(value: unknown): number | null {
  const hours = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  const whole =
    typeof hours === 'number' &&
    Number.isInteger(hours) &&
    hours >= 1 &&
    hours <= OVERVIEW_MAX_LAST_HOURS
  return whole ? (hours as number) : null
}

function namedRangeOf(value: string): OverviewRangeInput | null {
  const key = value.trim().toLowerCase()
  return (OVERVIEW_NAMED_RANGES as readonly string[]).includes(key)
    ? (key as OverviewRangeInput)
    : null
}

function rangeOf(value: unknown): OverviewRangeInput | null {
  if (typeof value === 'string') {
    const named = namedRangeOf(value)
    if (named) return named
    const parsed = jsonObjectOf(value)
    return parsed ? rangeOf(parsed) : null
  }
  if (isRecord(value) && value.lastHours !== undefined) {
    const hours = hoursOf(value.lastHours)
    return hours === null ? null : { lastHours: hours }
  }
  if (isRecord(value) && typeof value.from === 'string' && typeof value.to === 'string') {
    return { from: value.from, to: value.to }
  }
  return null
}

/** The window as the tool's arguments carry it: the flat fields, or one `range` value. */
function rangeOfParams(params: Record<string, unknown>): OverviewRangeInput | null {
  // `range` may be a name, or a model's kind tag ("lastHours") beside the real fields;
  // an unrecognised value simply falls through to them.
  const viaRange = rangeOf(params.range)
  if (viaRange) return viaRange
  const hours = hoursOf(params.lastHours)
  if (hours !== null) return { lastHours: hours }
  if (typeof params.from === 'string' && typeof params.to === 'string') {
    return { from: params.from, to: params.to }
  }
  return null
}

function invalidRange(): string {
  return (
    'Name the window as `range` (one of ' +
    OVERVIEW_NAMED_RANGES.join(', ') +
    '), or `lastHours` (a whole number from 1 to ' +
    OVERVIEW_MAX_LAST_HOURS +
    ', which is how "the last N hours" is asked for), or `from` and `to` (local dates or ISO ' +
    'timestamps). Never compute timestamps: lastHours already covers a number of hours.'
  )
}

/** The window in the reader's language, so the agent never has to convert timestamps. */
function windowLabelOf(window: OverviewWindow, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  return `${format.format(window.from)} – ${format.format(window.to)}`
}

/**
 * A wrong range is the caller's to fix; anything else is ours. Saying so stops a
 * model retrying the same call with different fields, which it otherwise assumes
 * is the remedy.
 */
function toolFailure(error: unknown): string {
  if (error instanceof OverviewRangeError) return error.message
  const detail = error instanceof Error ? error.message : String(error)
  appLoggerInstance.error(
    `${OVERVIEW_TOOL} failed: ${error instanceof Error ? (error.stack ?? detail) : detail}`,
    'overviews',
  )
  return (
    `The Overview could not be completed because of an internal error in the app (${detail}). ` +
    'This is not something a different range or different arguments will fix: tell the user the ' +
    'app hit a bug, and do not keep retrying.'
  )
}

/** The live preview URL, but only when that server is serving the folder the file went into. */
function previewUrlOf(workspaceDir: string, fileName: string): string | undefined {
  const root = workspacePreviewRoot()
  return root && sameFolder(root, workspaceDir) ? resolvePreviewUrl(fileName) : undefined
}

/** Longest edge a Session's picture is scaled to before it is inlined. */
const OVERVIEW_PICTURE_EDGE = 480
/** Encoded bytes one page may carry in total; later Sessions lose their pictures past it. */
const OVERVIEW_PICTURE_BUDGET_BYTES = 4 * 1024 * 1024

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

/**
 * Each card's stored picture, newest Session first. Once the page budget binds
 * nothing later is decoded, so a wide range stays a small file; a missing or
 * undecodable file is simply that card without a picture.
 */
async function sectionsWithPictures(
  sessions: readonly OverviewSessionCard[],
): Promise<OverviewSection[]> {
  let remaining = OVERVIEW_PICTURE_BUDGET_BYTES
  let budgetBound = false
  const sections: OverviewSection[] = []
  for (const session of sessions) {
    let picture: string | undefined
    if (session.picturePath && !budgetBound) {
      const dataUri = await pictureDataUri(session.picturePath)
      if (dataUri) {
        const size = Buffer.byteLength(dataUri)
        if (size <= remaining) {
          remaining -= size
          picture = dataUri
        } else {
          budgetBound = true
        }
      }
    }
    sections.push({
      title: session.title,
      summary: session.summary,
      icon: session.icon,
      ...(picture ? { picture } : {}),
    })
  }
  return sections
}

async function buildOverviewTools(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    pi.defineTool({
      name: OVERVIEW_TOOL,
      label: OVERVIEW_TOOL,
      description:
        'Write one Overview of the Sessions the user marked "Included in Overviews" that were ' +
        'active in a time range. Translate the user’s timeframe into the range fields and call ' +
        'this once; the app resolves the window, chooses every included Session active in it, ' +
        'leaves out the Session asking, and builds the page from each Session’s stored Overview ' +
        'Summary. Call it exactly once per request. It returns the resolved `window`, its ' +
        'reader-language `windowLabel`, the file’s workspace-relative `path`, and the live `url` ' +
        'when a preview server is serving the Workspace. When nothing is included, nothing is ' +
        'active in the window, or none of the active Sessions has a usable summary, it writes no ' +
        'file and returns `written: false` with the `outcome` and a `message`. It also reports the ' +
        '`omitted` Titles (active Sessions with no usable summary) and `behind` Titles (a summary ' +
        'that stops at an older entry) so you can relay what the page leaves out or marks. It ' +
        'never returns History Entries or summary text. Relay the window and the link unchanged; ' +
        'never summarise a Session, write markup, or compute a timestamp.',
      parameters: jsonSchemaParameters(OVERVIEW_SCHEMA),
      execute: async (_toolCallId, params) => {
        if (!host.sessionRef) return textResult(overviewMissingSession())
        const chrome = host.overviewChrome
        if (!chrome) return textResult(overviewMissingChrome())
        const input = rangeOfParams(params as Record<string, unknown>)
        if (!input) return textResult(invalidRange())
        try {
          const selection = await selectOverviewSessions({
            range: input,
            excludingSessionId: host.sessionRef,
          })
          const windowLabel = windowLabelOf(selection.window, chrome.locale)
          if (selection.outcome !== 'ok') {
            return jsonResult({
              written: false,
              outcome: selection.outcome,
              window: selection.window,
              windowLabel,
              ...(selection.omitted.length ? { omitted: selection.omitted } : {}),
              message: selection.message,
            })
          }
          const fileName = overviewFileName(selection.window)
          const sections = await sectionsWithPictures(selection.sessions)
          await fs.mkdir(host.workspaceDir, { recursive: true })
          await fs.writeFile(
            path.join(host.workspaceDir, fileName),
            renderOverviewHtml(
              {
                window: selection.window,
                locale: chrome.locale,
                sessions: sections,
                omitted: selection.omitted,
                behind: selection.behind,
              },
              chrome,
            ),
            'utf8',
          )
          const url = previewUrlOf(host.workspaceDir, fileName)
          return jsonResult({
            written: true,
            path: fileName,
            ...(url ? { url } : {}),
            window: selection.window,
            windowLabel,
            ...(selection.omitted.length ? { omitted: selection.omitted } : {}),
            ...(selection.behind.length ? { behind: selection.behind } : {}),
          })
        } catch (error) {
          return textResult(toolFailure(error))
        }
      },
    }) as ToolDefinition,
  ]
}

export const overviewCapability: AgentCapability = {
  id: OVERVIEW_CAPABILITY_ID,
  label: 'Overviews',
  summary:
    'Builds the Overview of the Sessions marked "Included in Overviews" from their stored ' +
    'summaries for a time range the user names, and writes it as one HTML file in this ' +
    'Session’s Workspace. Activate it when the user asks what happened across their Sessions.',
  buildTools: buildOverviewTools,
  // The one call is the whole task; deferring it would cost a round trip before anything
  // else can happen.
  lazyEligible: false,
}
