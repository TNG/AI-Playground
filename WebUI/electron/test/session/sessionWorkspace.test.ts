import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '', media: '', games: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
  getGamesDir: () => dirs.games,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { createSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { ensureSessionWorkspace, isInGamesLibrary, sessionWorkspaceDir, turnWorkspaceDir } =
  await import('../../session/sessionWorkspace')
const { addSessionFolder, sessionFolderToOpen } = await import('../../session/sessionFolders')
const { adoptMediaFile } = await import('../../session/sessionMediaTurn')
const { harnessSessionFor } = await import('../../session/sessionHarness')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-workspace-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.media = path.join(root, 'media')
  dirs.games = path.join(root, 'games')
})

beforeEach(async () => {
  setSessionDeps({ isDemoMode: () => false })
  await fs.mkdir(dirs.media, { recursive: true })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.media, { recursive: true, force: true })
})

const localPathOf = (url: string): string | null =>
  path.join(dirs.media, decodeURIComponent(url.slice('aipg-media://media/'.length)))

describe("a Session's Workspace", () => {
  it('is created when opened in Explorer before the first turn', async () => {
    const { id } = await createSession()
    await expect(fs.access(sessionWorkspaceDir(id))).rejects.toThrow()

    const opened = await sessionFolderToOpen(id)

    expect(opened).toBe(sessionWorkspaceDir(id))
    expect(path.basename(opened)).toMatch(/ New session$/)
    expect((await fs.stat(opened)).isDirectory()).toBe(true)
  })

  it('opens a listed folder by its entry, and nothing the Session does not list', async () => {
    const { id } = await createSession()
    const picked = path.join(dirs.media, 'project')
    await fs.mkdir(picked)
    const { list } = await addSessionFolder(id, picked)
    const entry = list.folders.find((folder) => folder.hostPath === picked)

    expect(await sessionFolderToOpen(id, entry?.id)).toBe(picked)
    await expect(sessionFolderToOpen(id, 'folder-unlisted')).rejects.toThrow()
  })

  it('is where adopted media lands and where its agent works', async () => {
    const { id } = await createSession()
    await fs.writeFile(path.join(dirs.media, 'fox.png'), 'fox')
    const workspace = await ensureSessionWorkspace(id)

    await adoptMediaFile(id, 'aipg-media://media/fox.png', localPathOf)
    const harness = await harnessSessionFor(id, 'Assistant')

    expect(await fs.readdir(workspace)).toEqual(['fox.png'])
    expect(harness.workspaceDir).toBe(workspace)
  })
})

describe('the games library check', () => {
  it('counts the library and any folder inside it', () => {
    expect(isInGamesLibrary(dirs.games)).toBe(true)
    expect(isInGamesLibrary(path.join(dirs.games, 'Star Blaster'))).toBe(true)
    expect(isInGamesLibrary(path.join(dirs.games, 'Star Blaster', 'generated'))).toBe(true)
  })

  it('refuses a sibling, a name that only starts the same, and an ancestor', () => {
    expect(isInGamesLibrary(`${dirs.games}-mine`)).toBe(false)
    expect(isInGamesLibrary(path.join(`${dirs.games}-mine`, 'Star Blaster'))).toBe(false)
    expect(isInGamesLibrary(path.dirname(dirs.games))).toBe(false)
    expect(isInGamesLibrary(path.join(dirs.games, '..', 'media'))).toBe(false)
  })

  it('takes its root from the paths layer unless a caller names one', () => {
    const game = path.join(dirs.games, 'Star Blaster')
    expect(isInGamesLibrary(game)).toBe(true)
    expect(isInGamesLibrary(game, game)).toBe(true)
    expect(isInGamesLibrary(game, dirs.media)).toBe(false)
  })
})

describe("a turn's Workspace followed through a rename", () => {
  it('keeps a missing game folder as it is, but follows one outside the library', async () => {
    const { id } = await createSession()
    const game = path.join(dirs.games, 'Star Blaster')
    const outside = path.join(`${dirs.games}-outside`, 'Gone')

    expect(await turnWorkspaceDir(id, game)).toBe(game)
    expect(await turnWorkspaceDir(id, outside)).toBe(await ensureSessionWorkspace(id))
  })
})
