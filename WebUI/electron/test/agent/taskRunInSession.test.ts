import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentModeTurnConfig } from '@/types/agentIpc'

// A Task Run inside its Session, seen from outside main: a real Pi session runs
// each Step against a fake OpenAI-compatible backend served through `fetch`, so
// the assertions are on the request bodies Pi sent and on the Session's files.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-task-run-')))

vi.mock('../../adapters/trash', async () => {
  const fs = await import('node:fs/promises')
  return { moveToTrash: (target: string) => fs.rm(target, { recursive: true, force: true }) }
})

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot, isPackaged: false, getAppPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

vi.mock('../../persist/userDataPaths.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../persist/userDataPaths.ts')>()),
  getSessionsDir: () => path.join(tempRoot, 'sessions'),
  getLegacySessionsDir: () => path.join(tempRoot, 'sessions'),
  getAppWorkspacesDir: () => `${path.join(tempRoot, 'sessions')}-workspaces`,
  getSessionsDemoDir: () => path.join(tempRoot, 'sessions-demo'),
  getLegacySessionsDemoDir: () => path.join(tempRoot, 'sessions-demo'),
  getAppWorkspacesDemoDir: () => `${path.join(tempRoot, 'sessions-demo')}-workspaces`,
}))

const BACKEND = 'http://fake-llm.test/v1'

type Body = { messages?: Array<{ role: string; content?: unknown }> }

/** Request bodies the fake backend received, in order. */
let bodies: Body[] = []
/** A tool call the backend makes once, before it answers. */
let toolCall: { name: string; args: Record<string, unknown> } | null = null

function frame(chunk: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
}

function completion(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function reply(body: Body): Response {
  const call = toolCall && !body.messages?.some((message) => message.role === 'tool')
  const chunks = call
    ? [
        completion({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: toolCall!.name, arguments: JSON.stringify(toolCall!.args) },
            },
          ],
        }),
        completion({}, 'tool_calls'),
      ]
    : [completion({ role: 'assistant', content: `reply ${bodies.length}` }), completion({}, 'stop')]
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(frame(chunk))
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    if (!request.url.startsWith(BACKEND)) return realFetch(input, init)
    const text = await request.text()
    const body = text ? (JSON.parse(text) as Body) : {}
    bodies.push(body)
    return reply(body)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

let manager: typeof import('../../agent/piAgentManager')
let sessions: typeof import('../../session/sessions')
let workspaces: typeof import('../../session/sessionWorkspace')
let harness: typeof import('../../session/sessionHarness')
let history: typeof import('../../session/sessionHistory')
let store: typeof import('../../agent/piSessionStore')
let taskRuns: typeof import('../../session/sessionTaskRuns')

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  sessions = await import('../../session/sessions')
  workspaces = await import('../../session/sessionWorkspace')
  harness = await import('../../session/sessionHarness')
  history = await import('../../session/sessionHistory')
  store = await import('../../agent/piSessionStore')
  taskRuns = await import('../../session/sessionTaskRuns')
  sessions.setSessionDeps({ isDemoMode: () => false })
  const fakeWindow = { isDestroyed: () => false, webContents: { send: () => {} } }
  const bus = await import('../../kernel/kernelBus')
  bus.setKernelEventWindow(fakeWindow as never)
  manager.setAgentModeMainWindow(fakeWindow as never)
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

beforeEach(() => {
  bodies = []
  toolCall = null
})

async function agentConfig(sessionId: string): Promise<AgentModeTurnConfig> {
  const { harnessSessionId, workspaceDir } = await harness.harnessSessionFor(sessionId, 'Agent')
  return {
    sessionId: harnessSessionId,
    sessionRef: sessionId,
    presetName: 'Agent',
    workspaceDir,
    modelConfig: { source: 'local', model: 'test-model', baseUrl: BACKEND, contextWindow: 8192 },
    toolSpecs: [],
    capabilities: [],
  }
}

/** A run turn's prompt as the window sends it: the instruction and every Step. */
const RUN_PROMPT = 'Carry out these steps.\n1. Fetch the headlines.\n2. Summarise them.'

async function taskRunConfig(sessionId: string, input?: string): Promise<AgentModeTurnConfig> {
  const { harnessSessionId, workspaceDir } = await taskRuns.taskRunHarnessFor(sessionId)
  return {
    ...(await agentConfig(sessionId)),
    sessionId: harnessSessionId,
    workspaceDir,
    taskRun: { taskName: 'Morning digest', ...(input ? { input } : {}) },
  }
}

