import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { KernelEvent } from '@/types/kernelEvents'
import type { AgentTurnEnd } from '../../agent/agentTurnOutcome'
import type { ActiveSession } from '../../agent/piAgentState'

// A Stop pressed at any point of an agent turn must keep the model from being
// asked anything more: before Pi's run starts, Pi itself drops an abort, so a
// Stop that lands there used to let the whole turn run on in the background.
// A real Pi session runs against a fake OpenAI-compatible backend served
// through `fetch`, so "stopped" is asserted on what the backend received.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-agent-stop-')))

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot, isPackaged: false, getAppPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

/** Runs on the session `ensureSession` hands the turn runner, before the runner sees it. */
let onSessionReady: (session: ActiveSession) => void = () => {}

vi.mock('../../agent/piSessionLifecycle.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../agent/piSessionLifecycle.ts')>()
  return {
    ...original,
    ensureSession: async (...args: Parameters<typeof original.ensureSession>) => {
      const session = await original.ensureSession(...args)
      onSessionReady(session)
      return session
    },
  }
})

const BACKEND = 'http://fake-llm.test/v1'

let requests = 0

function sseResponse(): Response {
  const encoder = new TextEncoder()
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    encoder.encode(
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    )
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(frame({ role: 'assistant', content: 'done' }))
      controller.enqueue(frame({}, 'stop'))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    if (!request.url.startsWith(BACKEND)) return realFetch(input, init)
    // A real fetch with an aborted signal never reaches the server.
    if (init?.signal?.aborted || request.signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    requests++
    return sseResponse()
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

let events: KernelEvent[] = []
let onEvent: (event: KernelEvent) => void = () => {}
let ends: AgentTurnEnd[] = []
let workspace: string

type Manager = typeof import('../../agent/piAgentManager')
let manager: Manager

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  const bus = await import('../../kernel/kernelBus')
  const outcome = await import('../../agent/agentTurnOutcome')
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, event: KernelEvent) => {
        events.push(event)
        onEvent(event)
      },
    },
  }
  bus.setKernelEventWindow(fakeWindow as never)
  manager.setAgentModeMainWindow(fakeWindow as never)
  outcome.onAgentTurnEnd((end) => void ends.push(end))
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

beforeEach(() => {
  events = []
  ends = []
  requests = 0
  onEvent = () => {}
  onSessionReady = () => {}
  workspace = fs.mkdtempSync(path.join(tempRoot, 'ws-'))
})

function configFor(sessionId: string): AgentModeTurnConfig {
  return {
    sessionId,
    workspaceDir: workspace,
    modelConfig: { source: 'local', model: 'test-model', baseUrl: BACKEND, contextWindow: 8192 },
    toolSpecs: [],
    capabilities: [],
  }
}

function expectStoppedWithoutAModelCall(sessionId: string, turnId: string) {
  expect(requests).toBe(0)
  expect(ends).toEqual([{ sessionId, turnId, outcome: 'cancelled' }])
  expect(
    events.some(
      (event) =>
        event.type === 'agent-chunk' && (event.chunk as { type?: string }).type === 'error',
    ),
  ).toBe(false)
  expect(events.at(-1)).toMatchObject({ type: 'agent-turn-done', sessionId, turnId })
}

describe('stopping an agent turn', () => {
  it('stops a turn stopped as it takes its place, before its session is ready', async () => {
    const sessionId = 'aipg-agent-stop-place'
    const turnId = crypto.randomUUID()
    onEvent = (event) => {
      if (event.type === 'agent-turn-state' && event.state === 'running') {
        manager.cancelAgentTurn(sessionId, turnId)
      }
    }

    expect((await manager.startAgentTurn(turnId, 'hello', configFor(sessionId))).success).toBe(
      false,
    )
    expectStoppedWithoutAModelCall(sessionId, turnId)
  }, 30000)

  it('stops a turn stopped while its Pi session is being readied', async () => {
    const sessionId = 'aipg-agent-stop-session'
    const turnId = crypto.randomUUID()
    onSessionReady = () => manager.cancelAgentTurn(sessionId, turnId)

    await manager.startAgentTurn(turnId, 'hello', configFor(sessionId))
    expectStoppedWithoutAModelCall(sessionId, turnId)
  }, 30000)

  it("stops a turn stopped after the prompt went to Pi but before Pi's run started", async () => {
    const sessionId = 'aipg-agent-stop-preflight'
    const turnId = crypto.randomUUID()
    onSessionReady = (live) => {
      const prompt = live.session.prompt.bind(live.session)
      live.session.prompt = (async (...args: Parameters<typeof prompt>) => {
        live.session.prompt = prompt
        const sent = prompt(...args)
        manager.cancelAgentTurn(sessionId, turnId)
        return await sent
      }) as typeof prompt
    }

    await manager.startAgentTurn(turnId, 'hello', configFor(sessionId))
    expectStoppedWithoutAModelCall(sessionId, turnId)
  }, 30000)

  it('still runs the next turn of a session whose turn was stopped early', async () => {
    const sessionId = 'aipg-agent-stop-next'
    const stopped = crypto.randomUUID()
    onSessionReady = () => manager.cancelAgentTurn(sessionId, stopped)
    await manager.startAgentTurn(stopped, 'hello', configFor(sessionId))
    onSessionReady = () => {}

    expect(
      await manager.startAgentTurn(crypto.randomUUID(), 'again', configFor(sessionId)),
    ).toEqual({ success: true })
    expect(requests).toBe(1)
  }, 30000)
})
