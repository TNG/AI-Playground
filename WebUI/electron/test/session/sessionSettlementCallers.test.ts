import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))
const settlement = vi.hoisted(() => ({ settleTurn: vi.fn() }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../session/sessionSettlement', () => ({ settleTurn: settlement.settleTurn }))

const { createSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { trackChatTurnInSession } = await import('../../session/sessionChatTurn')
const { trackAgentTurnInSession } = await import('../../session/sessionAgentTurns')
const { recordMediaTurn } = await import('../../session/sessionMediaTurn')
const { recordAudioTurn } = await import('../../session/sessionAudioTurn')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-settlement-callers-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
  settlement.settleTurn.mockReset()
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return settled
}

async function gate(): Promise<{
  hold: ReturnType<typeof deferred>
  release: () => Promise<void>
}> {
  const hold = deferred()
  settlement.settleTurn.mockReturnValueOnce(hold.promise)
  return {
    hold,
    release: async () => {
      hold.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

describe('a turn reports done only after its settlement', () => {
  it('waits for a chat turn', async () => {
    const { id } = await createSession()
    const turn = trackChatTurnInSession(id, () => null)
    const held = await gate()

    const done = turn.settle({ preset: 'Chat', prompt: 'a red fox', status: 'completed' })

    expect(settlement.settleTurn).toHaveBeenCalledTimes(1)
    expect(await hasSettled(done)).toBe(false)
    await held.release()
    await done
  })

  it('waits for an agent turn', async () => {
    const { id } = await createSession()
    const turn = trackAgentTurnInSession({
      sessionRef: id,
      presetName: 'Agent',
      workspaceDir: path.join(dirs.real, id, 'files'),
      prompt: 'a red fox',
      harnessSessionId: 'harness-1',
    })
    const held = await gate()

    const done = turn.settle({ sessionId: 'harness-1', turnId: 'turn-1', outcome: 'completed' })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settlement.settleTurn).toHaveBeenCalledTimes(1)
    expect(await hasSettled(done)).toBe(false)
    await held.release()
    await done
  })

  it('waits for a panel media turn', async () => {
    const { id } = await createSession()
    const held = await gate()

    const done = recordMediaTurn({
      sessionId: id,
      runId: 'run-1',
      mode: 'imageGen',
      preset: 'Dummy Image (test)',
      prompt: 'a red fox',
      status: 'completed',
      items: [],
      localPathOf: () => null,
    })

    expect(settlement.settleTurn).toHaveBeenCalledTimes(1)
    expect(await hasSettled(done)).toBe(false)
    await held.release()
    await done
  })

  it('waits for an audio turn', async () => {
    const { id } = await createSession()
    const held = await gate()

    const done = recordAudioTurn({
      sessionId: id,
      kind: 'tts',
      preset: 'Text to Speech',
      prompt: 'Hello there',
      status: 'completed',
      engine: 'Kokoro',
    })

    expect(settlement.settleTurn).toHaveBeenCalledTimes(1)
    expect(await hasSettled(done)).toBe(false)
    await held.release()
    await done
  })
})
