import { fillTemplate } from '@/lib/fillTemplate'
import type { OverviewChrome, OverviewChromeKey } from '@/types/overviewChrome'
import type { OverviewWindow } from './overviewRange'

// The page: fixed template, code-owned layout, every interpolation escaped.

export type OverviewSection = {
  title: string
  summary: string
  /** A ready `data:image/…` URI, downscaled by the tool that read the file. */
  picture?: string
}

export type OverviewDocument = {
  window: OverviewWindow
  /** The language the chrome strings were resolved for. */
  locale: string
  /** The query's order: most recently updated Session first. */
  sessions: OverviewSection[]
  shownEntries: number
  /** Every turn in range, including those the read's line budget left out. */
  totalEntries: number
  truncated: boolean
}

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

/** Local calendar date, the one the file name uses. */
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

function sessionCard(session: OverviewSection): string {
  // Only an inlined picture may reach the page: a URL scheme would not resolve
  // once the file is copied, and the CSP allows nothing but `data:`.
  const picture =
    session.picture?.startsWith('data:image/') === true
      ? `<img class="picture" src="${escapeHtml(session.picture)}" alt="">\n`
      : ''
  return (
    `<article class="card">\n${picture}<div class="text">\n` +
    `<p class="title">${escapeHtml(session.title)}</p>\n` +
    `<p class="summary">${escapeHtml(session.summary)}</p>\n</div>\n</article>`
  )
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 78rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: 1rem; align-items: start; }
.card { display: flex; gap: .9rem; padding: .9rem; border: 1px solid rgba(127, 127, 127, .35); border-radius: .75rem; background: rgba(127, 127, 127, .06); }
.text { min-width: 0; }
.picture { flex: none; width: 7rem; height: 7rem; object-fit: cover; border-radius: .5rem; }
.title { margin: 0; font-weight: 600; font-size: 1.05rem; }
.summary { margin: .35rem 0 0; white-space: pre-wrap; }
.note { opacity: .75; margin: 0 0 1.25rem; }
@media print { .cards { display: block; } .card { break-inside: avoid; margin-bottom: 1rem; } }
`

export function renderOverviewHtml(overview: OverviewDocument, chrome: OverviewChrome): string {
  const from = overviewDateTime(overview.window.from)
  const to = overviewDateTime(overview.window.to)
  const title = chromeHtml(chrome, 'OVERVIEW_PAGE_TITLE', { from, to })
  const note = overview.truncated
    ? `<p class="note">${chromeHtml(chrome, 'OVERVIEW_REPORT_TRUNCATED', {
        shown: overview.shownEntries,
        total: overview.totalEntries,
      })}</p>\n`
    : ''

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
${note}<div class="cards">
${overview.sessions.map((session) => sessionCard(session)).join('\n')}
</div>
</main>
</body>
</html>
`
}
