import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '', picked: '', home: '' }))

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

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = () => dirs.home || actual.homedir()
  return { ...actual, default: { ...actual, homedir }, homedir }
})

const {
  createSession,
  mutateSession,
  readSession,
  renameSession,
  resetSessionsForTest,
  setSessionDeps,
} = await import('../../session/sessions')
const {
  addSessionFolder,
  migrateSessionFolderLists,
  readSessionFolders,
  registerAgentFolder,
  removeSessionFolder,
  sessionWorkspaceEntry,
  setSessionFolderAccess,
  starSessionFolder,
} = await import('../../session/sessionFolders')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-folders-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.picked = path.join(root, 'picked')
  dirs.home = path.join(root, 'home')
})

beforeEach(async () => {
  setSessionDeps({ isDemoMode: () => false })
  await fs.mkdir(dirs.picked, { recursive: true })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.picked, { recursive: true, force: true })
})

async function pickedFolder(...segments: string[]): Promise<string> {
  const folder = path.join(dirs.picked, ...segments)
  await fs.mkdir(folder, { recursive: true })
  return folder
}

const slugs = async (id: string) => (await readSessionFolders(id)).folders.map((f) => f.slug)

describe("a Session's folder list", () => {
  it('starts with the app-created Workspace, starred and read-write, not yet on disk', async () => {
    const { id } = await createSession()

    const list = await readSessionFolders(id)
    const workspace = await sessionWorkspaceEntry(id)

    expect(list.folders).toEqual([workspace])
    expect(workspace).toMatchObject({
      access: 'read-write',
      slug: 'session',
      appCreated: true,
      planned: true,
    })
    expect(path.dirname(workspace.hostPath)).toBe(`${dirs.real}-workspaces`)
    expect(path.basename(workspace.hostPath)).toMatch(/^\d{4}-\d{2}-\d{2} New session$/)
  })

  it('gives an added folder a slug from its name, read-only until changed', async () => {
    const { id } = await createSession()
    const notes = await pickedFolder('My notes')

    await addSessionFolder(id, notes)

    const added = (await readSessionFolders(id)).folders.at(-1)
    expect(added).toMatchObject({ hostPath: notes, slug: 'My-notes', access: 'read-only' })
    expect(added?.appCreated).toBeUndefined()
  })

  it('keeps slugs unique within the Session, removed folders included, and never renames one', async () => {
    const { id } = await createSession()
    await addSessionFolder(id, await pickedFolder('a', 'notes'))
    await addSessionFolder(id, await pickedFolder('b', 'notes'))
    const [, first] = (await readSessionFolders(id)).folders

    await removeSessionFolder(id, first.id)
    await fs.rename(path.join(dirs.picked, 'b', 'notes'), path.join(dirs.picked, 'b', 'renamed'))
    await addSessionFolder(id, await pickedFolder('c', 'notes'))

    expect(await slugs(id)).toEqual(['session', 'notes-2', 'notes-3'])
  })

  it('refuses a folder that overlaps the Workspace or another entry, and the home folder', async () => {
    const { id } = await createSession()
    const notes = await pickedFolder('notes')
    await addSessionFolder(id, notes)
    const workspace = await sessionWorkspaceEntry(id)

    const inWorkspace = await addSessionFolder(id, path.join(workspace.hostPath, 'sub'))
    const aroundNotes = await addSessionFolder(id, dirs.picked)
    const home = await addSessionFolder(id, path.dirname(dirs.home))

    expect(inWorkspace.refusal).toEqual({ reason: 'mounted', folder: '/mnt/session' })
    expect(aroundNotes.refusal).toEqual({ reason: 'contains-mounted', folder: '/mnt/notes' })
    expect(home.refusal).toEqual({ reason: 'home' })
    expect(await slugs(id)).toEqual(['session', 'notes'])
  })

  it('will not remove the Workspace, and removing another folder leaves its files', async () => {
    const { id } = await createSession()
    const notes = await pickedFolder('notes')
    await fs.writeFile(path.join(notes, 'keep.txt'), 'mine')
    await addSessionFolder(id, notes)
    const [workspace, added] = (await readSessionFolders(id)).folders

    await expect(removeSessionFolder(id, workspace.id)).rejects.toThrow(/Workspace/)
    await removeSessionFolder(id, added.id)

    expect(await slugs(id)).toEqual(['session'])
    expect(await fs.readFile(path.join(notes, 'keep.txt'), 'utf8')).toBe('mine')
  })

  it('lets a folder become read-write, but never the Workspace read-only', async () => {
    const { id } = await createSession()
    await addSessionFolder(id, await pickedFolder('notes'))
    const [workspace, added] = (await readSessionFolders(id)).folders

    await setSessionFolderAccess(id, added.id, 'read-write')

    await expect(setSessionFolderAccess(id, workspace.id, 'read-only')).rejects.toThrow(/Workspace/)
    expect((await readSessionFolders(id)).folders.map((f) => f.access)).toEqual([
      'read-write',
      'read-write',
    ])
  })
})

