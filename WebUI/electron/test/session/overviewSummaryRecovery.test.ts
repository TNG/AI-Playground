import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A failed or interrupted Overview Summary update recovers through the two retry
// seams and through the pending marker a crash leaves: the old account survives a
// failure, a retry writes its new outcome onto the entry the row shows, and a
// pending marker resumes on the next launch or turn.

const dirs = vi.hoisted(() => ({ real: '', demo: '', games: '', mediaRecords: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
  getGamesDir: () => dirs.games,
  getMediaRecordsDir: () => dirs.mediaRecords,
  getMediaRecordsDemoDir: () => `${dirs.mediaRecords}-demo`,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', () => ({
  emitSessionChanged: vi.fn(),
  emitSessionGroupsChanged: vi.fn(),
  emitFailure: vi.fn(),
}))

const { createSession, mutateSession, openSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { appendHistoryEntry, readHistoryEntries } = await import('../../session/sessionHistory')
const { settleTurn } = await import('../../session/sessionSettlement')
const summary = await import('../../session/overviewSummary')
import type { ChatModelConfig } from '@/types/chatIpc'
import type { HistoryEntry } from '@/types/sessionIpc'

type CompleteArgs = Parameters<
  NonNullable<Parameters<typeof summary.setOverviewSummaryComplete>[0]>
>[0]

const MODEL: ChatModelConfig = {
  backend: 'llamaCPP',
  modelId: 'qwen-test',
  readiness: { serviceName: 'llamacpp-backend', llmModelName: 'qwen-test' },
}
const DESCRIPTOR = {
  readiness: { serviceName: 'llamacpp-backend', llmModelName: 'qwen-test' },
  replyLanguage: 'de',
}
const REQUEST = { model: MODEL, language: 'de' }

let calls: CompleteArgs[] = []
let reply: (
  args: CompleteArgs,
) => Promise<{ text: string; pictureMatches: boolean; tokens?: number }> = async () => ({
  text: 'A short account of the Session.',
  pictureMatches: false,
  tokens: 12,
})

function entry(overrides: Partial<HistoryEntry> = {}): Omit<HistoryEntry, 'id' | 'timestamp'> {
  return {
    preset: 'Assistant',
    kind: 'chat',
    prompt: 'a prompt',
    status: 'completed',
    artifacts: [],
    ...overrides,
  }
}

async function included(): Promise<{ sessionId: string; coveredEntry: HistoryEntry }> {
  const session = await createSession()
  await mutateSession(session.id, (file) => ({ ...file, title: 'Kitchen renovation' }))
  const first = await appendHistoryEntry(session.id, entry({ prompt: 'set up the project' }))
  await summary.applyOverviewInclusion(session.id, true, REQUEST)
  await vi.waitFor(async () => {
    expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
  })
  calls = []
  return { sessionId: session.id, coveredEntry: first }
}

async function failedTurn(sessionId: string): Promise<HistoryEntry> {
  reply = async () => {
    throw new Error('the model went away')
  }
  const written = await settleTurn(
    sessionId,
    entry({ prompt: 'a red fox', response: 'The answer that must survive.' }),
    { summariser: DESCRIPTOR },
  )
  if (!written) throw new Error('turn not recorded')
  expect(written.overviewUpdate?.state).toBe('failed')
  return written
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-overview-recovery-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.games = path.join(root, 'games')
  dirs.mediaRecords = path.join(root, 'media-records')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
  calls = []
  reply = async () => ({
    text: 'A short account of the Session.',
    pictureMatches: false,
    tokens: 12,
  })
  summary.setOverviewSummaryComplete(async (args) => {
    calls.push(args)
    return reply(args)
  })
})

afterEach(async () => {
  summary.resetOverviewSummaryForTest()
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.games, { recursive: true, force: true })
})

