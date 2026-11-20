import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ root: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => path.join(dirs.root, 'userData', 'sessions'),
  getSessionsDemoDir: () => path.join(dirs.root, 'userData', 'sessions-demo'),
  getLegacySessionsDir: () => path.join(dirs.root, 'AI-Playground', 'sessions'),
  getLegacySessionsDemoDir: () => path.join(dirs.root, 'AI-Playground', 'sessions-demo'),
  getAppWorkspacesDir: () => path.join(dirs.root, 'AI-Playground', 'workspaces'),
  getAppWorkspacesDemoDir: () => path.join(dirs.root, 'AI-Playground', 'workspaces-demo'),
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { moveSessionBookkeeping } = await import('../../persist/sessionBookkeepingMove')
const { listSessions, readSession, listSessionGroups, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { readHistoryEntries } = await import('../../session/sessionHistory')

const ID = 'session-11111111-2222-3333-4444-555555555555'
const legacy = () => path.join(dirs.root, 'AI-Playground', 'sessions')
const internal = () => path.join(dirs.root, 'userData', 'sessions')

const sessionJson = {
  schemaVersion: 1,
  id: ID,
  title: 'Cat poster',
  renamed: false,
  pinned: false,
  createdAt: 1,
  updatedAt: 2,
  presetsUsed: [],
  timeline: [],
  settings: {},
  harnessSessions: {},
  harnessWorkspaces: {},
  retiredHarnessSessions: [],
  taskRunHarnessSessions: [],
  updateCursors: {},
  reachable: false,
}

const historyLine = JSON.stringify({
  id: 'entry-1',
  kind: 'image',
  preset: 'Image Gen',
  prompt: 'a cat',
  timestamp: 1,
  status: 'completed',
  artifacts: [{ path: 'files/cat.png', mediaType: 'image' }],
})

async function oldLayout(): Promise<void> {
  const folder = path.join(legacy(), ID)
  await fs.mkdir(path.join(folder, 'files'), { recursive: true })
  await fs.mkdir(path.join(folder, 'attachments'), { recursive: true })
  await fs.writeFile(path.join(folder, 'session.json'), JSON.stringify(sessionJson))
  await fs.writeFile(path.join(folder, 'session-history.jsonl'), `${historyLine}\n`)
  await fs.writeFile(path.join(folder, 'attachments', 'notes.md'), 'notes')
  await fs.writeFile(path.join(folder, 'files', 'cat.png'), 'cat')
  await fs.writeFile(
    path.join(legacy(), 'session-groups.json'),
    JSON.stringify({
      schemaVersion: 1,
      groups: [{ id: 'g1', name: 'Posters', createdAt: 1, expanded: true }],
    }),
  )
}

async function tree(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort()
}

beforeEach(async () => {
  dirs.root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-bookkeeping-'))
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.root, { recursive: true, force: true })
})

describe("moving Sessions' bookkeeping into the app's internal storage", () => {
  it('moves record, History, attachments and groups, and leaves files/ where it is', async () => {
    await oldLayout()

    await moveSessionBookkeeping()

    expect(await tree(internal())).toEqual([
      path.join(ID, 'attachments', 'notes.md'),
      path.join(ID, 'session-history.jsonl'),
      path.join(ID, 'session.json'),
      'session-groups.json',
    ])
    expect(await tree(legacy())).toEqual([path.join(ID, 'files', 'cat.png')])
    expect((await listSessions()).map((session) => session.title)).toEqual(['Cat poster'])
    expect((await listSessionGroups()).map((group) => group.name)).toEqual(['Posters'])
    expect((await readHistoryEntries(ID))[0].artifacts).toEqual([
      { path: 'files/cat.png', mediaType: 'image' },
    ])
    expect((await readSession(ID)).id).toBe(ID)
  })

  it('changes nothing when run again', async () => {
    await oldLayout()
    await moveSessionBookkeeping()
    const once = { internal: await tree(internal()), legacy: await tree(legacy()) }

    await moveSessionBookkeeping()

    expect({ internal: await tree(internal()), legacy: await tree(legacy()) }).toEqual(once)
  })

  it('finishes a move that stopped half-way, keeping what already arrived', async () => {
    await oldLayout()
    await fs.mkdir(path.join(internal(), ID, 'attachments'), { recursive: true })
    await fs.copyFile(
      path.join(legacy(), ID, 'session.json'),
      path.join(internal(), ID, 'session.json'),
    )
    await fs.writeFile(path.join(internal(), ID, 'attachments', 'notes.md'), 'other notes')

    await moveSessionBookkeeping()

    expect(await tree(internal())).toEqual([
      path.join(ID, 'attachments', 'notes-1.md'),
      path.join(ID, 'attachments', 'notes.md'),
      path.join(ID, 'session-history.jsonl'),
      path.join(ID, 'session.json'),
      'session-groups.json',
    ])
    expect(await tree(legacy())).toEqual([path.join(ID, 'files', 'cat.png')])
  })

  it('does nothing when there is no old layout', async () => {
    await moveSessionBookkeeping()

    expect(await listSessions()).toEqual([])
  })
})
