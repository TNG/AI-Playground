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
  getAppWorkspacesDir: () => path.join(dirs.root, 'AI-Playground', 'Readable'),
  getAppWorkspacesDemoDir: () => path.join(dirs.root, 'AI-Playground', 'Readable-demo'),
  getGamesDir: () => path.join(dirs.root, 'AI-Playground', 'games'),
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { moveSessionBookkeeping } = await import('../../persist/sessionBookkeepingMove')
const { migrateSessionLayout } = await import('../../session/sessionLayoutMigration')
const { readSession, resetSessionsForTest, setSessionDeps } = await import('../../session/sessions')
const { readSessionFolders } = await import('../../session/sessionFolders')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const { artifactHostPath } = await import('../../session/historyArtifacts')
const { sessionLegacyMediaFile } = await import('../../session/sessionFolderMedia')
const { missingArtifactUrls } = await import('../../session/sessionArtifacts')
const { ownedWorkspaceDirs } = await import('../../session/ownedWorkspaces')
const { missingSessionWorkspace } = await import('../../session/sessionWorkspace')

const CAT = 'session-11111111-2222-3333-4444-555555555555'
const DOG = 'session-22222222-2222-3333-4444-555555555555'
const EMPTY = 'session-33333333-2222-3333-4444-555555555555'
const GAME = 'session-44444444-2222-3333-4444-555555555555'
const CREATED = new Date(2026, 10, 19, 9, 0).getTime()

const legacy = () => path.join(dirs.root, 'AI-Playground', 'sessions')
const internal = () => path.join(dirs.root, 'userData', 'sessions')
const readable = () => path.join(dirs.root, 'AI-Playground', 'Readable')
const games = () => path.join(dirs.root, 'AI-Playground', 'games')
const picked = () => path.join(dirs.root, 'picked')

const legacyUrl = (id: string, name: string) => `aipg-media://sessions/${id}/files/${name}`

function sessionJson(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id,
    title,
    renamed: false,
    pinned: false,
    createdAt: CREATED,
    updatedAt: CREATED,
    presetsUsed: [],
    timeline: [],
    settings: {},
    harnessSessions: {},
    harnessWorkspaces: {},
    retiredHarnessSessions: [],
    taskRunHarnessSessions: [],
    updateCursors: {},
    reachable: false,
    ...extra,
  }
}

function historyLine(id: string, artifacts: { path: string; mediaType: string }[]): string {
  return JSON.stringify({
    id,
    kind: 'image',
    preset: 'Image Gen',
    prompt: 'a cat',
    timestamp: 1,
    status: 'completed',
    artifacts,
  })
}

type OldSession = {
  id: string
  title?: string
  files?: Record<string, string>
  attachments?: Record<string, string>
  history?: string[]
  extra?: Record<string, unknown>
}

/** A Session as the app kept it before ADR 0013: everything under `AI-Playground/sessions/<id>/`. */
async function oldSession(session: OldSession): Promise<void> {
  const folder = path.join(legacy(), session.id)
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(
    path.join(folder, 'session.json'),
    JSON.stringify(sessionJson(session.id, session.title ?? '', session.extra)),
  )
  await fs.writeFile(
    path.join(folder, 'session-history.jsonl'),
    (session.history ?? []).map((line) => `${line}\n`).join(''),
  )
  if (session.files) await fs.mkdir(path.join(folder, 'files'), { recursive: true })
  for (const [name, bytes] of Object.entries(session.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(folder, 'files', name)), { recursive: true })
    await fs.writeFile(path.join(folder, 'files', name), bytes)
  }
  for (const [name, bytes] of Object.entries(session.attachments ?? {})) {
    await fs.mkdir(path.join(folder, 'files', 'attachments'), { recursive: true })
    await fs.writeFile(path.join(folder, 'files', 'attachments', name), bytes)
  }
}

