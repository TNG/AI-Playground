import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTurnSnapshot, KernelEvent, KernelSnapshot } from '@/types/kernelEvents'
import type { IpcMutationResult } from '@/types/ipcChannels'

// The renderer half of the hidden-window lifecycle: a window that (re)connects
// while main is mid-turn adopts that turn from the kernel snapshot — the
// accumulated chunks replay as the resumed stream's opening content, live
// events append, and the turn's done event settles processing.

let pushKernelEvent: (event: KernelEvent) => void = () => {}
let resolveSnapshot: (snapshot: KernelSnapshot) => void = () => {}

const SESSION_ID = 'aipg-agent-7'
const TURN_ID = '6f1c1e0a-3b7d-4c55-9a43-2f7d0c1b9e10'

const RUNNING_TURN: AgentTurnSnapshot = {
  sessionId: SESSION_ID,
  turnId: TURN_ID,
  state: 'running',
  chunks: [
    { type: 'start', id: 'msg-1', message: { id: 'msg-1', role: 'assistant', parts: [] } },
    { type: 'text-start', id: 'part-1' },
    { type: 'text-delta', id: 'part-1', delta: 'hello ' },
  ],
  toolProgress: { 'call-1': 'navigating' },
  toolImages: {
    'call-1': [
      {
        type: 'agent-tool-image',
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        toolCallId: 'call-1',
        dataUri: 'data:image/png;base64,',
        label: 'cover.png',
      },
    ],
  },
}

function kernelEventOf(payload: Record<string, unknown>, seq: number): KernelEvent {
  return {
    sessionId: SESSION_ID,
    ...payload,
    scope: { kind: 'run', runId: TURN_ID },
    seq,
  } as KernelEvent
}

const startTurn = vi.fn(
  async (_turnId: string, _prompt: string, _config: unknown): Promise<IpcMutationResult> => ({
    success: true,
  }),
)
const cancelTurn = vi.fn(async (_sessionId: string, _turnId?: string) => {})

const reported: unknown[] = []
const report = vi.fn((error: unknown) => void reported.push(error))

beforeEach(() => {
  vi.clearAllMocks()
  pushKernelEvent = () => {}
  resolveSnapshot = () => {}
  globalThis.window = {
    electronAPI: {
      onKernelEvent: vi.fn((listener: (event: KernelEvent) => void) => {
        pushKernelEvent = listener
        return () => {}
      }),
      getKernelSnapshot: vi.fn(
        () =>
          new Promise<KernelSnapshot>((resolve) => {
            resolveSnapshot = resolve
          }),
      ),
      reportInFlightWork: vi.fn(),
      agentMode: {
        sessionDocuments: vi.fn(async () => []),
        onExecuteTool: vi.fn(),
        submitToolResult: vi.fn(),
        startTurn,
        cancel: cancelTurn,
      },
    },
  } as unknown as Window & typeof globalThis
})

