import { describe, expect, it } from 'vitest'
import { sessionSections, sectionTimeBucket } from '@/lib/sessionSections'
import { sessionTimeLabel, type TimeLabelBucket } from '@/lib/sessionTimeLabel'
import type { SessionSummary } from '@/types/sessionIpc'

const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s).getTime()
const NOW = at(2026, 11, 5, 15, 30)
const label = (time: number, locale: string, bucket: TimeLabelBucket) =>
  sessionTimeLabel(time, NOW, locale, bucket).replace(/\s/g, ' ')

describe('sessionTimeLabel', () => {
  it('says how long ago under Today', () => {
    expect(label(at(2026, 11, 5, 15, 25), 'en-US', 'today')).toBe('5 min. ago')
    expect(label(at(2026, 11, 5, 12, 10), 'en-US', 'today')).toBe('3 hr. ago')
    expect(label(at(2026, 11, 5, 15, 25), 'de', 'today')).toBe('vor 5 Min.')
    expect(label(at(2026, 11, 5, 12, 10), 'de', 'today')).toBe('vor 3 Std.')
  })

  it('says now for anything under a minute old', () => {
    expect(label(at(2026, 11, 5, 15, 29, 30), 'en-US', 'today')).toBe('now')
    expect(label(NOW, 'en-US', 'today')).toBe('now')
    expect(label(at(2026, 11, 5, 15, 29, 30), 'de', 'today')).toBe('jetzt')
  })

  it('says how long ago under Today however old the time, as for a live Session', () => {
    expect(label(at(2026, 10, 6, 15, 30), 'en-US', 'today')).toBe('30 days ago')
    expect(label(at(2026, 10, 6, 15, 30), 'de', 'today')).toBe('vor 30 Tagen')
  })

  it('gives the time of day under Yesterday', () => {
    expect(label(at(2026, 11, 4, 23, 50), 'en-US', 'yesterday')).toBe('11:50 PM')
    expect(label(at(2026, 11, 4, 9, 5), 'de', 'yesterday')).toBe('09:05')
  })

  it('gives the weekday and time under Previous 7 days', () => {
    expect(label(at(2026, 11, 3, 14, 5), 'en-US', 'previous7Days')).toBe('Tue 2:05 PM')
    expect(label(at(2026, 10, 29, 8, 0), 'de', 'previous7Days')).toBe('Do., 08:00')
  })

  it('gives the date under Older, with the year only when it is a past one', () => {
    expect(label(at(2026, 10, 28, 8, 0), 'en-US', 'older')).toBe('Oct 28')
    expect(label(at(2026, 3, 14), 'de', 'older')).toBe('14. März')
    expect(label(at(2025, 3, 14), 'en-US', 'older')).toBe('Mar 14, 2025')
    expect(label(at(2025, 3, 14), 'de', 'older')).toBe('14. März 2025')
  })

  it('says how long ago at any age outside the date buckets', () => {
    expect(label(at(2026, 11, 5, 12, 10), 'en-US', 'relative')).toBe('3 hr. ago')
    expect(label(at(2026, 10, 15, 15, 30), 'en-US', 'relative')).toBe('21 days ago')
    expect(label(at(2026, 10, 15, 15, 30), 'de', 'relative')).toBe('vor 21 Tagen')
  })
})

describe('a Session row label in the panel', () => {
  const session = (id: string, over: Partial<SessionSummary>): SessionSummary => ({
    id,
    title: id,
    renamed: false,
    pinned: false,
    reachable: false,
    createdAt: 0,
    updatedAt: 0,
    presetsUsed: [],
    ...over,
  })

  function labels(sessions: SessionSummary[], liveSessionIds: string[] = []) {
    const listed = sessionSections({
      sessions,
      groups: [],
      query: '',
      untitled: 'Untitled',
      openSessionId: null,
      showMore: { pinned: false, older: false },
      now: NOW,
      liveSessionIds: new Set(liveSessionIds),
    })
    return Object.fromEntries(
      listed.flatMap((section) =>
        section.id === 'groups'
          ? []
          : section.sessions.map((s) => [
              s.id,
              label(s.updatedAt, 'en-US', sectionTimeBucket(section.id)),
            ]),
      ),
    )
  }

  it('follows the bucket of the section it is listed in', () => {
    const lastMonth = at(2026, 10, 6, 15, 30)
    const sessions = [
      session('live', { updatedAt: lastMonth }),
      session('settled', { updatedAt: lastMonth }),
    ]
    expect(labels(sessions, ['live'])).toEqual({ live: '30 days ago', settled: 'Oct 6' })
  })

  it('says how long ago for a pinned Session, however old', () => {
    const pinned = session('pin', { pinned: true, updatedAt: at(2026, 10, 15, 15, 30) })
    expect(labels([pinned])).toEqual({ pin: '21 days ago' })
  })
})
