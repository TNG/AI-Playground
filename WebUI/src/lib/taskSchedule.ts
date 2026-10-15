import {
  MIN_SCHEDULE_MINUTES,
  type AgentTaskSchedule,
  type AgentTaskScheduleUnit,
} from '@/types/agentTaskIpc'

export type ScheduleProblem = 'invalid-count' | 'too-short' | 'missing-start'

const MINUTE_MS = 60_000
const FIXED_UNIT_MS = { minutes: MINUTE_MS, hours: 60 * MINUTE_MS } as const
const CALENDAR_UNIT_DAYS = { days: 1, weeks: 7 } as const

export function scheduleProblem(schedule: AgentTaskSchedule): ScheduleProblem | null {
  if (!Number.isInteger(schedule.every) || schedule.every < 1) return 'invalid-count'
  if (schedule.unit === 'minutes' && schedule.every < MIN_SCHEDULE_MINUTES) return 'too-short'
  if (!Number.isFinite(schedule.startAt)) return 'missing-start'
  return null
}

/** The nominal length of one interval; days and weeks may differ by an hour across DST. */
export function scheduleIntervalMs(every: number, unit: AgentTaskScheduleUnit): number {
  return unit === 'minutes' || unit === 'hours'
    ? every * FIXED_UNIT_MS[unit]
    : every * CALENDAR_UNIT_DAYS[unit] * 24 * 60 * MINUTE_MS
}

/** The smallest slot `startAt + k × interval` (k ≥ 0) strictly after `after`. */
export function nextSlotAfter(schedule: AgentTaskSchedule, after: number): number {
  const { every, unit, startAt } = schedule
  if (startAt > after) return startAt
  if (unit === 'minutes' || unit === 'hours') {
    const interval = scheduleIntervalMs(every, unit)
    return startAt + (Math.floor((after - startAt) / interval) + 1) * interval
  }
  const slot = calendarSlots(startAt, every * CALENDAR_UNIT_DAYS[unit])
  let k = Math.max(0, Math.floor((after - startAt) / scheduleIntervalMs(every, unit)))
  while (slot(k) <= after) k++
  while (k > 0 && slot(k - 1) > after) k--
  return slot(k)
}

export type NextRunStrings = { today: string; tomorrow: string }

export function describeNextRun(
  at: number,
  now: number,
  locale: string,
  strings: NextRunStrings,
): string {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at)
  const days = localDayNumber(at) - localDayNumber(now)
  if (days === 0) return strings.today.replace('{time}', time)
  if (days === 1) return strings.tomorrow.replace('{time}', time)
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
}

function localDayNumber(at: number): number {
  const date = new Date(at)
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
}

/** Slot k as a local date k × days after the start, at the start's wall-clock time. */
function calendarSlots(startAt: number, days: number): (k: number) => number {
  const start = new Date(startAt)
  return (k) =>
    new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + k * days,
      start.getHours(),
      start.getMinutes(),
      start.getSeconds(),
      start.getMilliseconds(),
    ).getTime()
}
