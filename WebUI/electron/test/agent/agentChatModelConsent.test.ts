import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { KernelEvent } from '@/types/kernelEvents'
import type { PermissionsPromptPayload } from '@/types/permissionsIpc'
import type { MediaRequestPayload } from '@/types/mediaRequests'
import type { AgentModeTurnConfig } from '@/types/agentIpc'

// An agent turn whose local chat model is not on disk: it holds its place, asks
// the window what is missing, raises the download prompt as its session, and
// waits as a Paused Session. Only once the download finished does it take its
// place back and load the model. The backend is faked through `fetch`.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-model-consent-')))

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot, isPackaged: false, getAppPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

const BACKEND = 'http://fake-llm.test/v1'

let received: string[] = []
/** A model call that answers only once its promise resolves. */
let held: Record<string, Promise<void>> = {}

function frame(chunk: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
}

function reply(): Response {
  const chunks = [{ role: 'assistant', content: 'done' }, {}].map((delta, index) => ({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: index === 1 ? 'stop' : null }],
  }))
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
    const model = text ? JSON.parse(text).model : ''
    received.push(model)
    await held[model]
    return reply()
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

let events: KernelEvent[] = []
let prompts: PermissionsPromptPayload[] = []
let checks: MediaRequestPayload[] = []
const loaded: string[] = []
/** What the window reports missing, by chat model name. */
let missing: Record<string, unknown[]> = {}
let failCheck = false

let manager: typeof import('../../agent/piAgentManager')
let promptAdapter: typeof import('../../permissions/promptAdapter')

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  const bus = await import('../../kernel/kernelBus')
  const bridge = await import('../../artifact/rendererBridge')
  promptAdapter = await import('../../permissions/promptAdapter')
  const readiness = await import('../../chat/chatReadiness')
  readiness.setChatReadinessDeps({
    getService: () => ({
      ensureBackendReadiness: async (llmModelName: string) => {
        loaded.push(llmModelName)
      },
      baseUrl: null,
    }),
    awaitChatWindow: async () => {},
    stopOvmsImageServer: async () => {},
    notifyHomeAgentUpstreamReady: () => {},
  })
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        if (channel === 'kernel:event') events.push(payload as KernelEvent)
        else if (channel === 'artifact:request') {
          const request = payload as MediaRequestPayload
          checks.push(request)
          if (request.kind !== 'chat-check-models') return
          const models = missing[request.llmModelName] ?? []
          queueMicrotask(() =>
            bridge.handleMediaResponse(
              failCheck
                ? { requestId: request.requestId, error: 'ai-backend is not running' }
                : { requestId: request.requestId, result: { models } },
            ),
          )
        } else if (channel === 'permissions:prompt') {
          const prompt = payload as PermissionsPromptPayload
          if (prompt.kind === 'is-remote') {
            queueMicrotask(() =>
              promptAdapter.handlePermissionsPromptResponse({
                requestId: prompt.requestId,
                result: false,
              }),
            )
            return
          }
          prompts.push(prompt)
        }
      },
    },
  }
  bus.setKernelEventWindow(fakeWindow as never)
  manager.setAgentModeMainWindow(fakeWindow as never)
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

let workspace: string

beforeEach(() => {
  events = []
  prompts = []
  checks = []
  received = []
  held = {}
  loaded.length = 0
  missing = {}
  failCheck = false
  workspace = fs.mkdtempSync(path.join(tempRoot, 'ws-'))
})

function configFor(
  sessionId: string,
  model: string,
  overrides: { supportsVision?: boolean } = {},
): AgentModeTurnConfig {
  return {
    sessionId,
    workspaceDir: workspace,
    modelConfig: {
      source: 'local',
      model,
      baseUrl: BACKEND,
      contextWindow: 8192,
      ...overrides,
    },
    readiness: { serviceName: 'llamacpp-backend', llmModelName: model },
    toolSpecs: [],
    capabilities: [],
  }
}