describe("an Agent's own Workspace in a Session", () => {
  const site = async () => ({
    id: 'agent-ws-1',
    hostPath: await pickedFolder('site'),
    slug: 'site',
  })

  it('is registered as an entry of that Agent, hidden from the list and never starred', async () => {
    const { id } = await createSession()
    const folder = await site()

    const entry = await registerAgentFolder(id, { agentId: 'poster', folder })

    const list = await readSessionFolders(id)
    expect(list.folders.map((f) => f.slug)).toEqual(['session'])
    expect(list.agentOwned).toEqual([
      {
        id: 'agent-ws-1',
        hostPath: folder.hostPath,
        slug: 'site',
        access: 'read-write',
        agentId: 'poster',
      },
    ])
    expect(entry).toEqual(list.agentOwned?.[0])
    await expect(starSessionFolder(id, entry.id)).rejects.toThrow(/no such folder/)
  })

  it("gets a slug the Session's own folders do not have, and the Session's never take it", async () => {
    const { id } = await createSession()
    await addSessionFolder(id, await pickedFolder('a', 'site'))

    const entry = await registerAgentFolder(id, { agentId: 'poster', folder: await site() })
    await addSessionFolder(id, await pickedFolder('b', 'site'))

    expect(entry.slug).toBe('site-2')
    expect(await slugs(id)).toEqual(['session', 'site', 'site-3'])
  })

  it('keeps its slug across runs and after the Session is renamed', async () => {
    const { id } = await createSession()
    await addSessionFolder(id, await pickedFolder('a', 'site'))
    const folder = await site()
    const first = await registerAgentFolder(id, { agentId: 'poster', folder })
    await removeSessionFolder(id, (await readSessionFolders(id)).folders[1].id)

    await renameSession(id, 'Cat poster')
    const again = await registerAgentFolder(id, { agentId: 'poster', folder })

    expect(again).toEqual(first)
    expect((await readSessionFolders(id)).agentOwned).toHaveLength(1)
  })
})

describe('moving agent-settings Mounted Folders into the list', () => {
  async function legacySession(mountedFolders: unknown[]): Promise<string> {
    const { id } = await createSession()
    await mutateSession(id, ({ folders: _folders, workspaceFolderId: _star, ...file }) => ({
      ...file,
      settings: {
        Assistant: {
          bags: {
            Assistant: { values: { mountedFolders, temperature: 0.5 }, fromDefaults: false },
          },
        },
      },
    }))
    return id
  }

  it('keeps the names the folders have today, after the Workspace', async () => {
    const [a, b, c] = ['/srv/a/notes', '/srv/b/notes', '/srv/files']
    const id = await legacySession([
      { hostPath: a, access: 'read-write' },
      { hostPath: b },
      { hostPath: c, name: 'Archive' },
      { hostPath: '/srv/d/files' },
    ])

    await migrateSessionFolderLists()

    const list = await readSessionFolders(id)
    expect(list.folders.map(({ hostPath, slug, access }) => [hostPath, slug, access])).toEqual([
      [path.join(dirs.real, id, 'files'), 'files-2', 'read-write'],
      [a, 'notes', 'read-write'],
      [b, 'notes-2', 'read-only'],
      [c, 'Archive', 'read-only'],
      ['/srv/d/files', 'files', 'read-only'],
    ])
    expect(list.workspaceId).toBe(list.folders[0].id)
    const values = (await readSession(id)).settings.Assistant as {
      bags: { Assistant: { values: Record<string, unknown> } }
    }
    expect(values.bags.Assistant.values).toEqual({ temperature: 0.5 })
  })

  it('shows the moved list before the migration has written it', async () => {
    const id = await legacySession([{ hostPath: '/srv/notes' }])

    expect(await slugs(id)).toEqual(['files', 'notes'])
  })

  it('changes nothing the second time', async () => {
    const id = await legacySession([{ hostPath: '/srv/notes' }])
    await migrateSessionFolderLists()
    const once = await readSession(id)

    await migrateSessionFolderLists()

    expect(await readSession(id)).toEqual(once)
  })
})
