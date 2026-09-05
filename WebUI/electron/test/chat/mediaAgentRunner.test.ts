import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { KernelEvent } from '@/types/kernelEvents'
import type { ChatToolSpec, MediaAgentRunRequest } from '@/types/chatIpc'

// Main-side media specialist runner (step 6): the nested tool loop runs in
// main, the inner tools execute over the renderer tool bridge. Driven here
// with a scripted mock model (the loop itself is covered by
// toolAgent.test.ts); assertions cover the wiring the move added — the bridge
// payload carries the nested history (source image included), the shipped
// repair data coerces a bogus workflow, progress reaches the kernel stream
// coalesced, and a cancel settles a pending inner call.

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../chat/chatModelMain', () => ({
  createMainChatModel: vi.fn(),
}))

vi.mock('../../subprocesses/mcpManager', () => ({
  listMcpServers: vi.fn(),
  getMcpServerStatus: vi.fn(),
}))

vi.mock('../../laminar', () => ({
  noteLlamaCppChatTimings: vi.fn(),
  noteMainChatTurnContext: vi.fn(),
  markDelegatedMediaRun: vi.fn(),
}))

const { runMediaAgentInMain, cancelMediaAgentRun } = await import('../../chat/mediaAgentRunner')
const { createMainChatModel } = await import('../../chat/chatModelMain')
const { setKernelEventWindow, resetKernelBusForTest, onKernelEvent } =
  await import('../../kernel/kernelBus')
const { handleChatToolResult, resetChatToolBridgeForTest } = await import('../../chat/toolBridge')

type SentPayload = Record<string, unknown>

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

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

function stream(...parts: Record<string, unknown>[]) {
  return {
    stream: simulateReadableStream({
      chunks: [{ type: 'stream-start', warnings: [] }, ...parts] as never[],
      chunkDelayInMs: 0,
    }),
  }
}

function toolCallResponse(toolName: string, input: Record<string, unknown>, id: string) {
  return stream(
    { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
  )
}

function textResponse(text: string) {
  return stream(
    { type: 'text-start', id: 't0' },
    { type: 'text-delta', id: 't0', delta: text },
    { type: 'text-end', id: 't0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
  )
}

const TOOL_SPEC: ChatToolSpec = {
  name: 'comfyUI',
  description: 'Create images',
  inputSchema: { type: 'object', properties: { workflow: { type: 'string' } } },
}

function runRequest(overrides: Partial<MediaAgentRunRequest> = {}): MediaAgentRunRequest {
  return {
    runKey: 'media-run:test',
    request: 'a castle image',
    sourceImage: 'data:image/png;base64,aGk=',
    system: 'You are the media specialist.',
    toolSpecs: [TOOL_SPEC],
    repairData: { comfyUI: { names: ['W1'], defaultWorkflow: 'W1' } },
    model: {
      backend: 'llamaCPP',
      modelId: 'test-model',
      baseUrl: 'http://127.0.0.1:39101',
    },
    ...overrides,
  }
}

let events: KernelEvent[]
let detachTap: () => void
let sent: SentPayload[]

beforeEach(() => {
  vi.clearAllMocks()
  resetKernelBusForTest()
  resetChatToolBridgeForTest()
  events = []
  detachTap = onKernelEvent((event) => void events.push(event))
  const window = fakeWindow()
  sent = window.sent
  setKernelEventWindow(window.win)
})

afterEach(() => {
  detachTap()
  vi.unstubAllGlobals()
})

function mediaEvents() {
  return events
    .filter(
      (e): e is Extract<KernelEvent, { type: 'media-agent-event' }> =>
        e.type === 'media-agent-event',
    )
    .map((e) => e.event)
}

/** The tool-bridge requests the fake window received (kernel events excluded). */
function toolRequests(): SentPayload[] {
  return sent.filter((p) => p.channel === 'chat:executeTool')
}

async function settleBridge(output: unknown): Promise<SentPayload> {
  await vi.waitFor(() => {
    if (toolRequests().length === 0) throw new Error('bridge request not sent yet')
  })
  const payload = toolRequests()[0]
  handleChatToolResult({ requestId: payload.requestId as string, output })
  return payload
}

describe('runMediaAgentInMain', () => {
  it('runs the nested loop, bridging inner tools with the nested history', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return toolCallResponse('comfyUI', { workflow: 'W1' }, 'c1')
        return textResponse('Made the castle.')
      },
    })
    vi.mocked(createMainChatModel).mockReturnValue(model)

    const run = runMediaAgentInMain(runRequest())
    const payload = await settleBridge({ images: [{ imageUrl: 'aipg-media://castle.png' }] })
    const result = await run

    // The bridge request routes to the run's registry key and carries the
    // nested history: prepended source image first, then the delegated request.
    expect(payload.conversationKey).toBe('media-run:test')
    expect(payload.toolName).toBe('comfyUI')
    expect(payload.input).toEqual({ workflow: 'W1' })
    const messages = payload.messages as Array<Record<string, unknown>>
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'file', mediaType: 'image/png' }],
    })
    expect(messages[1]).toMatchObject({ role: 'user', content: 'a castle image' })

    expect(result.text).toBe('Made the castle.')
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].output).toMatchObject({
      images: [{ imageUrl: 'aipg-media://castle.png' }],
    })

    const progress = mediaEvents()
    expect(progress.filter((e) => e.type === 'phase')).toEqual([
      { type: 'phase', phase: 'planning' },
      { type: 'phase', phase: 'running-tool' },
      { type: 'phase', phase: 'planning' },
    ])
    expect(progress.filter((e) => e.type === 'tool-start')).toHaveLength(1)
    expect(progress.filter((e) => e.type === 'tool-finish')).toHaveLength(1)
    expect(
      progress.some((e) => e.type === 'narration-delta' && e.text === 'Made the castle.'),
    ).toBe(true)
  })

  it('coerces a bogus workflow to the default via the shipped repair data', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return toolCallResponse('comfyUI', { workflow: 'bogus' }, 'c1')
        return textResponse('Done.')
      },
    })
    vi.mocked(createMainChatModel).mockReturnValue(model)

    const run = runMediaAgentInMain(runRequest())
    const payload = await settleBridge({ images: [] })
    await run

    expect(payload.input).toEqual({ workflow: 'W1' })
  })

  it('cancel aborts a pending inner call and the run settles as a failure', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return toolCallResponse('comfyUI', { workflow: 'W1' }, 'c1')
        return textResponse('Stopped.')
      },
    })
    vi.mocked(createMainChatModel).mockReturnValue(model)

    const run = runMediaAgentInMain(runRequest())
    await vi.waitFor(() => {
      if (toolRequests().length === 0) throw new Error('bridge request not sent yet')
    })
    cancelMediaAgentRun('media-run:test')

    // The aborted stream surfaces as a rejection (AbortError) — the same
    // throw contract callers had before the move; the pending bridge request
    // was rejected, so a late settle cannot revive it.
    await expect(run).rejects.toThrow()
    // Cancelling an unknown run key is a logged no-op, not a throw.
    expect(() => cancelMediaAgentRun('media-run:unknown')).not.toThrow()
  })
})
