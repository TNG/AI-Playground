import type { AgentSessionRecord } from '@/assets/js/store/agentModeSessions'
import type { AgentTask, AgentTaskSchedule } from '@/types/agentMakerIpc'

/**
 * Scheduling for Agent Maker tasks, store-free so it is unit-testable. Times are
 * local wall-clock times; scheduled runs only happen while the app is running,
 * and missed times are never caught up.
 */

const MINUTE = 60_000

function atTimeOfDay(base: Date, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number)
  const next = new Date(base)
  next.setHours(hours, minutes, 0, 0)
  return next
}

/** The first scheduled time strictly after `from`. */
export function nextRunAt(schedule: AgentTaskSchedule, from: number): number {
  if (schedule.kind === 'interval') return from + schedule.everyMinutes * MINUTE
  const days = schedule.kind === 'daily' ? null : new Set(schedule.days)
  const start = new Date(from)
  // Eight days covers "same weekday next week" when today's time has passed.
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset)
    if (days && !days.has(day.getDay())) continue
    const candidate = atTimeOfDay(day, schedule.time).getTime()
    if (candidate > from) return candidate
  }
  throw new Error('A weekly schedule needs at least one day.')
}

/**
 * When the task's schedule fires next. `armedAt` is when the scheduler started
 * watching this schedule (app start, or the last edit), so a time missed while
 * the app was closed is skipped rather than run on start.
 */
export function taskNextRunAt(task: AgentTask, armedAt: number): number | null {
  if (!task.schedule) return null
  return nextRunAt(task.schedule, Math.max(task.lastScheduledAt ?? 0, armedAt))
}

export function isTaskDue(task: AgentTask, armedAt: number, now: number): boolean {
  const next = taskNextRunAt(task, armedAt)
  return next !== null && next <= now
}

export type ScheduledRunDecision =
  | { action: 'run' }
  | { action: 'skip'; reason: 'busy' | 'agent-in-use' }
  | { action: 'fail'; reason: 'model-missing' }

/** What a due schedule does, given what the app is busy with right now. */
export function decideScheduledRun(state: {
  runActive: boolean
  agentModeVisible: boolean
  agentTurnRunning: boolean
  modelMissing: boolean
}): ScheduledRunDecision {
  if (state.runActive) return { action: 'skip', reason: 'busy' }
  if (state.agentModeVisible || state.agentTurnRunning) {
    return { action: 'skip', reason: 'agent-in-use' }
  }
  if (state.modelMissing) return { action: 'fail', reason: 'model-missing' }
  return { action: 'run' }
}

export const KEPT_RUNS_PER_TASK = 10

/** Runs to delete so a task keeps its newest `keep`; the live and the open run are never deleted. */
export function runsToPrune(
  runs: readonly Pick<AgentSessionRecord, 'id' | 'createdAt'>[],
  protectedIds: readonly (string | null | undefined)[],
  keep = KEPT_RUNS_PER_TASK,
): string[] {
  const keepIds = new Set(protectedIds.filter((id): id is string => !!id))
  return [...runs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(keep)
    .map((run) => run.id)
    .filter((id) => !keepIds.has(id))
}

export type ScheduleLabels = {
  everyMinutes: string
  everyHours: string
  dailyAt: string
  weeklyAt: string
}

export function formatTimeOfDay(time: string, locale: string): string {
  return atTimeOfDay(new Date(2024, 0, 1), time).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Short weekday names, Sunday first (2024-01-07 was a Sunday). */
export function weekdayNames(locale: string): string[] {
  return Array.from({ length: 7 }, (_, day) =>
    new Date(2024, 0, 7 + day).toLocaleDateString(locale, { weekday: 'short' }),
  )
}

/** "Every 2 h", "Daily at 08:00", "Mon, Wed at 08:00". */
export function describeSchedule(
  schedule: AgentTaskSchedule,
  labels: ScheduleLabels,
  locale: string,
): string {
  if (schedule.kind === 'interval') {
    const hours = schedule.everyMinutes / 60
    return Number.isInteger(hours)
      ? labels.everyHours.replace('{count}', String(hours))
      : labels.everyMinutes.replace('{count}', String(schedule.everyMinutes))
  }
  const time = formatTimeOfDay(schedule.time, locale)
  if (schedule.kind === 'daily') return labels.dailyAt.replace('{time}', time)
  const names = weekdayNames(locale)
  // Monday-first reads naturally for a week; Sunday goes last.
  const days = [...schedule.days]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((day) => names[day])
    .join(', ')
  return labels.weeklyAt.replace('{days}', days).replace('{time}', time)
}

export function formatRunTime(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
