const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** A named range, a whole number of minutes or hours back, or an explicit date/timestamp window. */
export type OverviewRangeInput =
  | 'last-24h'
  | 'today'
  | 'yesterday'
  | 'last-7-days'
  | 'last-30-days'
  | { from: string; to: string }
  | { lastHours: number }
  | { lastMinutes: number }

export type OverviewWindow = { from: number; to: number }

export const OVERVIEW_NAMED_RANGES = [
  'last-24h',
  'today',
  'yesterday',
  'last-7-days',
  'last-30-days',
] as const satisfies readonly OverviewRangeInput[]

/** The longest `{ lastHours }` window accepted: a year of hours. */
export const OVERVIEW_MAX_LAST_HOURS = 8760

/** The longest `{ lastMinutes }` window accepted: a day of minutes. */
export const OVERVIEW_MAX_LAST_MINUTES = 1440

/** A range the caller got wrong, as opposed to something failing on our side. */
export class OverviewRangeError extends Error {
  override name = 'OverviewRangeError'
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Adds calendar days in local time, so a DST change does not stretch a day. */
function addLocalDays(ms: number, days: number): number {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function parsePoint(value: string): number | null {
  const trimmed = value.trim()
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (dateOnly) {
    const [, year, month, day] = dateOnly
    return new Date(Number(year), Number(month) - 1, Number(day)).getTime()
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * The concrete window a range names. `last-24h` rolls from now; `today` and
 * `yesterday` are local calendar days; the day ranges are local-midnight aligned
 * and end at now. Everything is the machine's local timezone.
 */
export function resolveOverviewWindow(
  range: OverviewRangeInput,
  now: number = Date.now(),
): OverviewWindow {
  switch (range) {
    case 'last-24h':
      return { from: now - DAY_MS, to: now }
    case 'today': {
      const start = startOfLocalDay(now)
      return { from: start, to: addLocalDays(start, 1) }
    }
    case 'yesterday': {
      const today = startOfLocalDay(now)
      return { from: addLocalDays(today, -1), to: today }
    }
    case 'last-7-days':
      return { from: addLocalDays(startOfLocalDay(now), -6), to: now }
    case 'last-30-days':
      return { from: addLocalDays(startOfLocalDay(now), -29), to: now }
  }
  if (typeof range === 'object' && range !== null && 'lastMinutes' in range) {
    const { lastMinutes } = range
    if (
      !Number.isInteger(lastMinutes) ||
      lastMinutes < 1 ||
      lastMinutes > OVERVIEW_MAX_LAST_MINUTES
    ) {
      throw new OverviewRangeError(
        `The minute count must be a whole number from 1 to ${OVERVIEW_MAX_LAST_MINUTES}.`,
      )
    }
    return { from: now - lastMinutes * MINUTE_MS, to: now }
  }
  if (typeof range === 'object' && range !== null && 'lastHours' in range) {
    const { lastHours } = range
    if (!Number.isInteger(lastHours) || lastHours < 1 || lastHours > OVERVIEW_MAX_LAST_HOURS) {
      throw new OverviewRangeError(
        `The hour count must be a whole number from 1 to ${OVERVIEW_MAX_LAST_HOURS}.`,
      )
    }
    return { from: now - lastHours * HOUR_MS, to: now }
  }
  if (typeof range === 'object' && range !== null) {
    const from = parsePoint(range.from)
    const to = parsePoint(range.to)
    if (from === null) throw new OverviewRangeError(`Not a date: ${range.from}`)
    if (to === null) throw new OverviewRangeError(`Not a date: ${range.to}`)
    if (from >= to) throw new OverviewRangeError('The range must start before it ends.')
    return { from, to }
  }
  throw new OverviewRangeError(`Unknown range: ${String(range)}`)
}
