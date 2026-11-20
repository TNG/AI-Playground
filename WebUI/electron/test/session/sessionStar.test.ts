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

const { createSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const { addSessionFolder, readSessionFolders, starSessionFolder, sessionWorkspaceEntry } =
  await import('../../session/sessionFolders')
const { recordMediaTurn } = await import('../../session/sessionMediaTurn')
const { recordAudioTurn } = await import('../../session/sessionAudioTurn')
const { claimSessionTurn, releaseSessionTurn, resetSessionTurnsForTest } =
  await import('../../session/sessionTurns')
const { sessionWorkspaceDir } = await import('../../session/sessionWorkspace')

beforeAll(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-star-')))
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
  for (const dir of [dirs.real, dirs.media, dirs.picked]) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

const localPathOf = (url: string): string | null =>
  url.startsWith('aipg-media://media/')
    ? path.join(dirs.media, decodeURIComponent(url.slice('aipg-media://media/'.length)))
    : null

async function comfyOutput(name: string): Promise<string> {
  await fs.writeFile(path.join(dirs.media, name), `bytes of ${name}`)
  return `aipg-media://media/${name}`
}

function doneImage(imageUrl: string): MediaItem {
  return {
    id: `item-${imageUrl}`,
    mode: 'imageGen',
    state: 'done',
    type: 'image',
    imageUrl,
    settings: { preset: 'Dummy Image (test)', prompt: 'a red fox' },
    dynamicSettings: [],
    createdAt: 1,
  } as MediaItem
}

async function generate(sessionId: string, name: string, runId = name): Promise<MediaItem> {
  const [item] = await recordMediaTurn({
    sessionId,
    runId,
    mode: 'imageGen',
    preset: 'Dummy Image (test)',
    prompt: 'a red fox',
    status: 'completed',
    items: [doneImage(await comfyOutput(name))],
    localPathOf,
  })
  return item
}

async function userFolder(id: string, name: string): Promise<{ id: string; hostPath: string }> {
  const hostPath = path.join(dirs.picked, name)
  await fs.mkdir(hostPath, { recursive: true })
  const { list } = await addSessionFolder(id, hostPath)
  const entry = list.folders.find((folder) => folder.hostPath === hostPath)
  if (!entry) throw new Error('folder not added')
  return { id: entry.id, hostPath }
}

describe('starring a folder as the Workspace', () => {
  it('makes the next media Artifacts land at that folder root', async () => {
    const { id } = await createSession()
    await generate(id, 'before.png')
    const appCreated = sessionWorkspaceDir(id)
    const project = await userFolder(id, 'Project')

    await starSessionFolder(id, project.id)
    const item = await generate(id, 'after.png')

    expect(await fs.readdir(project.hostPath)).toEqual(['after.png'])
    expect(await fs.readdir(appCreated)).toEqual(['before.png'])
    expect(item.type === 'image' && item.imageUrl).toBe(
      `aipg-media://folders/${id}/${project.id}/after.png`,
    )
    const [, second] = await readHistoryEntries(id)
    expect(second.artifacts).toEqual([
      { folderId: project.id, path: 'after.png', mediaType: 'image' },
    ])
    expect(await sessionWorkspaceDir(id)).toBe(project.hostPath)
  })

  it('never overwrites a file already in the folder', async () => {
    const { id } = await createSession()
    const project = await userFolder(id, 'Project')
    await fs.writeFile(path.join(project.hostPath, 'fox.png'), 'mine')

    await starSessionFolder(id, project.id)
    await generate(id, 'fox.png')

    expect(await fs.readFile(path.join(project.hostPath, 'fox.png'), 'utf8')).toBe('mine')
    expect((await fs.readdir(project.hostPath)).sort()).toEqual(['fox-1.png', 'fox.png'])
  })

  it('lands audio turns there too', async () => {
    const { id } = await createSession()
    const project = await userFolder(id, 'Project')
    await starSessionFolder(id, project.id)

    await recordAudioTurn({
      sessionId: id,
      kind: 'tts',
      preset: 'Text to Speech',
      prompt: 'hello',
      status: 'completed',
      audio: { base64: Buffer.from('wav').toString('base64'), fileName: 'hello.wav' },
    } as Parameters<typeof recordAudioTurn>[0])

    expect(await fs.readdir(project.hostPath)).toEqual(['hello.wav'])
  })

  it('switches a read-only folder to read-write and says so', async () => {
    const { id } = await createSession()
    const project = await userFolder(id, 'Project')

    const starred = await starSessionFolder(id, project.id)

    expect(starred.madeReadWrite).toBe(true)
    expect(starred.list.workspaceId).toBe(project.id)
    expect(starred.list.folders.find((folder) => folder.id === project.id)?.access).toBe(
      'read-write',
    )
  })

  it('keeps the old Workspace in the list, read-write', async () => {
    const { id } = await createSession()
    const old = await sessionWorkspaceEntry(id)
    const project = await userFolder(id, 'Project')

    const { list, madeReadWrite } = await starSessionFolder(id, project.id)
    await starSessionFolder(id, project.id)

    expect(madeReadWrite).toBe(true)
    expect(list.folders.find((folder) => folder.id === old.id)).toEqual(old)
  })

  it('is refused while the Session has a turn in flight', async () => {
    const { id } = await createSession()
    const project = await userFolder(id, 'Project')
    claimSessionTurn(id, { turnId: 'run-1', kind: 'media', presetName: 'Dummy Image (test)' })

    await expect(starSessionFolder(id, project.id)).rejects.toThrow(/in flight|running/i)
    expect((await readSessionFolders(id)).workspaceId).not.toBe(project.id)

    releaseSessionTurn(id, 'run-1')
    await starSessionFolder(id, project.id)
    expect((await readSessionFolders(id)).workspaceId).toBe(project.id)
  })

  it('lets several Sessions star the same folder', async () => {
    const first = await createSession()
    const second = await createSession()
    const a = await userFolder(first.id, 'Shared')
    const b = await userFolder(second.id, 'Shared')

    await starSessionFolder(first.id, a.id)
    await starSessionFolder(second.id, b.id)
    await generate(first.id, 'one.png')
    await generate(second.id, 'two.png')

    expect((await fs.readdir(a.hostPath)).sort()).toEqual(['one.png', 'two.png'])
  })
})
