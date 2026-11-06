import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '@/types/agentTaskIpc'

// Agents outlive the Session they were made in: deleting it keeps them in the Agents
// file and drops only the Schedules that ran in it, driven against real files in a temp dir.

const dirs = vi.hoisted(() => ({ root: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => path.join(dirs.root, 'sessions'),
  getSessionsDemoDir: () => path.join(dirs.root, 'sessions-demo'),
  getAgentTasksFile: () => path.join(dirs.root, 'agent-tasks.json'),
  getAgentTasksDemoFile: () => path.join(dirs.root, 'agent-tasks-demo.json'),
  getGamesDir: () => path.join(dirs.root, 'games'),
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const sessions = await import('../../session/sessions')
const taskFiles = await import('../../persist/agentTaskFiles')
const { dropSchedulesWithSession } = await import('../../session/sessionTaskRuns')

function task(id: string, sessionRef: string): AgentTask {
  return {
    id,
    name: id,
    sessionRef,
    settingsTemplate: {},
    steps: [{ id: 's', prompt: 'go' }],
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeAll(async () => {
  dirs.root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-tasks-'))
})

beforeEach(() => {
  sessions.setSessionDeps({ isDemoMode: () => false })
  taskFiles.setAgentTaskFilesDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  sessions.resetSessionsForTest()
  taskFiles.resetAgentTaskFilesForTest()
  await fs.rm(path.join(dirs.root, 'sessions'), { recursive: true, force: true })
  await fs.rm(path.join(dirs.root, 'agent-tasks.json'), { force: true })
})

describe('deleting a Session', () => {
  it('keeps its Agents, dropping the Schedules that ran in it, and leaves other Agents alone', async () => {
    dropSchedulesWithSession()
    const doomed = await sessions.createSession()
    const kept = await sessions.createSession()
    const daily = { every: 1, unit: 'days' as const, startAt: 100, enabled: true, nextRunAt: 200 }
    const inDoomed = { sessionRef: doomed.id, ...daily }
    const inKept = { sessionRef: kept.id, ...daily }
    await taskFiles.saveAgentTask({ ...task('a', doomed.id), schedules: [inDoomed, inKept] })
    await taskFiles.saveAgentTask({ ...task('b', kept.id), schedules: [inKept] })

    await sessions.deleteSession(doomed.id)

    const { sessionRef: _gone, ...made } = task('a', doomed.id)
    expect(await taskFiles.readAgentTasks()).toEqual([
      { ...made, schedules: [inKept] },
      { ...task('b', kept.id), schedules: [inKept] },
    ])
  })
})
