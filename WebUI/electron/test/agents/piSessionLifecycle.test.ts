import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Lifecycle tests for the Pi session manager. The behaviour that matters here is
// invisible in the UI until it breaks: one long-lived Pi session must be reused
// across turns (rebuilding it silently drops the conversation), it must be
// rebuilt when the model/workspace/tool set changes, and its session file must
// be remembered so a restart resumes instead of starting over.
//
// Pi itself, the tool builders and the workspace runtime are mocked: this is
// about the manager's bookkeeping, not about Pi's internals.

let userDataDir: string
let workspaceA: string
let workspaceB: string

const sessionFiles: string[] = []
const disposed: FakeSession[] = []

type FakeSession = {
  id: number
  sessionFile: string
  prompt: ReturnType<typeof vi.fn>
  compact: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  sendCustomMessage: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  getSessionStats: () => {
    sessionFile: string
    tokens: Record<string, number>
    cost: number
  }
  getContextUsage: () => { tokens: number; contextWindow: number; percent: number }
  messages: unknown[]
  emit: (event: unknown) => void
}

async function makeAgentSession(): Promise<{ session: FakeSession }> {
  const id = sessionFiles.length + 1
  const sessionFile = path.join(userDataDir, 'pi', 'sessions', `session-${id}.jsonl`)
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
  fs.writeFileSync(sessionFile, '')
  sessionFiles.push(sessionFile)
  let listener: ((event: unknown) => void) | undefined
  const session: FakeSession = {
    id,
    sessionFile,
    prompt: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    abort: vi.fn(),
    dispose: vi.fn(() => {
      disposed.push(session)
    }),
    sendCustomMessage: vi.fn(async () => {}),
    subscribe: vi.fn((callback: (event: unknown) => void) => {
      listener = callback
      return () => {
        listener = undefined
      }
    }),
    getSessionStats: () => ({
      sessionFile,
      tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
      cost: 0,
    }),
    getContextUsage: () => ({ tokens: 1200, contextWindow: 32768, percent: 3.7 }),
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', usage: { input: 80, output: 12, cacheRead: 5 } },
    ],
    emit: (event) => listener?.(event),
  }
  return { session }
}

const createAgentSession = vi.fn(makeAgentSession)

const openSession = vi.fn((sessionFilePath: string) => ({ kind: 'opened', sessionFilePath }))
const createSessionManager = vi.fn((cwd: string) => ({ kind: 'created', cwd }))
const registerProvider = vi.fn()

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => userDataDir },
  BrowserWindow: class {},
}))

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Pi itself is behind the runtime loader (it is ESM-only and loaded lazily), so
// mocking the loader is what stands in for the real agent.
vi.mock('../../agentMode/piRuntime.ts', () => ({
  loadPi: async () => ({
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: vi.fn() }) },
    ModelRegistry: {
      inMemory: () => ({
        registerProvider,
        find: (provider: string, modelId: string) => ({ provider, id: modelId }),
      }),
    },
    SessionManager: { open: openSession, create: createSessionManager },
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      async reload() {}
    },
    createAgentSession,
  }),
}))

vi.mock('../../agentMode/piToolOperations', () => ({
  createAgentToolAccess: vi.fn(async ({ workspaceDir }: { workspaceDir: string }) => ({
    cwd: workspaceDir,
    skillsRoot: '/skills',
    definitions: [],
    dispose: vi.fn(async () => {}),
  })),
}))

vi.mock('../../agentMode/piCustomTools', () => ({
  buildCustomTools: vi.fn(async () => []),
  writeAgentSkills: vi.fn(() => []),
  buildSkillsPromptSection: vi.fn(() => ''),
  setToolBridgeWindow: vi.fn(),
  submitAgentToolResult: vi.fn(),
  rejectAllPendingToolCalls: vi.fn(),
}))

vi.mock('../../agentMode/piWorkspaceRuntime', () => ({
  ensureWorkspaceRuntime: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:45678' })),
  closeWorkspaceRuntime: vi.fn(),
  buildWorkspaceInstructions: vi.fn(() => 'workspace instructions'),
}))

vi.mock('../../subprocesses/agentBrowser', () => ({ closeBrowserSession: vi.fn() }))

type SentMessage = { channel: string; payload: Record<string, unknown> }
let sent: SentMessage[]

function fakeWindow() {
  return {
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }),
    },
  }
}

function configFor(overrides: Partial<AgentModeTurnConfig> = {}): AgentModeTurnConfig {
  return {
    sessionId: 'aipg-agent-1',
    workspaceDir: workspaceA,
    modelConfig: {
      source: 'local',
      model: 'test-model',
      baseUrl: 'http://127.0.0.1:39000/v1',
      contextWindow: 32768,
    },
    toolSpecs: [],
    mcpServerIds: [],
    ...overrides,
  }
}

type Manager = typeof import('../../agentMode/piAgentManager')

async function loadManager(): Promise<Manager> {
  const manager = await import('../../agentMode/piAgentManager')
  manager.setAgentModeMainWindow(fakeWindow() as never)
  return manager
}

