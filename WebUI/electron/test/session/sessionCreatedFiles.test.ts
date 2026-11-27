import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveSession } from '../../agent/piAgentState'

// The Artifacts tab's document listing: files the Sessions' agent turns wrote,
// scanned from every session file, with the harness-record fallback for writes
// that settled before timestamps existed.

const dirs = vi.hoisted(() => ({ real: '', demo: '', agents: '', agentsDemo: '', games: '' }))

// The session pointers `sessionFileMounts` prefers; set per test, cleared in beforeEach.
const pointers = vi.hoisted(() => new Map<string, Record<string, unknown>>())

vi.mock('../../agent/piSessionStore', () => ({
  readSessionStore: () => Object.fromEntries(pointers.entries()),
}))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
  getAgentSessionsDir: () => dirs.agents,
  getAgentSessionsDemoDir: () => dirs.agentsDemo,
  getGamesDir: () => dirs.games,
}))

vi.mock('../../adapters/trash', async () => {
  const fs = await import('node:fs/promises')
  return { moveToTrash: (target: string) => fs.rm(target, { recursive: true, force: true }) }
})

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../kernel/kernelBus')>()),
  emitSessionChanged: vi.fn(),
}))

const { createSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { renameSession } = await import('../../session/sessions')
const { upsertTimelineMessages } = await import('../../session/sessionTimeline')
const { listAllCreatedFiles } = await import('../../session/sessionCreatedFiles')
const { resetAgentSessionFilesForTest, saveAgentSession, setAgentSessionFileDeps } =
  await import('../../persist/agentSessionFiles')
const { sessionFileMounts } = await import('../../agent/sessionWorkspace')
const { setActive } = await import('../../agent/piAgentState')
const { ensureSessionWorkspace } = await import('../../session/sessionWorkspace')
const { addSessionFolder, starSessionFolder } = await import('../../session/sessionFolders')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-created-files-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.agents = path.join(root, 'agent-sessions')
  dirs.agentsDemo = path.join(root, 'agent-sessions-demo')
  dirs.games = path.join(root, 'games')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
  setAgentSessionFileDeps({ isDemoMode: () => false })
  pointers.clear()
})

afterEach(async () => {
  setActive(null)
  resetSessionsForTest()
  resetAgentSessionFilesForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.agents, { recursive: true, force: true })
})

/** An agent answer whose writing tools finished, tagged the way the timeline stores it. */
function agentAnswer(
  id: string,
  harnessSessionId: string,
  files: string[],
  createdAt?: number,
): { id: string; role: string; createdAt?: number; parts: unknown[]; metadata: unknown } {
  return {
    id,
    role: 'assistant',
    createdAt,
    parts: files.map((file, index) => ({
      type: 'dynamic-tool',
      toolCallId: `${id}-t${index}`,
      toolName: 'write',
      state: 'output-available',
      input: { path: file },
    })),
    metadata: { agentTurn: { presetName: 'Game Agent', harnessSessionId } },
  }
}

const harnessRecord = (
  id: string,
  createdAt: number,
  workspaceDir: string,
  sessionRef?: string,
) => ({
  id,
  workspaceDir,
  title: 'dodge asteroids',
  createdAt,
  updatedAt: createdAt,
  capabilities: ['game-studio'],
  presetName: 'Game Agent',
  ...(sessionRef ? { sessionRef } : {}),
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'dodge asteroids' }] }],
})

/** A real workspace dir holding the named files, as the harness record points at it. */
async function workspaceWith(files: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-created-ws-'))
  for (const file of files) await fs.writeFile(path.join(dir, file), `content of ${file}`)
  return dir
}