describe('retrying a failed update', () => {
  it('reruns from the failed row without a new turn and writes the outcome onto that entry', async () => {
    const { sessionId } = await included()
    const failed = await failedTurn(sessionId)
    const before = await readHistoryEntries(sessionId)
    calls = []

    reply = async () => ({ text: 'Recovered account.', pictureMatches: false, tokens: 9 })
    const document = await summary.retryOverviewUpdate(sessionId, failed.id, REQUEST)

    expect(document.overviewSummary).toMatchObject({ state: 'ready', text: 'Recovered account.' })
    const after = await readHistoryEntries(sessionId)
    expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id))
    const retried = after.find((item) => item.id === failed.id)
    expect(retried?.overviewUpdate).toMatchObject({
      state: 'ready',
      text: 'Recovered account.',
      coveredEntryId: failed.id,
    })
    expect(retried?.response).toBe('The answer that must survive.')
    expect(calls).toHaveLength(1)
    expect(calls[0].prompt).toContain('Current account')
    expect(calls[0].prompt).toContain('a red fox')
  })

  it('records a retry that fails again on the same entry, keeping the old account', async () => {
    const { sessionId, coveredEntry } = await included()
    const failed = await failedTurn(sessionId)

    reply = async () => {
      throw new Error('still no model')
    }
    const document = await summary.retryOverviewUpdate(sessionId, failed.id, REQUEST)

    expect(document.overviewSummary).toMatchObject({
      state: 'failed',
      text: 'A short account of the Session.',
      coveredEntryId: coveredEntry.id,
      failureReason: expect.stringContaining('still no model'),
    })
    const retried = (await readHistoryEntries(sessionId)).find((item) => item.id === failed.id)
    expect(retried?.overviewUpdate).toMatchObject({
      state: 'failed',
      coveredEntryId: coveredEntry.id,
      failureReason: expect.stringContaining('still no model'),
    })
  })

  it('updates only the Session summary state from the chip, leaving the turn row as it was', async () => {
    const { sessionId } = await included()
    const failed = await failedTurn(sessionId)

    reply = async () => ({ text: 'Recovered account.', pictureMatches: false })
    await summary.refreshOverviewSummary(sessionId, REQUEST)
    await vi.waitFor(async () => {
      expect((await openSession(sessionId)).overviewSummary?.text).toBe('Recovered account.')
    })

    const stored = (await openSession(sessionId)).overviewSummary
    expect(stored?.state).toBe('ready')
    const row = (await readHistoryEntries(sessionId)).find((item) => item.id === failed.id)
    expect(row?.overviewUpdate?.state).toBe('failed')
    expect(row?.overviewUpdate?.text).toBeUndefined()
  })
})

describe('a pending update across a restart', () => {
  it('resumes on launch, keeps the answer and settles the row', async () => {
    const { sessionId } = await included()
    const pending = await appendHistoryEntry(
      sessionId,
      entry({
        prompt: 'a red fox',
        response: 'The answer that must survive.',
        overviewUpdate: { state: 'pending' },
      }),
    )
    await mutateSession(sessionId, (file) => ({
      ...file,
      overviewSummary: file.overviewSummary && { ...file.overviewSummary, state: 'pending' },
    }))

    // Simulate the app closing around the update: nothing in memory survives.
    summary.resetOverviewSummaryForTest()
    resetSessionsForTest()
    setSessionDeps({ isDemoMode: () => false })
    summary.setOverviewSummaryComplete(async (args) => {
      calls.push(args)
      return reply(args)
    })

    const resumed = await summary.resumePendingOverviewUpdates(REQUEST)

    expect(resumed).toEqual([sessionId])
    const document = await openSession(sessionId)
    expect(document.overviewSummary).toMatchObject({
      state: 'ready',
      text: 'A short account of the Session.',
      coveredEntryId: pending.id,
    })
    const recovered = (await readHistoryEntries(sessionId)).find((item) => item.id === pending.id)
    expect(recovered?.response).toBe('The answer that must survive.')
    expect(recovered?.overviewUpdate).toMatchObject({
      state: 'ready',
      text: 'A short account of the Session.',
    })
  })

  it('resumes on the next settled turn when no launch resume ran', async () => {
    const { sessionId } = await included()
    const pending = await appendHistoryEntry(
      sessionId,
      entry({ prompt: 'a red fox', overviewUpdate: { state: 'pending' } }),
    )

    reply = async () => ({ text: 'Caught up.', pictureMatches: false })
    const next = await settleTurn(sessionId, entry({ prompt: 'a blue fox' }), {
      summariser: DESCRIPTOR,
    })

    expect(next?.overviewUpdate).toMatchObject({ state: 'ready', text: 'Caught up.' })
    const caughtUp = (await readHistoryEntries(sessionId)).find((item) => item.id === pending.id)
    expect(caughtUp?.overviewUpdate?.state).toBe('ready')
    expect(calls[0].prompt).toContain('a red fox')
    expect(calls[0].prompt).toContain('a blue fox')
  })

  it('leaves a pending marker alone when no local model can run it', async () => {
    const { sessionId } = await included()
    await appendHistoryEntry(
      sessionId,
      entry({ prompt: 'a red fox', overviewUpdate: { state: 'pending' } }),
    )

    const resumed = await summary.resumePendingOverviewUpdates({ language: 'de' })

    expect(resumed).toEqual([])
    expect(calls).toEqual([])
    expect((await openSession(sessionId)).overviewSummaryState).toBe('ready')
  })
})

describe('no retry loop', () => {
  it('waits for a retry or the next turn after a failure', async () => {
    const { sessionId } = await included()
    const failed = await failedTurn(sessionId)
    expect(calls).toHaveLength(1)

    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(calls).toHaveLength(1)
    expect((await openSession(sessionId)).overviewSummary?.state).toBe('failed')
    const waiting = (await readHistoryEntries(sessionId)).filter(
      (item) => item.overviewUpdate?.state === 'pending',
    )
    expect(waiting).toEqual([])
    expect(failed.overviewUpdate?.state).toBe('failed')
  })
})
