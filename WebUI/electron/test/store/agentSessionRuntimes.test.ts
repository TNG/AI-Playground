import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentTurnSnapshot, KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// One turn runtime per Agent Session: kernel events land only in the session they
// carry, Agent Mode renders the Open Session's runtime, and the work done when a
// turn ends (saving the transcript, settling its cards) is for the turn's own
// session. For the Agent preset, switching sessions leaves turns running; the
// games presets still stop the open session's turn when it is left.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'pick',
} as ChatPreset

const activePreset = ref<ChatPreset>(AGENT)

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    presets: [AGENT],
    get activePresetWithVariant() {
      return activePreset.value
    },
  }),
}))

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset: vi.fn(async () => ({ success: true })) }),
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    backend: 'llamaCPP',
    ensureReadyForInference: vi.fn(),
    bindSessionSettings: vi.fn(),
    loadSettingsForActivePreset: vi.fn(),
    settingsAvailability: {
      models: [],
      embeddingModels: [],
      services: [],
      cloudEnabled: false,
      cloudProviderIds: [],
      embeddingBackend: 'llamaCPP',
    },
  }),
}))

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({ checkModelAlreadyLoaded: vi.fn().mockResolvedValue([]) }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: vi.fn() }) }))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US', state: {} }),
}))

vi.mock('@/assets/js/tools/agentBridge', () => ({ getAgentToolSpecs: () => [] }))

vi.mock('@/assets/js/store/agentModeTurn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/assets/js/store/agentModeTurn')>()
  return {
    ...actual,
    buildTurnConfig: async (input: { sessionId: string }) => ({ sessionId: input.sessionId }),
  }
})

const userMessage = (id: string, text: string) => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})

const record = (id: string, text: string) => ({
  id,
  workspaceDir: `/work/${id}`,
  title: text,
  messages: [userMessage(`${id}-u1`, text)],
  createdAt: 1,
  updatedAt: 2,
  presetName: 'Agent',
  settings: {},
})

const RUNNING_B: AgentTurnSnapshot = {
  sessionId: 'session-b',
  turnId: 'turn-b',
  state: 'running',
  chunks: [
    { type: 'start', messageId: 'b-a1' },
    { type: 'text-start', id: 'part-1' },
    { type: 'text-delta', id: 'part-1', delta: 'from B ' },
  ],
  toolProgress: {},
  toolImages: {},
}

let pushKernelEvent: (event: KernelEvent) => void = () => {}
let resolveSnapshot: (snapshot: KernelSnapshot) => void = () => {}
let seq = 10

function pushEvent(payload: Record<string, unknown>): void {
  pushKernelEvent({ ...payload, scope: { kind: 'global' }, seq: ++seq } as KernelEvent)
}

function snapshotWith(turns: AgentTurnSnapshot[]): KernelSnapshot {
  return {
    scope: { kind: 'global' },
    sequence: 5,
    state: {
      services: [],
      agentTurns: turns,
      activeArtifactRun: null,
      chatTurns: [],
      activities: [],
      inferenceProfile: null,
    },
  }
}

const startTurn = vi.fn(async (_turnId: string, _prompt: string, _config: unknown) => ({
  success: true,
}))
const cancel = vi.fn(async (_sessionId: string, _turnId?: string) => {})
const saveSession = vi.fn(async (_record: { id: string; messages: unknown[] }) => ({
  success: true,
}))

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  seq = 10
  const storage = new Map<string, string>()
  const storageShim = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }
  globalThis.localStorage = storageShim as unknown as Storage
  globalThis.sessionStorage = storageShim as unknown as Storage
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
      agentMode: {
        startTurn,
        cancel,
        saveSession,
        onExecuteTool: vi.fn(() => () => {}),
        submitToolResult: vi.fn(),
        deleteSession: vi.fn(async () => ({ success: true })),
        bootstrapSessions: vi.fn(async () => ({
          status: 'ok',
          activeSessionId: 'session-a',
          sessions: [record('session-a', 'task A'), record('session-b', 'task B')],
        })),
        migrateSessions: vi.fn(),
        saveActiveSessionId: vi.fn(async () => ({ success: true })),
        readWorkspaceState: vi.fn(async () => ({ success: true, section: null })),
        migrateWorkspaceState: vi.fn(async () => ({ success: true })),
        writeWorkspaceState: vi.fn(async () => ({ success: true })),
      },
      getLocaleSettings: vi.fn(async () => ({ languageOverride: null })),
      games: { read: vi.fn(async () => null), list: vi.fn(async () => []) },
    },
  } as unknown as Window & typeof globalThis
})

