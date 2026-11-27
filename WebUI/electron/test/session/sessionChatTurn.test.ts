import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '', audio: '' }))

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
const { sessionWorkspaceDir } = await import('../../session/sessionWorkspace')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const { sessionWorkspaceEntry } = await import('../../session/sessionFolders')
const workspaceId = async (id: string) => (await sessionWorkspaceEntry(id)).id
const { trackChatTurnInSession } = await import('../../session/sessionChatTurn')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-chat-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.audio = path.join(root, 'audio')
})

beforeEach(async () => {
  setSessionDeps({ isDemoMode: () => false })
  await fs.mkdir(dirs.audio, { recursive: true })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.audio, { recursive: true, force: true })
})

describe('a chat turn in a Session', () => {
  it("copies a Text-to-Speech clip into the Session Folder and names it in the tool's output", async () => {
    const { id } = await createSession()
    const savedFilePath = path.join(dirs.audio, 'hello.wav')
    await fs.writeFile(savedFilePath, 'wav bytes')
    const turn = trackChatTurnInSession(id, () => null)

    const output = await turn.adoptToolMedia({ ok: true, message: 'Saved.', savedFilePath })
    await turn.settle({ preset: 'Chat', prompt: 'say hello', status: 'completed' })

    expect(output).toEqual({
      ok: true,
      message: 'Saved.',
      savedFilePath,
      audioUrl: `aipg-media://folders/${id}/${await workspaceId(id)}/hello.wav`,
    })
    expect(await fs.readFile(path.join(sessionWorkspaceDir(id), 'hello.wav'), 'utf8')).toBe(
      'wav bytes',
    )
    expect(await fs.readdir(dirs.audio)).toEqual(['hello.wav'])
    expect(await readHistoryEntries(id)).toEqual([
      expect.objectContaining({
        artifacts: [{ folderId: await workspaceId(id), path: 'hello.wav', mediaType: 'audio' }],
      }),
    ])
  })
})
