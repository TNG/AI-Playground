import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '', trash: '' }))

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

vi.mock('../../adapters/trash', () => ({
  moveToTrash: async (target: string) => {
    await fs.mkdir(dirs.trash, { recursive: true })
    await fs.rename(target, path.join(dirs.trash, path.basename(target)))
  },
}))

const { createSession, deleteSession, renameSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { ensureSessionWorkspace } = await import('../../session/sessionWorkspace')
const { appendHistoryEntry } = await import('../../session/sessionHistory')
const {
  deleteArtifact,
  listAllArtifacts,
  missingArtifactUrls,
  newestArtifact,
  openArtifactActions,
} = await import('../../session/sessionArtifacts')
const { addSessionFolder, sessionWorkspaceEntry, starSessionFolder } =
  await import('../../session/sessionFolders')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-artifacts-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.trash = path.join(root, 'Trash')
})

let demo = false

beforeEach(() => {
  demo = false
  setSessionDeps({ isDemoMode: () => demo })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.demo, { recursive: true, force: true })
  await fs.rm(dirs.trash, { recursive: true, force: true })
})

async function sessionWithArtifacts(title: string, names: string[], prompt = 'a red fox') {
  const { id } = await createSession()
  await renameSession(id, title)
  const filesDir = path.join(demo ? dirs.demo : dirs.real, id, 'files')
  await fs.mkdir(filesDir, { recursive: true })
  for (const name of names) await fs.writeFile(path.join(filesDir, name), `bytes of ${name}`)
  await appendHistoryEntry(id, {
    preset: 'Dummy Image (test)',
    kind: 'image',
    prompt,
    status: 'completed',
    artifacts: names.map((name) => ({ path: `files/${name}`, mediaType: 'image' as const })),
  })
  return id
}

describe('the gallery across Sessions', () => {
  it('lists the artifacts of every Session, newest first', async () => {
    const older = await sessionWithArtifacts('Foxes', ['fox.png'])
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newer = await sessionWithArtifacts('Owls', ['owl-1.png', 'owl-2.png'], 'an owl')

    const artifacts = await listAllArtifacts()

    expect(artifacts.map((artifact) => [artifact.sessionId, artifact.path])).toEqual([
      [newer, 'files/owl-1.png'],
      [newer, 'files/owl-2.png'],
      [older, 'files/fox.png'],
    ])
    expect(artifacts[2]).toEqual(
      expect.objectContaining({
        sessionTitle: 'Foxes',
        preset: 'Dummy Image (test)',
        kind: 'image',
        prompt: 'a red fox',
        mediaType: 'image',
        url: `aipg-media://sessions/${older}/files/fox.png`,
      }),
    )
  })

  it('leaves out an artifact whose file is gone', async () => {
    const id = await sessionWithArtifacts('Foxes', ['fox.png', 'gone.png'])
    await fs.rm(path.join(dirs.real, id, 'files', 'gone.png'))

    expect((await listAllArtifacts()).map((artifact) => artifact.path)).toEqual(['files/fox.png'])
  })

  it('drops a deleted Session’s artifacts', async () => {
    const kept = await sessionWithArtifacts('Foxes', ['fox.png'])
    const removed = await sessionWithArtifacts('Owls', ['owl.png'])

    await deleteSession(removed)

    expect((await listAllArtifacts()).map((artifact) => artifact.sessionId)).toEqual([kept])
  })

  it('lists only the demo root in demo mode', async () => {
    await sessionWithArtifacts('Real', ['fox.png'])
    demo = true
    const demoId = await sessionWithArtifacts('Demo', ['owl.png'])

    expect((await listAllArtifacts()).map((artifact) => artifact.sessionId)).toEqual([demoId])
  })
})

