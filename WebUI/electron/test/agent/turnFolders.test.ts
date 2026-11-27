import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { SessionFolderList } from '@/types/sessionIpc'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), isPackaged: false } }))

const folderLists = vi.hoisted(() => new Map<string, SessionFolderList>())
const registeredSlugs = vi.hoisted(() => new Map<string, string>())
const registered = vi.hoisted(() => [] as unknown[])
vi.mock('../../session/sessionFolders', () => ({
  readSessionFolders: async (id: string) => {
    const list = folderLists.get(id)
    if (!list) throw new Error(`no session ${id}`)
    return list
  },
  registerAgentFolder: async (
    sessionId: string,
    owner: { agentId?: string; folder: { id: string; hostPath: string; slug: string } },
  ) => {
    registered.push({ sessionId, ...owner })
    const { folder } = owner
    return { ...folder, slug: registeredSlugs.get(folder.id) ?? folder.slug, access: 'read-write' }
  },
}))

const trials = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../persist/userDataPaths.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../persist/userDataPaths.ts')>()),
  getAgentTrialsDir: () => trials.dir,
}))

const { folderEntryLocation, turnFolders } = await import('../../agent/turnFolders')
const { createTrialFolder } = await import('../../persist/trialRunFiles')
const { resetSessionFilesForTest, setSessionFileDeps } = await import('../../persist/sessionFiles')

let root: string
let workspace: string
let notes: string
let papers: string
let data: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-turn-folders-')))
  workspace = path.join(root, 'poster')
  notes = path.join(root, 'notes')
  papers = path.join(root, 'papers')
  data = path.join(root, 'data')
  for (const dir of [workspace, notes, papers, data]) fs.mkdirSync(dir)
  trials.dir = path.join(root, 'agent-trials')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  folderLists.clear()
  registeredSlugs.clear()
  registered.length = 0
})

const onlyData = () => ({
  folders: [{ id: 'a1', hostPath: data, slug: 'data', access: 'read-only' as const }],
})

describe("an Agent's folders", () => {
  afterEach(() => resetSessionFilesForTest())

  const agentTurn = () =>
    ({ workspaceDir: workspace, folderOverrides: onlyData() }) as AgentModeTurnConfig

  it('are mounted beside the turn', async () => {
    expect((await turnFolders(agentTurn())).mounted.map((folder) => folder.hostPath)).toEqual([
      data,
    ])
  })

  it('are never mounted in demo mode', async () => {
    setSessionFileDeps({ isDemoMode: () => true })

    expect((await turnFolders(agentTurn())).mounted).toEqual([])
  })
})

describe('an Agent Run in a Session', () => {
  beforeEach(() => {
    folderLists.set('s1', {
      workspaceId: 'ws',
      folders: [
        { id: 'ws', hostPath: workspace, slug: 'poster', access: 'read-write' },
        { id: 'n', hostPath: notes, slug: 'notes', access: 'read-only' },
        { id: 'p', hostPath: papers, slug: 'papers', access: 'read-write' },
      ],
    })
  })

  const runTurn = (folderOverrides?: AgentModeTurnConfig['folderOverrides']) =>
    ({
      sessionRef: 's1',
      workspaceDir: workspace,
      taskRun: { taskName: 'Poster' },
      ...(folderOverrides ? { folderOverrides } : {}),
    }) as AgentModeTurnConfig

  const mounts = async (config: AgentModeTurnConfig) => {
    const folders = await turnFolders(config)
    return {
      workspace: folders.workspace && `/mnt/${folders.workspace.name}`,
      mounted: folders.mounted.map((folder) => `/mnt/${folder.name} ${folder.access}`),
    }
  }

  it("sees the Session's Workspace and other folders when its Agent inherits them", async () => {
    expect(await mounts(runTurn())).toEqual({
      workspace: '/mnt/poster',
      mounted: ['/mnt/notes read-only', '/mnt/papers read-write'],
    })
  })

  it("sees the Session's Workspace and only its Agent's folders on “Use only these”", async () => {
    expect(await mounts(runTurn(onlyData()))).toEqual({
      workspace: '/mnt/poster',
      mounted: ['/mnt/data read-only'],
    })
  })

  it('sees only the Workspace when its Agent uses only an empty list', async () => {
    expect(await mounts(runTurn({ folders: [] }))).toEqual({
      workspace: '/mnt/poster',
      mounted: [],
    })
  })

  describe('whose Agent always works in its own folder', () => {
    let site: string
    beforeEach(() => {
      site = path.join(root, 'site')
      fs.mkdirSync(site)
    })

    const overrideTurn = (folders?: AgentModeTurnConfig['folderOverrides']) =>
      ({
        sessionRef: 's1',
        workspaceDir: site,
        taskRun: { taskName: 'Poster', taskId: 'agent-1' },
        folderOverrides: { workspace: { id: 'w1', hostPath: site, slug: 'site' }, ...folders },
      }) as AgentModeTurnConfig

    it("works there, the Session's Workspace read-write and its other folders beside", async () => {
      const folders = await turnFolders(overrideTurn())

      expect(folders.workspace).toEqual({ hostPath: site, name: 'site', access: 'read-write' })
      expect(await mounts(overrideTurn())).toEqual({
        workspace: '/mnt/site',
        mounted: ['/mnt/notes read-only', '/mnt/papers read-write', '/mnt/poster read-write'],
      })
    })

    it('registers the folder as that Agent’s in the Session, under its slug there', async () => {
      registeredSlugs.set('w1', 'site-2')

      expect((await mounts(overrideTurn({ folders: [] }))).workspace).toBe('/mnt/site-2')
      expect(registered).toEqual([
        { sessionId: 's1', agentId: 'agent-1', folder: { id: 'w1', hostPath: site, slug: 'site' } },
      ])
    })

    it("keeps the Session's Workspace mounted around a folder inside it", async () => {
      const inner = path.join(workspace, 'site')
      fs.mkdirSync(inner)
      const config = {
        ...overrideTurn(),
        workspaceDir: inner,
        folderOverrides: { workspace: { id: 'w1', hostPath: inner, slug: 'site' } },
      }

      expect(await mounts(config)).toEqual({
        workspace: '/mnt/site',
        mounted: ['/mnt/notes read-only', '/mnt/papers read-write', '/mnt/poster read-write'],
      })
    })

    it('names a read-only Session folder it leaves out for a folder inside it', async () => {
      const inner = path.join(notes, '2026')
      fs.mkdirSync(inner)
      const config = {
        ...overrideTurn(),
        workspaceDir: inner,
        folderOverrides: { workspace: { id: 'w1', hostPath: inner, slug: 'year' } },
      }

      expect((await turnFolders(config)).leftOut).toEqual([
        { hostPath: notes, name: 'notes', overlaps: inner },
      ])
    })

    it('mounts nothing of the Session when the turn was sent for another folder', async () => {
      const config = { ...overrideTurn(), workspaceDir: workspace }

      expect((await turnFolders(config)).workspace).toBeUndefined()
      expect(registered).toEqual([])
    })
  })
})

