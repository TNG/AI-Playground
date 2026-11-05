import { dateBucket } from '@/lib/sessionSections'

const MINUTE_MS = 60_000

function relativeLabel(time: number, now: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  const minutes = Math.floor((now - time) / MINUTE_MS)
  if (minutes < 1) return format.format(0, 'second')
  if (minutes < 60) return format.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return format.format(-hours, 'hour')
  return format.format(-Math.floor(hours / 24), 'day')
}

/** A Session row's time, worded for the date bucket it is listed under (a live one under Today). */
export function sessionTimeLabel(time: number, now: number, locale: string, live = false): string {
  switch (live ? 'today' : dateBucket(time, now)) {
    case 'today':
      return relativeLabel(time, now, locale)
    case 'yesterday':
      return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(time)
    case 'previous7Days':
      return new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(time)
    case 'older': {
      const pastYear = new Date(time).getFullYear() !== new Date(now).getFullYear()
      return new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        year: pastYear ? 'numeric' : undefined,
      }).format(time)
    }
  }
}
