import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '@/types/mediaItem'

const dirs = vi.hoisted(() => ({ real: '', demo: '', media: '', picked: '' }))

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

const { createSession, openSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const {
  addSessionFolder,
  readSessionFolders,
  removeSessionFolder,
  starSessionFolder,
  startNewSessionWorkspace,
} = await import('../../session/sessionFolders')
const { recordMediaTurn } = await import('../../session/sessionMediaTurn')
const { listAllArtifacts, missingArtifactUrls } = await import('../../session/sessionArtifacts')
const { historyAsSeenBy } = await import('../../session/historyArtifacts')
const { sessionFolderMediaFile } = await import('../../session/sessionFolderMedia')
const { resetSessionTurnsForTest } = await import('../../session/sessionTurns')
const { sessionWorkspaceDir } = await import('../../session/sessionWorkspace')

beforeAll(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-folder-detach-')))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.media = path.join(root, 'media')
  dirs.picked = path.join(root, 'picked')
})

beforeEach(async () => {
  setSessionDeps({ isDemoMode: () => false })
  await fs.mkdir(dirs.media, { recursive: true })
  await fs.mkdir(dirs.picked, { recursive: true })
})

afterEach(async () => {
  resetSessionsForTest()
  resetSessionTurnsForTest()
  for (const dir of [dirs.real, `${dirs.real}-workspaces`, dirs.media, dirs.picked]) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

const localPathOf = (url: string): string | null =>
  url.startsWith('aipg-media://media/')
    ? path.join(dirs.media, decodeURIComponent(url.slice('aipg-media://media/'.length)))
    : null

async function generate(sessionId: string, name: string): Promise<string> {
  await fs.writeFile(path.join(dirs.media, name), `bytes of ${name}`)
  const [item] = await recordMediaTurn({
    sessionId,
    runId: name,
    mode: 'imageGen',
    preset: 'Dummy Image (test)',
    prompt: 'a red fox',
    status: 'completed',
    items: [
      {
        id: `item-${name}`,
        mode: 'imageGen',
        state: 'done',
        type: 'image',
        imageUrl: `aipg-media://media/${name}`,
        settings: { preset: 'Dummy Image (test)', prompt: 'a red fox' },
        dynamicSettings: [],
        createdAt: 1,
      } as MediaItem,
    ],
    localPathOf,
  })
  return item.type === 'image' ? item.imageUrl : ''
}

async function userFolder(id: string, name: string): Promise<{ id: string; hostPath: string }> {
  const hostPath = path.join(dirs.picked, name)
  await fs.mkdir(hostPath, { recursive: true })
  const { list } = await addSessionFolder(id, hostPath)
  const entry = list.folders.find((folder) => folder.hostPath === hostPath)
  if (!entry) throw new Error('folder not added')
  return { id: entry.id, hostPath }
}

async function bytesAt(url: string): Promise<string | null> {
  const file = sessionFolderMediaFile(url)
  return file ? fs.readFile(file, 'utf8').catch(() => null) : null
}

describe('starring another folder', () => {
  it('moves nothing: the old Workspace keeps its files and stays listed', async () => {
    const { id } = await createSession()
    const foxUrl = await generate(id, 'fox.png')
    const appCreated = sessionWorkspaceDir(id)
    const project = await userFolder(id, 'Project')

    const { list } = await starSessionFolder(id, project.id)

    expect(await fs.readdir(appCreated)).toEqual(['fox.png'])
    expect(await fs.readdir(project.hostPath)).toEqual([])
    expect(list.workspaceId).toBe(project.id)
    expect(list.folders.map((folder) => folder.hostPath)).toContain(appCreated)
    expect(await bytesAt(foxUrl)).toBe('bytes of fox.png')
    expect(JSON.stringify((await openSession(id)).timeline)).toContain(foxUrl)
  })
})

describe('the folder the app created for the Session', () => {
  it('cannot leave the list, even once another folder is the Workspace', async () => {
    const { id } = await createSession()
    const foxUrl = await generate(id, 'fox.png')
    const project = await userFolder(id, 'Project')
    await starSessionFolder(id, project.id)
    const own = (await readSessionFolders(id)).folders.find((folder) => folder.appCreated)!

    await expect(removeSessionFolder(id, own.id)).rejects.toThrow(/created for this Session/)

    expect((await readSessionFolders(id)).folders.map((folder) => folder.id)).toContain(own.id)
    expect(await bytesAt(foxUrl)).toBe('bytes of fox.png')
    expect((await listAllArtifacts()).map((artifact) => artifact.url)).toEqual([foxUrl])
  })
})

describe('removing a folder that holds Artifacts', () => {
  it('keeps a user folder’s Artifacts viewable once it leaves the list', async () => {
    const { id } = await createSession()
    const project = await userFolder(id, 'Project')
    await starSessionFolder(id, project.id)
    const owlUrl = await generate(id, 'owl.png')
    const other = await userFolder(id, 'Other')
    await starSessionFolder(id, other.id)

    await removeSessionFolder(id, project.id)

    expect(await bytesAt(owlUrl)).toBe('bytes of owl.png')
    expect(await missingArtifactUrls(id)).toEqual([])
  })

  it('no longer mounts it, and an agent reader gets a copy of its media', async () => {
    const { id } = await createSession()
    const project = await userFolder(id, 'Project')
    await starSessionFolder(id, project.id)
    await generate(id, 'fox.png')
    const own = (await readSessionFolders(id)).folders.find((folder) => folder.appCreated)!
    await starSessionFolder(id, own.id)
    await removeSessionFolder(id, project.id)

    const seen = await historyAsSeenBy(id, await readHistoryEntries(id), {
      workspaceDir: sessionWorkspaceDir(id),
    })

    const [artifact] = seen.flatMap((entry) => entry.artifacts)
    expect(artifact).toMatchObject({ path: expect.stringContaining('fox.png') })
    expect((await readSessionFolders(id)).folders.map((folder) => folder.id)).toEqual([own.id])
  })

  it('serves nothing outside the removed folder', async () => {
    const { id } = await createSession()
    const project = await userFolder(id, 'Project')
    await removeSessionFolder(id, project.id)

    expect(sessionFolderMediaFile(`aipg-media://folders/${id}/${project.id}/../secret`)).toBeNull()
  })

  it('keeps its /mnt name for it, so another folder of that name gets a new one', async () => {
    const { id } = await createSession()
    const first = await userFolder(id, 'a/proj')
    await removeSessionFolder(id, first.id)

    const second = await userFolder(id, 'b/proj')
    const { list } = await addSessionFolder(id, first.hostPath)

    const slugOf = (folderId: string) => list.folders.find((folder) => folder.id === folderId)!.slug
    expect(slugOf(second.id)).toBe('proj-2')
    expect(slugOf(first.id)).toBe('proj')
  })

  it('takes the same entry back when the folder is added again', async () => {
    const { id } = await createSession()
    const project = await userFolder(id, 'Project')
    await removeSessionFolder(id, project.id)

    const { list } = await addSessionFolder(id, project.hostPath)

    const again = list.folders.find((folder) => folder.hostPath === project.hostPath)!
    expect(again.id).toBe(project.id)
    expect(again.access).toBe('read-only')
  })
})

describe('starting a new Workspace in place of a missing one', () => {
  it('keeps the missing folder’s Artifacts addressable if the folder comes back', async () => {
    const { id } = await createSession()
    const project = await userFolder(id, 'Project')
    await starSessionFolder(id, project.id)
    const owlUrl = await generate(id, 'owl.png')
    await fs.rename(project.hostPath, `${project.hostPath}-away`)

    await startNewSessionWorkspace(id)
    await fs.rename(`${project.hostPath}-away`, project.hostPath)

    expect(await bytesAt(owlUrl)).toBe('bytes of owl.png')
  })
})
