import { fillTemplate } from '@/lib/fillTemplate'
import type { OverviewChrome, OverviewChromeKey } from '@/types/overviewChrome'
import type { OverviewWindow } from './overviewRange'

// The page: fixed template, code-owned layout, every interpolation escaped.

export type OverviewSection = {
  title: string
  summary: string
  /** A ready `data:image/…` URI, downscaled by the tool that read the file. */
  picture?: string
  /** What the Session worked on, as an emoji; the renderer only places it. */
  icon?: string
}

export type OverviewDocument = {
  window: OverviewWindow
  /** The language the chrome strings were resolved for. */
  locale: string
  /** The query's order: the Session active most recently first. */
  sessions: OverviewSection[]
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
  const icon = session.icon
    ? `<span class="icon" aria-hidden="true">${escapeHtml(session.icon)}</span>`
    : ''
  return (
    `<article class="card">\n` +
    `<header class="card-head"><p class="title">${icon}${escapeHtml(session.title)}</p></header>\n` +
    `<div class="card-body">\n<div class="text">\n` +
    `<p class="summary">${escapeHtml(session.summary)}</p>\n</div>\n` +
    picture +
    `</div>\n</article>`
  )
}

const STYLE = `
:root { color-scheme: light dark; --accent: #5b4be6; }
@media (prefers-color-scheme: dark) { :root { --accent: #a99bff; } }
body { margin: 0; font: 16px/1.6 system-ui, sans-serif; }
main { max-width: 68rem; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
.head { margin: 0 0 2rem; }
h1 { margin: 0; font-size: 1.75rem; line-height: 1.25; font-weight: 650; letter-spacing: -.02em; color: var(--accent); }
.subtitle { margin: .4rem 0 0; opacity: .7; }
.cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem; }
.card { display: flex; flex-direction: column; min-height: 13rem; padding: 1.15rem 1.35rem 1.35rem; border: 1px solid rgba(127, 127, 127, .25); border-radius: 1rem; background: rgba(127, 127, 127, .06); background: color-mix(in srgb, var(--accent) 6%, transparent); box-shadow: 0 1px 2px rgba(0, 0, 0, .05); }
.card-head { padding-bottom: .65rem; margin-bottom: .85rem; border-bottom: 1px solid rgba(127, 127, 127, .2); }
.title { margin: 0; font-size: 1.05rem; line-height: 1.35; font-weight: 600; color: var(--accent); }
.icon { margin-right: .4rem; }
.card-body { display: flex; gap: 1rem; align-items: flex-start; }
.text { flex: 1; min-width: 0; }
.picture { flex: none; width: 7.5rem; height: 7.5rem; object-fit: cover; border-radius: .65rem; background: rgba(127, 127, 127, .12); }
.summary { margin: 0; opacity: .92; white-space: pre-wrap; }
@media (max-width: 48rem) { .cards { grid-template-columns: minmax(0, 1fr); } }
@media print { .cards { display: block; } .card { break-inside: avoid; margin-bottom: 1rem; } }
`

export function renderOverviewHtml(overview: OverviewDocument, chrome: OverviewChrome): string {
  const from = overviewDateTime(overview.window.from)
  const to = overviewDateTime(overview.window.to)
  const title = chromeHtml(chrome, 'OVERVIEW_PAGE_TITLE', { from, to })
  const subtitle = chromeHtml(chrome, 'OVERVIEW_SUBTITLE')

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
<header class="head"><h1>${title}</h1><p class="subtitle">${subtitle}</p></header>
<div class="cards">
${overview.sessions.map((session) => sessionCard(session)).join('\n')}
</div>
</main>
</body>
</html>
`
}
