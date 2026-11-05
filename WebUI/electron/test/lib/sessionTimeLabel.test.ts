import { describe, expect, it } from 'vitest'
import { sessionTimeLabel } from '@/lib/sessionTimeLabel'

const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s).getTime()
const NOW = at(2026, 11, 5, 15, 30)
const label = (time: number, locale: string, live = false) =>
  sessionTimeLabel(time, NOW, locale, live).replace(/\s/g, ' ')

describe('sessionTimeLabel', () => {
  it('says how long ago under Today', () => {
    expect(label(at(2026, 11, 5, 15, 25), 'en-US')).toBe('5 min. ago')
    expect(label(at(2026, 11, 5, 12, 10), 'en-US')).toBe('3 hr. ago')
    expect(label(at(2026, 11, 5, 15, 25), 'de')).toBe('vor 5 Min.')
    expect(label(at(2026, 11, 5, 12, 10), 'de')).toBe('vor 3 Std.')
  })

  it('says now for anything under a minute old', () => {
    expect(label(at(2026, 11, 5, 15, 29, 30), 'en-US')).toBe('now')
    expect(label(NOW, 'en-US')).toBe('now')
    expect(label(at(2026, 11, 5, 15, 29, 30), 'de')).toBe('jetzt')
  })

  it('gives the time of day under Yesterday', () => {
    expect(label(at(2026, 11, 4, 23, 50), 'en-US')).toBe('11:50 PM')
    expect(label(at(2026, 11, 4, 9, 5), 'de')).toBe('09:05')
  })

  it('gives the weekday and time under Previous 7 days', () => {
    expect(label(at(2026, 11, 3, 14, 5), 'en-US')).toBe('Tue 2:05 PM')
    expect(label(at(2026, 10, 29, 8, 0), 'de')).toBe('Do., 08:00')
  })

  it('gives the date under Older, with the year only when it is a past one', () => {
    expect(label(at(2026, 10, 28, 8, 0), 'en-US')).toBe('Oct 28')
    expect(label(at(2026, 3, 14), 'de')).toBe('14. März')
    expect(label(at(2025, 3, 14), 'en-US')).toBe('Mar 14, 2025')
    expect(label(at(2025, 3, 14), 'de')).toBe('14. März 2025')
  })

  it('says how long ago for a live Session listed under Today, however old its last turn', () => {
    expect(label(at(2026, 11, 5, 12, 10), 'en-US', true)).toBe('3 hr. ago')
    expect(label(at(2026, 11, 4, 23, 30), 'en-US', true)).toBe('16 hr. ago')
    expect(label(at(2026, 10, 6, 15, 30), 'en-US', true)).toBe('30 days ago')
    expect(label(at(2026, 10, 6, 15, 30), 'de', true)).toBe('vor 30 Tagen')
  })
})