function pointerStore(): Record<string, { sessionFilePath: string; workspaceDir: string }> {
  const file = path.join(userDataDir, 'agent-sessions.json')
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

beforeEach(() => {
  vi.resetModules()
  createAgentSession.mockClear()
  openSession.mockClear()
  createSessionManager.mockClear()
  sessionFiles.length = 0
  disposed.length = 0
  sent = []
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-agent-session-')))
  userDataDir = path.join(root, 'userData')
  workspaceA = path.join(root, 'workspace-a')
  workspaceB = path.join(root, 'workspace-b')
  for (const dir of [userDataDir, workspaceA, workspaceB]) fs.mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(path.dirname(userDataDir), { recursive: true, force: true })
})

describe('session reuse', () => {
  it('keeps one session across turns of the same conversation', async () => {
    const manager = await loadManager()

    expect(await manager.startAgentTurn('t1', 'first', configFor())).toEqual({ success: true })
    expect(await manager.startAgentTurn('t2', 'second', configFor())).toEqual({ success: true })

    expect(createAgentSession).toHaveBeenCalledTimes(1)
    expect(disposed).toHaveLength(0)
  })

  it.each([
    ['the model changes', { modelConfig: { source: 'local', model: 'other', baseUrl: 'u' } }],
    ['the workspace changes', {}],
    ['the tool set changes', { toolSpecs: [{ name: 'media', description: 'x', inputSchema: {} }] }],
    ['MCP servers change', { mcpServerIds: ['filesystem'] }],
    ['the shell mode changes', { unsandboxed: true }],
    ['the conversation changes', { sessionId: 'aipg-agent-2' }],
  ] as [string, Partial<AgentModeTurnConfig>][])('rebuilds when %s', async (label, overrides) => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'first', configFor())

    const changed = label === 'the workspace changes' ? { workspaceDir: workspaceB } : overrides
    await manager.startAgentTurn('t2', 'second', configFor(changed))

    expect(createAgentSession).toHaveBeenCalledTimes(2)
    // The replaced session must be released, or its Pi listeners keep running.
    expect(disposed).toHaveLength(1)
  })

  it('refuses a second turn while one is running', async () => {
    const manager = await loadManager()
    let release = () => {}
    // Hold the first turn open in session construction, so the second one has to
    // deal with a turn that is genuinely in flight.
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    createAgentSession.mockImplementationOnce(async () => {
      await gate
      throw new Error('cancelled')
    })

    const first = manager.startAgentTurn('t1', 'first', configFor())
    const second = await manager.startAgentTurn('t2', 'second', configFor())
    expect(second).toEqual({ success: false, error: 'An agent turn is already running.' })

    release()
    expect(await first).toEqual({ success: false, error: 'cancelled' })
    // Once it settled, the next turn is accepted again.
    expect(await manager.startAgentTurn('t3', 'third', configFor())).toEqual({ success: true })
  })
})

describe('session persistence', () => {
  it('records the session file for the conversation', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())

    expect(pointerStore()['aipg-agent-1']).toMatchObject({
      workspaceDir: workspaceA,
      sessionFilePath: sessionFiles[0],
    })
    expect(createSessionManager).toHaveBeenCalledTimes(1)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('reopens the stored session file after a restart', async () => {
    const first = await loadManager()
    await first.startAgentTurn('t1', 'hello', configFor())
    const storedFile = pointerStore()['aipg-agent-1'].sessionFilePath

    // A restart: fresh module state, same userData directory on disk.
    vi.resetModules()
    openSession.mockClear()
    const second = await loadManager()
    await second.startAgentTurn('t2', 'again', configFor())

    expect(openSession).toHaveBeenCalledWith(storedFile, expect.any(String), workspaceA)
  })

  it('starts fresh when the stored session file is gone', async () => {
    const first = await loadManager()
    await first.startAgentTurn('t1', 'hello', configFor())
    fs.rmSync(pointerStore()['aipg-agent-1'].sessionFilePath)

    vi.resetModules()
    openSession.mockClear()
    createSessionManager.mockClear()
    const second = await loadManager()
    await second.startAgentTurn('t2', 'again', configFor())

    expect(openSession).not.toHaveBeenCalled()
    expect(createSessionManager).toHaveBeenCalledTimes(1)
  })

  it('starts fresh when the same conversation moved to another workspace', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())
    openSession.mockClear()

    await manager.startAgentTurn('t2', 'hello', configFor({ workspaceDir: workspaceB }))

    expect(openSession).not.toHaveBeenCalled()
    expect(pointerStore()['aipg-agent-1'].workspaceDir).toBe(workspaceB)
  })
})

describe('reset and delete', () => {
  it('reset drops the live session and its stored pointer', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())

    await manager.resetAgentSession()

    expect(disposed).toHaveLength(1)
    expect(pointerStore()).toEqual({})
    // Next turn must build a brand-new session rather than resume.
    await manager.startAgentTurn('t2', 'fresh start', configFor())
    expect(createAgentSession).toHaveBeenCalledTimes(2)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('delete removes the pointer and Pi session file', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())
    const storedFile = pointerStore()['aipg-agent-1'].sessionFilePath

    expect(await manager.deleteAgentSession('aipg-agent-1')).toEqual({ success: true })

    expect(fs.existsSync(storedFile)).toBe(false)
    expect(pointerStore()).toEqual({})
    expect(disposed).toHaveLength(1)
  })

  it('delete of an unknown session is not an error', async () => {
    const manager = await loadManager()

    expect(await manager.deleteAgentSession('aipg-agent-unknown')).toEqual({ success: true })
  })
})

