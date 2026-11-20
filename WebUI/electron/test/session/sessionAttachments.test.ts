import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '', games: '' }))

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

const { createSession, resetSessionsForTest, sessionPaths, setSessionDeps, wipeDemoSessions } =
  await import('../../session/sessions')
const { ensureSessionWorkspace, sessionWorkspaceDir } =
  await import('../../session/sessionWorkspace')
const { appendHistoryEntry, readHistoryEntries } = await import('../../session/sessionHistory')
const { attachmentsFolderFor, migrateSessionAttachments } =
  await import('../../session/sessionAttachments')
const { importAttachment } = await import('../../agent/workspaceAttachments')
const { documentsLine, sessionDocuments } = await import('../../agent/sessionDocuments')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-attachments-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.games = path.join(root, 'games')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.demo, { recursive: true, force: true })
  await fs.rm(dirs.games, { recursive: true, force: true })
})

async function listTree(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort()
}

describe("a Session's bookkeeping", () => {
  it('keeps its record and History out of the Workspace', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, {
      preset: 'Dummy Image (test)',
      kind: 'image',
      prompt: 'a red fox',
      status: 'completed',
      artifacts: [],
    })

    const workspace = await ensureSessionWorkspace(id)

    expect(await listTree(workspace)).toEqual([])
    expect(await readHistoryEntries(id)).toHaveLength(1)
  })
})

describe("a Session's Attached Documents", () => {
  it('are stored in internal storage, never in the Workspace', async () => {
    const { id } = await createSession()
    const workspace = await ensureSessionWorkspace(id)

    const folder = attachmentsFolderFor({ sessionId: id, workspaceDir: workspace })
    const saved = importAttachment(folder, 'report.md', Buffer.from('# budget'))

    expect(saved.path).toBe('/attachments/report.md')
    expect(await listTree(workspace)).toEqual([])
    expect(sessionDocuments(folder)).toEqual(['/attachments/report.md'])
    expect(documentsLine(folder)).toContain('/attachments/report.md')
  })

  it('stay listed when the Workspace folder is emptied or gone', async () => {
    const { id } = await createSession()
    const workspace = await ensureSessionWorkspace(id)
    importAttachment(
      attachmentsFolderFor({ sessionId: id, workspaceDir: workspace }),
      'notes.txt',
      Buffer.from('notes'),
    )

    await fs.rm(workspace, { recursive: true })

    const folder = attachmentsFolderFor({ sessionId: id, workspaceDir: workspace })
    expect(sessionDocuments(folder)).toEqual(['/attachments/notes.txt'])
  })

  it('of a game stay in the game folder, where the game ships them', async () => {
    const { id } = await createSession()
    const game = path.join(dirs.games, 'asteroids')
    await fs.mkdir(game, { recursive: true })

    const folder = attachmentsFolderFor({ sessionId: id, workspaceDir: game })
    importAttachment(folder, 'ship.png', Buffer.from('png'))

    expect(await listTree(game)).toEqual([path.join('attachments', 'ship.png')])
  })

  it('without a Session stay in the folder the turn works in', async () => {
    const folder = path.join(dirs.games, 'trial')
    await fs.mkdir(folder, { recursive: true })

    expect(attachmentsFolderFor({ workspaceDir: folder })).toEqual({
      dir: path.join(folder, 'attachments'),
      reference: 'attachments',
    })
  })

  it('of a demo Session are wiped with it', async () => {
    setSessionDeps({ isDemoMode: () => true })
    const { id } = await createSession()
    const workspace = await ensureSessionWorkspace(id)
    const folder = attachmentsFolderFor({ sessionId: id, workspaceDir: workspace })
    importAttachment(folder, 'notes.md', Buffer.from('demo'))

    await wipeDemoSessions()

    await expect(fs.stat(folder.dir)).rejects.toThrow()
  })
})

describe("moving attachments out of an older Session's files/ on startup", () => {
  async function legacySession(files: Record<string, string>): Promise<{
    id: string
    workspace: string
  }> {
    const { id } = await createSession()
    const workspace = sessionPaths(id).filesDir
    await fs.mkdir(path.join(workspace, 'attachments'), { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(workspace, 'attachments', name), content)
    }
    await fs.writeFile(path.join(workspace, 'cover.png'), 'artifact')
    return { id, workspace }
  }

  it('moves them to internal storage and leaves the Artifacts', async () => {
    const { id, workspace } = await legacySession({ 'report.md': 'r', 'cat.png': 'c' })

    await migrateSessionAttachments()

    const folder = attachmentsFolderFor({ sessionId: id, workspaceDir: sessionWorkspaceDir(id) })
    expect(await listTree(workspace)).toEqual(['cover.png'])
    expect(await listTree(folder.dir)).toEqual(['cat.png', 'report.md'])
    expect(sessionDocuments(folder)).toEqual(['/attachments/report.md'])
  })

  it('is idempotent and loses nothing on a name clash', async () => {
    const { id, workspace } = await legacySession({ 'report.md': 'first' })
    await migrateSessionAttachments()
    await migrateSessionAttachments()
    await fs.mkdir(path.join(workspace, 'attachments'))
    await fs.writeFile(path.join(workspace, 'attachments', 'report.md'), 'second')
    await fs.writeFile(path.join(workspace, 'attachments', 'same.md'), 'same')
    const folder = attachmentsFolderFor({ sessionId: id, workspaceDir: sessionWorkspaceDir(id) })
    await fs.writeFile(path.join(folder.dir, 'same.md'), 'same')

    await migrateSessionAttachments()

    expect(await listTree(workspace)).toEqual(['cover.png'])
    expect(await listTree(folder.dir)).toEqual(['report-1.md', 'report.md', 'same.md'])
    expect(await fs.readFile(path.join(folder.dir, 'report.md'), 'utf8')).toBe('first')
    expect(await fs.readFile(path.join(folder.dir, 'report-1.md'), 'utf8')).toBe('second')
  })
})