describe('deleting an artifact', () => {
  it('moves the file to the Trash and leaves the History Entries byte for byte', async () => {
    const id = await sessionWithArtifacts('Foxes', ['fox.png', 'owl.png'])
    const historyFile = path.join(dirs.real, id, 'session-history.jsonl')
    const before = await fs.readFile(historyFile)

    await deleteArtifact(id, `aipg-media://sessions/${id}/files/fox.png`)

    expect(await fs.readdir(path.join(dirs.real, id, 'files'))).toEqual(['owl.png'])
    expect(await fs.readdir(dirs.trash)).toEqual(['fox.png'])
    expect(await fs.readFile(historyFile)).toEqual(before)
    expect((await listAllArtifacts()).map((artifact) => artifact.path)).toEqual(['files/owl.png'])
  })

  it('reports the deleted file as missing for the timeline card', async () => {
    const id = await sessionWithArtifacts('Foxes', ['fox.png', 'owl.png'])

    await deleteArtifact(id, `aipg-media://sessions/${id}/files/fox.png`)

    expect(await missingArtifactUrls(id)).toEqual([`aipg-media://sessions/${id}/files/fox.png`])
  })

  it('lists, deletes and reports a folder-and-path Artifact like an older one', async () => {
    const { id } = await createSession()
    const filesDir = await ensureSessionWorkspace(id)
    await fs.mkdir(filesDir, { recursive: true })
    await fs.writeFile(path.join(filesDir, 'fox.png'), 'fox')
    const { id: folderId } = await sessionWorkspaceEntry(id)
    await appendHistoryEntry(id, {
      preset: 'Dummy Image (test)',
      kind: 'image',
      prompt: 'a red fox',
      status: 'completed',
      artifacts: [{ folderId, path: 'fox.png', mediaType: 'image' }],
    })
    const url = `aipg-media://folders/${id}/${folderId}/fox.png`

    expect(await listAllArtifacts()).toEqual([expect.objectContaining({ path: 'fox.png', url })])
    expect(await newestArtifact(id, 'image')).toEqual(
      expect.objectContaining({ path: 'fox.png', url }),
    )
    await deleteArtifact(id, url)
    expect(await missingArtifactUrls(id)).toEqual([url])
  })

  it('lists and deletes an Artifact in a starred user folder, and only a recorded one', async () => {
    const { id } = await createSession()
    const project = path.join(dirs.real, '..', 'Project')
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(path.join(project, 'fox.png'), 'fox')
    await fs.writeFile(path.join(project, 'notes.txt'), 'mine')
    const { list } = await addSessionFolder(id, project)
    const folderId = list.folders.find((folder) => folder.hostPath === project)!.id
    await starSessionFolder(id, folderId)
    await appendHistoryEntry(id, {
      preset: 'Dummy Image (test)',
      kind: 'image',
      prompt: 'a red fox',
      status: 'completed',
      artifacts: [{ folderId, path: 'fox.png', mediaType: 'image' }],
    })
    const url = `aipg-media://folders/${id}/${folderId}/fox.png`

    expect((await listAllArtifacts()).map((artifact) => artifact.url)).toEqual([url])
    await expect(
      deleteArtifact(id, `aipg-media://folders/${id}/${folderId}/notes.txt`),
    ).rejects.toThrow()
    await deleteArtifact(id, url)

    expect(await fs.readdir(project)).toEqual(['notes.txt'])
    expect(await fs.readdir(dirs.trash)).toEqual(['fox.png'])
    await fs.rm(project, { recursive: true })
  })

  it('is a no-op for a file already gone', async () => {
    const id = await sessionWithArtifacts('Foxes', ['fox.png'])
    await deleteArtifact(id, `aipg-media://sessions/${id}/files/fox.png`)

    await expect(
      deleteArtifact(id, `aipg-media://sessions/${id}/files/fox.png`),
    ).resolves.toBeUndefined()
  })

  it.each(['../session.json', 'session.json', 'files/../session-history.jsonl', 'files'])(
    'refuses a path outside the Session’s files (%s)',
    async (relativePath) => {
      const id = await sessionWithArtifacts('Foxes', ['fox.png'])

      await expect(
        deleteArtifact(id, `aipg-media://sessions/${id}/${relativePath}`),
      ).rejects.toThrow()

      const folder = (await fs.readdir(path.join(dirs.real, id))).sort()
      expect(folder).toEqual(['files', 'session-history.jsonl', 'session.json'])
      expect(await fs.readdir(path.join(dirs.real, id, 'files'))).toEqual(['fox.png'])
    },
  )
})

describe('opening an artifact', () => {
  it('opens the artifact file with the OS default application', async () => {
    const id = await sessionWithArtifacts('Foxes', ['fox.png'])
    const open = vi.fn(async () => '')

    await openArtifactActions({ open })(id, `aipg-media://sessions/${id}/files/fox.png`)

    expect(open).toHaveBeenCalledWith(path.join(dirs.real, id, 'files', 'fox.png'))
  })

  it('reports the OS open error text', async () => {
    const id = await sessionWithArtifacts('Foxes', ['fox.png'])
    const open = vi.fn(async () => 'No application is available for this file type')

    await expect(
      openArtifactActions({ open })(id, `aipg-media://sessions/${id}/files/fox.png`),
    ).rejects.toThrow('No application is available for this file type')
  })

  it('refuses a URL that names no artifact of this Session', async () => {
    const id = await sessionWithArtifacts('Foxes', ['fox.png'])
    const other = await sessionWithArtifacts('Owls', ['owl.png'])
    const open = vi.fn(async () => '')

    await expect(
      openArtifactActions({ open })(id, `aipg-media://sessions/${other}/files/owl.png`),
    ).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
})
