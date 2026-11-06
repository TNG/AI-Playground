import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '@/types/agentTaskIpc'
import { createShutdown, type ShutdownCause } from '../../kernel/shutdown'
import {
  readAgentTasks,
  resetAgentTaskFilesForTest,
  saveAgentTask,
  settleTaskRunsOnQuit,
} from '../../persist/agentTaskFiles'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

const tasksFile = vi.hoisted(() => ({ path: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getAgentTasksFile: () => tasksFile.path,
  getAgentTasksDemoFile: () => `${tasksFile.path}.demo`,
}))

const silentLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createShutdown', () => {
  it('runs steps once, in registration order', async () => {
    const order: string[] = []
    const shutdown = createShutdown(silentLogger())
    shutdown.register({ name: 'agent', run: () => order.push('agent') })
    shutdown.register({ name: 'services', run: async () => void order.push('services') })

    await shutdown.shutdown('quit')
    await shutdown.shutdown('quit')

    expect(order).toEqual(['agent', 'services'])
  })

  it('keeps tearing down after a step throws', async () => {
    const logger = silentLogger()
    const shutdown = createShutdown(logger)
    shutdown.register({
      name: 'wedged backend',
      run: () => {
        throw new Error('port already closed')
      },
    })
    const after = vi.fn()
    shutdown.register({ name: 'cloud proxy', run: after })

    await shutdown.shutdown('quit')

    expect(after).toHaveBeenCalledOnce()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('wedged backend failed to stop'),
      'shutdown',
    )
  })

  it('gives up on a hanging step so quitting is never blocked', async () => {
    const logger = silentLogger()
    const shutdown = createShutdown(logger)
    shutdown.register({ name: 'hanging backend', run: () => new Promise(() => {}) })

    await shutdown.shutdown('quit', 20)

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('still running after 20ms'),
      'shutdown',
    )
  })

  it('reports that it is shutting down from the first call onwards', async () => {
    const shutdown = createShutdown(silentLogger())
    let sawFlagDuringTeardown = false
    shutdown.register({
      name: 'slow backend',
      run: async () => {
        await nap(5)
        sawFlagDuringTeardown = shutdown.isShuttingDown()
      },
    })

    expect(shutdown.isShuttingDown()).toBe(false)
    await shutdown.shutdown('quit')

    expect(sawFlagDuringTeardown).toBe(true)
    expect(shutdown.isShuttingDown()).toBe(true)
  })

  it('tells every step why the app is shutting down, keeping the first cause', async () => {
    const shutdown = createShutdown(silentLogger())
    const causes: string[] = []
    shutdown.register({ name: 'agent', run: (cause) => void causes.push(cause) })
    shutdown.register({ name: 'services', run: (cause) => void causes.push(cause) })

    await Promise.all([shutdown.shutdown('session-end'), shutdown.shutdown('quit')])

    expect(causes).toEqual(['session-end', 'session-end'])
  })
})

describe('Task Runs on shutdown', () => {
  const marked: AgentTask = {
    id: 'daily',
    name: 'Daily report',
    workspaceDir: '/work/project',
    settingsTemplate: { backend: 'llamaCPP', model: 'Qwen-9B', capabilities: ['files'] },
    steps: [
      { id: 's1', prompt: 'first' },
      { id: 's2', prompt: 'second' },
      { id: 's3', prompt: 'third' },
    ],
    createdAt: 1,
    updatedAt: 2,
    activeRun: { sessionId: 'aipg-agent-1', stepIndex: 2, stepCount: 3, scheduled: true },
  }
  const idle: AgentTask = { ...marked, id: 'weekly', name: 'Weekly', activeRun: undefined }

  beforeEach(async () => {
    resetAgentTaskFilesForTest()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-shutdown-tasks-'))
    tasksFile.path = path.join(dir, 'agent-tasks.json')
    await saveAgentTask(marked)
    await saveAgentTask(idle)
  })

  async function shutDownWith(cause: ShutdownCause): Promise<void> {
    const shutdown = createShutdown(silentLogger())
    shutdown.register({ name: 'task runs', run: settleTaskRunsOnQuit })
    await shutdown.shutdown(cause)
  }

  it('records a Task Run the user quit during as stopped at the step it reached', async () => {
    await shutDownWith('quit')

    const [daily, weekly] = await readAgentTasks()
    expect(daily.activeRun).toBeUndefined()
    expect(daily.lastOutcome).toMatchObject({
      kind: 'stopped',
      sessionId: 'aipg-agent-1',
      stepIndex: 2,
      stepCount: 3,
    })
    expect(daily.lastOutcome?.reason).toBeUndefined()
    expect(weekly).toEqual(idle)
  })

  it.each(['session-end', 'signal'] as const)(
    'leaves the marker for the next launch to call failed when the %s ended the app',
    async (cause) => {
      await shutDownWith(cause)

      expect(await readAgentTasks()).toEqual([marked, idle])
    },
  )

  it('keeps the stopped outcome when the window writes the run after the quit settled it', async () => {
    await shutDownWith('quit')
    await saveAgentTask({ ...marked, activeRun: { ...marked.activeRun!, stepIndex: 3 } })

    const [daily] = await readAgentTasks()
    expect(daily.activeRun).toBeUndefined()
    expect(daily.lastOutcome?.kind).toBe('stopped')
  })

  it('keeps the stopped outcome when the window records the aborted turn as failed', async () => {
    await shutDownWith('quit')
    const { activeRun: _run, ...settled } = marked
    await saveAgentTask({
      ...settled,
      lastOutcome: { kind: 'failed', at: 9, sessionId: 'aipg-agent-1', stepIndex: 2, stepCount: 3 },
    })

    const [daily] = await readAgentTasks()
    expect(daily.lastOutcome?.kind).toBe('stopped')
  })

  it('still saves a change to a Task that is not about its run after the quit', async () => {
    await shutDownWith('quit')
    await saveAgentTask({ ...idle, name: 'Weekly digest' })
    await saveAgentTask({ ...marked, id: 'new', name: 'New', activeRun: marked.activeRun })

    const tasks = await readAgentTasks()
    expect(tasks.find((task) => task.id === 'weekly')?.name).toBe('Weekly digest')
    expect(tasks.find((task) => task.id === 'new')).toMatchObject({ name: 'New' })
    expect(tasks.find((task) => task.id === 'new')?.activeRun).toBeUndefined()
  })
})