describe('turn streaming', () => {
  it('sends translated chunks and always closes the turn', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())

    const channels = sent.map((message) => message.channel)
    expect(channels).toContain('agentMode:streamChunk')
    expect(channels.at(-1)).toBe('agentMode:turnDone')
    const finish = sent
      .filter((message) => message.channel === 'agentMode:streamChunk')
      .map((message) => message.payload.chunk as Record<string, unknown>)
      .at(-1)
    expect(finish).toMatchObject({
      type: 'finish',
      messageMetadata: {
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 },
        contextUsage: { tokens: 1200, contextWindow: 32768, percent: 3.7 },
        lastStep: { inputTokens: 80, outputTokens: 12, cacheReadTokens: 5 },
      },
    })
  })

  it('revises usage metadata during the turn, not only at its end', async () => {
    const manager = await loadManager()
    createAgentSession.mockImplementationOnce(async () => {
      const created = await makeAgentSession()
      const session = created.session
      // A long agentic turn: the gauge must move while tool calls and replies
      // pile context up, instead of jumping once the turn is over.
      session.prompt.mockImplementationOnce(async () => {
        session.emit({ type: 'turn_start' })
        session.messages = [...session.messages, { role: 'toolResult', content: 'output' }]
        session.emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash' })
      })
      return created
    })

    await manager.startAgentTurn('t1', 'hello', configFor())

    const metadata = sent
      .filter((message) => message.channel === 'agentMode:streamChunk')
      .map((message) => message.payload.chunk as Record<string, unknown>)
      .filter((chunk) => chunk.type === 'message-metadata')
    expect(metadata.length).toBeGreaterThan(0)
    expect(metadata[0]).toMatchObject({
      messageMetadata: { contextUsage: { tokens: 1200, contextWindow: 32768 } },
    })
  })

  it('reports a failed turn as an error chunk before closing it', async () => {
    const manager = await loadManager()
    createAgentSession.mockImplementationOnce(async () => {
      throw new Error('model unavailable')
    })

    expect(await manager.startAgentTurn('t1', 'hello', configFor())).toEqual({
      success: false,
      error: 'model unavailable',
    })

    const chunks = sent.filter((message) => message.channel === 'agentMode:streamChunk')
    expect(chunks.at(-1)?.payload.chunk).toEqual({
      type: 'error',
      errorText: 'model unavailable',
    })
    expect(sent.at(-1)?.channel).toBe('agentMode:turnDone')
  })

  it('rejects compaction without a session and runs it on the live one', async () => {
    const manager = await loadManager()

    expect(await manager.compactAgentContext()).toMatchObject({ success: false })

    await manager.startAgentTurn('t1', 'hello', configFor())
    const session = (await createAgentSession.mock.results[0].value).session as FakeSession
    // Compaction happens between turns, so the numbers are only reachable
    // through the returned result — nothing is streaming to the UI.
    session.compact.mockImplementationOnce(async () => {
      session.emit({
        type: 'compaction_end',
        reason: 'manual',
        result: { tokensBefore: 42_000, estimatedTokensAfter: 8_000 },
      })
    })

    expect(await manager.compactAgentContext('keep the API notes')).toEqual({
      success: true,
      tokensBefore: 42_000,
      tokensAfter: 8_000,
    })
    expect(session.compact).toHaveBeenCalledWith('keep the API notes')
  })

  // Pi rejects compacting a small session; that is a no-op the UI reports
  // calmly, not a failure worth an error toast.
  it('reports a too-small session as a no-op', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())
    const session = (await createAgentSession.mock.results[0].value).session as FakeSession
    session.compact.mockRejectedValueOnce(new Error('Nothing to compact (session too small)'))

    expect(await manager.compactAgentContext()).toEqual({ success: true, noop: true })
  })

  it('reports a real compaction failure', async () => {
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())
    const session = (await createAgentSession.mock.results[0].value).session as FakeSession
    session.compact.mockRejectedValueOnce(new Error('summarizer request failed'))

    expect(await manager.compactAgentContext()).toEqual({
      success: false,
      error: 'summarizer request failed',
    })
  })

  it('re-asserts the preview URL when the port changed', async () => {
    const runtime = await import('../../agentMode/piWorkspaceRuntime')
    const manager = await loadManager()
    await manager.startAgentTurn('t1', 'hello', configFor())

    vi.mocked(runtime.ensureWorkspaceRuntime).mockResolvedValue({
      baseUrl: 'http://127.0.0.1:50000',
    } as never)
    await manager.startAgentTurn('t2', 'again', configFor())

    const session = (await createAgentSession.mock.results[0].value).session as FakeSession
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: 'workspace-preview' }),
      { deliverAs: 'nextTurn' },
    )
  })
})
