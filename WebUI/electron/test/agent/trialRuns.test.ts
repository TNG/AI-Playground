import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Trial Run folders, driven against a real temp dir: one per Agent, the next
// one throwing the previous away with its Harness Session, all gone at restart.

const paths = vi.hoisted(() => ({ trials: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getAgentTrialsDir: () => paths.trials,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { discardTrialRun, setTrialRunDeps, trialRunHarnessFor, wipeTrialRuns } =
  await import('../../agent/trialRuns')

const deletedHarnesses: string[] = []
let tmpRoot = ''

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-trials-')))
  paths.trials = path.join(tmpRoot, 'agent-trials')
  deletedHarnesses.length = 0
  setTrialRunDeps({
    deleteHarnessSession: async (id) => void deletedHarnesses.push(id),
  })
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

const exists = (target: string) =>
  fs.stat(target).then(
    () => true,
    () => false,
  )

describe('Trial Run folders', () => {
  it('gives a Trial Run a fresh Harness Session working in its Agent’s scratch folder', async () => {
    const harness = await trialRunHarnessFor('agent-1')

    expect(harness.harnessSessionId).toMatch(/^aipg-agent-/)
    expect(harness.workspaceDir.startsWith(paths.trials)).toBe(true)
    expect((await fs.stat(harness.workspaceDir)).isDirectory()).toBe(true)
  })

  it('throws the previous Trial Run of the Agent away when the next one starts', async () => {
    const first = await trialRunHarnessFor('agent-1')
    await fs.writeFile(path.join(first.workspaceDir, 'cat.png'), 'old')
    const other = await trialRunHarnessFor('agent-2')

    const second = await trialRunHarnessFor('agent-1')

    expect(second.harnessSessionId).not.toBe(first.harnessSessionId)
    expect(deletedHarnesses).toEqual([first.harnessSessionId])
    expect(await exists(path.join(second.workspaceDir, 'cat.png'))).toBe(false)
    expect(await exists(other.workspaceDir)).toBe(true)
  })

  it('discards an Agent’s Trial Run and its folder', async () => {
    const trial = await trialRunHarnessFor('agent-1')

    await discardTrialRun('agent-1')

    expect(deletedHarnesses).toEqual([trial.harnessSessionId])
    expect(await exists(trial.workspaceDir)).toBe(false)
  })

  it('leaves no Trial Run or folder behind after a restart', async () => {
    const one = await trialRunHarnessFor('agent-1')
    const two = await trialRunHarnessFor('agent-2')
    await fs.writeFile(path.join(two.workspaceDir, 'notes.md'), 'draft')

    await wipeTrialRuns()

    expect(deletedHarnesses.sort()).toEqual([one.harnessSessionId, two.harnessSessionId].sort())
    expect(await exists(paths.trials)).toBe(false)
  })

  it('starts clean when no Trial Run was ever made', async () => {
    await wipeTrialRuns()

    expect(deletedHarnesses).toEqual([])
  })

  it('refuses an Agent id that would leave the trials folder', async () => {
    await expect(trialRunHarnessFor('../escape')).rejects.toThrow()
  })
})
