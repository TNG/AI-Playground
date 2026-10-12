import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  decideScheduledRun,
  describeSchedule,
  isTaskDue,
  nextRunAt,
  runsToPrune,
  taskNextRunAt,
} from '@/lib/agentTaskSchedule'
import type { AgentTask, AgentTaskSchedule } from '@/types/agentMakerIpc'

// A zone with a DST switch, so wall-clock schedules are tested across it.
const originalTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Europe/Berlin'
})
afterAll(() => {
  process.env.TZ = originalTz
})

const local = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime()

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    schemaVersion: 3,
    id: 't',
    name: 'T',
    slug: 't',
    steps: ['x'],
    model: { backend: 'llamaCPP', model: 'm' },
    capabilities: [],
    createdAt: 0,
    updatedAt: 0,
    schedule: { kind: 'interval', everyMinutes: 60 },
    ...overrides,
  }
}

describe('nextRunAt', () => {
  it('spaces an interval from the last run', () => {
    expect(nextRunAt({ kind: 'interval', everyMinutes: 90 }, local(2026, 1, 5, 10))).toBe(
      local(2026, 1, 5, 11, 30),
    )
  })

  it('runs daily later today, or tomorrow once the time has passed', () => {
    const daily = { kind: 'daily', time: '08:30' } as const
    expect(nextRunAt(daily, local(2026, 1, 5, 7))).toBe(local(2026, 1, 5, 8, 30))
    expect(nextRunAt(daily, local(2026, 1, 5, 8, 30))).toBe(local(2026, 1, 6, 8, 30))
  })

  it('keeps the wall-clock time across a DST switch', () => {
    // Berlin moves to summer time on 2026-03-29.
    const next = nextRunAt({ kind: 'daily', time: '08:00' }, local(2026, 3, 28, 9))
    expect(new Date(next).getHours()).toBe(8)
    expect(new Date(next).getDate()).toBe(29)
  })

  it('wraps a weekly schedule to the next week', () => {
    // 2026-01-09 is a Friday; Monday only → 2026-01-12.
    const weekly: AgentTaskSchedule = { kind: 'weekly', days: [1], time: '09:00' }
    expect(nextRunAt(weekly, local(2026, 1, 9, 12))).toBe(local(2026, 1, 12, 9))
    // Same weekday, time already passed → a week later.
    expect(nextRunAt(weekly, local(2026, 1, 12, 9, 1))).toBe(local(2026, 1, 19, 9))
  })
})

describe('taskNextRunAt / isTaskDue', () => {
  it('ignores tasks without a schedule', () => {
    expect(taskNextRunAt(task({ schedule: undefined }), 0)).toBeNull()
  })

  it('does not catch up on times missed while the app was closed', () => {
    const armedAt = local(2026, 1, 5, 12)
    const stale = task({ lastScheduledAt: local(2026, 1, 5, 6) })
    expect(isTaskDue(stale, armedAt, armedAt)).toBe(false)
    expect(isTaskDue(stale, armedAt, local(2026, 1, 5, 13))).toBe(true)
  })

  it('counts from the last handled time once that is later than arming', () => {
    const t = task({ lastScheduledAt: local(2026, 1, 5, 14) })
    expect(taskNextRunAt(t, local(2026, 1, 5, 12))).toBe(local(2026, 1, 5, 15))
  })
})

describe('decideScheduledRun', () => {
  const idle = {
    runActive: false,
    agentModeVisible: false,
    agentTurnRunning: false,
    modelMissing: false,
  }

  it('runs when nothing is busy', () => {
    expect(decideScheduledRun(idle)).toEqual({ action: 'run' })
  })

  it('skips while another run is going', () => {
    expect(decideScheduledRun({ ...idle, runActive: true, modelMissing: true })).toEqual({
      action: 'skip',
      reason: 'busy',
    })
  })

  it('skips while the agent session is in use', () => {
    expect(decideScheduledRun({ ...idle, agentModeVisible: true })).toMatchObject({
      reason: 'agent-in-use',
    })
    expect(decideScheduledRun({ ...idle, agentTurnRunning: true })).toMatchObject({
      reason: 'agent-in-use',
    })
  })

  it('fails instead of prompting for a missing model', () => {
    expect(decideScheduledRun({ ...idle, modelMissing: true })).toEqual({
      action: 'fail',
      reason: 'model-missing',
    })
  })
})

describe('runsToPrune', () => {
  const runs = Array.from({ length: 13 }, (_, i) => ({ id: `r${i}`, createdAt: i }))

  it('keeps the newest ten', () => {
    expect(runsToPrune(runs, []).sort()).toEqual(['r0', 'r1', 'r2'])
  })

  it('never deletes the live or the open run', () => {
    expect(runsToPrune(runs, ['r1', null]).sort()).toEqual(['r0', 'r2'])
  })
})

describe('describeSchedule', () => {
  const labels = {
    everyMinutes: 'Every {count} min',
    everyHours: 'Every {count} h',
    dailyAt: 'Daily at {time}',
    weeklyAt: '{days} at {time}',
  }

  it('says hours when the interval is whole hours', () => {
    expect(describeSchedule({ kind: 'interval', everyMinutes: 120 }, labels, 'en-GB')).toBe(
      'Every 2 h',
    )
    expect(describeSchedule({ kind: 'interval', everyMinutes: 45 }, labels, 'en-GB')).toBe(
      'Every 45 min',
    )
  })

  it('lists weekdays Monday first', () => {
    expect(
      describeSchedule({ kind: 'weekly', days: [0, 3, 1], time: '08:00' }, labels, 'en-GB'),
    ).toBe('Mon, Wed, Sun at 08:00')
  })
})
