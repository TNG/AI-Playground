import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OVERVIEW_CHROME_KEYS, type OverviewChrome } from '@/types/overviewChrome'
import {
  overviewFileName,
  renderOverviewHtml,
  type OverviewDocument,
  type OverviewSection,
} from '../../session/overviewHtml'

// The Overview page is produced by code, never by the model: one resolved Overview
// in, a self-contained HTML string out. One card per Session — its type icon, Title
// and stored Overview Summary — and nothing about the turns behind them.

const FROM = new Date(2026, 10, 22).getTime()
const TO = new Date(2026, 10, 25).getTime()
const HOUR = 60 * 60 * 1000

const localeDir = fileURLToPath(new URL('../../../src/assets/i18n', import.meta.url))

const readLocale = (file: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8')) as Record<string, string>

const chromeOf = (locale: string, strings: Record<string, string>): OverviewChrome => ({
  locale,
  strings: Object.fromEntries(
    OVERVIEW_CHROME_KEYS.map((key) => {
      const value = strings[key]
      if (typeof value !== 'string') throw new Error(`missing chrome string ${key}`)
      return [key, value]
    }),
  ) as OverviewChrome['strings'],
})

const english = chromeOf('en-US', readLocale('en-US.json'))

function section(overrides: Partial<OverviewSection>): OverviewSection {
  return {
    title: 'A Session',
    summary: 'It did a thing.',
    ...overrides,
  }
}

function documentOf(sessions: OverviewSection[], overrides: Partial<OverviewDocument> = {}) {
  return {
    window: { from: FROM, to: TO },
    locale: 'en-US',
    sessions,
    ...overrides,
  } satisfies OverviewDocument
}

function notes(html: string): string {
  return (html.match(/<p class="note[\s\S]*?<\/p>/g) ?? []).join('\n')
}

describe('overview HTML renderer', () => {
  it('renders one card per Session with its Title and summary, in the order given', () => {
    const html = renderOverviewHtml(
      documentOf([
        section({ title: 'Beta', summary: 'Beta built the asteroid field.' }),
        section({ title: 'Alpha', summary: 'Alpha tuned the collision boxes.' }),
      ]),
      english,
    )

    expect(html).toContain('<div class="cards">')
    expect(html.match(/<article class="card">/g)).toHaveLength(2)
    expect(html).toContain('<p class="title">Beta</p>')
    expect(html).toContain('<p class="summary">Beta built the asteroid field.</p>')
    expect(html).toContain('<p class="title">Alpha</p>')
    expect(html).toContain('<p class="summary">Alpha tuned the collision boxes.</p>')
    expect(html.indexOf('Beta')).toBeLessThan(html.indexOf('Alpha'))

    const reversed = renderOverviewHtml(
      documentOf([section({ title: 'Alpha' }), section({ title: 'Beta' })]),
      english,
    )
    expect(reversed.indexOf('Alpha')).toBeLessThan(reversed.indexOf('Beta'))
  })

  it('shows no prompt, response, turn, day, preset or count text', () => {
    const html = renderOverviewHtml(
      documentOf([section({ title: 'Work', summary: 'A few sentences of summary.' })]),
      english,
    )

    expect(html).not.toContain('<ol')
    expect(html).not.toContain('class="turn"')
    expect(html).not.toContain('class="prompt"')
    expect(html).not.toContain('class="response"')
    expect(html).not.toContain('class="status"')
    expect(html).not.toContain('turns in range')
    expect(html).not.toContain('By day')
  })

  it('places the Session icon beside its Title and has no subtitle', () => {
    const html = renderOverviewHtml(documentOf([section({ title: 'Art', icon: '🎨' })]), english)

    expect(html).toContain(
      '<p class="title"><span class="icon" aria-hidden="true">🎨</span>Art</p>',
    )
    expect(html).not.toContain('class="subtitle"')
  })

  it('heads the page "Sessions active …" and states the window in the document title', () => {
    const html = renderOverviewHtml(documentOf([section({})]), english)

    expect(html).toContain('<title>Sessions active 2026-11-22 00:00 to 2026-11-25 00:00</title>')
    expect(html).toContain('<h1>Sessions active 2026-11-22 00:00 to 2026-11-25 00:00</h1>')
    expect(html.match(/<h1>/g)).toHaveLength(1)
  })

  it('escapes every interpolated string and carries no script', () => {
    const html = renderOverviewHtml(
      documentOf([
        section({
          title: '<img src=x onerror="alert(1)"> & "quoted"',
          summary: '<script>alert(1)</script></p><b>"quoted"</b>',
        }),
      ]),
      english,
    )

    expect(html).not.toMatch(/<script/i)
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>')
    expect(html).toContain(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;',
    )
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&lt;/p&gt;&lt;b&gt;')
  })

  it('renders a Session with no picture normally, with no placeholder', () => {
    const html = renderOverviewHtml(
      documentOf([section({ title: 'Plain', summary: 'No picture here.' })]),
      english,
    )

    expect(html).toContain('<p class="title">Plain</p>')
    expect(html).toContain('<p class="summary">No picture here.</p>')
    expect(html).not.toMatch(/<img\b/)
  })

  it('footnotes omitted Sessions by Title, with the strings escaped', () => {
    const html = renderOverviewHtml(
      documentOf([section({ title: 'Kept', summary: 'Kept work.' })], {
        omitted: ['No <b>summary</b> & "quoted"'],
      }),
      english,
    )

    expect(html).toContain('<article class="card">')
    expect(html).toContain('<p class="note omitted">')
    expect(notes(html)).toContain('No &lt;b&gt;summary&lt;/b&gt; &amp; &quot;quoted&quot;')
    expect(html).not.toContain('<b>summary</b>')
    expect(html).not.toMatch(/\{sessions\}/)
  })

  it('footnotes behind Sessions by Title, with the strings escaped', () => {
    const html = renderOverviewHtml(
      documentOf([section({ title: 'Behind', summary: 'Older account.' })], {
        behind: ['Behind <script>alert(1)</script>'],
      }),
      english,
    )

    expect(html).toContain('<p class="note behind">')
    expect(notes(html)).toContain('Behind &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/\{sessions\}/)
  })

  it('names a day range by date and a rolling range by its exact time', () => {
    const day = {
      from: new Date(2026, 10, 23).getTime(),
      to: new Date(2026, 10, 24).getTime(),
    }
    expect(overviewFileName(day)).toBe('overview-2026-11-23..2026-11-24.html')

    const rolling = {
      from: new Date(2026, 10, 23, 10, 0).getTime(),
      to: new Date(2026, 10, 24, 10, 0).getTime(),
    }
    expect(overviewFileName(rolling)).toBe('overview-2026-11-23_1000..2026-11-24_1000.html')

    const later = { from: rolling.from + 2 * HOUR, to: rolling.to + 2 * HOUR }
    expect(overviewFileName(later)).not.toBe(overviewFileName(rolling))
    expect(overviewFileName(later)).toBe('overview-2026-11-23_1200..2026-11-24_1200.html')
  })

  it('resolves every placeholder in every locale', () => {
    const locales = fs
      .readdirSync(localeDir)
      .filter((file) => file.endsWith('.json'))
      .sort()
    expect(locales.length).toBe(13)

    for (const file of locales) {
      const locale = file.replace(/\.json$/, '')
      const chrome = chromeOf(locale, readLocale(file))
      const html = renderOverviewHtml(
        documentOf([section({ title: 'A Session', summary: 'A summary.' })], {
          locale,
          omitted: ['An Omitted Session'],
          behind: ['A Behind Session'],
        }),
        chrome,
      )

      expect(html).toContain(`<html lang="${locale}">`)
      // A visible `{count}` means a translation dropped a placeholder or the
      // renderer never resolved a key.
      expect(html).not.toMatch(/\{[a-zA-Z]+\}/)
      expect(html).not.toMatch(/<script/i)

      // The locale's own words are in the page, not the key that named them.
      for (const key of OVERVIEW_CHROME_KEYS) {
        const parts = chrome.strings[key]
          .split(/\{\w+\}/)
          .map((part) => part.trim())
          .filter((part) => part.length > 2)
        for (const part of parts) expect(html).toContain(part)
      }
    }
  })

  it('renders no footnotes when nothing is omitted or behind', () => {
    const html = renderOverviewHtml(documentOf([section({})]), english)

    expect(html).not.toContain('class="note"')
  })

  it('has the two footnote strings in every locale, with the same placeholders', () => {
    const placeholderSet = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    const files = fs
      .readdirSync(localeDir)
      .filter((file) => file.endsWith('.json'))
      .sort()
    expect(files.length).toBe(13)
    const englishLocale = readLocale('en-US.json')

    for (const key of ['OVERVIEW_OMITTED_NOTE', 'OVERVIEW_BEHIND_NOTE'] as const) {
      expect(typeof englishLocale[key]).toBe('string')
      for (const file of files) {
        const locale = readLocale(file)
        expect(typeof locale[key], `${file} ${key}`).toBe('string')
        expect(placeholderSet(locale[key]), `${file} ${key}`).toEqual(
          placeholderSet(englishLocale[key]),
        )
        expect(placeholderSet(locale[key]), `${file} ${key}`).toEqual(['sessions'])
      }
    }
  })
})