describe('listAllCreatedFiles', () => {
  it('lists every Session agent-written file with its message stamp', async () => {
    const session = await createSession()
    await renameSession(session.id, 'space game')
    const ws = await workspaceWith(['game.js', 'design.md'])
    await saveAgentSession(harnessRecord('h1', 500, ws))

    await upsertTimelineMessages(session.id, [
      agentAnswer('a1', 'h1', ['game.js', 'design.md'], 1_000),
    ])

    expect(await listAllCreatedFiles()).toEqual([
      {
        file: 'game.js',
        exists: true,
        harnessSessionId: 'h1',
        sessionRef: session.id,
        sessionTitle: 'space game',
        createdAt: 1_000,
      },
      {
        file: 'design.md',
        exists: true,
        harnessSessionId: 'h1',
        sessionRef: session.id,
        sessionTitle: 'space game',
        createdAt: 1_000,
      },
    ])
  })

  it('keeps one entry per file, the latest write winning', async () => {
    const session = await createSession()
    const ws = await workspaceWith(['game.js'])
    await saveAgentSession(harnessRecord('h1', 500, ws))
    await upsertTimelineMessages(session.id, [
      agentAnswer('a1', 'h1', ['game.js'], 1_000),
      agentAnswer('a2', 'h1', ['game.js'], 2_000),
    ])

    const files = await listAllCreatedFiles()
    expect(files).toEqual([
      {
        file: 'game.js',
        exists: true,
        harnessSessionId: 'h1',
        sessionRef: session.id,
        sessionTitle: '',
        createdAt: 2_000,
      },
    ])
  })

  it('falls back to the harness record creation for writes that settled before stamps', async () => {
    const session = await createSession()
    const ws = await workspaceWith(['game.js'])
    await saveAgentSession(harnessRecord('h1', 500, ws))
    await upsertTimelineMessages(session.id, [agentAnswer('a1', 'h1', ['game.js'])])

    const [file] = await listAllCreatedFiles()
    expect(file).toMatchObject({ file: 'game.js', harnessSessionId: 'h1', createdAt: 500 })
  })

  it('a re-write with a real stamp beats the harness fallback', async () => {
    const session = await createSession()
    const ws = await workspaceWith(['game.js'])
    await saveAgentSession(harnessRecord('h1', 500, ws))
    await upsertTimelineMessages(session.id, [
      agentAnswer('a1', 'h1', ['game.js']),
      agentAnswer('a2', 'h1', ['game.js'], 8_000),
    ])

    const [file] = await listAllCreatedFiles()
    expect(file).toMatchObject({ createdAt: 8_000 })
  })

  it('ignores messages that are not agent answers', async () => {
    const session = await createSession()
    const chat = {
      id: 'c1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolCallId: 't1',
          toolName: 'write',
          state: 'output-available',
          input: { path: 'chat.txt' },
        },
      ],
      metadata: { chatTurn: true },
    }
    await upsertTimelineMessages(session.id, [chat])

    expect(await listAllCreatedFiles()).toEqual([])
  })

  it('marks a file that no longer exists on disk instead of dropping it', async () => {
    const session = await createSession()
    const ws = await workspaceWith(['game.js', 'design.md'])
    await saveAgentSession(harnessRecord('h1', 500, ws))
    await upsertTimelineMessages(session.id, [agentAnswer('a1', 'h1', ['game.js', 'design.md'])])

    expect(await listAllCreatedFiles()).toEqual([
      expect.objectContaining({ file: 'game.js', exists: true }),
      expect.objectContaining({ file: 'design.md', exists: true }),
    ])

    await fs.rm(path.join(ws, 'game.js'))
    const files = await listAllCreatedFiles()
    expect(files).toEqual([
      expect.objectContaining({ file: 'game.js', exists: false }),
      expect.objectContaining({ file: 'design.md', exists: true }),
    ])

    // A file written back to the same path exists again.
    await fs.writeFile(path.join(ws, 'game.js'), 'back')
    expect(await listAllCreatedFiles()).toEqual([
      expect.objectContaining({ file: 'game.js', exists: true }),
      expect.objectContaining({ file: 'design.md', exists: true }),
    ])
  })

  it("keeps a renamed Session's created files listed (the record's stale dir is followed)", async () => {
    const session = await createSession()
    const ws = await ensureSessionWorkspace(session.id)
    await fs.writeFile(path.join(ws, 'game.js'), 'content of game.js')
    await saveAgentSession(harnessRecord('h1', 500, ws, session.id))
    await upsertTimelineMessages(session.id, [agentAnswer('a1', 'h1', ['game.js'], 1_000)])

    await renameSession(session.id, 'renamed title')

    expect(existsSync(ws)).toBe(false)
    const moved = await ensureSessionWorkspace(session.id)
    expect(await sessionFileMounts('h1')).toMatchObject({ workspaceDir: moved })
    expect(await listAllCreatedFiles()).toEqual([
      expect.objectContaining({ file: 'game.js', exists: true }),
    ])
  })

  it("falls back to the followed record while a live session's workspace was renamed", async () => {
    const session = await createSession()
    const ws = await ensureSessionWorkspace(session.id)
    await fs.writeFile(path.join(ws, 'live.js'), 'content of live.js')
    await saveAgentSession(harnessRecord('h1', 500, ws, session.id))
    await upsertTimelineMessages(session.id, [agentAnswer('a1', 'h1', ['live.js'], 1_000)])
    setActive({ sessionId: 'h1', workspaceDir: ws } as unknown as ActiveSession)

    await renameSession(session.id, 'renamed title')

    expect(await listAllCreatedFiles()).toEqual([
      expect.objectContaining({ file: 'live.js', exists: true }),
    ])
  })

  it('does not follow a games-library workspace that no longer exists', async () => {
    const session = await createSession()
    await ensureSessionWorkspace(session.id)
    const gone = path.join(dirs.games, 'my-game')
    await saveAgentSession(harnessRecord('h1', 500, gone, session.id))
    await upsertTimelineMessages(session.id, [agentAnswer('a1', 'h1', ['game.js'], 1_000)])

    expect(await listAllCreatedFiles()).toEqual([
      expect.objectContaining({ file: 'game.js', exists: false }),
    ])
  })

  it('does not follow a stale record when the Workspace is a user folder', async () => {
    const session = await createSession()
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-starred-'))
    const { list } = await addSessionFolder(session.id, project)
    const entry = list.folders.find((folder) => folder.hostPath === project)
    if (!entry) throw new Error('folder not added')
    await starSessionFolder(session.id, entry.id)
    const gone = await workspaceWith(['gone.js'])
    await fs.rm(gone, { recursive: true })
    await saveAgentSession(harnessRecord('h1', 500, gone, session.id))
    await upsertTimelineMessages(session.id, [agentAnswer('a1', 'h1', ['gone.js'], 1_000)])

    expect(await listAllCreatedFiles()).toEqual([
      expect.objectContaining({ file: 'gone.js', exists: false }),
    ])
  })

  it('drops a card whose harness workspace is gone without failing the listing', async () => {
    const session = await createSession()
    const kept = await workspaceWith(['kept.js'])
    await saveAgentSession(harnessRecord('h1', 500, kept))
    await upsertTimelineMessages(session.id, [
      agentAnswer('a1', 'h1', ['kept.js'], 1_000),
      agentAnswer('a2', 'h2', ['gone.js'], 2_000),
    ])

    const files = await listAllCreatedFiles()
    expect(files).toEqual([
      {
        file: 'kept.js',
        exists: true,
        harnessSessionId: 'h1',
        sessionRef: session.id,
        sessionTitle: '',
        createdAt: 1_000,
      },
    ])
  })

  it("resolves an idle session's files through its saved pointer while another session runs", async () => {
    const session = await createSession()
    const ws = await workspaceWith(['notes.md'])
    await saveAgentSession(harnessRecord('h1', 500, ws, session.id))
    await upsertTimelineMessages(session.id, [
      agentAnswer('a1', 'h1', ['/mnt/space/notes.md'], 1_000),
    ])
    pointers.set('h1', {
      sessionId: 'h1',
      workspaceDir: ws,
      sessionFilePath: '',
      updatedAt: 1,
      workdir: '/mnt/space',
      mountedFolders: [{ hostPath: ws, name: 'space', access: 'read-write' }],
    })
    // Another session's turn is live: this one has neither an open turn nor
    // `active`, so its resolution rests entirely on the pointer.
    setActive({ sessionId: 'another', workspaceDir: ws } as unknown as ActiveSession)

    expect(await sessionFileMounts('h1')).toEqual({
      workspaceDir: ws,
      workdir: '/mnt/space',
      mounted: [],
    })
    expect(await listAllCreatedFiles()).toEqual([
      expect.objectContaining({ file: '/mnt/space/notes.md', exists: true }),
    ])
  })

  it('derives the mounted list from the pointer, the Workspace entry left out', async () => {
    const session = await createSession()
    const ws = await workspaceWith(['notes.md'])
    const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-pointer-extra-'))
    await saveAgentSession(harnessRecord('h1', 500, ws, session.id))
    pointers.set('h1', {
      sessionId: 'h1',
      workspaceDir: ws,
      sessionFilePath: '',
      updatedAt: 1,
      workdir: '/mnt/space',
      mountedFolders: [
        { hostPath: ws, name: 'space', access: 'read-write' },
        { hostPath: extra, name: 'extra', access: 'read-only' },
      ],
    })

    expect(await sessionFileMounts('h1')).toMatchObject({
      mounted: [{ hostPath: extra, name: 'extra' }],
    })
  })

  it('falls back to the reconstruction when the pointer names another workspace', async () => {
    const session = await createSession()
    const ws = await workspaceWith(['game.js'])
    await saveAgentSession(harnessRecord('h1', 500, ws))
    await upsertTimelineMessages(session.id, [agentAnswer('a1', 'h1', ['game.js'], 1_000)])
    pointers.set('h1', {
      sessionId: 'h1',
      workspaceDir: '/somewhere/else',
      sessionFilePath: '',
      updatedAt: 1,
      workdir: '/mnt/elsewhere',
      mountedFolders: [{ hostPath: '/somewhere/else', name: 'elsewhere', access: 'read-write' }],
    })

    expect(await listAllCreatedFiles()).toEqual([
      expect.objectContaining({ file: 'game.js', exists: true }),
    ])
  })

  it('ignores a pointer from before the workdir was recorded', async () => {
    const session = await createSession()
    const ws = await workspaceWith(['game.js'])
    await saveAgentSession(harnessRecord('h1', 500, ws))
    await upsertTimelineMessages(session.id, [agentAnswer('a1', 'h1', ['game.js'], 1_000)])
    pointers.set('h1', { sessionId: 'h1', workspaceDir: ws, sessionFilePath: '', updatedAt: 1 })

    expect(await listAllCreatedFiles()).toEqual([
      expect.objectContaining({ file: 'game.js', exists: true }),
    ])
  })

  it('keeps following a renamed Workspace even when the pointer still names the old dir', async () => {
    const session = await createSession()
    const ws = await ensureSessionWorkspace(session.id)
    await fs.writeFile(path.join(ws, 'game.js'), 'content of game.js')
    await saveAgentSession(harnessRecord('h1', 500, ws, session.id))
    await upsertTimelineMessages(session.id, [agentAnswer('a1', 'h1', ['game.js'], 1_000)])
    pointers.set('h1', {
      sessionId: 'h1',
      workspaceDir: ws,
      sessionFilePath: '',
      updatedAt: 1,
      workdir: '/mnt/space',
      mountedFolders: [{ hostPath: ws, name: 'space', access: 'read-write' }],
    })

    await renameSession(session.id, 'renamed title')
    const moved = await ensureSessionWorkspace(session.id)

    expect(await sessionFileMounts('h1')).toMatchObject({ workspaceDir: moved })
    expect(await listAllCreatedFiles()).toEqual([
      expect.objectContaining({ file: 'game.js', exists: true }),
    ])
  })
})