async function catSession(): Promise<void> {
  await fs.mkdir(path.join(picked(), 'notes'), { recursive: true })
  await oldSession({
    id: CAT,
    title: 'Cat poster',
    files: { 'cat.png': 'cat', 'sprites/tail.png': 'tail' },
    attachments: { 'brief.md': 'brief' },
    history: [
      historyLine('entry-1', [
        { path: 'files/cat.png', mediaType: 'image' },
        { path: 'files/sprites/tail.png', mediaType: 'image' },
      ]),
      historyLine('entry-2', [{ path: 'files/gone.png', mediaType: 'image' }]),
    ],
    extra: {
      timeline: [
        {
          id: 'm1',
          role: 'assistant',
          parts: [
            { type: 'data-media', data: { imageUrl: legacyUrl(CAT, 'cat.png') } },
            { type: 'data-media', data: { imageUrl: legacyUrl(CAT, 'gone.png') } },
          ],
        },
      ],
      settings: {
        Assistant: {
          bags: {
            Assistant: {
              values: { mountedFolders: [{ hostPath: path.join(picked(), 'notes') }] },
              fromDefaults: false,
            },
          },
        },
      },
    },
  })
}

async function migrate(): Promise<void> {
  await moveSessionBookkeeping()
  await migrateSessionLayout()
}

async function tree(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort()
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

async function workspaceOf(id: string) {
  const list = await readSessionFolders(id)
  return list.folders.find((folder) => folder.id === list.workspaceId)!
}

async function snapshot() {
  const ids = [CAT, DOG, EMPTY, GAME]
  return {
    readable: await tree(readable()),
    legacy: await tree(legacy()),
    internal: await tree(internal()),
    games: await tree(games()),
    sessions: await Promise.all(ids.map((id) => readSession(id).catch(() => null))),
    history: await Promise.all(ids.map((id) => readHistoryEntries(id))),
  }
}

beforeEach(async () => {
  dirs.root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-layout-migration-'))
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.root, { recursive: true, force: true })
})