afterEach(async () => {
  const { unregisterAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
  unregisterAgentModeIpc()
})

const { useAgentMode } = await import('@/assets/js/store/agentMode')
const { useConfirmations } = await import('@/assets/js/store/confirmations')

/** Session A open, session B's turn adopted from the kernel snapshot (as after a reload). */
async function storeWithBackgroundTurn() {
  const store = useAgentMode()
  await store.init()
  resolveSnapshot(snapshotWith([RUNNING_B]))
  await vi.waitFor(() => expect(store.anyTurnOpen).toBe(true))
  return store
}

const savedRecord = (id: string) =>
  saveSession.mock.calls.map(([saved]) => saved).findLast((saved) => saved.id === id)

describe('one turn runtime per Agent Session', () => {
  it('keeps another session’s turn out of the Open Session', async () => {
    const store = await storeWithBackgroundTurn()

    pushEvent({
      type: 'agent-chunk',
      sessionId: 'session-b',
      turnId: 'turn-b',
      chunk: { type: 'text-delta', id: 'part-1', delta: 'still B' },
    })
    pushEvent({
      type: 'agent-tool-progress',
      sessionId: 'session-b',
      turnId: 'turn-b',
      toolCallId: 'call-1',
      toolName: 'bash',
      text: 'running',
    })
    pushEvent({
      type: 'agent-tool-image',
      sessionId: 'session-b',
      turnId: 'turn-b',
      toolCallId: 'call-1',
      dataUri: 'data:image/png;base64,',
      label: 'shot.png',
    })

    expect(store.openSessionId).toBe('session-a')
    expect(store.processing).toBe(false)
    expect(JSON.stringify(store.messages)).toContain('task A')
    expect(JSON.stringify(store.messages)).not.toContain('B')
    expect(store.toolProgress).toEqual({})
    expect(store.toolImages).toEqual({})
  })

  it('shows a running session’s live transcript and busy state when it is opened', async () => {
    const store = await storeWithBackgroundTurn()

    await store.switchSession('session-b')

    expect(store.processing).toBe(true)
    await vi.waitFor(() => expect(JSON.stringify(store.messages)).toContain('from B'))
    // Its earlier transcript comes from the record, ahead of the streamed reply.
    expect(JSON.stringify(store.messages)).toContain('task B')
    // Leaving session A (idle) cancelled nothing of B's.
    expect(cancel).not.toHaveBeenCalledWith('session-b', 'turn-b')
  })

  it('saves the ending turn’s own session and settles only its cards', async () => {
    const store = await storeWithBackgroundTurn()
    const confirmations = useConfirmations()
    const cardB = confirmations.request({
      conversationKey: 'session-b',
      title: 'B asks',
      summaryMarkdown: '',
      origin: 'desktop',
    })
    void confirmations.request({
      conversationKey: 'session-a',
      title: 'A asks',
      summaryMarkdown: '',
      origin: 'desktop',
    })
    saveSession.mockClear()

    pushEvent({
      type: 'agent-chunk',
      sessionId: 'session-b',
      turnId: 'turn-b',
      chunk: { type: 'text-end', id: 'part-1' },
    })
    pushEvent({ type: 'agent-turn-done', sessionId: 'session-b', turnId: 'turn-b' })

    await vi.waitFor(() => expect(store.anyTurnOpen).toBe(false))
    await expect(cardB).resolves.toBe(false)
    expect(confirmations.items.map((item) => item.conversationKey)).toEqual(['session-a'])
    const saved = savedRecord('session-b')
    expect(JSON.stringify(saved?.messages)).toContain('task B')
    expect(JSON.stringify(saved?.messages)).toContain('from B')
    expect(savedRecord('session-a')).toBeUndefined()
  })

  it('resumes a queued turn from the snapshot as queued, then running when it takes its place', async () => {
    const store = useAgentMode()
    await store.init()
    resolveSnapshot(snapshotWith([{ ...RUNNING_B, state: 'queued', chunks: [] }]))
    await vi.waitFor(() => expect(store.anyTurnOpen).toBe(true))

    await store.switchSession('session-b')
    expect(store.processing).toBe(true)
    expect(store.turnState).toBe('queued')
    pushEvent({
      type: 'agent-turn-state',
      sessionId: 'session-b',
      turnId: 'turn-b',
      state: 'running',
    })
    expect(store.turnState).toBe('running')
  })

  it('puts the earlier transcript back when the snapshot beats the records', async () => {
    const store = useAgentMode()
    resolveSnapshot(snapshotWith([RUNNING_B]))
    await vi.waitFor(() => expect(store.anyTurnOpen).toBe(true))
    await store.init()

    await store.switchSession('session-b')
    await vi.waitFor(() => expect(JSON.stringify(store.messages)).toContain('from B'))
    expect(JSON.stringify(store.messages)).toContain('task B')
  })

  it('keeps the running turn when another session is opened, "+" is clicked or a new one is started', async () => {
    const store = useAgentMode()
    await store.init()
    resolveSnapshot(snapshotWith([]))
    await store.newSession()
    store.workspaceDir = '/work/new'
    const sent = store.generate('build it')
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled())
    const draftId = (startTurn.mock.calls[0][2] as { sessionId: string }).sessionId
    // The sent message is on the record before the turn has run.
    expect(JSON.stringify(savedRecord(draftId)?.messages)).toContain('build it')

    await store.switchSession('session-a')
    await store.newSession()
    await store.startNew()
    await store.switchSession(draftId)

    expect(cancel).not.toHaveBeenCalled()
    expect(store.processing).toBe(true)
    expect(store.anyTurnOpen).toBe(true)
    await store.stop()
    await sent
  })

  it('sends to a second session while the first one runs; each shows its own turn state', async () => {
    const store = useAgentMode()
    await store.init()
    resolveSnapshot(snapshotWith([]))
    store.workspaceDir = '/work/session-a'
    const sentA = store.generate('first')
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1))
    const turnA = startTurn.mock.calls[0][0]
    pushEvent({ type: 'agent-turn-state', sessionId: 'session-a', turnId: turnA, state: 'running' })

    await store.switchSession('session-b')
    expect(store.processing).toBe(false)
    const sentB = store.generate('second')
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2))
    const turnB = startTurn.mock.calls[1][0]
    expect((startTurn.mock.calls[1][2] as { sessionId: string }).sessionId).toBe('session-b')
    pushEvent({ type: 'agent-turn-state', sessionId: 'session-b', turnId: turnB, state: 'queued' })
    expect(store.turnState).toBe('queued')

    await store.switchSession('session-a')
    expect(store.turnState).toBe('running')
    expect(store.processing).toBe(true)

    // Stop on the queued session reaches only that session's turn.
    await store.switchSession('session-b')
    await store.stop()
    expect(cancel).toHaveBeenCalledWith('session-b', turnB)
    expect(cancel).not.toHaveBeenCalledWith('session-a', expect.anything())
    await sentB
    expect(store.processing).toBe(false)

    pushEvent({ type: 'agent-turn-done', sessionId: 'session-a', turnId: turnA })
    await sentA
    expect(store.anyTurnOpen).toBe(false)
  })

  it('stops the turn of a session that is deleted', async () => {
    const store = useAgentMode()
    await store.init()
    resolveSnapshot(snapshotWith([]))
    store.workspaceDir = '/work/session-a'
    const sent = store.generate('doomed')
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled())
    const turnId = startTurn.mock.calls[0][0]
    await store.switchSession('session-b')

    await store.deleteSession('session-a')
    expect(cancel).toHaveBeenCalledWith('session-a', turnId)
    await sent
    expect(store.anyTurnOpen).toBe(false)
  })
})

