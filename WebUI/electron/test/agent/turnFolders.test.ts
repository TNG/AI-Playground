import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), isPackaged: false } }))

const { folderEntryLocation, turnFolders } = await import('../../agent/turnFolders')
const { resetSessionFilesForTest, setSessionFileDeps } = await import('../../persist/sessionFiles')

let root: string
let workspace: string
let notes: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-turn-folders-')))
  workspace = path.join(root, 'poster')
  notes = path.join(root, 'notes')
  for (const dir of [workspace, notes]) fs.mkdirSync(dir)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("an Agent's folders", () => {
  afterEach(() => resetSessionFilesForTest())

  const agentTurn = () =>
    ({
      workspaceDir: workspace,
      mountedFolders: [{ hostPath: notes, name: 'notes', access: 'read-only' as const }],
    }) as AgentModeTurnConfig

  it('are mounted beside the turn', async () => {
    expect((await turnFolders(agentTurn())).mounted.map((folder) => folder.hostPath)).toEqual([
      notes,
    ])
  })

  it('are never mounted in demo mode', async () => {
    setSessionFileDeps({ isDemoMode: () => true })

    expect((await turnFolders(agentTurn())).mounted).toEqual([])
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
