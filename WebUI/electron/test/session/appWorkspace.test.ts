import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '@/types/mediaItem'

const dirs = vi.hoisted(() => ({ root: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => path.join(dirs.root, 'userData', 'sessions'),
  getSessionsDemoDir: () => path.join(dirs.root, 'userData', 'sessions-demo'),
  getLegacySessionsDir: () => path.join(dirs.root, 'AI-Playground', 'sessions'),
  getLegacySessionsDemoDir: () => path.join(dirs.root, 'AI-Playground', 'sessions-demo'),
  getAppWorkspacesDir: () => path.join(dirs.root, 'AI-Playground', 'Readable'),
  getAppWorkspacesDemoDir: () => path.join(dirs.root, 'AI-Playground', 'Readable-demo'),
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { createSession, renameSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { readSessionFolders, addSessionFolder, starSessionFolder } =
  await import('../../session/sessionFolders')
const { ensureSessionWorkspace } = await import('../../session/sessionWorkspace')
const { ensureFolderEntry, settleWorkspaceRenames } = await import('../../session/appWorkspace')
const { recordMediaTurn } = await import('../../session/sessionMediaTurn')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const { artifactHostPath } = await import('../../session/historyArtifacts')
const { claimSessionTurn, releaseSessionTurn, resetSessionTurnsForTest } =
  await import('../../session/sessionTurns')
const { harnessSessionFor } = await import('../../session/sessionHarness')

const readable = () => path.join(dirs.root, 'AI-Playground', 'Readable')
const media = () => path.join(dirs.root, 'media')

beforeEach(async () => {
  dirs.root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-app-workspace-'))
  await fs.mkdir(media(), { recursive: true })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 19, 9, 0))
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  await settleWorkspaceRenames()
  vi.useRealTimers()
  resetSessionsForTest()
  resetSessionTurnsForTest()
  await fs.rm(dirs.root, { recursive: true, force: true })
})

async function onDisk(): Promise<string[]> {
  return fs.readdir(readable()).catch(() => [])
}

async function workspaceOf(id: string) {
  const list = await readSessionFolders(id)
  return list.folders.find((folder) => folder.id === list.workspaceId)!
}

async function imageTurn(sessionId: string, name: string, prompt = 'a red fox') {
  await fs.writeFile(path.join(media(), name), `bytes of ${name}`)
  const item = {
    id: `item-${name}`,
    mode: 'imageGen',
    state: 'done',
    type: 'image',
    imageUrl: `aipg-media://media/${name}`,
    settings: { preset: 'Image Gen', prompt },
    dynamicSettings: [],
    createdAt: 1,
  } as MediaItem
  return recordMediaTurn({
    sessionId,
    runId: `run-${name}`,
    mode: 'imageGen',
    preset: 'Image Gen',
    prompt,
    status: 'completed',
    items: [item],
    localPathOf: (url) => path.join(media(), url.slice('aipg-media://media/'.length)),
  })
}

describe("a new Session's app-created Workspace", () => {
  it('is named after the date and "New session", and is not on disk before it is used', async () => {
    const { id } = await createSession()

    const workspace = await workspaceOf(id)

    expect(workspace.hostPath).toBe(path.join(readable(), '2026-11-19 New session'))
    expect(workspace.appCreated).toBe(true)
    expect(await onDisk()).toEqual([])
  })

  it('is created by the first turn, which lands its Artifact there', async () => {
    const { id } = await createSession()

    await imageTurn(id, 'fox.png')

    const workspace = await workspaceOf(id)
    expect(await fs.readdir(workspace.hostPath)).toEqual(['fox.png'])
  })

  it('is created when it is opened', async () => {
    const { id } = await createSession()
    const { workspaceId } = await readSessionFolders(id)

    const entry = await ensureFolderEntry(id, workspaceId)

    expect((await fs.stat(entry.hostPath)).isDirectory()).toBe(true)
    expect(await onDisk()).toEqual(['2026-11-19 New session'])
  })

  it('takes the title the Session already has when it is first created', async () => {
    const { id } = await createSession()
    await renameSession(id, 'Cat poster')

    expect(await onDisk()).toEqual([])
    await ensureSessionWorkspace(id)

    expect(await onDisk()).toEqual(['2026-11-19 Cat poster'])
  })

  it('gets a suffix when the name is taken', async () => {
    const first = await createSession()
    const second = await createSession()
    await fs.mkdir(path.join(readable(), '2026-11-19 New session (2)'), { recursive: true })

    await ensureSessionWorkspace(first.id)
    const dir = await ensureSessionWorkspace(second.id)

    expect(path.basename(dir)).toBe('2026-11-19 New session (3)')
    expect((await workspaceOf(second.id)).hostPath).toBe(dir)
  })

  it('is the working directory of the Assistant', async () => {
    const { id } = await createSession()

    const harness = await harnessSessionFor(id, 'Assistant')

    expect(harness.workspaceDir).toBe(path.join(readable(), '2026-11-19 New session'))
  })
})

describe('renaming the app-created Workspace with the Session', () => {
  it('follows the generated title of the first turn', async () => {
    const { id } = await createSession()

    await imageTurn(id, 'fox.png', 'A red fox: in the snow?')

    expect(await onDisk()).toEqual(['2026-11-19 A red fox in the snow'])
    expect(await fs.readdir(path.join(readable(), '2026-11-19 A red fox in the snow'))).toEqual([
      'fox.png',
    ])
  })

  it('follows a manual rename, keeping its slug and its History', async () => {
    const { id } = await createSession()
    await imageTurn(id, 'fox.png')
    const before = await workspaceOf(id)

    await renameSession(id, 'Cat poster')

    const after = await workspaceOf(id)
    expect(await onDisk()).toEqual(['2026-11-19 Cat poster'])
    expect(after.slug).toBe(before.slug)
    expect(after.id).toBe(before.id)
    const [entry] = await readHistoryEntries(id)
    const file = artifactHostPath(id, entry.artifacts[0], await readSessionFolders(id))
    expect(await fs.readFile(file!, 'utf8')).toBe('bytes of fox.png')
  })

  it('waits while something is in flight in the Session, then renames once idle', async () => {
    const { id } = await createSession()
    await ensureSessionWorkspace(id)
    claimSessionTurn(id, { turnId: 'turn-1', kind: 'media' })

    await renameSession(id, 'Cat poster')
    expect(await onDisk()).toEqual(['2026-11-19 New session'])

    releaseSessionTurn(id, 'turn-1')
    await settleWorkspaceRenames()
    expect(await onDisk()).toEqual(['2026-11-19 Cat poster'])
    expect((await workspaceOf(id)).hostPath).toBe(path.join(readable(), '2026-11-19 Cat poster'))
  })

  it('takes a suffix when another folder already has the name', async () => {
    const { id } = await createSession()
    await ensureSessionWorkspace(id)
    await fs.mkdir(path.join(readable(), '2026-11-19 Cat poster'))

    await renameSession(id, 'Cat poster')

    expect((await workspaceOf(id)).hostPath).toBe(
      path.join(readable(), '2026-11-19 Cat poster (2)'),
    )
  })

  it('never renames a folder the user added', async () => {
    const { id } = await createSession()
    const own = path.join(dirs.root, 'Projects', 'posters')
    await fs.mkdir(own, { recursive: true })
    await addSessionFolder(id, own)

    await renameSession(id, 'Cat poster')

    const { folders } = await readSessionFolders(id)
    expect(folders.map((folder) => folder.hostPath)).toContain(own)
    expect((await fs.stat(own)).isDirectory()).toBe(true)
  })

  it('stops following the title once another folder is the Workspace', async () => {
    const { id } = await createSession()
    await imageTurn(id, 'fox.png')
    const previous = (await workspaceOf(id)).hostPath
    const own = path.join(dirs.root, 'Projects', 'posters')
    await fs.mkdir(own, { recursive: true })
    const { list } = await addSessionFolder(id, own)
    await starSessionFolder(id, list.folders.find((folder) => folder.hostPath === own)!.id)

    await renameSession(id, 'Cat poster')

    const { folders } = await readSessionFolders(id)
    expect(folders.map((folder) => folder.hostPath)).toContain(previous)
    expect(await onDisk()).toEqual([path.basename(previous)])
  })

  it('leaves the folder of an older Session where it is', async () => {
    const { id } = await createSession()
    await imageTurn(id, 'fox.png')
    const legacy = path.join(dirs.root, 'AI-Playground', 'sessions', id, 'files')
    await fs.mkdir(legacy, { recursive: true })
    const recordFile = path.join(dirs.root, 'userData', 'sessions', id, 'session.json')
    const record = JSON.parse(await fs.readFile(recordFile, 'utf8'))
    record.folders[0].hostPath = legacy
    await fs.writeFile(recordFile, JSON.stringify(record))

    await renameSession(id, 'Cat poster')

    expect((await workspaceOf(id)).hostPath).toBe(legacy)
  })
})
