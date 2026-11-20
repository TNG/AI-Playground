import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '', trash: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => `${dirs.real}-legacy`,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => `${dirs.demo}-legacy`,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
  getGamesDir: () => `${dirs.real}-games`,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', () => ({
  emitSessionChanged: vi.fn(),
  emitSessionGroupsChanged: vi.fn(),
}))

vi.mock('../../adapters/trash', () => ({
  moveToTrash: async (target: string) => {
    await fs.mkdir(dirs.trash, { recursive: true })
    await fs.rename(target, path.join(dirs.trash, path.basename(target)))
  },
}))

const {
  createSession,
  deleteSession,
  renameSession,
  resetSessionsForTest,
  sessionDeletePreview,
  setSessionDeps,
  wipeDemoSessions,
} = await import('../../session/sessions')
const { ensureSessionWorkspace } = await import('../../session/sessionWorkspace')
const { settleWorkspaceRenames } = await import('../../session/appWorkspace')
const { addSessionFolder, readSessionFolders, starSessionFolder } =
  await import('../../session/sessionFolders')

async function listDir(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => [])).sort()
}

let demo = false
let root = ''

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-delete-'))
  dirs.real = path.join(root, 'internal')
  dirs.demo = path.join(root, 'internal-demo')
  dirs.trash = path.join(root, 'Trash')
})

beforeEach(() => {
  demo = false
  setSessionDeps({ isDemoMode: () => demo })
})

afterEach(async () => {
  await settleWorkspaceRenames()
  resetSessionsForTest()
  for (const entry of await fs.readdir(root)) {
    await fs.rm(path.join(root, entry), { recursive: true, force: true })
  }
})

async function sessionWithWorkspace(title: string, files: string[]) {
  const { id } = await createSession()
  await renameSession(id, title)
  const workspace = await ensureSessionWorkspace(id)
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true })
    await fs.writeFile(path.join(workspace, file), file)
  }
  return { id, workspace }
}

async function userFolder(name: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'mine.txt'), 'mine')
  return dir
}

describe('deleting a Session', () => {
  it('moves its app-created Workspace to the Trash, files and all', async () => {
    const { id, workspace } = await sessionWithWorkspace('Foxes', ['fox.png', 'sub/owl.png'])

    await deleteSession(id)

    expect(await listDir(path.dirname(workspace))).toEqual([])
    expect(await listDir(dirs.trash)).toEqual([path.basename(workspace)])
    expect(await listDir(path.join(dirs.trash, path.basename(workspace)))).toEqual([
      'fox.png',
      'sub',
    ])
    expect(await listDir(dirs.real)).not.toContain(id)
  })

  it('never touches a folder the user chose, starred or not', async () => {
    const { id } = await sessionWithWorkspace('Foxes', ['fox.png'])
    const starred = await userFolder('Project')
    const other = await userFolder('Photos')
    await addSessionFolder(id, other)
    const { list } = await addSessionFolder(id, starred)
    await starSessionFolder(id, list.folders.find((folder) => folder.hostPath === starred)!.id)

    await deleteSession(id)

    expect(await listDir(starred)).toEqual(['mine.txt'])
    expect(await listDir(other)).toEqual(['mine.txt'])
    expect(await listDir(dirs.trash)).toHaveLength(1)
  })

  it('trashes its app-created folder after another folder became the Workspace', async () => {
    const { id, workspace } = await sessionWithWorkspace('Foxes', ['fox.png'])
    const project = await userFolder('Project')
    const { list } = await addSessionFolder(id, project)
    await starSessionFolder(id, list.folders.find((folder) => !folder.appCreated)!.id)

    await deleteSession(id)

    expect(await listDir(dirs.trash)).toEqual([path.basename(workspace)])
    expect(await listDir(project)).toEqual(['mine.txt'])
  })

  it('trashes an older Session’s files/ folder too, and leaves nothing of the Session behind', async () => {
    const { id } = await createSession()
    const legacy = path.join(`${dirs.real}-legacy`, id)
    await fs.mkdir(path.join(legacy, 'files'), { recursive: true })
    await fs.writeFile(path.join(legacy, 'files', 'cat.png'), 'cat')
    const file = path.join(dirs.real, id, 'session.json')
    const json = JSON.parse(await fs.readFile(file, 'utf8'))
    delete json.folders
    delete json.workspaceFolderId
    await fs.writeFile(file, JSON.stringify(json))

    await deleteSession(id)

    expect(await listDir(dirs.trash)).toEqual(['files'])
    expect(await listDir(`${dirs.real}-legacy`)).toEqual([])
  })

  it('trashes nothing for a Session whose Workspace was never created', async () => {
    const { id } = await createSession()

    await deleteSession(id)

    expect(await listDir(dirs.trash)).toEqual([])
    expect(await listDir(`${dirs.real}-workspaces`)).toEqual([])
  })
})

describe('what the delete dialog says', () => {
  it('names the app-created Workspace and counts its files', async () => {
    const { id, workspace } = await sessionWithWorkspace('Foxes', ['a.png', 'b.png', 'sub/c.png'])

    expect(await sessionDeletePreview(id)).toEqual({
      trashedWorkspace: { name: path.basename(workspace), fileCount: 3 },
    })
  })

  it('names nothing when no app-created Workspace would go to the Trash', async () => {
    const { id } = await createSession()
    expect(await sessionDeletePreview(id)).toEqual({ trashedWorkspace: null })
  })
})

describe('demo mode', () => {
  it('keeps demo Workspaces under the demo root and wipes them, and nothing else, on exit', async () => {
    const real = await sessionWithWorkspace('Real', ['fox.png'])
    demo = true
    const demoSession = await sessionWithWorkspace('Demo', ['owl.png'])

    expect(path.dirname(demoSession.workspace)).toBe(`${dirs.demo}-workspaces`)
    await wipeDemoSessions()

    expect(await listDir(`${dirs.demo}-workspaces`)).toEqual([])
    expect(await listDir(dirs.demo)).toEqual([])
    expect(await listDir(real.workspace)).toEqual(['fox.png'])
    expect(await listDir(dirs.real)).toEqual([real.id])
  })

  it('refuses to add a folder', async () => {
    demo = true
    const { id } = await createSession()

    await expect(addSessionFolder(id, await userFolder('Project'))).rejects.toThrow()
    expect((await readSessionFolders(id)).folders).toHaveLength(1)
  })

  it('refuses to star a folder the user chose', async () => {
    demo = true
    const { id } = await createSession()
    const file = path.join(dirs.demo, id, 'session.json')
    const json = JSON.parse(await fs.readFile(file, 'utf8'))
    const hostPath = await userFolder('Project')
    json.folders.push({ id: 'folder-user', hostPath, access: 'read-only', slug: 'Project' })
    await fs.writeFile(file, JSON.stringify(json))

    await expect(starSessionFolder(id, 'folder-user')).rejects.toThrow()
    expect((await readSessionFolders(id)).workspaceId).toBe(json.workspaceFolderId)
  })

  it('deletes a demo Session’s Workspace outright instead of filling the host’s Trash', async () => {
    demo = true
    const { id, workspace } = await sessionWithWorkspace('Demo', ['owl.png'])

    await deleteSession(id)

    expect(await listDir(path.dirname(workspace))).toEqual([])
    expect(await listDir(dirs.trash)).toEqual([])
  })
})
