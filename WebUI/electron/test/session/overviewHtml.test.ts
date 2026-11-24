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
import type { OverviewEntry } from '../../session/overviewData'

// The Overview page is produced by code, never by the model: one resolved Overview
// in, a self-contained HTML string out. These tests assert the page a reader gets
// — escaping, day grouping, ordering and the truncation wording — without
// snapshotting the whole template, so a styling change is not a failure.

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

function entry(overrides: Partial<OverviewEntry>): OverviewEntry {
  return {
    time: FROM,
    preset: 'Assistant',
    prompt: 'a turn',
    status: 'completed',
    artifacts: [],
    ...overrides,
  }
}

function section(overrides: Partial<OverviewSection>): OverviewSection {
  const entries = overrides.entries ?? []
  return {
    title: 'A Session',
    entries,
    totalEntries: entries.length,
    truncated: false,
    shownCovers: 0,
    totalCovers: 0,
    coversTruncated: false,
    ...overrides,
  }
}

function documentOf(sessions: OverviewSection[], overrides: Partial<OverviewDocument> = {}) {
  return {
    window: { from: FROM, to: TO },
    locale: 'en-US',
    opening: 'A short opening.',
    sessions,
    shownEntries: sessions.reduce((sum, item) => sum + item.entries.length, 0),
    totalEntries: sessions.reduce((sum, item) => sum + item.totalEntries, 0),
    sessionsOmitted: 0,
    truncated: false,
    ...overrides,
  } satisfies OverviewDocument
}

