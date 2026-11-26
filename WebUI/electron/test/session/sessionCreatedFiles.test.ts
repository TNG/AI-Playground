import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The Artifacts tab's document listing: files the Sessions' agent turns wrote,
// scanned from every session file, with the harness-record fallback for writes
// that settled before timestamps existed.

const dirs = vi.hoisted(() => ({ real: '', demo: '', agents: '', agentsDemo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
  getAgentSessionsDir: () => dirs.agents,
  getAgentSessionsDemoDir: () => dirs.agentsDemo,
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

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-created-files-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.agents = path.join(root, 'agent-sessions')
  dirs.agentsDemo = path.join(root, 'agent-sessions-demo')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
  setAgentSessionFileDeps({ isDemoMode: () => false })
})

afterEach(async () => {
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

const harnessRecord = (id: string, createdAt: number, workspaceDir: string) => ({
  id,
  workspaceDir,
  title: 'dodge asteroids',
  createdAt,
  updatedAt: createdAt,
  capabilities: ['game-studio'],
  presetName: 'Game Agent',
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
})
