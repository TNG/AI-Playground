import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { SessionFolderList } from '@/types/sessionIpc'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), isPackaged: false } }))

const folderLists = vi.hoisted(() => new Map<string, SessionFolderList>())
vi.mock('../../session/sessionFolders', () => ({
  readSessionFolders: async (id: string) => {
    const list = folderLists.get(id)
    if (!list) throw new Error(`no session ${id}`)
    return list
  },
}))

const { folderEntryLocation, turnFolders } = await import('../../agent/turnFolders')
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
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  folderLists.clear()
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

  it("sees the Session's Workspace and all its other folders when its Agent inherits them", async () => {
    expect(await mounts(runTurn())).toEqual({
      workspace: '/mnt/poster',
      mounted: ['/mnt/notes read-only', '/mnt/papers read-write'],
    })
  })

  it("sees the Session's Workspace and only its Agent's folders with “Use only these”", async () => {
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
})