describe('games presets keep stop-on-switch', () => {
  const GAME: ChatPreset = {
    type: 'chat',
    category: 'chat',
    name: 'Game Agent',
    backends: ['llamaCPP'],
    agentPreset: true,
    agentWorkspace: 'games',
  } as ChatPreset

  afterEach(() => {
    activePreset.value = AGENT
  })

  it('stops the running turn when another game session is opened', async () => {
    activePreset.value = GAME
    const gameRecord = (id: string) => ({
      ...record(id, `game ${id}`),
      presetName: 'Game Agent',
      settings: undefined,
    })
    window.electronAPI.agentMode.bootstrapSessions = vi.fn(async () => ({
      status: 'ok' as const,
      activeSessionId: 'game-1',
      sessions: [gameRecord('game-1'), gameRecord('game-2')],
    })) as never
    window.electronAPI.games.read = vi.fn(async (dir: string) =>
      dir ? ({ dir, name: dir } as never) : null,
    ) as never
    const store = useAgentMode()
    await store.init()
    resolveSnapshot(snapshotWith([]))
    await store.switchSession('game-1')
    store.workspaceDir = '/work/game-1'
    const sent = store.generate('make it faster')
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled())
    const turnId = startTurn.mock.calls[0][0]

    await store.switchSession('game-2')
    await sent

    expect(cancel).toHaveBeenCalledWith('game-1', turnId)
    expect(store.anyTurnOpen).toBe(false)
    // A turn the user stopped by leaving it is not a new result.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.unseenTurns).toEqual({})
  })
})

