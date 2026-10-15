import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { KernelEvent } from '@/types/kernelEvents'
import type { ChatAskPayload } from '@/types/chatRequests'
import type { PermissionsPromptPayload } from '@/types/permissionsIpc'

// A Paused Session, seen from outside main: session A's turn calls a speech tool,
// and the window answering it raises a download prompt. A gives up its Turn Queue
// place, so session B's queued turn (on another model) runs to the end; once the
// prompt is answered, A takes the place back, readiness loads A's model again,
// and A's live Pi session carries on. The backend is faked through `fetch`.

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-paused-')))

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot, isPackaged: false, getAppPath: () => tempRoot },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

const BACKEND = 'http://fake-llm.test/v1'

type Received = { model: string; hasToolResult: boolean }
let received: Received[] = []
let onRequest: () => void = () => {}

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

/** A's first step calls the speech tool; every other step just answers. */
function reply(body: { model?: string; messages?: Array<{ role: string }> }): Response {
  const callsTool =
    body.model === 'model-a' && !body.messages?.some((message) => message.role === 'tool')
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
    const body = text ? JSON.parse(text) : {}
    received.push({
      model: body.model,
      hasToolResult: body.messages?.some((m: { role: string }) => m.role === 'tool') ?? false,
    })
    onRequest()
    return reply(body)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

let events: KernelEvent[] = []
let asks: ChatAskPayload[] = []
let prompts: PermissionsPromptPayload[] = []
const loaded: string[] = []

let manager: typeof import('../../agent/piAgentManager')
let bus: typeof import('../../kernel/kernelBus')
let chatAsk: typeof import('../../chat/chatAsk')
let promptAdapter: typeof import('../../permissions/promptAdapter')
let permissions: typeof import('../../permissions/permissionsService')

beforeAll(async () => {
  manager = await import('../../agent/piAgentManager')
  bus = await import('../../kernel/kernelBus')
  chatAsk = await import('../../chat/chatAsk')
  promptAdapter = await import('../../permissions/promptAdapter')
  permissions = await import('../../permissions/permissionsService')
  const bridge = await import('../../artifact/rendererBridge')
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
        if (channel === 'chat:ask') asks.push(payload as ChatAskPayload)
        else if (channel === 'artifact:request') {
          // Every chat model is on disk here.
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
})

afterAll(async () => {
  await manager.shutdownAgentMode()
})

let workspace: string

beforeEach(() => {
  events = []
  asks = []
  prompts = []
  received = []
  loaded.length = 0
  onRequest = () => {}
  workspace = fs.mkdtempSync(path.join(tempRoot, 'ws-'))
})

function configFor(sessionId: string, model: string, speech: boolean): AgentModeTurnConfig {
  return {
    sessionId,
    workspaceDir: workspace,
    modelConfig: { source: 'local', model, baseUrl: BACKEND, contextWindow: 8192 },
    readiness: { serviceName: 'llamacpp-backend', llmModelName: model },
    toolSpecs: speech
      ? [
          {
            name: 'synthesizeTextToSpeech',
            description: 'Speak text into an audio file.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ]
      : [],
    capabilities: speech ? ['media'] : [],
  }
}

function stateEvents(turnId: string): string[] {
  return events.flatMap((event) =>
    event.type === 'agent-turn-state' && event.turnId === turnId ? [event.state] : [],
  )
}

async function nextPrompt(kind: PermissionsPromptPayload['kind']) {
  await vi.waitFor(() => expect(prompts.some((p) => p.kind === kind)).toBe(true))
  return prompts.find((p) => p.kind === kind)!
}

describe('a Paused Session', () => {
  it('gives up its place while the user is asked, and continues on its own model after', async () => {
    const turnA = crypto.randomUUID()
    const runA = manager.startAgentTurn(turnA, 'say hi', configFor('aipg-agent-a', 'model-a', true))
    await vi.waitFor(() => expect(asks).toHaveLength(1))

    const turnB = crypto.randomUUID()
    const runB = manager.startAgentTurn(
      turnB,
      'and you',
      configFor('aipg-agent-b', 'model-b', false),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received.map((r) => r.model)).toEqual(['model-a'])

    // The window, answering A's speech request, needs a voice model downloaded.
    const consent = permissions.requestDownloadConsent([{ repo_id: 'voice' }])
    const remote = await nextPrompt('is-remote')
    promptAdapter.handlePermissionsPromptResponse({ requestId: remote.requestId, result: false })
    const download = await nextPrompt('download')
    expect(download.conversationKey).toBe('aipg-agent-a')

    expect(await runB).toEqual({ success: true })
    expect(stateEvents(turnA)).toEqual(['queued', 'running', 'paused'])
    expect(bus.getKernelSnapshot().state.agentTurns).toEqual([
      expect.objectContaining({ sessionId: 'aipg-agent-a', turnId: turnA, state: 'paused' }),
    ])
    expect(received.map((r) => r.model)).toEqual(['model-a', 'model-b'])
    expect(loaded).toEqual(['model-a', 'model-b'])

    promptAdapter.handlePermissionsPromptResponse({ requestId: download.requestId, result: true })
    await consent
    chatAsk.handleChatAnswer({
      requestId: asks[0].requestId,
      result: { audioBase64: '', mediaType: 'audio/wav', voice: 'test', engine: 'kokoro' },
    })

    expect(await runA).toEqual({ success: true })
    expect(received).toEqual([
      { model: 'model-a', hasToolResult: false },
      { model: 'model-b', hasToolResult: false },
      { model: 'model-a', hasToolResult: true },
    ])
    expect(loaded).toEqual(['model-a', 'model-b', 'model-a'])
    expect(stateEvents(turnA)).toEqual(['queued', 'running', 'paused', 'running', 'running'])
    for (const event of events) {
      if (!event.type.startsWith('agent-')) continue
      const { turnId, sessionId } = event as { turnId: string; sessionId: string }
      expect(sessionId).toBe(turnId === turnA ? 'aipg-agent-a' : 'aipg-agent-b')
    }
  }, 30000)

  it('ends when stopped while paused, letting the queue move on', async () => {
    const turnA = crypto.randomUUID()
    const runA = manager.startAgentTurn(turnA, 'say hi', configFor('aipg-agent-a', 'model-a', true))
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    const consent = permissions.requestDownloadConsent([{ repo_id: 'voice' }]).catch(() => {})
    const remote = await nextPrompt('is-remote')
    promptAdapter.handlePermissionsPromptResponse({ requestId: remote.requestId, result: false })
    await nextPrompt('download')
    await vi.waitFor(() => expect(stateEvents(turnA)).toContain('paused'))

    manager.cancelAgentTurn('aipg-agent-a')
    await runA
    expect(manager.isAgentTurnActive()).toBe(false)
    expect(bus.getKernelSnapshot().state.agentTurns).toEqual([])
    expect(received.map((r) => r.model)).toEqual(['model-a'])

    const download = prompts.find((p) => p.kind === 'download')!
    promptAdapter.handlePermissionsPromptResponse({
      requestId: download.requestId,
      error: 'declined',
      cancelled: true,
    })
    await consent
  }, 30000)
})
