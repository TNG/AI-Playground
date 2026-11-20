import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '', picked: '' }))

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

const { createSession, openSession, renameSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const {
  addSessionFolder,
  locateSessionWorkspace,
  readSessionFolders,
  setSessionFolderAccess,
  starSessionFolder,
  startNewSessionWorkspace,
} = await import('../../session/sessionFolders')
const { recordAudioTurn } = await import('../../session/sessionAudioTurn')
const { resetSessionTurnsForTest } = await import('../../session/sessionTurns')
const { settleWorkspaceRenames } = await import('../../session/appWorkspace')
const { assertSessionWorkspacePresent, ensureSessionWorkspace, missingSessionWorkspace } =
  await import('../../session/sessionWorkspace')

beforeAll(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-missing-ws-')))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.picked = path.join(root, 'picked')
})

beforeEach(async () => {
  setSessionDeps({ isDemoMode: () => false })
  await fs.mkdir(dirs.picked, { recursive: true })
})

afterEach(async () => {
  await settleWorkspaceRenames()
  resetSessionsForTest()
  resetSessionTurnsForTest()
  for (const dir of [dirs.real, `${dirs.real}-workspaces`, dirs.picked])
    await fs.rm(dir, { recursive: true, force: true })
})

async function starredUserFolder(id: string, name: string) {
  const hostPath = path.join(dirs.picked, name)
  await fs.mkdir(hostPath, { recursive: true })
  const { list } = await addSessionFolder(id, hostPath)
  const entry = list.folders.find((folder) => folder.hostPath === hostPath)
  if (!entry) throw new Error('folder not added')
  await starSessionFolder(id, entry.id)
  return { ...entry, hostPath }
}

function ttsTurn(sessionId: string, fileName: string) {
  return recordAudioTurn({
    sessionId,
    kind: 'tts',
    preset: 'Text to Speech',
    prompt: 'hello',
    status: 'completed',
    audio: { fileName, base64: Buffer.from('RIFF').toString('base64') },
  })
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
}

describe('a missing Workspace', () => {
  it('is reported when a starred user folder no longer exists', async () => {
    const { id } = await createSession()
    const project = await starredUserFolder(id, 'Project')
    expect(await missingSessionWorkspace(id)).toBeNull()

    await fs.rm(project.hostPath, { recursive: true })

    expect(await missingSessionWorkspace(id)).toEqual({
      folderId: project.id,
      hostPath: project.hostPath,
      name: 'Project',
    })
  })

  it('is never reported for the app-created Workspace, which is made on demand', async () => {
    const { id } = await createSession()
    expect(await missingSessionWorkspace(id)).toBeNull()
  })

  it('reports a folder renamed outside the app as missing and keeps the Session title', async () => {
    const { id } = await createSession()
    await renameSession(id, 'My trip')
    const project = await starredUserFolder(id, 'Project')

    await fs.rename(project.hostPath, path.join(dirs.picked, 'Renamed'))

    expect((await missingSessionWorkspace(id))?.hostPath).toBe(project.hostPath)
    expect((await openSession(id)).title).toBe('My trip')
  })

  it('refuses a turn with a message naming the folder', async () => {
    const { id } = await createSession()
    const project = await starredUserFolder(id, 'Project')
    await fs.rm(project.hostPath, { recursive: true })

    await expect(assertSessionWorkspacePresent(id)).rejects.toThrow(
      /Workspace folder "Project" is missing: .*Project/,
    )
  })

  it('leaves a turn in another folder (a game) alone', async () => {
    const { id } = await createSession()
    const project = await starredUserFolder(id, 'Project')
    await fs.rm(project.hostPath, { recursive: true })

    await expect(
      assertSessionWorkspacePresent(id, path.join(dirs.picked, 'some-game')),
    ).resolves.toBeUndefined()
  })

  it('writes nothing to a fallback folder', async () => {
    const { id } = await createSession()
    const project = await starredUserFolder(id, 'Project')
    await fs.rm(project.hostPath, { recursive: true })

    await expect(ttsTurn(id, 'hello.wav')).rejects.toThrow(/missing/)

    expect(await filesUnder(dirs.picked)).toEqual([])
    await expect(fs.stat(project.hostPath)).rejects.toThrow()
    expect(await filesUnder(dirs.real)).not.toContain('hello.wav')
    expect(await filesUnder(`${dirs.real}-workspaces`).catch(() => [])).toEqual([])
  })
})