describe('a Trial Run', () => {
  let site: string
  beforeEach(() => {
    site = path.join(root, 'site')
    fs.mkdirSync(site)
  })

  const trialTurn = (
    sessionId: string,
    workspaceDir: string,
    folderOverrides?: AgentModeTurnConfig['folderOverrides'],
  ) =>
    ({
      sessionId,
      workspaceDir,
      taskRun: { taskName: 'Poster' },
      ...(folderOverrides ? { folderOverrides } : {}),
    }) as AgentModeTurnConfig

  it('works in its scratch folder when its Agent has no Workspace override', async () => {
    const scratch = await createTrialFolder('agent-1', 'h1')

    const folders = await turnFolders(trialTurn('h1', scratch, onlyData()))

    expect(folders.workspace?.hostPath).toBe(scratch)
    expect(folders.mounted.map((folder) => folder.hostPath)).toEqual([data])
  })

  it("works in its Agent's own folder, beside the Agent's other folders", async () => {
    await createTrialFolder('agent-1', 'h1')
    const overrides = { workspace: { id: 'w1', hostPath: site, slug: 'site' }, ...onlyData() }

    const folders = await turnFolders(trialTurn('h1', site, overrides))

    expect(folders.workspace).toEqual({ hostPath: site, name: 'site', access: 'read-write' })
    expect(folders.mounted.map((folder) => folder.hostPath)).toEqual([data])
    expect(registered).toEqual([])
  })

  it('is not taken for one when no Trial Run holds its Harness Session', async () => {
    const overrides = { workspace: { id: 'w1', hostPath: site, slug: 'site' } }

    expect((await turnFolders(trialTurn('h1', site, overrides))).workspace).toBeUndefined()
  })
})

describe('where a turn finds a Session folder', () => {
  const foldersOf = () => ({
    workspace: { hostPath: workspace, name: 'poster', access: 'read-write' as const },
    mounted: [{ hostPath: notes, name: 'notes', access: 'read-only' as const }],
  })

  it('is its /mnt path in the sandbox, the Workspace included', () => {
    expect(folderEntryLocation(foldersOf(), { hostPath: workspace }, false)).toBe('/mnt/poster')
    expect(folderEntryLocation(foldersOf(), { hostPath: notes }, false)).toBe('/mnt/notes')
  })

  it('is its real path under the real shell', () => {
    expect(folderEntryLocation(foldersOf(), { hostPath: notes }, true)).toBe(notes)
  })

  it('is found through a symlinked host path, and is nowhere when the turn lacks it', () => {
    const alias = path.join(root, 'alias')
    fs.symlinkSync(notes, alias)
    const other = path.join(root, 'other')
    fs.mkdirSync(other)

    expect(folderEntryLocation(foldersOf(), { hostPath: alias }, false)).toBe('/mnt/notes')
    expect(folderEntryLocation(foldersOf(), { hostPath: other }, false)).toBeUndefined()
  })

  it('is its path inside a mounted folder that holds it', () => {
    const inner = path.join(notes, 'drafts', 'old')
    fs.mkdirSync(inner, { recursive: true })

    expect(folderEntryLocation(foldersOf(), { hostPath: inner }, false)).toBe(
      '/mnt/notes/drafts/old',
    )
    expect(folderEntryLocation(foldersOf(), { hostPath: inner }, true)).toBe(inner)
  })
})