afterEach(async () => {
  const { unregisterAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
  unregisterAgentModeIpc()
})

const onAdoptedTurnDone = vi.fn()

async function freshRuntimes(initialMessages: unknown[] = []) {
  const { createAgentTurnRuntimes } = await import('@/assets/js/store/agentModeTurn')
  const runtimes = createAgentTurnRuntimes({
    errors: { report },
    buildTurnConfig: async (sessionId) => ({ sessionId }) as never,
    initialMessages: () => initialMessages as never,
    onAdoptedTurnDone,
  })
  return {
    runtimes,
    /** The resumed session's runtime, once the snapshot has created it. */
    async adopted() {
      await vi.waitFor(() => expect(runtimes.runtimeOf(SESSION_ID)).toBeDefined())
      return runtimes.runtimeOf(SESSION_ID)!
    },
  }
}

function snapshotWithTurn(sequence: number, turn: typeof RUNNING_TURN | null) {
  return {
    scope: { kind: 'global' } as const,
    sequence,
    state: {
      services: [],
      agentTurns: turn ? [turn] : [],
      activeArtifactRun: null,
      chatTurns: [],
      activities: [],
      inferenceProfile: null,
    },
  }
}

describe('agent turn resume', () => {
  it('adopts a running turn: replays chunks, restores progress, appends live events', async () => {
    const { adopted } = await freshRuntimes()
    resolveSnapshot(snapshotWithTurn(5, RUNNING_TURN))
    const runtime = await adopted()

    await vi.waitFor(() => expect(runtime.processing.value).toBe(true))
    expect(runtime.toolProgress.value['call-1']).toBe('navigating')
    expect(runtime.toolImages.value['call-1']).toHaveLength(1)

    // The snapshot's accumulated chunks built the in-flight message...
    await vi.waitFor(() => expect(JSON.stringify(runtime.chat.messages)).toContain('hello '))

    // ...and live events above the watermark append.
    pushKernelEvent(
      kernelEventOf(
        {
          type: 'agent-chunk',
          turnId: TURN_ID,
          chunk: { type: 'text-delta', id: 'part-1', delta: 'world' },
        },
        6,
      ),
    )
    await vi.waitFor(() => expect(JSON.stringify(runtime.chat.messages)).toContain('world'))

    // The done event closes the stream and clears processing.
    pushKernelEvent(kernelEventOf({ type: 'agent-turn-done', turnId: TURN_ID }, 7))
    await vi.waitFor(() => expect(runtime.processing.value).toBe(false))
  })

  it('cancels an adopted turn by its session and turn id', async () => {
    const { adopted } = await freshRuntimes()
    resolveSnapshot(snapshotWithTurn(5, RUNNING_TURN))
    const runtime = await adopted()
    await vi.waitFor(() => expect(runtime.processing.value).toBe(true))

    await runtime.cancel()
    expect(cancelTurn).toHaveBeenCalledWith(SESSION_ID, TURN_ID)
  })

  it('mints a fresh UUID turn id after adopting', async () => {
    const { adopted } = await freshRuntimes()
    resolveSnapshot(snapshotWithTurn(5, RUNNING_TURN))
    const runtime = await adopted()
    await vi.waitFor(() => expect(runtime.processing.value).toBe(true))
    pushKernelEvent(kernelEventOf({ type: 'agent-turn-done', turnId: TURN_ID }, 7))
    await vi.waitFor(() => expect(runtime.processing.value).toBe(false))

    runtime.chat.sendMessage({ text: 'next request' })
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled())
    const [turnId, , config] = startTurn.mock.calls.at(-1) ?? []
    expect(turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(turnId).not.toBe(TURN_ID)
    expect(config).toEqual({ sessionId: SESSION_ID, userMessageId: expect.any(String) })
  })

  it('does not resume when the snapshot has no running turn', async () => {
    const { runtimes } = await freshRuntimes()
    resolveSnapshot(snapshotWithTurn(5, null))
    await Promise.resolve()
    expect(runtimes.runtimeOf(SESSION_ID)).toBeUndefined()
    expect(runtimes.anyTurnOpen.value).toBe(false)
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('does not adopt a turn whose done event arrived during the handshake', async () => {
    const { adopted } = await freshRuntimes()
    // Buffered behind the handshake, so its seq is above the watermark —
    // but the install runs first and reconnect still must not hang a dead
    // turn open.
    pushKernelEvent(kernelEventOf({ type: 'agent-turn-done', turnId: TURN_ID }, 6))
    resolveSnapshot(snapshotWithTurn(5, RUNNING_TURN))
    const runtime = await adopted()

    await vi.waitFor(() => expect(JSON.stringify(runtime.chat.messages)).toContain('hello '))
    // The turnDone flushed after install; processing settles without a hang.
    await vi.waitFor(() => expect(runtime.processing.value).toBe(false))
    expect(reported).toHaveLength(0)
  })
})

describe('following a turn another window started', () => {
  const OTHER_TURN = 'b2a0f9d4-1c2e-4a6b-8d3f-0e9c7a5b4d21'
  const ORIGIN = { prompt: 'More cheese please!', userMessageId: 'user-from-the-other-window' }
  const previous = [
    { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'Cheese?' }] },
    { id: 'a0', role: 'assistant', parts: [{ type: 'text', text: 'Here is a cheese image.' }] },
  ]
  const event = (payload: Record<string, unknown>, seq: number): KernelEvent =>
    ({
      sessionId: SESSION_ID,
      ...payload,
      scope: { kind: 'run', runId: OTHER_TURN },
      seq,
    }) as KernelEvent

  async function connected(initialMessages: unknown[] = []) {
    const fresh = await freshRuntimes(initialMessages)
    resolveSnapshot(snapshotWithTurn(5, null))
    await Promise.resolve()
    return fresh
  }

  it('streams it live as its own reply after the asking message, and leaves saving to its window', async () => {
    const { runtimes } = await connected(previous)
    runtimes.runtimeFor(SESSION_ID)
    pushKernelEvent(
      event({ type: 'agent-turn-state', turnId: OTHER_TURN, state: 'queued', origin: ORIGIN }, 6),
    )
    const runtime = runtimes.runtimeOf(SESSION_ID)!
    await vi.waitFor(() => expect(runtime.processing.value).toBe(true))

    pushKernelEvent(
      event(
        {
          type: 'agent-chunk',
          turnId: OTHER_TURN,
          chunk: { type: 'start', messageId: `${OTHER_TURN}-reply` },
        },
        7,
      ),
    )
    pushKernelEvent(
      event(
        { type: 'agent-chunk', turnId: OTHER_TURN, chunk: { type: 'text-start', id: 't1' } },
        8,
      ),
    )
    pushKernelEvent(
      event(
        {
          type: 'agent-chunk',
          turnId: OTHER_TURN,
          chunk: { type: 'text-delta', id: 't1', delta: 'Brie!' },
        },
        9,
      ),
    )
    await vi.waitFor(() =>
      expect(runtime.chat.messages.map((message) => message.id)).toEqual([
        'u0',
        'a0',
        ORIGIN.userMessageId,
        `${OTHER_TURN}-reply`,
      ]),
    )
    expect(JSON.stringify(runtime.chat.messages.at(-1))).toContain('Brie!')
    expect(JSON.stringify(runtime.chat.messages[1])).not.toContain('Brie!')

    pushKernelEvent(event({ type: 'agent-turn-done', turnId: OTHER_TURN }, 10))
    await vi.waitFor(() => expect(runtime.processing.value).toBe(false))
    expect(onAdoptedTurnDone).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('creates the runtime for a session that had none yet', async () => {
    const { runtimes } = await connected()
    pushKernelEvent(
      event({ type: 'agent-turn-state', turnId: OTHER_TURN, state: 'queued', origin: ORIGIN }, 6),
    )
    await vi.waitFor(() => expect(runtimes.runtimeOf(SESSION_ID)?.processing.value).toBe(true))
  })

  it('does not follow its own turn a second time', async () => {
    const { runtimes } = await connected()
    const runtime = runtimes.runtimeFor(SESSION_ID)
    runtime.chat.sendMessage({ text: 'mine' })
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled())
    const [turnId, , config] = startTurn.mock.calls.at(-1)!
    const userMessageId = (config as { userMessageId: string }).userMessageId
    expect(runtime.chat.messages.find((message) => message.role === 'user')?.id).toBe(userMessageId)

    pushKernelEvent({
      ...event(
        {
          type: 'agent-turn-state',
          turnId,
          state: 'queued',
          origin: { prompt: 'mine', userMessageId },
        },
        6,
      ),
      scope: { kind: 'run', runId: turnId },
    } as KernelEvent)
    pushKernelEvent({
      ...event(
        { type: 'agent-chunk', turnId, chunk: { type: 'start', messageId: `${turnId}-reply` } },
        7,
      ),
      scope: { kind: 'run', runId: turnId },
    } as KernelEvent)
    await vi.waitFor(() =>
      expect(runtime.chat.messages.map((message) => message.role)).toEqual(['user', 'assistant']),
    )
    expect(runtime.chat.messages.at(-1)?.id).toBe(`${turnId}-reply`)
  })

  it('ignores a turn event without an origin (a turn main started itself)', async () => {
    const { runtimes } = await connected()
    pushKernelEvent(event({ type: 'agent-turn-state', turnId: OTHER_TURN, state: 'queued' }, 6))
    await Promise.resolve()
    expect(runtimes.runtimeOf(SESSION_ID)).toBeUndefined()
  })
})