describe('history status of Agent Sessions', () => {
  it('shows a running session, then marks its result unseen until it is opened', async () => {
    const store = await storeWithBackgroundTurn()
    expect(store.sessionTurns).toEqual({ 'session-b': { state: 'running', queuePosition: null } })

    pushEvent({ type: 'agent-turn-done', sessionId: 'session-b', turnId: 'turn-b' })
    await vi.waitFor(() => expect(store.unseenTurns).toEqual({ 'session-b': 'done' }))
    expect(store.sessionTurns).toEqual({})

    await store.switchSession('session-b')
    expect(store.unseenTurns).toEqual({})
  })

  it('marks a turn that failed out of sight as failed', async () => {
    const store = await storeWithBackgroundTurn()
    pushEvent({
      type: 'agent-chunk',
      sessionId: 'session-b',
      turnId: 'turn-b',
      chunk: { type: 'error', errorText: 'model refused' },
    })
    pushEvent({ type: 'agent-turn-done', sessionId: 'session-b', turnId: 'turn-b' })
    await vi.waitFor(() => expect(store.unseenTurns).toEqual({ 'session-b': 'failed' }))
  })

  it('does not mark a turn that ended in the Open Session', async () => {
    const store = await storeWithBackgroundTurn()
    await store.switchSession('session-b')
    pushEvent({ type: 'agent-turn-done', sessionId: 'session-b', turnId: 'turn-b' })
    await vi.waitFor(() => expect(store.anyTurnOpen).toBe(false))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.unseenTurns).toEqual({})
  })

  it('follows a queued turn’s position as the turns ahead of it leave', async () => {
    const store = useAgentMode()
    await store.init()
    resolveSnapshot(snapshotWith([]))
    store.workspaceDir = '/work/session-a'
    const sent = store.generate('wait your turn')
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled())
    const turnId = startTurn.mock.calls[0][0]
    const queueEvent = (action: string, position?: number) =>
      pushEvent({
        type: 'queue-event',
        kind: 'text',
        action,
        runKey: turnId,
        conversationKey: 'session-a',
        queueDepth: 0,
        position,
      })

    queueEvent('enqueued', 2)
    expect(store.sessionTurns['session-a']).toEqual({ state: 'queued', queuePosition: 2 })
    queueEvent('moved', 1)
    expect(store.sessionTurns['session-a']).toEqual({ state: 'queued', queuePosition: 1 })
    queueEvent('started')
    pushEvent({ type: 'agent-turn-state', sessionId: 'session-a', turnId, state: 'running' })
    expect(store.sessionTurns['session-a']).toEqual({ state: 'running', queuePosition: null })

    await store.stop()
    await sent
  })

  it('takes a queued turn’s position from the snapshot after a reload', async () => {
    const store = useAgentMode()
    await store.init()
    resolveSnapshot(snapshotWith([{ ...RUNNING_B, state: 'queued', queuePosition: 3, chunks: [] }]))
    await vi.waitFor(() =>
      expect(store.sessionTurns['session-b']).toEqual({ state: 'queued', queuePosition: 3 }),
    )
  })
})
