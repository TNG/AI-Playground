import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { KernelEvent } from '@/types/kernelEvents'
import type { UIMessageChunk } from 'ai'

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../subprocesses/mcpManager', () => ({
  listMcpServers: vi.fn(),
  getMcpServerStatus: vi.fn(),
}))

const {
  submitChatTurn,
  cancelChatTurn,
  chatTurnActive,
  resumeChatTurn,
  setChatEngineDeps,
  resetChatEngineDepsForTest,
} = await import('../../chat/turnEngine')
const { setChatModelDeps, resetChatModelDepsForTest } = await import('../../chat/chatModelMain')
const { setKernelEventWindow, resetKernelBusForTest, onKernelEvent } =
  await import('../../kernel/kernelBus')
const { handleChatToolResult, resetChatToolBridgeForTest } = await import('../../chat/toolBridge')
const { listMcpServers, getMcpServerStatus } = await import('../../subprocesses/mcpManager')

type SentPayload = Record<string, unknown> & { channel?: string }

function fakeWindow(): { win: BrowserWindow; sent: SentPayload[] } {
  const sent: SentPayload[] = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: SentPayload) => void sent.push({ channel, ...payload }),
    },
  } as unknown as BrowserWindow
  return { win, sent }
}

// ── SSE fixtures ───────────────────────────────────────────────────────────────

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}`).join('\n\n') + '\n\ndata: [DONE]\n\n'
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function textChunks(text: string) {
  return [
    { id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] },
    {
      id: '1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      timings: {
        cache_n: 1,
        prompt_n: 3,
        prompt_ms: 30,
        prompt_per_token_ms: 10,
        prompt_per_second: 100,
        predicted_n: 2,
        predicted_ms: 100,
        predicted_per_token_ms: 50,
        predicted_per_second: 20,
      },
    },
  ]
}

function toolCallChunks(name: string, args: string) {
  return [
    {
      id: '1',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }],
          },
        },
      ],
    },
    {
      id: '1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    },
  ]
}

// ── Signal-aware fetch queue ───────────────────────────────────────────────────

type ResponseFactory = (signal?: AbortSignal) => Response

const sse =
  (chunks: unknown[]): ResponseFactory =>
  () =>
    sseResponse(chunks)

/** A stream that never yields; its reads reject with AbortError once cancelled. */
const pending = (): ResponseFactory => (signal) => {
  const stream = new ReadableStream<Uint8Array>({
    pull: () =>
      new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('This operation was aborted', 'AbortError'))
          return
        }
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('This operation was aborted', 'AbortError')),
          { once: true },
        )
      }),
    cancel: () => {},
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const requests: Array<{ url: string; body: Record<string, unknown> }> = []
let responses: ResponseFactory[] = []

function queueFetchMock(...queued: ResponseFactory[]) {
  responses = queued
  requests.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: unknown; signal?: AbortSignal }) => {
      requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
      const factory = responses.shift()
      if (!factory) throw new Error('test fetch queue empty')
      return factory(init?.signal)
    }),
  )
}

// ── Turn request fixture ───────────────────────────────────────────────────────

function turnRequest(overrides: Record<string, unknown> = {}) {
  return {
    conversationKey: 'conv-1',
    trigger: 'submit-message',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    systemPrompt: 'You are helpful.',
    model: {
      backend: 'llamaCPP',
      modelId: 'test/model.gguf',
      baseUrl: 'http://127.0.0.1:39101',
      timingsPerToken: true,
      maxOutputTokens: 100,
      temperature: 0.7,
    },
    tools: [],
    ...overrides,
  }
}

// ── Harness ────────────────────────────────────────────────────────────────────

let events: KernelEvent[]
let detachTap: () => void
let sent: SentPayload[]
let readMediaAsDataUri: ReturnType<typeof vi.fn<(url: string) => Promise<string>>>

beforeEach(() => {
  resetKernelBusForTest()
  resetChatToolBridgeForTest()
  resetChatModelDepsForTest()
  resetChatEngineDepsForTest()
  events = []
  detachTap = onKernelEvent((event) => void events.push(event))
  const window = fakeWindow()
  sent = window.sent
  setKernelEventWindow(window.win)
  readMediaAsDataUri = vi.fn(async (url: string) => `data:image/png;base64,${url.length}`)
  setChatEngineDeps({ readMediaAsDataUri })
  setChatModelDeps({
    llmApiBase: () => 'http://127.0.0.1:39101',
    ensureBackendReadiness: vi.fn(),
    homeAgentAuthToken: () => 'token',
  })
  vi.mocked(listMcpServers).mockReturnValue([])
  vi.mocked(getMcpServerStatus).mockReturnValue({ state: 'stopped' } as never)
})

afterEach(() => {
  detachTap()
  vi.unstubAllGlobals()
})

function chatChunks(): UIMessageChunk[] {
  return events.filter((e) => e.type === 'chat-chunk').map((e) => e.chunk as UIMessageChunk)
}

function doneTurnIds(): string[] {
  return events
    .filter((e) => e.type === 'chat-turn-done')
    .map((e) => (e as { turnId: string }).turnId)
}

async function waitForTurnDone(turnId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(doneTurnIds()).toContain(turnId)
  })
}

function bodyMessages(): Array<{ role: string; content: unknown }> {
  return requests[0].body.messages as Array<{ role: string; content: unknown }>
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('turn engine', () => {
  it('streams a text turn over the kernel bus, coalescing adjacent deltas', async () => {
    queueFetchMock(
      sse([
        ...textChunks('Hello').slice(0, 1),
        ...textChunks(' world').slice(0, 1),
        ...textChunks('').slice(1),
      ]),
    )
    const { turnId } = submitChatTurn(turnRequest())
    await waitForTurnDone(turnId)

    const chunks = chatChunks()
    const deltas = chunks.filter((c) => c.type === 'text-delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ type: 'text-delta', delta: 'Hello world' })
    expect(chunks.some((c) => c.type === 'finish')).toBe(true)

    expect(requests[0].body).toMatchObject({
      model: 'test---model.gguf',
      timings_per_token: true,
      temperature: 0.7,
      max_tokens: 100,
    })
    expect(bodyMessages()[0]).toMatchObject({ role: 'system', content: 'You are helpful.' })
    expect(chatTurnActive('conv-1')).toBe(false)
  })

  it('carries model + llama.cpp timings into message metadata', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(turnRequest())
    await waitForTurnDone(turnId)

    const chunks = chatChunks()
    const start = chunks.find((c) => c.type === 'start') as
      { messageMetadata?: { model?: string } } | undefined
    const finish = chunks.find((c) => c.type === 'finish') as
      { messageMetadata?: Record<string, unknown> } | undefined
    expect(start?.messageMetadata?.model).toBe('test/model.gguf')
    expect(finish?.messageMetadata?.timings).toMatchObject({ prompt_n: 3, predicted_n: 2 })
    expect(finish?.messageMetadata?.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 })
  })

  it('rejects a second turn for the same conversation but allows another one', async () => {
    queueFetchMock(pending(), pending())
    const first = submitChatTurn(turnRequest())
    expect(() => submitChatTurn(turnRequest())).toThrow('already running')
    const second = submitChatTurn(turnRequest({ conversationKey: 'conv-2' }))
    expect(second.turnId).toBeTruthy()

    cancelChatTurn('conv-1', second.turnId) // wrong turn: no-op
    cancelChatTurn('conv-1', first.turnId)
    cancelChatTurn('conv-2', second.turnId)
    await waitForTurnDone(first.turnId)
    await waitForTurnDone(second.turnId)
    expect(chatTurnActive('conv-1')).toBe(false)
    expect(chatTurnActive('conv-2')).toBe(false)
  })

  it('round-trips a tool call through the renderer bridge', async () => {
    queueFetchMock(
      sse(toolCallChunks('searchWeb', '{"query":"cats"}')),
      sse(textChunks('found cats')),
    )
    submitChatTurn(
      turnRequest({
        tools: [
          {
            name: 'searchWeb',
            description: 'Search the web',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        ],
      }),
    )

    const execution = await vi.waitFor(() => {
      const found = sent.find((p) => p.channel === 'chat:executeTool')
      expect(found).toBeDefined()
      return found as { requestId: string; toolName: string; input: unknown }
    })
    expect(execution.toolName).toBe('searchWeb')
    expect(execution.input).toEqual({ query: 'cats' })
    handleChatToolResult({ requestId: execution.requestId, output: { results: ['r1'] } })
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })

    const secondBody = requests[1].body
    const toolMessage = (secondBody.messages as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === 'tool',
    )
    expect(toolMessage).toBeDefined()
    expect(JSON.stringify(toolMessage!.content)).toContain('r1')
    expect(chatChunks().some((c) => c.type === 'tool-input-available')).toBe(true)
    expect(chatChunks().some((c) => c.type === 'finish')).toBe(true)
  })

  it('repairs an invalid comfyUI workflow before executing the tool', async () => {
    queueFetchMock(
      sse(toolCallChunks('comfyUI', '{"prompt":"a castle","workflow":"nope"}')),
      sse(textChunks('made it')),
    )
    submitChatTurn(
      turnRequest({
        tools: [
          {
            name: 'comfyUI',
            description: 'Generate an image',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                workflow: { type: 'string', enum: ['Draft Image'] },
              },
              required: ['prompt', 'workflow'],
            },
          },
        ],
        repairData: { comfyUI: { names: ['Draft Image'], defaultWorkflow: 'Draft Image' } },
      }),
    )

    const execution = await vi.waitFor(() => {
      const found = sent.find((p) => p.channel === 'chat:executeTool')
      expect(found).toBeDefined()
      return found as { requestId: string; input: { workflow?: string } }
    })
    expect(execution.input.workflow).toBe('Draft Image')
    handleChatToolResult({ requestId: execution.requestId, output: { ok: true } })
    await vi.waitFor(() => {
      expect(doneTurnIds().length).toBeGreaterThan(0)
    })
  })

  it('strips image parts for non-vision models and keeps text', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(
      turnRequest({
        messages: [
          {
            id: 'm1',
            role: 'user',
            parts: [
              { type: 'text', text: 'describe' },
              { type: 'file', mediaType: 'image/png', url: 'aipg-media://a.png' },
            ],
          },
        ],
        model: {
          backend: 'llamaCPP',
          modelId: 'test/model.gguf',
          baseUrl: 'http://127.0.0.1:39101',
          supportsVision: false,
        },
      }),
    )
    await waitForTurnDone(turnId)

    const userMessage = bodyMessages().find((m) => m.role === 'user')
    expect(JSON.stringify(userMessage!.content)).not.toContain('image_url')
    expect(JSON.stringify(userMessage!.content)).toContain('describe')
  })

  it('converts aipg-media references to data URIs for vision models', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(
      turnRequest({
        messages: [
          {
            id: 'm1',
            role: 'user',
            parts: [
              { type: 'file', mediaType: 'image/png', url: 'aipg-media://a.png' },
              { type: 'text', text: 'see this' },
            ],
          },
        ],
        model: {
          backend: 'llamaCPP',
          modelId: 'test/model.gguf',
          baseUrl: 'http://127.0.0.1:39101',
          supportsVision: true,
        },
      }),
    )
    await waitForTurnDone(turnId)

    expect(readMediaAsDataUri).toHaveBeenCalledWith('aipg-media://a.png')
    const userMessage = bodyMessages().find((m) => m.role === 'user')
    expect(JSON.stringify(userMessage!.content)).toContain('data:image/png;base64,')
  })

  it('replaces screenshot tool results with a vision image follow-up message', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(
      turnRequest({
        messages: [
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'look' }] },
          {
            id: 'm2',
            role: 'assistant',
            parts: [
              {
                type: 'tool-captureScreenshot',
                toolCallId: 'c1',
                state: 'output-available',
                input: {},
                output: { ok: true, windowName: 'w', dataUri: 'data:image/png;base64,AAA' },
              },
            ],
          },
          { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'what do you see' }] },
        ],
        tools: [
          { name: 'captureScreenshot', description: 'Capture', inputSchema: { type: 'object' } },
        ],
        model: {
          backend: 'llamaCPP',
          modelId: 'test/model.gguf',
          baseUrl: 'http://127.0.0.1:39101',
          supportsVision: true,
        },
      }),
    )
    await waitForTurnDone(turnId)

    const serialized = JSON.stringify(bodyMessages())
    expect(serialized).toContain('captured. The image is attached in the following message.')
    expect(serialized).toContain('data:image/png;base64,AAA')
    const injected = bodyMessages().find(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('captured screenshot'),
    )
    expect(injected).toBeDefined()
  })

  it('slims replayed media tool results before they reach the model', async () => {
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(
      turnRequest({
        messages: [
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'make art' }] },
          {
            id: 'm2',
            role: 'assistant',
            parts: [
              {
                type: 'tool-media',
                toolCallId: 'c1',
                state: 'output-available',
                input: { request: 'art' },
                output: {
                  images: [
                    {
                      id: 'i1',
                      type: 'image',
                      imageUrl: 'aipg-media://img.png',
                      mode: 'image',
                      settings: { big: 'x'.repeat(200) },
                    },
                  ],
                  steps: ['did'],
                  summary: 'art made',
                },
              },
            ],
          },
          { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'nice' }] },
        ],
        tools: [{ name: 'media', description: 'Create media', inputSchema: { type: 'object' } }],
      }),
    )
    await waitForTurnDone(turnId)

    const toolMessage = bodyMessages().find((m) => m.role === 'tool')
    const serialized = JSON.stringify(toolMessage!.content)
    expect(serialized).toContain('art made')
    expect(serialized).toContain('i1')
    expect(serialized).not.toContain('settings')
    expect(serialized).not.toContain('big')
  })

  it('appends running MCP server instructions when asked', async () => {
    vi.mocked(listMcpServers).mockReturnValue([
      { id: 's1', name: 'Serv', instructions: 'Do things' },
      { id: 's2', name: 'Off', instructions: 'Should not appear' },
    ] as never)
    vi.mocked(getMcpServerStatus).mockImplementation(
      (id: string) => ({ state: id === 's1' ? 'running' : 'stopped' }) as never,
    )
    queueFetchMock(sse(textChunks('ok')))
    const { turnId } = submitChatTurn(turnRequest({ includeMcpInstructions: true }))
    await waitForTurnDone(turnId)

    const system = bodyMessages().find((m) => m.role === 'system')
    const content = String(system!.content)
    expect(content).toContain('You are helpful.')
    expect(content).toContain('# MCP server instructions')
    expect(content).toContain('## MCP server: Serv')
    expect(content).toContain('Do things')
    expect(content).not.toContain('Off')
  })

  it('surfaces a backend error as an error chunk, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 400, statusText: 'Bad Request' })),
    )
    const { turnId } = submitChatTurn(turnRequest())
    await waitForTurnDone(turnId)

    const error = chatChunks().find((c) => c.type === 'error') as { errorText?: string } | undefined
    expect(error).toBeDefined()
    expect(error!.errorText).toContain('HTTP 400')
    expect(error!.errorText).toContain('boom')
    expect(chatTurnActive('conv-1')).toBe(false)
  })

  it('cancels a turn without surfacing an error chunk', async () => {
    queueFetchMock(pending())
    const { turnId } = submitChatTurn(turnRequest())
    await vi.waitFor(() => {
      expect(requests.length).toBeGreaterThan(0)
    })
    cancelChatTurn('conv-1', turnId)
    await waitForTurnDone(turnId)

    expect(chatChunks().some((c) => c.type === 'error')).toBe(false)
    expect(chatTurnActive('conv-1')).toBe(false)
  })

  it('resumeChatTurn includes the live turnId so a reloaded renderer can reconnect', async () => {
    queueFetchMock(pending())
    const { turnId } = submitChatTurn(turnRequest())
    await vi.waitFor(() => {
      expect(requests.length).toBeGreaterThan(0)
    })
    const resumed = resumeChatTurn('conv-1')
    expect(resumed).toMatchObject({
      turnId,
      chunks: expect.any(Array),
      sequence: expect.any(Number),
    })
    expect(resumeChatTurn('conv-missing')).toBeNull()
    cancelChatTurn('conv-1', turnId)
    await waitForTurnDone(turnId)
  })
})
