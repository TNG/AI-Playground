import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { KernelEvent } from '@/types/kernelEvents'
import type { ChatAskPayload } from '@/types/chatRequests'
import type { PermissionsPromptPayload } from '@/types/permissionsIpc'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { AgentTurnEnd } from '../../agent/agentTurnOutcome'

// How an agent turn ended, as a main-side subscriber hears it: a real Pi session
// against a fake OpenAI-compatible backend, faked through `fetch`.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-outcome-')))

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot, isPackaged: false, getAppPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

const BACKEND = 'http://fake-llm.test/v1'

type Backend = 'answer' | 'speak' | 'reject'
let backend: Backend = 'answer'

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

function reply(body: { messages?: Array<{ role: string }> }): Response {
  if (backend === 'reject') {
    return new Response(JSON.stringify({ error: { message: 'model test-model was retired' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const callsTool = backend === 'speak' && !body.messages?.some((m) => m.role === 'tool')
  const chunks = callsTool
    ? [
        completion({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'synthesizeTextToSpeech', arguments: '{"text":"hi"}' },
            },
          ],
        }),
        completion({}, 'tool_calls'),
      ]
    : [completion({ role: 'assistant', content: 'done' }), completion({}, 'stop')]
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
    return reply(text ? JSON.parse(text) : {})
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

let events: KernelEvent[] = []
let asks: ChatAskPayload[] = []
let prompts: PermissionsPromptPayload[] = []
let ends: AgentTurnEnd[] = []

let manager: typeof import('../../agent/piAgentManager')
let promptAdapter: typeof import('../../permissions/promptAdapter')
let permissions: typeof import('../../permissions/permissionsService')

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  promptAdapter = await import('../../permissions/promptAdapter')
  permissions = await import('../../permissions/permissionsService')
  const bus = await import('../../kernel/kernelBus')
  const bridge = await import('../../artifact/rendererBridge')
  const readiness = await import('../../chat/chatReadiness')
  readiness.setChatReadinessDeps({
    getService: () => ({ ensureBackendReadiness: async () => {}, baseUrl: null }),
    awaitChatWindow: async () => {},
    stopOvmsImageServer: async () => {},
    notifyHomeAgentUpstreamReady: () => {},
  })
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        if (channel === 'chat:ask') asks.push(payload as ChatAskPayload)
        else if (channel === 'artifact:request') {
          const { requestId } = payload as { requestId: string }
          queueMicrotask(() => bridge.handleMediaResponse({ requestId, result: { models: [] } }))
        } else if (channel === 'permissions:prompt')
          prompts.push(payload as PermissionsPromptPayload)
        else if (channel === 'kernel:event') events.push(payload as KernelEvent)
      },
    },
  }
  bus.setKernelEventWindow(fakeWindow as never)
  manager.setAgentModeMainWindow(fakeWindow as never)
  manager.onAgentTurnEnd((end) => ends.push(end))
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

let workspace: string

beforeEach(() => {
  events = []
  asks = []
  prompts = []
  ends = []
  backend = 'answer'
  workspace = fs.mkdtempSync(path.join(tempRoot, 'ws-'))
})

function configFor(sessionId: string): AgentModeTurnConfig {
  return {
    sessionId,
    workspaceDir: workspace,
    modelConfig: { source: 'local', model: 'model-a', baseUrl: BACKEND, contextWindow: 8192 },
    readiness: { serviceName: 'llamacpp-backend', llmModelName: 'model-a' },
    toolSpecs: [
      {
        name: 'synthesizeTextToSpeech',
        description: 'Speak text into an audio file.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
    capabilities: ['media'],
  }
}

/** The error text the renderer's stream shows for this turn. */
function shownError(turnId: string): string | undefined {
  for (const event of events) {
    if (event.type !== 'agent-chunk' || event.turnId !== turnId) continue
    const chunk = event.chunk as { type: string; errorText?: string }
    if (chunk.type === 'error') return chunk.errorText
  }
  return undefined
}

describe('an agent turn end', () => {
  it('reports completed when the model answers', async () => {
    const turnId = crypto.randomUUID()
    await manager.startAgentTurn(turnId, 'hi', configFor('aipg-agent-done'))
    expect(ends).toEqual([{ sessionId: 'aipg-agent-done', turnId, outcome: 'completed' }])
  }, 30000)

  it('reports failed with the error the app shows when the model call fails', async () => {
    backend = 'reject'
    const turnId = crypto.randomUUID()
    await manager.startAgentTurn(turnId, 'hi', configFor('aipg-agent-fail'))
    const error = shownError(turnId)
    expect(error).toContain('model test-model was retired')
    expect(ends).toEqual([{ sessionId: 'aipg-agent-fail', turnId, outcome: 'failed', error }])
  }, 30000)

  it('reports cancelled when the user stops it', async () => {
    backend = 'speak'
    const turnId = crypto.randomUUID()
    const run = manager.startAgentTurn(turnId, 'say hi', configFor('aipg-agent-stop'))
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    manager.cancelAgentTurn('aipg-agent-stop')
    await run
    expect(ends).toEqual([{ sessionId: 'aipg-agent-stop', turnId, outcome: 'cancelled' }])
  }, 30000)

  it('reports the stop once, and nothing when its held prompt is dropped after', async () => {
    backend = 'speak'
    const turnId = crypto.randomUUID()
    const run = manager.startAgentTurn(turnId, 'say hi', configFor('aipg-agent-held'))
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    const consent = permissions.requestDownloadConsent([{ repo_id: 'voice' }]).catch(() => {})
    await vi.waitFor(() => expect(prompts.some((p) => p.kind === 'is-remote')).toBe(true))
    const remote = prompts.find((p) => p.kind === 'is-remote')!
    promptAdapter.handlePermissionsPromptResponse({ requestId: remote.requestId, result: false })
    await vi.waitFor(() => expect(prompts.some((p) => p.kind === 'download')).toBe(true))

    manager.cancelAgentTurn('aipg-agent-held')
    await run
    const download = prompts.find((p) => p.kind === 'download')!
    promptAdapter.handlePermissionsPromptResponse({
      requestId: download.requestId,
      error: 'The turn that asked has ended.',
      cancelled: true,
    })
    await consent
    expect(ends).toEqual([{ sessionId: 'aipg-agent-held', turnId, outcome: 'cancelled' }])
  }, 30000)

  it('never reports failed when the app shuts down mid-turn', async () => {
    backend = 'speak'
    const turnId = crypto.randomUUID()
    const run = manager.startAgentTurn(turnId, 'say hi', configFor('aipg-agent-quit'))
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    await manager.shutdownAgentMode()
    await run
    expect(ends).toEqual([{ sessionId: 'aipg-agent-quit', turnId, outcome: 'cancelled' }])
  }, 30000)
})
