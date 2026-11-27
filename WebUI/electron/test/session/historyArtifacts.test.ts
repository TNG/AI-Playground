import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryArtifact } from '@/types/sessionIpc'

const dirs = vi.hoisted(() => ({ real: '', demo: '', picked: '', reader: '' }))

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

const { createSession, mutateSession, resetSessionsForTest, setSessionDeps, sessionPaths } =
  await import('../../session/sessions')
const { appendHistoryEntry } = await import('../../session/sessionHistory')
const { addSessionFolder, removeSessionFolder, sessionWorkspaceEntry } =
  await import('../../session/sessionFolders')
const { getSessionHistoryEntry, listSessionHistory, takeSessionUpdate } =
  await import('../../session/sessionUpdate')
const { READER_COPY_CAP_BYTES } = await import('../../session/historyArtifacts')
const { agentHistoryReader } = await import('../../agent/sessionHistoryTool')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-history-artifacts-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.picked = path.join(root, 'picked')
  dirs.reader = path.join(root, 'reader')
})

beforeEach(async () => {
  setSessionDeps({ isDemoMode: () => false })
  await fs.mkdir(dirs.picked, { recursive: true })
  await fs.mkdir(dirs.reader, { recursive: true })
})

afterEach(async () => {
  resetSessionsForTest()
  for (const dir of [dirs.real, dirs.picked, dirs.reader]) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// An older Session, whose Workspace is its files/ folder, so both entry forms reach it.
async function sessionWithWorkspaceFile(name: string) {
  const { id } = await createSession()
  const filesDir = sessionPaths(id).filesDir
  await mutateSession(id, (file) => ({
    ...file,
    folders: file.folders?.map(({ planned: _planned, ...entry }) => ({
      ...entry,
      hostPath: filesDir,
    })),
  }))
  await fs.mkdir(filesDir, { recursive: true })
  await fs.writeFile(path.join(filesDir, name), `${name}-bytes`)
  return { id, filesDir, workspace: await sessionWorkspaceEntry(id) }
}

async function photosFolder(id: string, file: string, bytes = 'cat-bytes') {
  const hostPath = path.join(dirs.picked, 'Photos')
  await fs.mkdir(hostPath, { recursive: true })
  await fs.writeFile(path.join(hostPath, file), bytes)
  const { list } = await addSessionFolder(id, hostPath)
  const entry = list.folders.find((folder) => folder.hostPath === hostPath)!
  return { hostPath, folderId: entry.id }
}

async function recorded(id: string, artifacts: HistoryArtifact[]) {
  await appendHistoryEntry(id, {
    preset: 'Image Gen',
    kind: 'image',
    prompt: 'a red fox',
    status: 'completed',
    artifacts,
  })
  const [row] = await listSessionHistory(id, {})
  return row.id
}

describe('History Artifacts as a reader sees them', () => {
  it('shows a Workspace Artifact relative to the Workspace, in both entry forms', async () => {
    const { id, filesDir, workspace } = await sessionWithWorkspaceFile('fox.png')
    const entryId = await recorded(id, [
      { folderId: workspace.id, path: 'fox.png', mediaType: 'image' },
      { path: 'files/fox.png', mediaType: 'image' },
    ])

    const entry = await getSessionHistoryEntry(id, entryId, { workspaceDir: filesDir })

    expect(entry?.artifacts).toEqual([
      { path: 'fox.png', mediaType: 'image' },
      { path: 'fox.png', mediaType: 'image' },
    ])
  })

  it('shows an Artifact in another folder the reader has at that folder’s path', async () => {
    const { id, filesDir } = await sessionWithWorkspaceFile('fox.png')
    const photos = await photosFolder(id, 'cat.png')
    const entryId = await recorded(id, [
      { folderId: photos.folderId, path: 'cat.png', mediaType: 'image' },
    ])

    const update = await takeSessionUpdate(id, {
      key: 'agent-1',
      reader: {
        workspaceDir: filesDir,
        folders: [{ hostPath: photos.hostPath, path: '/mnt/photos' }],
      },
    })
    const entry = await getSessionHistoryEntry(id, entryId, {
      workspaceDir: filesDir,
      folders: [{ hostPath: photos.hostPath, path: '/mnt/photos' }],
    })

    expect(update).toContain('→ /mnt/photos/cat.png')
    expect(entry?.artifacts).toEqual([{ path: '/mnt/photos/cat.png', mediaType: 'image' }])
  })

  it('copies a small unreachable image into the reader’s Workspace on demand', async () => {
    const { id } = await sessionWithWorkspaceFile('fox.png')
    const photos = await photosFolder(id, 'cat.png')
    await recorded(id, [{ folderId: photos.folderId, path: 'cat.png', mediaType: 'image' }])

    const update = await takeSessionUpdate(id, {
      key: 'agent-run',
      reader: { workspaceDir: dirs.reader },
    })

    expect(update).toContain('→ generated/cat.png')
    expect(await fs.readFile(path.join(dirs.reader, 'generated', 'cat.png'), 'utf8')).toBe(
      'cat-bytes',
    )
  })

  it('gives two different unreachable files of one name a copy each, and reuses a copy', async () => {
    const { id, filesDir, workspace } = await sessionWithWorkspaceFile('cat.png')
    const photos = await photosFolder(id, 'cat.png')
    const entryId = await recorded(id, [
      { folderId: photos.folderId, path: 'cat.png', mediaType: 'image' },
      { folderId: workspace.id, path: 'cat.png', mediaType: 'image' },
    ])
    const reader = { workspaceDir: dirs.reader }

    const first = await getSessionHistoryEntry(id, entryId, reader)
    const again = await getSessionHistoryEntry(id, entryId, reader)

    expect(first?.artifacts).toEqual([
      { path: 'generated/cat.png', mediaType: 'image' },
      { path: 'generated/cat-1.png', mediaType: 'image' },
    ])
    expect(again).toEqual(first)
    expect(await fs.readFile(path.join(dirs.reader, 'generated', 'cat-1.png'), 'utf8')).toBe(
      await fs.readFile(path.join(filesDir, 'cat.png'), 'utf8'),
    )
    expect(await fs.readdir(path.join(dirs.reader, 'generated'))).toHaveLength(2)
  })

  it('marks an unreachable Artifact that is not small media as not accessible', async () => {
    const { id } = await sessionWithWorkspaceFile('fox.png')
    const photos = await photosFolder(id, 'cat.glb')
    const big = path.join(photos.hostPath, 'long.mp4')
    await fs.writeFile(big, '')
    await fs.truncate(big, READER_COPY_CAP_BYTES + 1)
    const entryId = await recorded(id, [
      { folderId: photos.folderId, path: 'cat.glb', mediaType: 'model3d' },
      { folderId: photos.folderId, path: 'long.mp4', mediaType: 'video' },
    ])

    const entry = await getSessionHistoryEntry(id, entryId, { workspaceDir: dirs.reader })
    const update = await takeSessionUpdate(id, { key: 'r', reader: { workspaceDir: dirs.reader } })

    expect(entry?.artifacts).toEqual([
      { mediaType: 'model3d', notAccessible: true },
      { mediaType: 'video', notAccessible: true },
    ])
    expect(update).toContain('→ (model3d not accessible), (video not accessible)')
    await expect(fs.readdir(dirs.reader)).resolves.toEqual([])
  })

  it('still finds an Artifact whose folder left the list, as a copy', async () => {
    const { id, filesDir } = await sessionWithWorkspaceFile('fox.png')
    const photos = await photosFolder(id, 'cat.png')
    const entryId = await recorded(id, [
      { folderId: photos.folderId, path: 'cat.png', mediaType: 'image' },
    ])
    await removeSessionFolder(id, photos.folderId)

    const entry = await getSessionHistoryEntry(id, entryId, { workspaceDir: filesDir })

    expect(entry?.artifacts).toEqual([{ path: 'generated/cat.png', mediaType: 'image' }])
  })

  it('gives a reader without folders the Session Folder path, in both entry forms', async () => {
    const { id, workspace } = await sessionWithWorkspaceFile('fox.png')
    const entryId = await recorded(id, [
      { folderId: workspace.id, path: 'fox.png', mediaType: 'image' },
      { path: 'files/fox.png', mediaType: 'image' },
    ])

    const entry = await getSessionHistoryEntry(id, entryId)

    expect(entry?.artifacts).toEqual([
      { path: 'files/fox.png', mediaType: 'image' },
      { path: 'files/fox.png', mediaType: 'image' },
    ])
  })

  it('gives a reader without folders the real path of an Artifact outside the Session Folder', async () => {
    const { id } = await sessionWithWorkspaceFile('fox.png')
    const photos = await photosFolder(id, 'cat.png')
    const entryId = await recorded(id, [
      { folderId: photos.folderId, path: 'cat.png', mediaType: 'image' },
    ])

    const entry = await getSessionHistoryEntry(id, entryId)

    expect(entry?.artifacts).toEqual([
      { path: path.join(photos.hostPath, 'cat.png'), mediaType: 'image' },
    ])
  })
})

describe('an agent turn as reader', () => {
  it('sees its Workspace relative to its cwd and its other mounts at /mnt/<slug>', async () => {
    const { id, filesDir, workspace } = await sessionWithWorkspaceFile('fox.png')
    const photos = await photosFolder(id, 'cat.png')
    const entryId = await recorded(id, [
      { folderId: workspace.id, path: 'fox.png', mediaType: 'image' },
      { folderId: photos.folderId, path: 'cat.png', mediaType: 'image' },
    ])
    const reader = agentHistoryReader(
      filesDir,
      {
        workspace: { hostPath: filesDir, name: workspace.slug, access: 'read-write' },
        mounted: [{ hostPath: photos.hostPath, name: 'Photos', access: 'read-only' }],
      },
      { unsandboxed: false, games: false },
    )

    const entry = await getSessionHistoryEntry(id, entryId, reader)

    expect(entry?.artifacts).toEqual([
      { path: 'fox.png', mediaType: 'image' },
      { path: '/mnt/Photos/cat.png', mediaType: 'image' },
    ])
  })
})

describe('a games reader', () => {
  it('copies any Session Artifact into generated/, whatever its type or size, as before', async () => {
    const { id, workspace } = await sessionWithWorkspaceFile('ship.glb')
    const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-game-'))
    await recorded(id, [{ folderId: workspace.id, path: 'ship.glb', mediaType: 'model3d' }])

    const update = await takeSessionUpdate(id, {
      key: 'game-1',
      reader: { workspaceDir: gameDir, copies: 'any' },
    })

    expect(update).toContain('→ generated/ship.glb')
    expect(await fs.readFile(path.join(gameDir, 'generated', 'ship.glb'), 'utf8')).toBe(
      'ship.glb-bytes',
    )
  })
})
