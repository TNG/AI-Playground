import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDraft, AgentTask } from '@/types/agentTaskIpc'

// The kernel-owned Tasks file, driven against a real file in a temp dir: the
// read/upsert/delete round trip, rejection of a corrupt file or an invalid
// payload, and demo routing + wipe.

const files = vi.hoisted(() => ({ real: '', demo: '', drafts: '', draftsDemo: '' }))
let tmpRoot = ''

vi.mock('../../persist/userDataPaths.ts', () => ({
  getAgentTasksFile: () => files.real,
  getAgentTasksDemoFile: () => files.demo,
  getAgentDraftsFile: () => files.drafts,
  getAgentDraftsDemoFile: () => files.draftsDemo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  deleteAgentDraft,
  deleteAgentTask,
  readAgentDrafts,
  saveAgentDraft,
  forgetSessionInAgentTasks,
  readAgentTasks,
  resetAgentTaskFilesForTest,
  saveAgentTask,
  setAgentTaskFilesDeps,
  wipeDemoAgentTasks,
} = await import('../../persist/agentTaskFiles')

function task(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    name: `Task ${id}`,
    sessionRef: 'session-1',
    settingsTemplate: { backend: 'llamaCPP', model: 'Qwen-9B', capabilities: ['files'] },
    steps: [
      { id: 's1', prompt: 'first' },
      { id: 's2', prompt: 'second' },
    ],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function draft(agentId: string, overrides: Partial<AgentDraft> = {}): AgentDraft {
  return {
    agentId,
    name: `Draft ${agentId}`,
    description: 'Checks the news',
    image: 'data:image/png;base64,AAAA',
    settingsTemplate: { backend: 'llamaCPP', model: 'Qwen-9B', capabilities: ['files'] },
    steps: [{ id: 's1', prompt: 'edited' }],
    updatedAt: 3,
    ...overrides,
  }
}

async function readRaw(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

beforeEach(async () => {
  resetAgentTaskFilesForTest()
  if (!tmpRoot) tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-agent-tasks-'))
  files.real = path.join(tmpRoot, 'agent-tasks.json')
  files.demo = path.join(tmpRoot, 'agent-tasks-demo.json')
  files.drafts = path.join(tmpRoot, 'agent-drafts.json')
  files.draftsDemo = path.join(tmpRoot, 'agent-drafts-demo.json')
  for (const file of [files.real, files.demo, files.drafts, files.draftsDemo])
    await fs.rm(file, { force: true })
  setAgentTaskFilesDeps({ isDemoMode: () => false })
})

afterEach(() => {
  resetAgentTaskFilesForTest()
})

describe('the kernel Tasks file', () => {
  it('reads an absent file as no Tasks', async () => {
    expect(await readAgentTasks()).toEqual([])
  })

  it('round-trips saved Tasks with a schema version', async () => {
    await saveAgentTask(task('a'))
    await saveAgentTask(task('b'))

    expect(await readAgentTasks()).toEqual([task('a'), task('b')])
    expect((await readRaw(files.real))?.schemaVersion).toBe(3)
  })

  it('replaces a Task with the same id in place', async () => {
    await saveAgentTask(task('a'))
    await saveAgentTask(task('b'))
    const outcome = {
      kind: 'completed' as const,
      at: 5,
      sessionId: 'aipg-agent-1',
      stepCount: 2,
    }

    await saveAgentTask(task('a', { name: 'Renamed', lastOutcome: outcome }))

    expect(await readAgentTasks()).toEqual([
      task('a', { name: 'Renamed', lastOutcome: outcome }),
      task('b'),
    ])
  })

  it('round-trips run markers and an app-closed outcome', async () => {
    const activeRuns = [
      { sessionId: 'aipg-agent-1', sessionRef: 'session-1', stepIndex: 2, stepCount: 3 },
      { sessionId: 'aipg-agent-2', sessionRef: 'session-2', stepIndex: 1, stepCount: 3 },
    ]
    const outcome = {
      kind: 'failed' as const,
      at: 9,
      sessionId: 'aipg-agent-1',
      stepIndex: 2,
      stepCount: 3,
      reason: 'app-closed' as const,
    }

    await saveAgentTask(task('a', { activeRuns }))
    expect(await readAgentTasks()).toEqual([task('a', { activeRuns })])

    await saveAgentTask(task('a', { lastOutcome: outcome }))
    expect(await readAgentTasks()).toEqual([task('a', { lastOutcome: outcome })])
  })

  it('round-trips the outcome of a Scheduled Run that could not start, which has no session', async () => {
    const outcome = {
      kind: 'failed' as const,
      at: 9,
      stepCount: 3,
      message: 'The workspace folder is missing: /work',
      reason: 'not-started' as const,
    }

    await saveAgentTask(task('a', { lastOutcome: outcome }))

    expect(await readAgentTasks()).toEqual([task('a', { lastOutcome: outcome })])
  })

  it('round-trips one Agent scheduled in two Sessions, each with its own Next Run', async () => {
    const schedules = [
      {
        sessionRef: 'session-1',
        every: 1,
        unit: 'days' as const,
        startAt: 1_000,
        enabled: true,
        nextRunAt: 86_401_000,
      },
      { sessionRef: 'session-2', every: 2, unit: 'hours' as const, startAt: 1_000, enabled: false },
    ]

    await saveAgentTask(task('a', { schedules }))

    expect(await readAgentTasks()).toEqual([task('a', { schedules })])
  })

  it('reads a file written before Schedules existed', async () => {
    await fs.writeFile(files.real, JSON.stringify({ schemaVersion: 1, tasks: [task('a')] }), 'utf8')

    const [read] = await readAgentTasks()

    expect(read).toEqual(task('a'))
    expect(read).not.toHaveProperty('schedules')
  })

  it("moves an Agent's old Schedule into a Schedule in the Agent's Session", async () => {
    const schedule = { every: 2, unit: 'hours', startAt: 1_000, enabled: true }
    const old = { ...task('a'), schedule, nextRunAt: 7_201_000 }
    await fs.writeFile(files.real, JSON.stringify({ schemaVersion: 1, tasks: [old] }), 'utf8')

    const [read] = await readAgentTasks()

    expect(read).toEqual(
      task('a', {
        schedules: [{ sessionRef: 'session-1', ...schedule, nextRunAt: 7_201_000 } as never],
      }),
    )
  })

  it('drops an old Schedule that has no Session to run in', async () => {
    const { sessionRef: _none, ...legacy } = task('old')
    const schedule = { every: 10, unit: 'minutes', startAt: 1, enabled: true }
    const old = { ...legacy, schedule, nextRunAt: 601 }
    await fs.writeFile(files.real, JSON.stringify({ schemaVersion: 1, tasks: [old] }), 'utf8')

    const [read] = await readAgentTasks()

    expect(read).toEqual(legacy)
  })

  it("moves an old run marker into the Agent's run markers, in the Session it ran in", async () => {
    const activeRun = { sessionId: 'aipg-agent-1', stepIndex: 2, stepCount: 3 }
    const old = { ...task('a'), activeRun }
    await fs.writeFile(files.real, JSON.stringify({ schemaVersion: 1, tasks: [old] }), 'utf8')

    const [read] = await readAgentTasks()

    expect(read).toEqual(task('a', { activeRuns: [{ ...activeRun, sessionRef: 'session-1' }] }))
  })

  it('writes the migrated shape back on the next upsert', async () => {
    const schedule = { every: 2, unit: 'hours', startAt: 1_000, enabled: true }
    const old = { ...task('a'), schedule, nextRunAt: 7_201_000 }
    await fs.writeFile(files.real, JSON.stringify({ schemaVersion: 1, tasks: [old] }), 'utf8')

    await saveAgentTask(task('b'))

    const raw = (await readRaw(files.real)) as { tasks: Record<string, unknown>[] }
    expect(raw.tasks[0]).not.toHaveProperty('schedule')
    expect(raw.tasks[0]).toMatchObject({ schedules: [{ sessionRef: 'session-1', every: 2 }] })
  })

  it('reads a Task saved before Tasks belonged to a Session, and keeps it on an upsert', async () => {
    const { sessionRef: _none, ...legacy } = task('old')
    const old = { ...legacy, workspaceDir: '/work/project' }
    await fs.writeFile(files.real, JSON.stringify({ schemaVersion: 1, tasks: [old] }), 'utf8')

    await saveAgentTask(task('new'))

    expect(await readAgentTasks()).toEqual([old, task('new')])
  })

  it("keeps a deleted Session's Agents and their Schedules in other Sessions", async () => {
    const { sessionRef: _none, ...legacy } = task('old')
    const daily = { every: 1, unit: 'days' as const, startAt: 100, enabled: true, nextRunAt: 200 }
    const here = { sessionRef: 'session-1', ...daily }
    const there = { sessionRef: 'session-2', ...daily }
    const outcome = { kind: 'completed' as const, at: 5, stepCount: 1 }
    await saveAgentTask(task('a', { schedules: [here, there], lastOutcome: outcome }))
    await saveAgentTask(task('b', { sessionRef: 'session-2', schedules: [there] }))
    await saveAgentTask({ ...legacy, schedules: [here] })

    await forgetSessionInAgentTasks('session-1')

    const { sessionRef: _gone, ...keptA } = task('a', { schedules: [there], lastOutcome: outcome })
    expect(await readAgentTasks()).toEqual([
      keptA,
      task('b', { sessionRef: 'session-2', schedules: [there] }),
      legacy,
    ])
  })

  it('deletes one Task and keeps the others', async () => {
    await saveAgentTask(task('a'))
    await saveAgentTask(task('b'))

    await deleteAgentTask('a')

    expect(await readAgentTasks()).toEqual([task('b')])
  })

  it('treats deleting from an absent file as done', async () => {
    await deleteAgentTask('a')
    expect(await readRaw(files.real)).toBeNull()
  })

  it('rejects a payload that is not a Task', async () => {
    await expect(saveAgentTask({ id: 'a', name: 'no steps' })).rejects.toThrow(/invalid task/)
    await expect(saveAgentTask(task(''))).rejects.toThrow(/invalid task/)
    expect(await readRaw(files.real)).toBeNull()
  })

  it('rejects a delete without a task id', async () => {
    await expect(deleteAgentTask(5)).rejects.toThrow(/task id/)
  })

  it('treats a corrupt file as a failed read and never overwrites it', async () => {
    await fs.writeFile(files.real, 'not json', 'utf8')

    await expect(readAgentTasks()).rejects.toThrow(/unreadable/)
    await expect(saveAgentTask(task('a'))).rejects.toThrow(/unreadable/)
    await expect(deleteAgentTask('a')).rejects.toThrow(/unreadable/)
    expect(await fs.readFile(files.real, 'utf8')).toBe('not json')
  })

  it('treats a schema-invalid file as unreadable too', async () => {
    await fs.writeFile(
      files.real,
      JSON.stringify({ schemaVersion: 1, tasks: [{ id: 'a', steps: 'nope' }] }),
      'utf8',
    )
    await expect(readAgentTasks()).rejects.toThrow(/unreadable/)
  })

  it('routes Tasks through the demo file when demo mode is on', async () => {
    setAgentTaskFilesDeps({ isDemoMode: () => true })

    await saveAgentTask(task('demo'))

    expect(await readRaw(files.real)).toBeNull()
    expect(await readAgentTasks()).toEqual([task('demo')])
  })

  it('wipes only the demo file', async () => {
    await saveAgentTask(task('real'))
    setAgentTaskFilesDeps({ isDemoMode: () => true })
    await saveAgentTask(task('demo'))

    await wipeDemoAgentTasks()

    expect(await readRaw(files.demo)).toBeNull()
    setAgentTaskFilesDeps({ isDemoMode: () => false })
    expect(await readAgentTasks()).toEqual([task('real')])
  })
})

describe('the kernel Drafts file', () => {
  it('round-trips an Agent with a description and an image', async () => {
    const described = task('a', { description: 'Morning digest', image: 'data:image/png;base64,B' })
    await saveAgentTask(described)

    expect(await readAgentTasks()).toEqual([described])
  })

  it('reads an absent file as no Drafts', async () => {
    expect(await readAgentDrafts()).toEqual([])
  })

  it('keeps Drafts across a restart, one per Agent', async () => {
    await saveAgentDraft(draft('a'))
    await saveAgentDraft(draft('b'))
    await saveAgentDraft(draft('a', { name: 'Renamed' }))

    resetAgentTaskFilesForTest()
    setAgentTaskFilesDeps({ isDemoMode: () => false })

    expect(await readAgentDrafts()).toEqual([draft('a', { name: 'Renamed' }), draft('b')])
  })

  it('keeps a Draft apart from the saved Agent', async () => {
    await saveAgentTask(task('a'))
    await saveAgentDraft(draft('a'))

    expect(await readAgentTasks()).toEqual([task('a')])
  })

  it('discards one Draft and keeps the others', async () => {
    await saveAgentDraft(draft('a'))
    await saveAgentDraft(draft('b'))

    await deleteAgentDraft('a')

    expect(await readAgentDrafts()).toEqual([draft('b')])
  })

  it("removes an Agent's Draft when the Agent is deleted", async () => {
    await saveAgentTask(task('a'))
    await saveAgentDraft(draft('a'))
    await saveAgentDraft(draft('b'))

    await deleteAgentTask('a')

    expect(await readAgentDrafts()).toEqual([draft('b')])
  })

  it('removes the Draft of an Agent that was never saved', async () => {
    await saveAgentDraft(draft('new'))

    await deleteAgentTask('new')

    expect(await readAgentDrafts()).toEqual([])
  })

  it('rejects a payload that is not a Draft', async () => {
    await expect(saveAgentDraft({ agentId: 'a' })).rejects.toThrow(/invalid draft/)
    expect(await readRaw(files.drafts)).toBeNull()
  })

  it('routes Drafts through the demo file and wipes it with the demo Agents', async () => {
    await saveAgentDraft(draft('real'))
    setAgentTaskFilesDeps({ isDemoMode: () => true })
    await saveAgentDraft(draft('demo'))
    expect(await readAgentDrafts()).toEqual([draft('demo')])

    await wipeDemoAgentTasks()

    expect(await readRaw(files.draftsDemo)).toBeNull()
    setAgentTaskFilesDeps({ isDemoMode: () => false })
    expect(await readAgentDrafts()).toEqual([draft('real')])
  })
})
