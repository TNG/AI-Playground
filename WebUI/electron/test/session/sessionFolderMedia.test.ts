import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '', picked: '' }))

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

const { createSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { addSessionFolder, removeSessionFolder, sessionWorkspaceEntry } =
  await import('../../session/sessionFolders')
const { sessionFolderMediaFile } = await import('../../session/sessionFolderMedia')
const { ensureSessionWorkspace } = await import('../../session/sessionWorkspace')
const { sessionFolderMediaUrl } = await import('@/lib/comfyWorkflow')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-folder-media-'))
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
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.picked, { recursive: true, force: true })
})

async function listedFolder(sessionId: string, name: string) {
  const hostPath = path.join(dirs.picked, name)
  await fs.mkdir(hostPath, { recursive: true })
  const { list } = await addSessionFolder(sessionId, hostPath)
  return { hostPath, id: list.folders.find((folder) => folder.hostPath === hostPath)!.id }
}

describe('aipg-media:// for a Session folder', () => {
  it("serves a file inside a folder the Session lists, the Workspace's too", async () => {
    const { id } = await createSession()
    const project = await listedFolder(id, 'Project')
    const planned = await sessionWorkspaceEntry(id)
    expect(sessionFolderMediaFile(sessionFolderMediaUrl(id, planned.id, 'a b.png'))).toBeNull()
    await ensureSessionWorkspace(id)
    const workspace = await sessionWorkspaceEntry(id)

    expect(sessionFolderMediaFile(sessionFolderMediaUrl(id, project.id, 'art/fox.png'))).toBe(
      path.join(project.hostPath, 'art', 'fox.png'),
    )
    expect(sessionFolderMediaFile(sessionFolderMediaUrl(id, workspace.id, 'a b.png'))).toBe(
      path.join(workspace.hostPath, 'a b.png'),
    )
  })

  it('refuses a folder the Session never listed', async () => {
    const { id } = await createSession()
    const other = await createSession()
    const theirs = await listedFolder(other.id, 'Theirs')

    expect(sessionFolderMediaFile(sessionFolderMediaUrl(id, theirs.id, 'x.png'))).toBeNull()
    expect(sessionFolderMediaFile(sessionFolderMediaUrl('no-such', theirs.id, 'x.png'))).toBeNull()
  })

  it('still serves a folder the Session took off its list', async () => {
    const { id } = await createSession()
    const project = await listedFolder(id, 'Project')
    await removeSessionFolder(id, project.id)

    expect(sessionFolderMediaFile(sessionFolderMediaUrl(id, project.id, 'x.png'))).toBe(
      path.join(project.hostPath, 'x.png'),
    )
  })

  it('refuses a path that climbs out of the folder', async () => {
    const { id } = await createSession()
    const project = await listedFolder(id, 'Project')
    const url = `aipg-media://folders/${id}/${project.id}`

    expect(sessionFolderMediaFile(`${url}/..%2F..%2Fsecret.txt`)).toBeNull()
    expect(sessionFolderMediaFile(`${url}/%2E%2E/Other/x.png`)).toBeNull()
    expect(sessionFolderMediaFile(`aipg-media://folders/..%2F${id}/${project.id}/x`)).toBeNull()
    expect(sessionFolderMediaFile(`${url}/%E0`)).toBeNull()
  })
})
