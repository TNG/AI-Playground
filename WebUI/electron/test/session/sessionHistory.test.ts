import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

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

const { createSession, mutateSession, readSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const {
  appendHistoryEntry,
  lastTurnPreset,
  readHistoryEntries,
  removeHistoryEntries,
  removeHistoryEntry,
} = await import('../../session/sessionHistory')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-history-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
})

function historyFile(id: string): string {
  return path.join(dirs.real, id, 'session-history.jsonl')
}

const imageTurn = {
  preset: 'Dummy Image (test)',
  variant: 'Fast',
  kind: 'image' as const,
  prompt: 'a red fox',
  status: 'completed' as const,
  artifacts: [{ path: 'files/fox.png', mediaType: 'image' as const }],
}

describe('Session History', () => {
  it('appends entries in order, one JSON line each', async () => {
    const { id } = await createSession()

    const first = await appendHistoryEntry(id, imageTurn)
    const second = await appendHistoryEntry(id, {
      ...imageTurn,
      preset: 'Dummy Edit (test)',
      kind: 'edit',
      prompt: 'make it blue',
      artifacts: [{ path: 'files/fox-blue.png', mediaType: 'image' }],
    })

    const lines = (await fs.readFile(historyFile(id), 'utf8')).split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({ id: first.id, prompt: 'a red fox' })
    expect(JSON.parse(lines[1])).toMatchObject({ id: second.id, prompt: 'make it blue' })
    expect(first.id).not.toBe(second.id)
    expect(second.timestamp).toBeGreaterThanOrEqual(first.timestamp)

    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual([
      'a red fox',
      'make it blue',
    ])
  })

  it('never rewrites lines already written', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageTurn)
    const before = await fs.readFile(historyFile(id))

    await appendHistoryEntry(id, { ...imageTurn, status: 'failed', artifacts: [] })

    const after = await fs.readFile(historyFile(id))
    expect(after.subarray(0, before.length).equals(before)).toBe(true)
    expect(after.length).toBeGreaterThan(before.length)
  })

  it('keeps the order of appends issued at the same time', async () => {
    const { id } = await createSession()
    await Promise.all(
      ['one', 'two', 'three', 'four'].map((prompt) =>
        appendHistoryEntry(id, { ...imageTurn, prompt }),
      ),
    )
    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual([
      'one',
      'two',
      'three',
      'four',
    ])
  })

  it('skips a torn line instead of losing the rest of the history', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageTurn)
    await fs.appendFile(historyFile(id), '{"id":"broken"')
    await fs.appendFile(historyFile(id), '\n')
    await appendHistoryEntry(id, { ...imageTurn, prompt: 'after the tear' })

    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual([
      'a red fox',
      'after the tear',
    ])
  })
})

describe('removing an entry', () => {
  it('drops the entry and leaves every other line alone', async () => {
    const { id } = await createSession()
    const first = await appendHistoryEntry(id, imageTurn)
    const second = await appendHistoryEntry(id, { ...imageTurn, prompt: 'make it blue' })
    await fs.appendFile(historyFile(id), '{"id":"broken"\n')

    expect(await removeHistoryEntry(id, second.id)).toBe(true)
    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual(['a red fox'])
    const raw = await fs.readFile(historyFile(id), 'utf8')
    expect(raw).toContain(first.id)
    expect(raw).toContain('"id":"broken"')
    expect(raw).not.toContain(second.id)
  })

  it('is false when no entry matches, and nothing is written', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageTurn)

    expect(await removeHistoryEntry(id, 'entry-missing')).toBe(false)
    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual(['a red fox'])
  })

  it('moves a cursor off the removed entry, or drops it when nothing precedes', async () => {
    const { id } = await createSession()
    const first = await appendHistoryEntry(id, imageTurn)
    const second = await appendHistoryEntry(id, { ...imageTurn, prompt: 'make it blue' })
    await mutateSession(id, (file) => ({
      ...file,
      updateCursors: { later: second.id, earlier: first.id },
    }))

    await removeHistoryEntry(id, second.id)
    expect((await readSession(id)).updateCursors).toEqual({ later: first.id, earlier: first.id })

    await removeHistoryEntry(id, first.id)
    expect((await readSession(id)).updateCursors).toEqual({})
  })
})

describe("removing a harness turn's entries", () => {
  const agentTurn = (turnId: string) => ({
    preset: 'Agent',
    kind: 'agent' as const,
    prompt: `turn ${turnId}`,
    status: 'completed' as const,
    artifacts: [],
    harnessSessionId: 'aipg-agent-1',
    turnId,
  })

  it('drops the turn’s stamped entries, and moves a cursor to the entry before them', async () => {
    const { id } = await createSession()
    const fox = await appendHistoryEntry(id, imageTurn)
    await appendHistoryEntry(id, agentTurn('t1'))
    const last = await appendHistoryEntry(id, agentTurn('t2'))
    await mutateSession(id, (file) => ({
      ...file,
      updateCursors: { reading: last.id },
    }))

    expect(await removeHistoryEntries(id, 'aipg-agent-1', new Set(['t1']))).toBe(1)
    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual([
      'a red fox',
      'turn t2',
    ])
    expect((await readSession(id)).updateCursors).toEqual({ reading: last.id })

    expect(await removeHistoryEntries(id, 'aipg-agent-1', new Set(['t2']))).toBe(1)
    expect((await readHistoryEntries(id)).map((entry) => entry.prompt)).toEqual(['a red fox'])
    expect((await readSession(id)).updateCursors).toEqual({ reading: fox.id })
  })

  it('leaves what it cannot match: another harness session’s, or an unstamped entry', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageTurn)
    await appendHistoryEntry(id, { ...agentTurn('t1'), harnessSessionId: 'aipg-agent-2' })
    await appendHistoryEntry(id, { ...agentTurn('t1'), harnessSessionId: undefined })

    expect(await removeHistoryEntries(id, 'aipg-agent-1', new Set(['t1']))).toBe(0)
    expect(await removeHistoryEntries(id, 'aipg-agent-1', new Set(['no-such-turn']))).toBe(0)
    expect(await readHistoryEntries(id)).toHaveLength(3)
  })
})

describe('the last turn of a Session', () => {
  it('names the preset and variant of the newest entry', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageTurn)
    await appendHistoryEntry(id, {
      preset: 'Agent',
      kind: 'agent',
      prompt: 'tidy the folder',
      status: 'completed',
      artifacts: [],
    })
    expect(await lastTurnPreset(id)).toEqual({ preset: 'Agent' })

    await appendHistoryEntry(id, { ...imageTurn, variant: 'Quality' })
    expect(await lastTurnPreset(id)).toEqual({ preset: 'Dummy Image (test)', variant: 'Quality' })
  })

  it('is null for a Session nothing has run in yet', async () => {
    const { id } = await createSession()
    expect(await lastTurnPreset(id)).toBeNull()
  })
})