describe('locating a missing Workspace', () => {
  it('points the entry at the chosen folder and keeps its slug', async () => {
    const { id } = await createSession()
    const project = await starredUserFolder(id, 'Project')
    const moved = path.join(dirs.picked, 'Moved project')
    await fs.rename(project.hostPath, moved)

    const { list } = await locateSessionWorkspace(id, moved)

    expect(list.workspaceId).toBe(project.id)
    const entry = list.folders.find((folder) => folder.id === project.id)
    expect(entry).toMatchObject({ hostPath: moved, slug: project.slug, access: 'read-write' })
    expect(await missingSessionWorkspace(id)).toBeNull()
    await ttsTurn(id, 'hello.wav')
    expect(await fs.readdir(moved)).toEqual(['hello.wav'])
  })

  it('refuses a folder that overlaps another listed folder', async () => {
    const { id } = await createSession()
    const other = path.join(dirs.picked, 'Other')
    await fs.mkdir(other)
    await addSessionFolder(id, other)
    const project = await starredUserFolder(id, 'Project')
    await fs.rm(project.hostPath, { recursive: true })

    const { refusal } = await locateSessionWorkspace(id, other)

    expect(refusal?.reason).toBe('mounted')
    expect((await readSessionFolders(id)).folders.find((f) => f.id === project.id)?.hostPath).toBe(
      project.hostPath,
    )
  })

  it('refuses a path that is not a folder', async () => {
    const { id } = await createSession()
    const project = await starredUserFolder(id, 'Project')
    await fs.rm(project.hostPath, { recursive: true })

    await expect(locateSessionWorkspace(id, path.join(dirs.picked, 'nope'))).rejects.toThrow(
      /not a folder/,
    )
  })
})

describe('going back to the folder created for the Session', () => {
  async function withOwnFolder() {
    const { id } = await createSession()
    const own = await ensureSessionWorkspace(id)
    await fs.writeFile(path.join(own, 'fox.png'), 'fox')
    const ownId = (await readSessionFolders(id)).folders.find((folder) => folder.appCreated)!.id
    const project = await starredUserFolder(id, 'Project')
    await fs.rm(project.hostPath, { recursive: true })
    return { id, own, ownId, project }
  }

  it('is offered while that folder is still there', async () => {
    const { id, ownId } = await withOwnFolder()

    expect((await missingSessionWorkspace(id))?.fallback).toEqual({ folderId: ownId })
  })

  it('stars it again, read-write, files and all, in place of the missing folder', async () => {
    const { id, own, ownId, project } = await withOwnFolder()
    await setSessionFolderAccess(id, ownId, 'read-only')

    const { list } = await startNewSessionWorkspace(id)

    expect(list.workspaceId).toBe(ownId)
    expect(list.folders.find((folder) => folder.id === ownId)?.access).toBe('read-write')
    expect(list.folders.map((folder) => folder.id)).toEqual([ownId])
    expect(list.detached?.map((folder) => folder.id)).toEqual([project.id])
    expect(await fs.readdir(own)).toEqual(['fox.png'])
  })

  it('is not offered once that folder is gone too, and a fresh one replaces it', async () => {
    const { id, own, ownId } = await withOwnFolder()
    await fs.rm(own, { recursive: true })

    expect((await missingSessionWorkspace(id))?.fallback).toBeUndefined()
    const { list } = await startNewSessionWorkspace(id)

    const starred = list.folders.find((folder) => folder.id === list.workspaceId)!
    expect(starred.appCreated).toBe(true)
    expect(starred.id).not.toBe(ownId)
    expect(list.folders.map((folder) => folder.id)).toEqual([starred.id])
  })
})

describe('starting a new Workspace', () => {
  it('stars a fresh app-created Workspace where the next turn lands', async () => {
    const { id } = await createSession()
    const project = await starredUserFolder(id, 'Project')
    await fs.rm(project.hostPath, { recursive: true })

    const { list } = await startNewSessionWorkspace(id)

    const starred = list.folders.find((folder) => folder.id === list.workspaceId)
    expect(starred?.appCreated).toBe(true)
    expect(list.folders.some((folder) => folder.id === project.id)).toBe(false)
    expect(await missingSessionWorkspace(id)).toBeNull()
    await ttsTurn(id, 'hello.wav')
    await settleWorkspaceRenames()
    const now = (await readSessionFolders(id)).folders.find((f) => f.id === starred!.id)
    expect(await fs.readdir(now!.hostPath)).toEqual(['hello.wav'])
  })
})
