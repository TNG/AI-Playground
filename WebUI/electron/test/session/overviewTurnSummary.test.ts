import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The per-turn Overview Summary update, driven through the one settlement seam
// against real Session files: what a settled turn reads, what it writes back
// onto its History Entry, and how cloud, failure and cancellation settle.

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
const { appendHistoryEntry, readHistoryEntries, removeHistoryEntry, historyOverviewUpdates } =
  await import('../../session/sessionHistory')
const { settleTurn } = await import('../../session/sessionSettlement')
const summary = await import('../../session/overviewSummary')
const { sessionTimelineItems } = await import('@/lib/sessionTimeline')
import type { ChatModelConfig } from '@/types/chatIpc'
import type { HistoryEntry, OverviewTurnUpdate } from '@/types/sessionIpc'

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

async function addEntry(sessionId: string, overrides: Partial<HistoryEntry> = {}) {
  return appendHistoryEntry(sessionId, entry(overrides))
}

async function included(overrides: Partial<HistoryEntry> = {}): Promise<{
  sessionId: string
  entry: HistoryEntry
}> {
  const session = await createSession()
  await mutateSession(session.id, (file) => ({ ...file, title: 'Kitchen renovation' }))
  const first = await addEntry(session.id, { prompt: 'set up the project', ...overrides })
  await summary.applyOverviewInclusion(session.id, true, REQUEST)
  await vi.waitFor(async () => {
    expect((await openSession(session.id)).overviewSummary?.state).toBe('ready')
  })
  calls = []
  return { sessionId: session.id, entry: first }
}

