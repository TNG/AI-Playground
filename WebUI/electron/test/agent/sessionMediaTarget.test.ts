import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '', games: '' }))

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), isPackaged: false } }))

vi.mock('../../persist/userDataPaths.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../persist/userDataPaths.ts')>()),
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
const { readSessionFolders } = await import('../../session/sessionFolders')
const { sessionFolderMediaFile } = await import('../../session/sessionFolderMedia')
const { sessionMediaOf } = await import('../../agent/piSessionLifecycle')
const { sessionFolderMediaUrl } = await import('@/lib/comfyWorkflow')

beforeAll(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-media-target-')))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.games = path.join(root, 'games')
})

beforeEach(async () => {
  setSessionDeps({ isDemoMode: () => false })
  await fs.mkdir(path.join(dirs.games, 'asteroids'), { recursive: true })
})

afterEach(async () => {
  resetSessionsForTest()
  for (const dir of [dirs.real, `${dirs.real}-workspaces`, dirs.games]) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe("a game turn's media in a Session that has not written anything yet", () => {
  it('lands in the Session’s Workspace, made for it, where its URL resolves', async () => {
    const { id } = await createSession()
    const target = sessionMediaOf(id, path.join(dirs.games, 'asteroids'))
    if (target?.workspace !== 'game') throw new Error(`not a game target: ${target?.workspace}`)

    const dir = await target.filesDir()
    await fs.writeFile(path.join(dir, 'ship.png'), 'ship')

    const workspace = (await readSessionFolders(id)).folders.find((f) => f.id === target.folderId)!
    expect(workspace.planned).toBeFalsy()
    expect(workspace.hostPath).toBe(dir)
    expect(sessionFolderMediaFile(sessionFolderMediaUrl(id, target.folderId, 'ship.png'))).toBe(
      path.join(dir, 'ship.png'),
    )
  })
})
