import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentModeTurnConfig } from '@/types/agentIpc'

const dirs = vi.hoisted(() => ({ real: '', demo: '', picked: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
  getAgentTrialsDir: () => `${dirs.real}-trials`,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { createSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { addSessionFolder, readSessionFolders, starSessionFolder } =
  await import('../../session/sessionFolders')
const { ensureSessionWorkspace } = await import('../../session/sessionWorkspace')
const { resetSessionTurnsForTest } = await import('../../session/sessionTurns')
const { turnFolders } = await import('../../agent/turnFolders')

beforeAll(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-turn-session-')))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.picked = path.join(root, 'picked')
})

beforeEach(async () => {
  setSessionDeps({ isDemoMode: () => false })
  await fs.mkdir(dirs.picked, { recursive: true })
})

afterEach(async () => {
  resetSessionsForTest()
  resetSessionTurnsForTest()
  for (const dir of [dirs.real, `${dirs.real}-workspaces`, dirs.picked]) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function starredProject(id: string): Promise<string> {
  const hostPath = path.join(dirs.picked, 'Project')
  await fs.mkdir(hostPath, { recursive: true })
  const { list } = await addSessionFolder(id, hostPath)
  await starSessionFolder(id, list.folders.find((folder) => folder.hostPath === hostPath)!.id)
  return hostPath
}

const sessionTurn = (sessionRef: string, workspaceDir: string) =>
  ({ sessionRef, workspaceDir }) as AgentModeTurnConfig

async function ownFolder(id: string) {
  return (await readSessionFolders(id)).folders.find((folder) => folder.appCreated)!
}

describe('the folder created for the Session, beside another Workspace', () => {
  it('is not mounted, nor made, before the Session has written anything', async () => {
    const { id } = await createSession()
    const project = await starredProject(id)
    const own = await ownFolder(id)

    const folders = await turnFolders(sessionTurn(id, project))

    expect(folders.workspace?.hostPath).toBe(project)
    expect(folders.mounted).toEqual([])
    await expect(fs.stat(own.hostPath)).rejects.toThrow()
  })

  it('is made again, empty, and mounted when it was deleted on disk', async () => {
    const { id } = await createSession()
    const ownPath = await ensureSessionWorkspace(id)
    const project = await starredProject(id)
    await fs.rm(ownPath, { recursive: true })

    const folders = await turnFolders(sessionTurn(id, project))

    expect(folders.mounted.map((folder) => folder.hostPath)).toEqual([ownPath])
    expect((await fs.stat(ownPath)).isDirectory()).toBe(true)
  })
})