function stateEvents(turnId: string): string[] {
  return events.flatMap((event) =>
    event.type === 'agent-turn-state' && event.turnId === turnId ? [event.state] : [],
  )
}

function errorText(turnId: string): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'agent-chunk' || event.turnId !== turnId) return []
    const chunk = event.chunk as { type?: string; errorText?: string }
    return chunk.type === 'error' && chunk.errorText ? [chunk.errorText] : []
  })
}

async function downloadPrompt() {
  await vi.waitFor(() => expect(prompts.some((p) => p.kind === 'download')).toBe(true))
  return prompts.find((p) => p.kind === 'download')!
}

const MODEL_A_FILE = { repo_id: 'org/model-a', type: 'ggufLLM', backend: 'llama_cpp' }

describe('an agent turn whose chat model is not downloaded', () => {
  it('asks as its session, pauses, and loads the model only once the download finished', async () => {
    missing = { 'model-a': [MODEL_A_FILE] }
    const turnA = crypto.randomUUID()
    const runA = manager.startAgentTurn(turnA, 'say hi', configFor('aipg-agent-a', 'model-a'))
    const download = await downloadPrompt()
    expect(download).toMatchObject({ conversationKey: 'aipg-agent-a', models: [MODEL_A_FILE] })
    await vi.waitFor(() => expect(stateEvents(turnA)).toEqual(['queued', 'running', 'paused']))
    expect(loaded).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent-turn-state',
        turnId: turnA,
        state: 'paused',
        pauseReason: { kind: 'download', summary: 'model-a' },
      }),
    )

    // Another session's turn runs while A waits on the user.
    const turnB = crypto.randomUUID()
    const runB = manager.startAgentTurn(turnB, 'and you', configFor('aipg-agent-b', 'model-b'))
    expect(await runB).toEqual({ success: true })
    expect(loaded).toEqual(['model-b'])

    promptAdapter.handlePermissionsPromptResponse({ requestId: download.requestId, result: true })
    expect(await runA).toEqual({ success: true })
    expect(loaded).toEqual(['model-b', 'model-a'])
    expect(received).toEqual(['model-b', 'model-a'])
    expect(stateEvents(turnA).slice(0, 3)).toEqual(['queued', 'running', 'paused'])
    expect(stateEvents(turnA).at(-1)).toBe('running')
    expect(errorText(turnA)).toEqual([])
  }, 30000)

  it('takes its place back ahead of turns that queued while it was paused', async () => {
    missing = { 'model-a': [MODEL_A_FILE] }
    let releaseB = () => {}
    held = { 'model-b': new Promise<void>((resolve) => (releaseB = resolve)) }
    const turnA = crypto.randomUUID()
    const runA = manager.startAgentTurn(turnA, 'say hi', configFor('aipg-agent-a', 'model-a'))
    const download = await downloadPrompt()
    const runB = manager.startAgentTurn(
      crypto.randomUUID(),
      'b',
      configFor('aipg-agent-b', 'model-b'),
    )
    await vi.waitFor(() => expect(received).toEqual(['model-b']))
    const runC = manager.startAgentTurn(
      crypto.randomUUID(),
      'c',
      configFor('aipg-agent-c', 'model-c'),
    )

    promptAdapter.handlePermissionsPromptResponse({ requestId: download.requestId, result: true })
    await vi.waitFor(() => expect(stateEvents(turnA).at(-1)).toBe('queued'))
    expect(loaded).toEqual(['model-b'])
    releaseB()

    await Promise.all([runA, runB, runC])
    expect(loaded).toEqual(['model-b', 'model-a', 'model-c'])
    expect(received).toEqual(['model-b', 'model-a', 'model-c'])
  }, 30000)

  it('fails with "model download declined" when the user declines', async () => {
    missing = { 'model-a': [MODEL_A_FILE] }
    const turnA = crypto.randomUUID()
    const runA = manager.startAgentTurn(turnA, 'say hi', configFor('aipg-agent-a', 'model-a'))
    const download = await downloadPrompt()
    promptAdapter.handlePermissionsPromptResponse({
      requestId: download.requestId,
      error: 'User cancelled the download',
      cancelled: true,
    })
    expect(await runA).toEqual({ success: false, error: 'model download declined' })
    expect(errorText(turnA)).toEqual(['model download declined'])
    expect(loaded).toEqual([])
    expect(received).toEqual([])
  }, 30000)

  it('fails with the download error when the download breaks', async () => {
    missing = { 'model-a': [MODEL_A_FILE] }
    const turnA = crypto.randomUUID()
    const runA = manager.startAgentTurn(turnA, 'say hi', configFor('aipg-agent-a', 'model-a'))
    const download = await downloadPrompt()
    promptAdapter.handlePermissionsPromptResponse({
      requestId: download.requestId,
      error: 'Network unreachable',
    })
    expect(await runA).toEqual({ success: false, error: 'Network unreachable' })
    expect(errorText(turnA)).toEqual(['Network unreachable'])
    expect(loaded).toEqual([])
  }, 30000)

  it('ends when stopped while it waits for the answer', async () => {
    missing = { 'model-a': [MODEL_A_FILE] }
    const turnA = crypto.randomUUID()
    const runA = manager.startAgentTurn(turnA, 'say hi', configFor('aipg-agent-a', 'model-a'))
    const download = await downloadPrompt()
    manager.cancelAgentTurn('aipg-agent-a')
    expect((await runA).success).toBe(false)
    expect(manager.isAgentTurnActive()).toBe(false)
    expect(loaded).toEqual([])
    promptAdapter.handlePermissionsPromptResponse({ requestId: download.requestId, result: true })
  }, 30000)

  it('asks for the vision projector too when the prompt carries an attached image', async () => {
    const turnA = crypto.randomUUID()
    const run = manager.startAgentTurn(
      turnA,
      'what is this?\n\nAttached files, saved in the workspace: @attachments/cat.png',
      configFor('aipg-agent-a', 'model-a', { supportsVision: true }),
    )
    expect(await run).toEqual({ success: true })
    expect(checks).toEqual([
      expect.objectContaining({
        kind: 'chat-check-models',
        serviceName: 'llamacpp-backend',
        llmModelName: 'model-a',
        needsVision: true,
      }),
    ])
  }, 30000)
})