describe('overview HTML renderer', () => {
  it('escapes every interpolated string and carries no script', () => {
    const html = renderOverviewHtml(
      documentOf(
        [
          section({
            title: '<img src=x onerror="alert(1)"> & "quoted"',
            entries: [
              entry({
                agent: '<em>Agent</em>',
                prompt: '</p><b>"quoted"</b>',
                artifacts: [{ path: 'files/<x>.png', mediaType: 'image' }],
              }),
              entry({ preset: 'A & B', prompt: 'a preset turn' }),
            ],
          }),
        ],
        { opening: '<script>alert(1)</script>' },
      ),
      english,
    )

    expect(html).not.toMatch(/<script/i)
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<em>')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(html).toContain('&lt;em&gt;Agent&lt;/em&gt;')
    expect(html).toContain('&lt;/p&gt;&lt;b&gt;&quot;quoted&quot;&lt;/b&gt;')
    expect(html).toContain('A &amp; B')
    expect(html).toContain('files/&lt;x&gt;.png')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('groups turns by local day across Sessions, in time order', () => {
    const html = renderOverviewHtml(
      documentOf([
        section({
          title: 'Alpha',
          entries: [
            entry({ prompt: 'alpha next day', time: new Date(2026, 10, 24, 9).getTime() }),
            entry({ prompt: 'alpha morning', time: new Date(2026, 10, 23, 10).getTime() }),
          ],
        }),
        section({
          title: 'Beta',
          entries: [
            entry({ prompt: 'beta next day', time: new Date(2026, 10, 24, 8).getTime() }),
            entry({ prompt: 'beta morning', time: new Date(2026, 10, 23, 11).getTime() }),
          ],
        }),
      ]),
      english,
    )

    const day23 = html.indexOf('2026-11-23')
    const day24 = html.indexOf('2026-11-24')
    expect(day23).toBeGreaterThan(-1)
    expect(day23).toBeLessThan(day24)
    // Within a day, turns read chronologically whichever Session they came from.
    expect(html.indexOf('alpha morning')).toBeLessThan(html.indexOf('beta morning'))
    expect(html.indexOf('beta next day')).toBeLessThan(html.indexOf('alpha next day'))

    // Sessions keep the order the query returned (most recently updated first).
    const sessionsStart = html.indexOf('<h2>Sessions</h2>')
    expect(sessionsStart).toBeGreaterThan(-1)
    const sections = html.slice(sessionsStart)
    expect(sections.indexOf('Alpha')).toBeLessThan(sections.indexOf('Beta'))
    // ...and each Session's own turns are chronological.
    expect(sections.indexOf('alpha morning')).toBeLessThan(sections.indexOf('alpha next day'))
  })

  it('names the counts in the truncation sentences and skips Sessions with no lines', () => {
    const html = renderOverviewHtml(
      documentOf(
        [
          section({
            title: 'Busy',
            entries: [entry({ prompt: 'newest' }), entry({ prompt: 'second newest' })],
            totalEntries: 130,
            truncated: true,
          }),
          section({
            title: 'Quiet',
            entries: [
              entry({ prompt: 'one' }),
              entry({ prompt: 'two' }),
              entry({ prompt: 'three' }),
            ],
          }),
          section({ title: 'Omitted', entries: [], totalEntries: 40 }),
        ],
        { shownEntries: 5, totalEntries: 173, sessionsOmitted: 1, truncated: true },
      ),
      english,
    )

    expect(html).toContain('newest 5 of 173')
    expect(html).toContain('newest 2 of 130')
    expect(html).toContain('1 Sessions with turns in this range are not shown')
    expect(html).not.toContain('Omitted')
    expect(html.match(/<section class="session">/g)).toHaveLength(2)
  })

  it('says when the opening paragraph was shortened', () => {
    const html = renderOverviewHtml(
      documentOf([section({ entries: [entry({})] })], {
        openingTruncated: { shown: 1200, total: 1500 },
      }),
      english,
    )

    expect(html).toContain('first 1200 of 1500 characters')
  })

  it('names the picture-candidate count where a Session’s covers were cut', () => {
    const html = renderOverviewHtml(
      documentOf([
        section({
          title: 'Pictured',
          entries: [entry({})],
          shownCovers: 8,
          totalCovers: 10,
          coversTruncated: true,
        }),
      ]),
      english,
    )

    expect(html).toContain('newest 8 of 10 candidates')
  })

  it('inlines a Session picture as a data URI and shows none without one', () => {
    const picture = 'data:image/png;base64,AAAA'
    const html = renderOverviewHtml(
      documentOf([
        section({ title: 'Pictured', picture, entries: [entry({})] }),
        section({ title: 'Plain', entries: [entry({})] }),
      ]),
      english,
    )

    expect(html).toContain(`<img class="picture" src="${picture}" alt="">`)
    expect(html.match(/<img\b/g)).toHaveLength(1)
    const plainSection = html.slice(html.indexOf('<h3>Plain</h3>'))
    expect(plainSection.slice(0, plainSection.indexOf('</section>'))).not.toContain('<img')
  })

  it('never renders a picture source that is not a data URI', () => {
    const html = renderOverviewHtml(
      documentOf([
        section({ title: 'Remote', picture: 'https://example.com/cat.png', entries: [entry({})] }),
        section({ title: 'Local', picture: 'file:///tmp/cat.png', entries: [entry({})] }),
        section({
          title: 'Media',
          picture: 'aipg-media://games/x/icon.png',
          entries: [entry({})],
        }),
      ]),
      english,
    )

    expect(html).not.toMatch(/<img\b/)
    expect(html).not.toContain('https://example.com/cat.png')
    expect(html).not.toContain('file:///tmp/cat.png')
    expect(html).not.toContain('aipg-media://games/x/icon.png')
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
        documentOf(
          [
            section({
              title: 'A Session',
              entries: [entry({ status: 'failed' })],
              totalEntries: 3,
              truncated: true,
              shownCovers: 8,
              totalCovers: 10,
              coversTruncated: true,
            }),
            section({ entries: [entry({ status: 'cancelled' })] }),
          ],
          {
            locale,
            shownEntries: 2,
            totalEntries: 5,
            sessionsOmitted: 1,
            truncated: true,
            openingTruncated: { shown: 1200, total: 1500 },
          },
        ),
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
