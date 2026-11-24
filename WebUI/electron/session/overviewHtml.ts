import { fillTemplate } from '@/lib/fillTemplate'
import type { OverviewChrome, OverviewChromeKey } from '@/types/overviewChrome'
import type { OverviewEntry, OverviewWindow } from './overviewData'

// ── Overviews: the page ──────────────────────────────────────────────────────
//
// The model writes the opening paragraph and chooses pictures; the layout, the
// day grouping and every interpolation are code's. Escaping is unconditional
// because the page quotes prompts from many Sessions, and nothing here touches
// the filesystem or Electron, so a template change is testable on its own.

export type OverviewReportSession = {
  title: string
  entries: OverviewEntry[]
  totalEntries: number
  truncated: boolean
  /** A ready `data:image/…` URI, downscaled by the tool that read the file. */
  picture?: string
}

export type OverviewReport = {
  window: OverviewWindow
  /** The language the chrome strings were resolved for. */
  locale: string
  opening: string
  /** The query's order: most recently updated Session first. */
  sessions: OverviewReportSession[]
  shownEntries: number
  totalEntries: number
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

function overviewDateTime(ms: number): string {
  return `${overviewDate(ms)} ${overviewClock(ms)}`
}

export function overviewFileName(window: OverviewWindow): string {
  return `overview-${overviewDate(window.from)}..${overviewDate(window.to)}.html`
}

function textOf(
  chrome: OverviewChrome,
  key: OverviewChromeKey,
  values: Record<string, string | number> = {},
): string {
  const escaped = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, escapeHtml(String(value))]),
  )
  return fillTemplate(chrome[key] ?? key, escaped)
}

function outcomeOf(entry: OverviewEntry, chrome: OverviewChrome): string {
  const parts: string[] = []
  if (entry.status === 'failed') {
    parts.push(`<span class="status">${textOf(chrome, 'OVERVIEW_STATUS_FAILED')}</span>`)
  } else if (entry.status === 'cancelled') {
    parts.push(`<span class="status">${textOf(chrome, 'OVERVIEW_STATUS_CANCELLED')}</span>`)
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
  const outcome = outcomeOf(entry, chrome)
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
function dayGroups(sessions: readonly OverviewReportSession[]): DayGroup[] {
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

function sessionSection(session: OverviewReportSession, chrome: OverviewChrome): string {
  const entries = [...session.entries].sort((a, b) => a.time - b.time)
  // Only an inlined picture may reach the page: a URL scheme would not resolve
  // once the file is copied, and the CSP allows nothing but `data:`.
  const picture =
    session.picture?.startsWith('data:image/') === true
      ? `<img class="picture" src="${escapeHtml(session.picture)}" alt="">\n`
      : ''
  const truncation = session.truncated
    ? `<p class="note">${textOf(chrome, 'OVERVIEW_SESSION_TRUNCATED', {
        shown: entries.length,
        total: session.totalEntries,
      })}</p>\n`
    : ''
  return (
    `<section class="session">\n<h3>${escapeHtml(session.title)}</h3>\n` +
    picture +
    `<p class="meta">${textOf(chrome, 'OVERVIEW_SESSION_META', {
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

export function renderOverviewHtml(report: OverviewReport, chrome: OverviewChrome): string {
  const from = overviewDateTime(report.window.from)
  const to = overviewDateTime(report.window.to)
  const title = textOf(chrome, 'OVERVIEW_PAGE_TITLE', { from, to })
  const range = textOf(chrome, 'OVERVIEW_RANGE', { from, to })
  const opening = report.opening.trim()
  const openingNote = report.openingTruncated
    ? `<p class="note">${textOf(chrome, 'OVERVIEW_OPENING_TRUNCATED', {
        shown: report.openingTruncated.shown,
        total: report.openingTruncated.total,
      })}</p>`
    : ''
  const reportNote = report.truncated
    ? `<p class="note">${textOf(chrome, 'OVERVIEW_REPORT_TRUNCATED', {
        shown: report.shownEntries,
        total: report.totalEntries,
      })}</p>`
    : ''

  return `<!doctype html>
<html lang="${escapeHtml(report.locale)}">
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
${opening ? `<p class="opening">${escapeHtml(opening)}</p>\n` : ''}${reportNote}
${openingNote}
<h2>${textOf(chrome, 'OVERVIEW_BY_DAY')}</h2>
${dayGroups(report.sessions)
  .map((group) => daySection(group, chrome))
  .join('\n')}
<h2>${textOf(chrome, 'OVERVIEW_SESSIONS')}</h2>
${report.sessions.map((session) => sessionSection(session, chrome)).join('\n')}
</main>
</body>
</html>
`
}
