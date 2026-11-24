import { fillTemplate } from '@/lib/fillTemplate'
import type { OverviewChrome, OverviewChromeKey } from '@/types/overviewChrome'
import type { OverviewEntry } from './overviewData'
import type { OverviewWindow } from './overviewRange'

// The page: fixed template, code-owned layout, every interpolation escaped.

export type OverviewSection = {
  title: string
  entries: OverviewEntry[]
  totalEntries: number
  truncated: boolean
  /** A ready `data:image/…` URI, downscaled by the tool that read the file. */
  picture?: string
  /** How many picture candidates this Session offered before the cap. */
  shownCovers: number
  totalCovers: number
  coversTruncated: boolean
}

export type OverviewDocument = {
  window: OverviewWindow
  /** The language the chrome strings were resolved for. */
  locale: string
  opening: string
  /** The query's order: most recently updated Session first. */
  sessions: OverviewSection[]
  shownEntries: number
  /** Every turn in range, including those the Overview's line budget left out. */
  totalEntries: number
  /** Sessions with turns in range that the line budget left out entirely. */
  sessionsOmitted: number
  truncated: boolean
  openingTruncated?: { shown: number; total: number }
}

/** Longer opening paragraphs are cut off (the page says so). */
export const OVERVIEW_OPENING_CAP = 1200

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character])
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local calendar date, the one the file name and day grouping both use. */
export function overviewDate(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function overviewClock(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function overviewStamp(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getHours())}${pad(date.getMinutes())}`
}

function overviewDateTime(ms: number): string {
  return `${overviewDate(ms)} ${overviewClock(ms)}`
}

/** A date alone only when the bound is local midnight; otherwise the exact time too. */
function overviewBoundary(ms: number): string {
  const midnight = new Date(ms)
  midnight.setHours(0, 0, 0, 0)
  return midnight.getTime() === ms ? overviewDate(ms) : `${overviewDate(ms)}_${overviewStamp(ms)}`
}

export function overviewFileName(window: OverviewWindow): string {
  return `overview-${overviewBoundary(window.from)}..${overviewBoundary(window.to)}.html`
}

function chromeHtml(
  chrome: OverviewChrome,
  key: OverviewChromeKey,
  values: Record<string, string | number> = {},
): string {
  const escaped = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, escapeHtml(String(value))]),
  )
  return fillTemplate(chrome.strings[key], escaped)
}

function outcomeHtml(entry: OverviewEntry, chrome: OverviewChrome): string {
  const parts: string[] = []
  if (entry.status === 'failed') {
    parts.push(`<span class="status">${chromeHtml(chrome, 'OVERVIEW_STATUS_FAILED')}</span>`)
  } else if (entry.status === 'cancelled') {
    parts.push(`<span class="status">${chromeHtml(chrome, 'OVERVIEW_STATUS_CANCELLED')}</span>`)
  }
  if (entry.artifacts.length > 0) {
    parts.push(
      `<span class="artifacts">${entry.artifacts
        .map((artifact) => `<span class="artifact">${escapeHtml(artifact.path)}</span>`)
        .join(', ')}</span>`,
    )
  } else if (entry.response) {
    parts.push(`<span class="response">${escapeHtml(entry.response)}</span>`)
  }
  return parts.join(' ')
}

function turnLine(entry: OverviewEntry, chrome: OverviewChrome, sessionTitle?: string): string {
  const label = entry.agent ?? entry.preset
  const session = sessionTitle ? `<span class="session">${escapeHtml(sessionTitle)}</span> ` : ''
  const outcome = outcomeHtml(entry, chrome)
  return (
    `<li class="turn">${session}<time>${overviewClock(entry.time)}</time> ` +
    `<span class="label">${escapeHtml(label)}</span> ` +
    `<span class="prompt">${escapeHtml(entry.prompt)}</span>` +
    (outcome ? ` ${outcome}` : '') +
    '</li>'
  )
}

type DayGroup = {
  day: string
  turns: { entry: OverviewEntry; sessionTitle: string }[]
}

/** The range's turns read as one timeline: days ascending, then time within a day. */
function dayGroups(sessions: readonly OverviewSection[]): DayGroup[] {
  const groups = new Map<string, DayGroup>()
  for (const session of sessions) {
    for (const entry of session.entries) {
      const day = overviewDate(entry.time)
      const group = groups.get(day) ?? { day, turns: [] }
      group.turns.push({ entry, sessionTitle: session.title })
      groups.set(day, group)
    }
  }
  for (const group of groups.values()) {
    group.turns.sort((a, b) => a.entry.time - b.entry.time)
  }
  return [...groups.values()].sort((a, b) => a.day.localeCompare(b.day))
}

function daySection(group: DayGroup, chrome: OverviewChrome): string {
  return (
    `<section class="day">\n<h3>${escapeHtml(group.day)}</h3>\n<ol>\n` +
    group.turns.map((turn) => turnLine(turn.entry, chrome, turn.sessionTitle)).join('\n') +
    '\n</ol>\n</section>'
  )
}

function sessionSection(session: OverviewSection, chrome: OverviewChrome): string {
  const entries = [...session.entries].sort((a, b) => a.time - b.time)
  // Only an inlined picture may reach the page: a URL scheme would not resolve
  // once the file is copied, and the CSP allows nothing but `data:`.
  const picture =
    session.picture?.startsWith('data:image/') === true
      ? `<img class="picture" src="${escapeHtml(session.picture)}" alt="">\n`
      : ''
  const coversTruncation = session.coversTruncated
    ? `<p class="note">${chromeHtml(chrome, 'OVERVIEW_COVERS_TRUNCATED', {
        shown: session.shownCovers,
        total: session.totalCovers,
      })}</p>\n`
    : ''
  const truncation = session.truncated
    ? `<p class="note">${chromeHtml(chrome, 'OVERVIEW_SESSION_TRUNCATED', {
        shown: entries.length,
        total: session.totalEntries,
      })}</p>\n`
    : ''
  return (
    `<section class="session">\n<h3>${escapeHtml(session.title)}</h3>\n` +
    picture +
    coversTruncation +
    `<p class="meta">${chromeHtml(chrome, 'OVERVIEW_SESSION_META', {
      count: session.totalEntries,
    })}</p>\n` +
    truncation +
    `<ol>\n${entries.map((entry) => turnLine(entry, chrome)).join('\n')}\n</ol>\n</section>`
  )
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 60rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { margin: 0 0 .25rem; font-size: 1.75rem; }
h2 { margin: 2.5rem 0 .75rem; border-bottom: 1px solid currentColor; }
h3 { margin: 1.5rem 0 .35rem; font-size: 1.1rem; }
.range, .meta, .note { opacity: .75; margin: .25rem 0; }
.opening { white-space: pre-wrap; }
ol { margin: .25rem 0 0; padding-left: 1.25rem; }
.turn { margin: .2rem 0; }
time { opacity: .75; font-variant-numeric: tabular-nums; }
.label, .session { font-weight: 600; }
.response { opacity: .85; }
.status { font-weight: 600; }
.artifact { font-family: ui-monospace, monospace; }
.picture { display: block; max-width: 100%; max-height: 20rem; margin: .5rem 0; border-radius: .5rem; }
`

export function renderOverviewHtml(overview: OverviewDocument, chrome: OverviewChrome): string {
  const from = overviewDateTime(overview.window.from)
  const to = overviewDateTime(overview.window.to)
  const title = chromeHtml(chrome, 'OVERVIEW_PAGE_TITLE', { from, to })
  const range = chromeHtml(chrome, 'OVERVIEW_RANGE', { from, to })
  const opening = overview.opening.trim()
  const openingNote = overview.openingTruncated
    ? `<p class="note">${chromeHtml(chrome, 'OVERVIEW_OPENING_TRUNCATED', {
        shown: overview.openingTruncated.shown,
        total: overview.openingTruncated.total,
      })}</p>`
    : ''
  const overviewNote = overview.truncated
    ? `<p class="note">${chromeHtml(chrome, 'OVERVIEW_REPORT_TRUNCATED', {
        shown: overview.shownEntries,
        total: overview.totalEntries,
      })}</p>`
    : ''
  const omittedNote =
    overview.sessionsOmitted > 0
      ? `<p class="note">${chromeHtml(chrome, 'OVERVIEW_SESSIONS_OMITTED', {
          sessions: overview.sessionsOmitted,
        })}</p>`
      : ''
  const sessions = overview.sessions.filter((session) => session.entries.length > 0)

  return `<!doctype html>
<html lang="${escapeHtml(overview.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="range">${range}</p>
${opening ? `<p class="opening">${escapeHtml(opening)}</p>\n` : ''}${overviewNote}
${omittedNote}
${openingNote}
<h2>${chromeHtml(chrome, 'OVERVIEW_BY_DAY')}</h2>
${dayGroups(sessions)
  .map((group) => daySection(group, chrome))
  .join('\n')}
<h2>${chromeHtml(chrome, 'OVERVIEW_SESSIONS')}</h2>
${sessions.map((session) => sessionSection(session, chrome)).join('\n')}
</main>
</body>
</html>
`
}