// The conversation, without the system prompt, which names the Workspace after the Session title.
function conversationText(body: Body | undefined): string {
  return JSON.stringify((body?.messages ?? []).filter((message) => message.role !== 'system'))
}

function userTexts(body: Body | undefined): string[] {
  return (body?.messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
}

function offeredTools(body: Body | undefined): string[] {
  const tools = (body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools
  return (tools ?? []).map((tool) => tool.function?.name ?? '')
}

async function sessionWithHistory() {
  const session = await sessions.createSession()
  await manager.startAgentTurn('t0', 'remember the word plum', await agentConfig(session.id))
  await history.appendHistoryEntry(session.id, {
    preset: 'Draft Image',
    kind: 'image',
    prompt: 'a castle',
    status: 'completed',
    artifacts: [{ path: 'files/castle.png', mediaType: 'image' }],
  })
  bodies = []
  return session
}

describe('a Task Run in its Session', () => {
  it('starts a fresh Harness Session in the Session files folder', async () => {
    const session = await sessions.createSession()
    const agent = await agentConfig(session.id)

    const first = await taskRuns.taskRunHarnessFor(session.id)
    const second = await taskRuns.taskRunHarnessFor(session.id)

    expect(first.harnessSessionId).not.toBe(agent.sessionId)
    expect(second.harnessSessionId).not.toBe(first.harnessSessionId)
    expect(first.workspaceDir).toBe(workspaces.sessionWorkspaceDir(session.id))
  }, 30000)

  it('sends its first request with no Session Update, no session_history and no prior turns', async () => {
    const session = await sessionWithHistory()

    await manager.startAgentTurn('t1', 'summarise the news', await taskRunConfig(session.id))

    const body = bodies[0]
    expect(offeredTools(body)).not.toContain('session_history')
    const users = userTexts(body)
    expect(users).toHaveLength(1)
    expect(users[0]).not.toContain('a castle')
    expect(users[0]).not.toContain('Session Update')
    expect(conversationText(body)).not.toContain('plum')
  }, 30000)

  it('appends one History Entry for the run, naming the Agent and its Start Prompt', async () => {
    const session = await sessions.createSession()
    const run = await taskRunConfig(session.id, 'only Europe')

    await manager.startAgentTurn('t1', RUN_PROMPT, run)

    const entries = await history.readHistoryEntries(session.id)
    expect(entries).toEqual([
      expect.objectContaining({
        prompt: 'Run Agent Morning digest: only Europe',
        taskName: 'Morning digest',
      }),
    ])
    expect(entries[0]).not.toHaveProperty('stepIndex')
  }, 30000)

  it('names only the Agent in its History Entry when it was run with no Start Prompt', async () => {
    const session = await sessions.createSession()

    await manager.startAgentTurn('t1', RUN_PROMPT, await taskRunConfig(session.id))

    const [entry] = await history.readHistoryEntries(session.id)
    expect(entry.prompt).toBe('Run Agent Morning digest')
  }, 30000)

  it('is one line of the Session Update for another preset, without its Steps', async () => {
    const session = await sessions.createSession()
    const assistant = await agentConfig(session.id)
    await manager.startAgentTurn('t0', 'hello', assistant)
    await manager.startAgentTurn('t1', RUN_PROMPT, await taskRunConfig(session.id, 'only Europe'))
    bodies = []

    await manager.startAgentTurn('t2', 'anything new', assistant)

    const update = userTexts(bodies[0]).at(-1) ?? ''
    expect(update).toContain('Session Update')
    expect(update.match(/\[\d\d:\d\d\]/g)).toHaveLength(1)
    expect(update).toContain('Run Agent Morning digest: only Europe')
    expect(update).not.toContain('Fetch the headlines')
  }, 30000)

  it("deletes a run's Pi file with the Session", async () => {
    const stop = harness.cleanUpHarnessSessionsOnDelete((id) => manager.deleteAgentSession(id))
    const session = await sessions.createSession()
    const config = await taskRunConfig(session.id)
    await manager.startAgentTurn('t1', 'hello', config)
    const piFile = store.readSessionStore()[config.sessionId]?.sessionFilePath
    expect(piFile && fs.existsSync(piFile)).toBe(true)

    await sessions.deleteSession(session.id)

    expect(fs.existsSync(piFile!)).toBe(false)
    stop()
  }, 30000)
})

describe('a Follow-up to an Agent Run in its Session', () => {
  const FOLLOW_UP = { agentId: 't-news', agentName: 'Morning digest' }

  function followUpTo(run: AgentModeTurnConfig): AgentModeTurnConfig {
    const { taskRun: _step, ...rest } = run
    return { ...rest, followUp: FOLLOW_UP }
  }

  it('continues the run’s Harness Session, its Steps still in context', async () => {
    const session = await sessionWithHistory()
    const run = await taskRunConfig(session.id)
    await manager.startAgentTurn('t1', 'summarise the news', run)

    await manager.startAgentTurn('t2', 'why that headline?', followUpTo(run))

    const users = userTexts(bodies[1])
    expect(users).toHaveLength(2)
    expect(users[0]).toContain('summarise the news')
    expect(users[1]).toContain('why that headline?')
    expect(conversationText(bodies[1])).not.toContain('plum')
  }, 30000)

  it('gets a Session Update of the turns since the run, not of its Steps or Follow-ups', async () => {
    const session = await sessionWithHistory()
    const run = await taskRunConfig(session.id)
    await manager.startAgentTurn('t1', 'first step', run)
    await manager.startAgentTurn('t2', 'second step', {
      ...run,
      taskRun: { taskName: 'Morning digest' },
    })
    await manager.startAgentTurn('t3', 'assistant turn', await agentConfig(session.id))
    bodies = []

    await manager.startAgentTurn('t4', 'what did you miss', followUpTo(run))
    await manager.startAgentTurn('t5', 'and now?', followUpTo(run))

    const first = userTexts(bodies[0]).at(-1) ?? ''
    expect(first).toContain('Session Update')
    expect(first).toContain('assistant turn')
    expect(first).not.toContain('a castle')
    expect(first).not.toContain('first step')
    expect(first).not.toContain('second step')
    expect(userTexts(bodies[1]).at(-1)).not.toContain('Session Update')
  }, 30000)

  it('hears only what happened since a run from before Follow-ups, not its Steps', async () => {
    const session = await sessionWithHistory()
    const run = await taskRunConfig(session.id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const startedAt = Date.now()
    const legacy = { kind: 'agent' as const, status: 'completed' as const, artifacts: [] }
    await history.appendHistoryEntry(session.id, {
      ...legacy,
      preset: 'Agent',
      prompt: 'legacy step',
      taskName: 'Morning digest',
    })
    await history.appendHistoryEntry(session.id, { ...legacy, preset: 'Agent', prompt: 'a tower' })

    await manager.startAgentTurn('t1', 'what did you miss', {
      ...followUpTo(run),
      followedRun: { taskName: 'Morning digest', startedAt },
    })

    const update = userTexts(bodies[0]).at(-1) ?? ''
    expect(update).toContain('a tower')
    expect(update).not.toContain('a castle')
    expect(update).not.toContain('legacy step')
  }, 30000)

  it('is news to Assistant, under the Agent’s name', async () => {
    const session = await sessionWithHistory()
    const maker = await agentConfig(session.id)
    await manager.startAgentTurn('t1', 'catch up', maker)
    const run = await taskRunConfig(session.id)
    await manager.startAgentTurn('t2', 'summarise the news', run)
    await manager.startAgentTurn('t3', 'hello digest', followUpTo(run))
    bodies = []

    await manager.startAgentTurn('t4', 'anything new', maker)

    expect(userTexts(bodies[0]).at(-1)).toContain('Morning digest: \\"hello digest\\"')
  }, 30000)

  it('files its History Entry under Assistant, marked as a Follow-up of the Agent', async () => {
    const session = await sessions.createSession()
    const run = await taskRunConfig(session.id)
    await manager.startAgentTurn('t1', 'summarise the news', run)

    await manager.startAgentTurn('t2', 'hello digest', followUpTo(run))

    expect(await history.readHistoryEntries(session.id)).toEqual([
      expect.objectContaining({ taskName: 'Morning digest', harnessSessionId: run.sessionId }),
      expect.objectContaining({
        preset: 'Agent',
        prompt: 'hello digest',
        agentId: 't-news',
        agentName: 'Morning digest',
        followUp: true,
        harnessSessionId: run.sessionId,
      }),
    ])
    const [step] = await history.readHistoryEntries(session.id)
    expect(step).not.toHaveProperty('followUp')
    expect(await history.lastTurnPreset(session.id)).toEqual({ preset: 'Agent' })
  }, 30000)
})
