import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Agent Maker task store, against real files in a temp dir: saving a task,
// minting and pruning run workspaces, and the path checks on the ids.

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getAgentMakerDir: () => dirs.real,
  getAgentMakerDemoDir: () => dirs.demo,
}))
vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../kernel/kernelBus', () => ({ emitStored: vi.fn() }))

const {
  bootstrapAgentMaker,
  deleteRunWorkspace,
  mintRunWorkspace,
  resetAgentMakerFilesForTest,
  saveAgentTask,
} = await import('../../persist/agentMakerFiles')

const task = {
  schemaVersion: 3 as const,
  id: 'aipg-task-1',
  name: 'Daily News',
  slug: '',
  steps: ['fetch'],
  model: { backend: 'llamaCPP' as const, model: 'm' },
  capabilities: [],
  schedule: { kind: 'daily' as const, time: '08:00' },
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(async () => {
  dirs.real = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-maker-'))
  dirs.demo = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-maker-demo-'))
  resetAgentMakerFilesForTest()
})

afterEach(async () => {
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.demo, { recursive: true, force: true })
})

describe('agent maker files', () => {
  it('saves a scheduled task and reads it back with its slug', async () => {
    await saveAgentTask(task)
    const boot = await bootstrapAgentMaker()
    expect(boot).toMatchObject({ status: 'ok' })
    const saved = boot.status === 'ok' ? boot.tasks[0] : null
    expect(saved?.slug).toBe('daily-news')
    expect(saved?.schedule).toEqual({ kind: 'daily', time: '08:00' })
  })

  it('removes one run workspace and leaves the others', async () => {
    await saveAgentTask(task)
    const keep = await mintRunWorkspace('daily-news', 'aipg-agent-keep')
    const gone = await mintRunWorkspace('daily-news', 'aipg-agent-gone')
    await deleteRunWorkspace(task.id, 'aipg-agent-gone')
    await expect(fs.stat(gone)).rejects.toThrow()
    await expect(fs.stat(keep)).resolves.toBeTruthy()
  })

  it('refuses a run id that would leave the task folder', async () => {
    await saveAgentTask(task)
    await expect(deleteRunWorkspace(task.id, '../../escape')).rejects.toThrow()
  })
})
