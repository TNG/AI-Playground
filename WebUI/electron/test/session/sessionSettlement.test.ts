import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
}))

vi.mock('../../observability/logger', () => ({ appLoggerInstance: logger }))

const { createSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const { settleTurn } = await import('../../session/sessionSettlement')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-settlement-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
  logger.warn.mockClear()
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
})

function entry() {
  return {
    preset: 'Chat',
    kind: 'chat' as const,
    prompt: 'a red fox',
    status: 'completed' as const,
    artifacts: [],
  }
}

describe('settling a turn into its Session', () => {
  it('writes the turn as its History Entry', async () => {
    const { id } = await createSession()

    const written = await settleTurn(id, entry())

    expect(written).toMatchObject({ preset: 'Chat', kind: 'chat', prompt: 'a red fox' })
    expect(await readHistoryEntries(id)).toEqual([written])
  })

  it('accepts a summariser descriptor and an abort signal', async () => {
    const { id } = await createSession()

    const written = await settleTurn(id, entry(), {
      summariser: {
        model: {
          backend: 'llamaCPP',
          modelId: 'LFM2.5-350M-Q4_K_M.gguf',
          readiness: { serviceName: 'llamacpp-backend', llmModelName: 'LFM2.5-350M-Q4_K_M.gguf' },
        },
        language: 'en-US',
      },
      abortSignal: new AbortController().signal,
    })

    expect(written).toMatchObject({ prompt: 'a red fox' })
    expect(await readHistoryEntries(id)).toEqual([written])
  })

  it('logs a failed append and settles the turn anyway', async () => {
    await expect(settleTurn('not-a-session', entry())).resolves.toBeUndefined()

    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})