describe('an agent turn that needs no download', () => {
  it('still loads its model when the window cannot say what is missing', async () => {
    failCheck = true
    const turnA = crypto.randomUUID()
    const run = manager.startAgentTurn(turnA, 'say hi', configFor('aipg-agent-a', 'model-a'))
    expect(await run).toEqual({ success: true })
    expect(prompts).toEqual([])
    expect(loaded).toEqual(['model-a'])
  }, 30000)

  it('never prompts when the chat model is on disk', async () => {
    const turnA = crypto.randomUUID()
    const run = manager.startAgentTurn(turnA, 'say hi', configFor('aipg-agent-a', 'model-a'))
    expect(await run).toEqual({ success: true })
    expect(checks).toEqual([
      expect.objectContaining({ kind: 'chat-check-models', needsVision: false }),
    ])
    expect(prompts).toEqual([])
    expect(stateEvents(turnA)).not.toContain('paused')
    expect(loaded).toEqual(['model-a'])
  }, 30000)

  it('never asks the window about a cloud model', async () => {
    const turnA = crypto.randomUUID()
    const run = manager.startAgentTurn(turnA, 'say hi', {
      sessionId: 'aipg-agent-cloud',
      workspaceDir: workspace,
      modelConfig: {
        source: 'cloud',
        model: 'cloud-model',
        proxyBaseUrl: BACKEND,
        upstreamBaseUrl: 'https://cloud.test/v1',
        providerId: 'test',
        authStyle: 'bearer',
      },
      toolSpecs: [],
      capabilities: [],
    })
    expect(await run).toEqual({ success: true })
    expect(checks).toEqual([])
    expect(prompts).toEqual([])
    expect(loaded).toEqual([])
  }, 30000)
})