function lastEntry(entries: HistoryEntry[]): HistoryEntry {
  const last = entries.at(-1)
  if (!last) throw new Error('no entries')
  return last
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-overview-turn-'))
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

describe('a settled text turn updates its summary', () => {
  it('reads the previous summary and only the entries after the covered one', async () => {
    const { sessionId } = await included()
    const settled = await addEntry(sessionId, { prompt: 'fixed the last bug' })

    await settleTurn(sessionId, entry({ prompt: 'fixed the last bug' }), {
      summariser: DESCRIPTOR,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].prompt).toContain('Current account')
    expect(calls[0].prompt).toContain('A short account of the Session.')
    expect(calls[0].prompt).toContain('fixed the last bug')
    expect(calls[0].prompt).not.toContain('set up the project')

    const stored = (await openSession(sessionId)).overviewSummary
    const entries = await readHistoryEntries(sessionId)
    expect(stored?.state).toBe('ready')
    expect(stored?.coveredEntryId).toBe(lastEntry(entries).id)
    expect(stored?.coveredEntryId).not.toBe(settled.id)
  })

  it('records pending on the entry, then the outcome the details row reads', async () => {
    const { sessionId } = await included()

    const written = await settleTurn(sessionId, entry({ prompt: 'a red fox' }), {
      summariser: DESCRIPTOR,
    })

    const stored = (await openSession(sessionId)).overviewSummary
    expect(written?.overviewUpdate).toMatchObject({
      state: 'ready',
      model: 'qwen-test',
      tokens: 12,
      text: 'A short account of the Session.',
      coveredEntryId: stored?.coveredEntryId,
    })
    expect(written?.overviewUpdate?.durationMs).toBeGreaterThanOrEqual(0)
    expect(written?.overviewUpdate?.writtenAt).toBeTypeOf('number')

    const rows = await historyOverviewUpdates(sessionId)
    expect(rows.find((row) => row.entryId === written?.id)?.update.state).toBe('ready')
  })

  it('does not update or mark a Session that is not included', async () => {
    const session = await createSession()
    await addEntry(session.id)

    const written = await settleTurn(session.id, entry({ prompt: 'a red fox' }), {
      summariser: DESCRIPTOR,
    })

    expect(calls).toEqual([])
    expect(written?.overviewUpdate).toBeUndefined()
    expect((await openSession(session.id)).overviewSummary).toBeUndefined()
  })

  it('waits for the update before the settlement resolves', async () => {
    const { sessionId } = await included()
    let release: (value: { text: string; pictureMatches: boolean }) => void = () => {}
    reply = () => new Promise((resolve) => (release = resolve))

    let done = false
    const settling = settleTurn(sessionId, entry({ prompt: 'a red fox' }), {
      summariser: DESCRIPTOR,
    }).then(() => {
      done = true
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(done).toBe(false)
    release({ text: 'A later account.', pictureMatches: false })
    await settling
    expect(done).toBe(true)
  })

  it('records the model that wrote the new text after a model change', async () => {
    const { sessionId } = await included()

    const written = await settleTurn(sessionId, entry({ prompt: 'a red fox' }), {
      summariser: {
        readiness: { serviceName: 'llamacpp-backend', llmModelName: 'other-model' },
        replyLanguage: 'de',
      },
    })

    expect(calls[0].model.modelId).toBe('other-model')
    expect(calls[0].prompt).toContain('Current account')
    expect(written?.overviewUpdate?.model).toBe('other-model')
    expect((await openSession(sessionId)).overviewSummary?.model).toBe('other-model')
  })
})

describe('rebuilds', () => {
  it('rebuilds the whole history periodically', async () => {
    const { sessionId } = await included()
    const prompts: string[] = []
    reply = async (args) => {
      prompts.push(args.prompt)
      return { text: 'An account.', pictureMatches: false }
    }

    for (let index = 0; index < summary.OVERVIEW_SUMMARY_REBUILD_EVERY; index++) {
      await settleTurn(sessionId, entry({ prompt: `turn ${index}` }), { summariser: DESCRIPTOR })
    }

    expect(prompts.slice(0, -1).every((prompt) => prompt.includes('Current account'))).toBe(true)
    expect(prompts.at(-1)).not.toContain('Current account')
    expect(prompts.at(-1)).toContain('set up the project')
    expect((await openSession(sessionId)).overviewSummary?.updatesSinceRebuild).toBe(0)
  })

  it('rebuilds when the covered entry no longer exists', async () => {
    const { sessionId, entry: covered } = await included()
    await removeHistoryEntry(sessionId, covered.id)

    await settleTurn(sessionId, entry({ prompt: 'a red fox' }), { summariser: DESCRIPTOR })

    expect(calls[0].prompt).not.toContain('Current account')
    expect(calls[0].prompt).toContain('a red fox')
  })

  it('rebuilds when the contract changed', async () => {
    const { sessionId } = await included()
    await mutateSession(sessionId, (file) => ({
      ...file,
      overviewSummary: file.overviewSummary && {
        ...file.overviewSummary,
        contractVersion: 999,
      },
    }))

    await settleTurn(sessionId, entry({ prompt: 'a red fox' }), { summariser: DESCRIPTOR })

    expect(calls[0].prompt).not.toContain('Current account')
    expect(calls[0].prompt).toContain('set up the project')
  })
})

describe('cloud, cancellation and failure', () => {
  it('leaves a cloud turn pending, loading no local model', async () => {
    const { sessionId } = await included()

    const written = await settleTurn(sessionId, entry({ prompt: 'a red fox' }))

    expect(calls).toEqual([])
    expect(written?.overviewUpdate?.state).toBe('pending')
    const stored = (await openSession(sessionId)).overviewSummary
    expect(stored?.state).toBe('pending')
    expect(stored?.text).toBe('A short account of the Session.')
  })

  it('records a cancelled turn as skipped and the next turn covers it', async () => {
    const { sessionId } = await included()

    const cancelled = await settleTurn(
      sessionId,
      entry({ prompt: 'a red fox', status: 'cancelled' }),
      { summariser: DESCRIPTOR },
    )

    expect(cancelled?.overviewUpdate?.state).toBe('skipped')
    expect(calls).toEqual([])

    const next = await settleTurn(sessionId, entry({ prompt: 'a blue fox' }), {
      summariser: DESCRIPTOR,
    })
    expect(calls[0].prompt).toContain('a red fox')
    expect(calls[0].prompt).toContain('a blue fox')
    expect(next?.overviewUpdate?.coveredEntryId).toBe(next?.id)
  })

  it('keeps the previous summary, picture and covered entry on failure', async () => {
    const { sessionId, entry: covered } = await included()
    const picture = {
      path: 'files/cat.png',
      mediaType: 'image' as const,
      source: 'artifact' as const,
    }
    await mutateSession(sessionId, (file) => ({
      ...file,
      overviewSummary: file.overviewSummary && { ...file.overviewSummary, picture },
    }))
    reply = async () => {
      throw new Error('the model went away')
    }

    const written = await settleTurn(sessionId, entry({ prompt: 'a red fox' }), {
      summariser: DESCRIPTOR,
    })

    const stored = (await openSession(sessionId)).overviewSummary
    expect(stored).toMatchObject({
      state: 'failed',
      text: 'A short account of the Session.',
      coveredEntryId: covered.id,
      picture,
      failureReason: expect.stringContaining('the model went away'),
    })
    expect(written?.overviewUpdate).toMatchObject({
      state: 'failed',
      coveredEntryId: covered.id,
      failureReason: expect.stringContaining('the model went away'),
    })
    expect(written).toBeDefined()
  })
})

describe('the turn details data', () => {
  it('attaches a settled turn outcome to its details row, not a chat message', () => {
    const timeline = [
      {
        id: 'u1',
        role: 'user',
        metadata: { chatTurn: true },
        parts: [{ type: 'text', text: 'a red fox' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        metadata: { chatTurn: true, preset: 'Chat' },
        parts: [{ type: 'text', text: 'done' }],
      },
    ]
    const rows: OverviewTurnUpdate[] = [
      {
        entryId: 'entry-1',
        kind: 'chat',
        prompt: 'a red fox',
        update: {
          state: 'ready',
          model: 'qwen-test',
          text: 'A short account.',
          coveredEntryId: 'entry-1',
        },
      },
    ]

    const items = sessionTimelineItems(timeline, {} as never, {}, true, rows)
    const turn = items.find((item) => item.kind === 'chat')
    expect(turn?.details.parts).toContainEqual({
      kind: 'overview-update',
      update: rows[0].update,
    })
    expect(timeline.some((message) => 'overviewUpdate' in message)).toBe(false)
  })
})