describe('migrating older Sessions to the new layout', () => {
  it("moves a Session's files/ to its readable Workspace, starred", async () => {
    await catSession()

    await migrate()

    const workspace = await workspaceOf(CAT)
    expect(workspace.hostPath).toBe(path.join(readable(), '2026-11-19 Cat poster'))
    expect(workspace.appCreated).toBe(true)
    expect(workspace.planned).toBeUndefined()
    expect(await tree(readable())).toEqual([
      path.join('2026-11-19 Cat poster', 'cat.png'),
      path.join('2026-11-19 Cat poster', 'sprites', 'tail.png'),
    ])
    expect(await tree(path.join(internal(), CAT, 'attachments'))).toEqual(['brief.md'])
    expect(await exists(legacy())).toBe(false)
    expect(await ownedWorkspaceDirs(await readSession(CAT))).toEqual([workspace.hostPath])
    expect(await missingSessionWorkspace(CAT)).toBeNull()
  })

  it('keeps its Mounted Folders', async () => {
    await catSession()

    await migrate()

    const list = await readSessionFolders(CAT)
    expect(list.folders.map((folder) => folder.hostPath)).toContain(path.join(picked(), 'notes'))
  })

  it('rewrites History references to folder plus path, and they still resolve', async () => {
    await catSession()

    await migrate()

    const workspace = await workspaceOf(CAT)
    const [first, second] = await readHistoryEntries(CAT)
    expect(first.artifacts).toEqual([
      { folderId: workspace.id, path: 'cat.png', mediaType: 'image' },
      { folderId: workspace.id, path: 'sprites/tail.png', mediaType: 'image' },
    ])
    expect(second.artifacts).toEqual([
      { folderId: workspace.id, path: 'gone.png', mediaType: 'image' },
    ])
    const list = await readSessionFolders(CAT)
    expect(await fs.readFile(artifactHostPath(CAT, first.artifacts[0], list)!, 'utf8')).toBe('cat')
  })

  it("keeps the timeline's Artifacts showing, a deleted one still shown as deleted", async () => {
    await catSession()

    await migrate()

    const workspace = await workspaceOf(CAT)
    const folderUrl = (name: string) => `aipg-media://folders/${CAT}/${workspace.id}/${name}`
    const [message] = (await readSession(CAT)).timeline as {
      parts: { data: { imageUrl: string } }[]
    }[]
    expect(message.parts.map((part) => part.data.imageUrl)).toEqual([
      folderUrl('cat.png'),
      folderUrl('gone.png'),
    ])
    expect(await missingArtifactUrls(CAT)).toEqual([folderUrl('gone.png')])
  })

  it('still serves an old aipg-media://sessions/ URL persisted elsewhere', async () => {
    await catSession()

    await migrate()

    expect(sessionLegacyMediaFile(legacyUrl(CAT, 'sprites/tail.png'))).toBe(
      path.join(readable(), '2026-11-19 Cat poster', 'sprites', 'tail.png'),
    )
    expect(sessionLegacyMediaFile(legacyUrl(CAT, '../../escape.png'))).toBeNull()
  })

  it('names an untitled Session "<date> New session", with a suffix on a clash', async () => {
    await oldSession({ id: DOG, files: { 'dog.png': 'dog' } })
    await oldSession({ id: EMPTY, files: { 'bird.png': 'bird' } })

    await migrate()

    expect(await tree(readable())).toEqual(
      [
        path.join('2026-11-19 New session', 'dog.png'),
        path.join('2026-11-19 New session (2)', 'bird.png'),
      ].sort(),
    )
  })

  it('gives a Session without files a Workspace that is not on disk yet', async () => {
    await oldSession({ id: EMPTY, title: 'Just talk', files: {} })
    await oldSession({ id: DOG, title: 'No folder at all' })

    await migrate()

    for (const id of [EMPTY, DOG]) {
      const workspace = await workspaceOf(id)
      expect(workspace.planned).toBe(true)
      expect(workspace.appCreated).toBe(true)
    }
    expect(await exists(readable())).toBe(false)
    expect(await exists(legacy())).toBe(false)
  })

  it('leaves game folders untouched', async () => {
    const game = path.join(games(), 'asteroids')
    await fs.mkdir(path.join(game, 'generated'), { recursive: true })
    await fs.writeFile(path.join(game, 'index.html'), '<canvas>')
    await fs.writeFile(path.join(game, 'generated', 'ship.png'), 'ship')
    await oldSession({
      id: GAME,
      title: 'Asteroids',
      extra: {
        harnessSessions: { 'Game Agent': 'aipg-agent-1' },
        harnessWorkspaces: { 'Game Agent': game },
      },
    })

    await migrate()

    expect(await tree(games())).toEqual([
      path.join('asteroids', 'generated', 'ship.png'),
      path.join('asteroids', 'index.html'),
    ])
    expect((await readSession(GAME)).harnessWorkspaces).toEqual({ 'Game Agent': game })
  })

  it('changes nothing when run again', async () => {
    await catSession()
    await oldSession({ id: DOG, files: { 'dog.png': 'dog' } })
    await oldSession({ id: EMPTY, files: {} })
    await migrate()
    const once = await snapshot()

    await migrate()

    expect(await snapshot()).toEqual(once)
  })

  it('leaves an attachments/ folder the user makes in the new Workspace where it is', async () => {
    await catSession()
    await migrate()
    const workspace = await workspaceOf(CAT)
    await fs.mkdir(path.join(workspace.hostPath, 'attachments'))
    await fs.writeFile(path.join(workspace.hostPath, 'attachments', 'mine.txt'), 'mine')

    await migrate()

    expect(await tree(path.join(workspace.hostPath, 'attachments'))).toEqual(['mine.txt'])
  })

  it('finishes cleanly after being interrupted mid-way', async () => {
    await catSession()
    await migrate()
    const done = await snapshot()
    // Back to where a crash after recording the Workspace, before moving files, leaves it.
    const workspace = await workspaceOf(CAT)
    const oldFiles = path.join(legacy(), CAT, 'files')
    await fs.mkdir(path.join(oldFiles, 'sprites'), { recursive: true })
    await fs.rename(path.join(workspace.hostPath, 'cat.png'), path.join(oldFiles, 'cat.png'))
    await fs.rename(
      path.join(workspace.hostPath, 'sprites', 'tail.png'),
      path.join(oldFiles, 'sprites', 'tail.png'),
    )
    const historyFile = path.join(internal(), CAT, 'session-history.jsonl')
    const [first, ...rest] = (await fs.readFile(historyFile, 'utf8')).split('\n')
    await fs.writeFile(
      historyFile,
      [
        historyLine('entry-1', [
          { path: 'files/cat.png', mediaType: 'image' },
          { path: 'files/sprites/tail.png', mediaType: 'image' },
        ]),
        ...rest,
      ].join('\n'),
    )
    expect(first).toContain(workspace.id)

    await migrate()

    expect(await snapshot()).toEqual(done)
  })
})
