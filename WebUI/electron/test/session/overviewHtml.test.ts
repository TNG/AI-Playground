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
// in, a self-contained HTML string out. One entry per Session — its Title, its
// summary and a picture when it has one — and nothing about the turns behind them.

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
    shownEntries: sessions.length,
    totalEntries: sessions.length,
    truncated: false,
    ...overrides,
  } satisfies OverviewDocument
}

describe('overview HTML renderer', () => {
  it('renders one entry per Session with its Title and summary, in the order given', () => {
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

    expect(html).not.toMatch(/<h[1-6]\b/)
    expect(html).not.toContain('<ol')
    expect(html).not.toContain('class="turn"')
    expect(html).not.toContain('class="prompt"')
    expect(html).not.toContain('class="response"')
    expect(html).not.toContain('class="status"')
    expect(html).not.toContain('class="range"')
    expect(html).not.toContain('turns in range')
    expect(html).not.toContain('By day')
  })

  it('puts the window in the document title only', () => {
    const html = renderOverviewHtml(documentOf([section({})]), english)

    const [head, body] = html.split('</title>')
    expect(head).toContain('Overview: 2026-11-22 00:00 to 2026-11-25 00:00')
    expect(body).not.toContain('2026-11-22')
    expect(body).not.toContain('2026-11-25')
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

  it('inlines a Session picture as a data URI', () => {
    const picture = 'data:image/png;base64,AAAA'
    const html = renderOverviewHtml(
      documentOf([
        section({ title: 'Pictured', summary: 'With a picture.', picture }),
        section({ title: 'Plain', summary: 'Without one.' }),
      ]),
      english,
    )

    expect(html).toContain(`<img class="picture" src="${picture}" alt="">`)
    expect(html.match(/<img\b/g)).toHaveLength(1)
    // The text sits beside the picture, in the same card.
    expect(html.indexOf('class="picture"')).toBeLessThan(html.indexOf('class="text"'))
  })

  it('never renders a picture source that is not a data URI', () => {
    const html = renderOverviewHtml(
      documentOf([
        section({ title: 'Remote', picture: 'https://example.com/cat.png' }),
        section({ title: 'Local', picture: 'file:///tmp/cat.png' }),
        section({ title: 'Media', picture: 'aipg-media://games/x/icon.png' }),
      ]),
      english,
    )

    expect(html).not.toMatch(/<img\b/)
    expect(html).not.toContain('https://example.com/cat.png')
    expect(html).not.toContain('file:///tmp/cat.png')
    expect(html).not.toContain('aipg-media://games/x/icon.png')
  })

  it('says the read was cut in one footnote, and only when it was', () => {
    const complete = renderOverviewHtml(documentOf([section({})]), english)
    expect(complete).not.toContain('class="note"')
    expect(complete).not.toContain('newest')

    const capped = renderOverviewHtml(
      documentOf([section({})], { shownEntries: 5, totalEntries: 173, truncated: true }),
      english,
    )
    expect(capped.match(/class="note"/g)).toHaveLength(1)
    expect(capped).toContain('newest 5 of 173')
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
          shownEntries: 2,
          totalEntries: 5,
          truncated: true,
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
})
