import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OVERVIEW_CHROME_KEYS, type OverviewChrome } from '@/types/overviewChrome'
import {
  overviewFileName,
  renderOverviewHtml,
  type OverviewReport,
  type OverviewReportSession,
} from '../../session/overviewHtml'
import type { OverviewEntry } from '../../session/overviewData'

// The Overview page is produced by code, never by the model: one resolved report
// in, a self-contained HTML string out. These tests assert the page a reader gets
// — escaping, day grouping, ordering and the truncation wording — without
// snapshotting the whole template, so a styling change is not a failure.

const FROM = new Date(2026, 10, 22).getTime()
const TO = new Date(2026, 10, 25).getTime()

const localeDir = fileURLToPath(new URL('../../../src/assets/i18n', import.meta.url))

const readLocale = (file: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8')) as Record<string, string>

const chromeOf = (strings: Record<string, string>): OverviewChrome =>
  Object.fromEntries(
    OVERVIEW_CHROME_KEYS.map((key) => {
      const value = strings[key]
      if (typeof value !== 'string') throw new Error(`missing chrome string ${key}`)
      return [key, value]
    }),
  ) as OverviewChrome

const english = chromeOf(readLocale('en-US.json'))

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

function session(overrides: Partial<OverviewReportSession>): OverviewReportSession {
  const entries = overrides.entries ?? []
  return {
    title: 'A Session',
    entries,
    totalEntries: entries.length,
    truncated: false,
    ...overrides,
  }
}

function reportOf(sessions: OverviewReportSession[], overrides: Partial<OverviewReport> = {}) {
  return {
    window: { from: FROM, to: TO },
    locale: 'en-US',
    opening: 'A short opening.',
    sessions,
    shownEntries: sessions.reduce((sum, item) => sum + item.entries.length, 0),
    totalEntries: sessions.reduce((sum, item) => sum + item.totalEntries, 0),
    truncated: false,
    ...overrides,
  } satisfies OverviewReport
}

describe('overview HTML renderer', () => {
  it('escapes every interpolated string and carries no script', () => {
    const html = renderOverviewHtml(
      reportOf(
        [
          session({
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
      reportOf([
        session({
          title: 'Alpha',
          entries: [
            entry({ prompt: 'alpha next day', time: new Date(2026, 10, 24, 9).getTime() }),
            entry({ prompt: 'alpha morning', time: new Date(2026, 10, 23, 10).getTime() }),
          ],
        }),
        session({
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

  it('names the counts in both truncation sentences', () => {
    const html = renderOverviewHtml(
      reportOf(
        [
          session({
            title: 'Busy',
            entries: [entry({ prompt: 'newest' }), entry({ prompt: 'second newest' })],
            totalEntries: 130,
            truncated: true,
          }),
          session({
            title: 'Quiet',
            entries: [
              entry({ prompt: 'one' }),
              entry({ prompt: 'two' }),
              entry({ prompt: 'three' }),
            ],
          }),
        ],
        { shownEntries: 5, totalEntries: 133, truncated: true },
      ),
      english,
    )

    expect(html).toContain('newest 5 of 133')
    expect(html).toContain('newest 2 of 130')
  })

  it('says when the opening paragraph was shortened', () => {
    const html = renderOverviewHtml(
      reportOf([session({ entries: [entry({})] })], {
        openingTruncated: { shown: 1200, total: 1500 },
      }),
      english,
    )

    expect(html).toContain('first 1200 of 1500 characters')
  })

  it('uses the local calendar dates in the file name', () => {
    const from = new Date(2026, 10, 23, 15, 30).getTime()
    const to = new Date(2026, 10, 24, 15, 30).getTime()
    expect(overviewFileName({ from, to })).toBe('overview-2026-11-23..2026-11-24.html')
  })

  it('resolves every placeholder in every locale', () => {
    const locales = fs
      .readdirSync(localeDir)
      .filter((file) => file.endsWith('.json'))
      .sort()
    expect(locales.length).toBe(13)

    for (const file of locales) {
      const locale = file.replace(/\.json$/, '')
      const chrome = chromeOf(readLocale(file))
      const html = renderOverviewHtml(
        reportOf(
          [
            session({
              title: 'A Session',
              entries: [entry({ status: 'failed' })],
              totalEntries: 3,
              truncated: true,
            }),
            session({ entries: [entry({ status: 'cancelled' })] }),
          ],
          {
            locale,
            shownEntries: 2,
            totalEntries: 5,
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
        const parts = chrome[key]
          .split(/\{\w+\}/)
          .map((part) => part.trim())
          .filter((part) => part.length > 2)
        for (const part of parts) expect(html).toContain(part)
      }
    }
  })
})
