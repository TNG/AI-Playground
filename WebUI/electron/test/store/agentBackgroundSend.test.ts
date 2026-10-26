import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// The background send path: a session can be created and sent a turn without being
// the Open Session, and such a turn runs on the session's stored Session Settings
// rather than on the live panel controls. A settled-turn hook reports how each
// session's turn ended.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'pick',
  systemPrompt: 'You are the agent.',
} as ChatPreset

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({ presets: [AGENT], activePresetWithVariant: AGENT }),
}))

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset: vi.fn(async () => ({ success: true })) }),
}))

/** The live panel controls, and the stored-settings resolution the store asks for. */
const inference = vi.hoisted(() => {
  const base = {
    samplingRequestBody: {},
    temperature: 0.7,
    modelSupportsThinkingToggle: false,
    thinkingEnabled: false,
    thinkingActive: false,
    localBackendUrl: 'http://127.0.0.1:39100',
    modelSupportsVision: false,
    effectiveContextWindow: 8192,
    getCurrentDeviceId: () => '0',
    getCurrentDeviceName: () => 'Arc B580',
    activeLlmModel: null,
    embeddingBackend: 'llamaCPP' as const,
  }
  const live = { ...base, backend: 'llamaCPP', activeModel: 'Live-9B', contextSize: 8192 }
  return {
    base,
    live,
    catalog: [] as { name: string; type: string }[],
  }
})

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    ...inference.live,
    get activeModel() {
      return inference.live.activeModel
    },
    settingsPerPreset: {},
    ensureReadyForInference: vi.fn(),
    bindSessionSettings: vi.fn(),
    loadSettingsForActivePreset: vi.fn(),
    get settingsAvailability() {
      return {
        models: inference.catalog,
        embeddingModels: [],
        services: [],
        cloudEnabled: false,
        cloudProviderIds: [],
        embeddingBackend: 'llamaCPP',
      }
    },
    inferenceForSettings: (_presetName: string, settings: AgentSessionSettings) => ({
      inference: {
        ...inference.base,
        backend: settings.backend ?? 'llamaCPP',
        activeModel: settings.model,
        contextSize: settings.contextSize,
      },
      cloud: {
        selectedProviderId: 'custom',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
      tools: { toolDelegationEnabled: true, builtinToolEnablement: {} },
    }),
  }),
  backendToAipgBackendName: { llamaCPP: 'llama_cpp', openVINO: 'openvino' },
}))

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({ checkModelAlreadyLoaded: vi.fn().mockResolvedValue([]) }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

vi.mock('@/assets/js/store/developerSettings', () => ({
  useDeveloperSettings: () => ({ keepModelsLoaded: false }),
}))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: vi.fn() }) }))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US', state: {} }),
}))

vi.mock('@/assets/js/toast', () => ({ show: vi.fn() }))

vi.mock('@/assets/js/tools/agentBridge', () => ({ getAgentToolSpecs: () => [] }))

const STORED: AgentSessionSettings = {
  backend: 'llamaCPP',
  model: 'Stored-27B',
  contextSize: 32768,
  planningThinkingOnly: false,
  capabilities: ['files', 'web'],
}

const openRecord = {
  id: 'session-open',
  workspaceDir: '/work/open',
  title: 'what I am doing',
  messages: [{ id: 'open-u1', role: 'user', parts: [{ type: 'text', text: 'what I am doing' }] }],
  createdAt: 1,
  updatedAt: 2,
  presetName: 'Agent',
  settings: { backend: 'llamaCPP', model: 'Live-9B' },
}

let pushKernelEvent: (event: KernelEvent) => void = () => {}
let seq = 10

function pushEvent(payload: Record<string, unknown>): void {
  pushKernelEvent({ ...payload, scope: { kind: 'global' }, seq: ++seq } as KernelEvent)
}

const startTurn = vi.fn(async (_turnId: string, _prompt: string, _config: AgentModeTurnConfig) => ({
  success: true as boolean,
  error: undefined as string | undefined,
}))
const cancel = vi.fn(async (_sessionId: string, _turnId?: string) => {})
const saveSession = vi.fn(async (_record: Record<string, unknown>) => ({ success: true }))
const existsPath = vi.fn(async (dir: string) => dir !== '/missing')

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  seq = 10
  inference.live.activeModel = 'Live-9B'
  inference.catalog = []
  startTurn.mockImplementation(async () => ({ success: true, error: undefined }))
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
      getKernelSnapshot: vi.fn(async (): Promise<KernelSnapshot> => ({
        scope: { kind: 'global' },
        sequence: 5,
        state: {
          services: [],
          agentTurns: [],
          activeArtifactRun: null,
          chatTurns: [],
          activities: [],
          inferenceProfile: null,
        },
      })),
      existsPath,
      agentMode: {
        startTurn,
        cancel,
        saveSession,
        onExecuteTool: vi.fn(() => () => {}),
        submitToolResult: vi.fn(),
        deleteSession: vi.fn(async () => ({ success: true })),
        bootstrapSessions: vi.fn(async () => ({
          status: 'ok',
          activeSessionId: 'session-open',
          sessions: [openRecord],
        })),
        migrateSessions: vi.fn(),
        saveActiveSessionId: vi.fn(async () => ({ success: true })),
        readWorkspaceState: vi.fn(async () => ({
          success: true,
          section: { workspaceDir: '/work/open', lastWorkspaceByKind: { pick: '/work/open' } },
        })),
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

async function readyStore() {
  const store = useAgentMode()
  await store.init()
  return store
}

function createTaskSession(
  store: Awaited<ReturnType<typeof readyStore>>,
  workspaceDir = '/work/task',
) {
  return store.createSession({
    workspaceDir,
    settings: { ...STORED },
    presetName: 'Agent',
    title: 'Nightly cleanup',
  })
}

const sentConfig = (call: number) => startTurn.mock.calls[call][2]

async function turnIdOf(call: number): Promise<string> {
  await vi.waitFor(() => expect(startTurn.mock.calls.length).toBeGreaterThan(call))
  return startTurn.mock.calls[call][0]
}

async function finishTurn(sessionId: string, call: number, reply = 'done'): Promise<void> {
  const turnId = await turnIdOf(call)
  for (const chunk of [
    { type: 'start' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: reply },
    { type: 'text-end', id: 't' },
    { type: 'finish' },
  ]) {
    pushEvent({ type: 'agent-chunk', sessionId, turnId, chunk })
  }
  pushEvent({ type: 'agent-turn-done', sessionId, turnId })
}

function recordOutcomes(store: Awaited<ReturnType<typeof readyStore>>) {
  const outcomes: Array<{ sessionId: string; outcome: unknown }> = []
  store.onTurnSettled((sessionId, outcome) => outcomes.push({ sessionId, outcome }))
  return outcomes
}

const lastSaved = (id: string) =>
  saveSession.mock.calls.map(([saved]) => saved).findLast((saved) => saved.id === id)

describe('creating a session in the background', () => {
  it('stores it in the history without opening it', async () => {
    const store = await readyStore()

    const id = createTaskSession(store)

    expect(store.openSessionId).toBe('session-open')
    expect(JSON.stringify(store.messages)).toContain('what I am doing')
    expect(store.sessions[id]).toMatchObject({
      workspaceDir: '/work/task',
      title: 'Nightly cleanup',
      presetName: 'Agent',
      settings: STORED,
      messages: [],
    })
    expect(lastSaved(id)).toMatchObject({ workspaceDir: '/work/task', title: 'Nightly cleanup' })
  })
})

describe('sending to a session that is not open', () => {
  it('runs on the session’s stored settings, not the live controls', async () => {
    const store = await readyStore()
    const outcomes = recordOutcomes(store)
    const id = createTaskSession(store)
    inference.live.activeModel = 'Changed-4B'

    const result = await store.sendToSession(id, 'tidy the folder')

    expect(result).toEqual({ ok: true })
    await turnIdOf(0)
    expect(startTurn.mock.calls[0][1]).toBe('tidy the folder')
    expect(sentConfig(0)).toMatchObject({
      sessionId: id,
      workspaceDir: '/work/task',
      presetName: 'Agent',
      capabilities: ['files', 'web'],
      modelConfig: { model: 'Stored-27B' },
      readiness: { llmModelName: 'Stored-27B', contextSize: 32768 },
    })
    expect(sentConfig(0).instructions).toContain('You are the agent.')
    expect(store.openSessionId).toBe('session-open')
    expect(store.processing).toBe(false)

    await finishTurn(id, 0)
    await vi.waitFor(() =>
      expect(outcomes).toEqual([{ sessionId: id, outcome: { kind: 'completed' } }]),
    )
    expect(lastSaved(id)).toMatchObject({ title: 'Nightly cleanup', settings: STORED })
    expect(JSON.stringify(lastSaved(id)?.messages)).toContain('tidy the folder')
  })

  it('sends the next prompt on the same settings after the first turn settled', async () => {
    const store = await readyStore()
    const outcomes = recordOutcomes(store)
    const id = createTaskSession(store)
    await store.sendToSession(id, 'step one')
    await finishTurn(id, 0)
    await vi.waitFor(() => expect(outcomes).toHaveLength(1))
    inference.live.activeModel = 'Changed-4B'

    await store.sendToSession(id, 'step two')
    await turnIdOf(1)

    expect(sentConfig(1).modelConfig).toMatchObject({ model: 'Stored-27B' })
    await finishTurn(id, 1)
    await vi.waitFor(() => expect(outcomes).toHaveLength(2))
    const sent = JSON.stringify(lastSaved(id)?.messages)
    expect(sent).toContain('step one')
    expect(sent).toContain('step two')
  })

  it('refuses a session that already has a turn in flight', async () => {
    const store = await readyStore()
    const id = createTaskSession(store)
    await store.sendToSession(id, 'first')
    await turnIdOf(0)

    const result = await store.sendToSession(id, 'second')

    expect(result).toMatchObject({ ok: false, reason: 'busy' })
    expect(startTurn).toHaveBeenCalledTimes(1)
  })
})

describe('sending to the Open Session', () => {
  it('uses the record when flagged to use its stored settings', async () => {
    const store = await readyStore()
    const id = createTaskSession(store)
    await store.switchSession(id)
    inference.live.activeModel = 'Changed-4B'

    await store.sendToSession(id, 'frozen', { useStoredSettings: true })
    await turnIdOf(0)

    expect(sentConfig(0).modelConfig).toMatchObject({ model: 'Stored-27B' })
  })

  it('uses the live controls otherwise', async () => {
    const store = await readyStore()
    inference.live.activeModel = 'Changed-4B'

    await store.sendToSession('session-open', 'live')
    await turnIdOf(0)

    expect(sentConfig(0).modelConfig).toMatchObject({ model: 'Changed-4B' })
    expect(sentConfig(0).workspaceDir).toBe('/work/open')
  })
})

describe('checks before a background turn starts', () => {
  it('reports unusable stored settings without starting a turn', async () => {
    inference.catalog = [{ name: 'Other-9B', type: 'llamaCPP' }]
    const store = await readyStore()
    const id = createTaskSession(store)

    const result = await store.sendToSession(id, 'go')

    expect(result).toMatchObject({
      ok: false,
      reason: 'settings-problems',
      problems: [{ field: 'model', value: 'Stored-27B' }],
    })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('reports a missing folder without starting a turn', async () => {
    const store = await readyStore()
    const id = createTaskSession(store, '/missing')

    const result = await store.sendToSession(id, 'go')

    expect(result).toMatchObject({ ok: false, reason: 'missing-folder' })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('reports an unknown session', async () => {
    const store = await readyStore()
    expect(await store.sendToSession('nope', 'go')).toMatchObject({
      ok: false,
      reason: 'no-session',
    })
  })
})

describe('how a turn settled', () => {
  it('reports an error with its message', async () => {
    const store = await readyStore()
    const outcomes = recordOutcomes(store)
    const id = createTaskSession(store)
    await store.sendToSession(id, 'go')
    const turnId = await turnIdOf(0)

    pushEvent({ type: 'agent-chunk', sessionId: id, turnId, chunk: { type: 'start' } })
    pushEvent({
      type: 'agent-chunk',
      sessionId: id,
      turnId,
      chunk: { type: 'error', errorText: 'model refused' },
    })
    pushEvent({ type: 'agent-turn-done', sessionId: id, turnId })

    await vi.waitFor(() =>
      expect(outcomes).toEqual([
        { sessionId: id, outcome: { kind: 'error', message: 'model refused' } },
      ]),
    )
  })

  it('reports a turn the user stopped', async () => {
    const store = await readyStore()
    const outcomes = recordOutcomes(store)
    const id = createTaskSession(store)
    await store.sendToSession(id, 'go')
    const turnId = await turnIdOf(0)

    await store.stopSession(id)

    expect(cancel).toHaveBeenCalledWith(id, turnId)
    await vi.waitFor(() =>
      expect(outcomes).toEqual([{ sessionId: id, outcome: { kind: 'stopped' } }]),
    )
  })

  it('ends reasoning the user stopped, though main closes it after the stream is gone', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000)
    const store = await readyStore()
    const id = createTaskSession(store)
    await store.switchSession(id)
    await store.sendToSession(id, 'go')
    const turnId = await turnIdOf(0)
    for (const chunk of [
      { type: 'start' },
      { type: 'reasoning-start', id: 'r', providerMetadata: { aipg: { reasoningStarted: 1_000 } } },
      { type: 'reasoning-delta', id: 'r', delta: 'thinking' },
    ]) {
      pushEvent({ type: 'agent-chunk', sessionId: id, turnId, chunk })
    }
    const reasoningOf = (messages: unknown) =>
      (messages as Array<{ parts: Array<{ type: string }> }> | undefined)
        ?.at(-1)
        ?.parts.find((part) => part.type === 'reasoning')
    await vi.waitFor(() =>
      expect(reasoningOf(store.messages)).toMatchObject({ state: 'streaming' }),
    )

    await store.stopSession(id)
    const closing = { reasoningStarted: 1_000, reasoningFinished: 9_000 }
    const late = { type: 'reasoning-end', id: 'r', providerMetadata: { aipg: closing } }
    pushEvent({ type: 'agent-chunk', sessionId: id, turnId, chunk: late })

    const settled = {
      state: 'done',
      providerMetadata: { aipg: { reasoningStarted: 1_000, reasoningFinished: 5_000 } },
    }
    expect(reasoningOf(store.messages)).toMatchObject(settled)
    expect(reasoningOf(lastSaved(id)?.messages)).toMatchObject(settled)
  })

  it('reports a start main refused as an error instead of waiting forever', async () => {
    startTurn.mockImplementation(async () => ({
      success: false,
      error: 'This session already has a turn in flight.',
    }))
    const store = await readyStore()
    const outcomes = recordOutcomes(store)
    const id = createTaskSession(store)

    await store.sendToSession(id, 'go')

    await vi.waitFor(() =>
      expect(outcomes).toEqual([
        {
          sessionId: id,
          outcome: { kind: 'error', message: 'This session already has a turn in flight.' },
        },
      ]),
    )
    expect(store.sessionTurns).toEqual({})
  })

  it('stops reporting to a listener that unsubscribed', async () => {
    const store = await readyStore()
    const seen: string[] = []
    const unsubscribe = store.onTurnSettled((sessionId) => seen.push(sessionId))
    unsubscribe()
    const id = createTaskSession(store)
    await store.sendToSession(id, 'go')
    await finishTurn(id, 0)
    await vi.waitFor(() => expect(store.anyTurnOpen).toBe(false))
    expect(seen).toEqual([])
  })
})

describe('what decides a Held Answer', () => {
  function recordHeldEnds(store: Awaited<ReturnType<typeof readyStore>>) {
    const ends: Array<{ sessionId: string; end: string }> = []
    store.onHeldAnswerSettled((sessionId, end) => ends.push({ sessionId, end }))
    return ends
  }

  it('is the turn completing', async () => {
    const store = await readyStore()
    const ends = recordHeldEnds(store)
    const id = createTaskSession(store)
    await store.sendToSession(id, 'go')
    await finishTurn(id, 0)
    await vi.waitFor(() => expect(ends).toEqual([{ sessionId: id, end: 'completed' }]))
  })

  it('is a stop on the desktop', async () => {
    const store = await readyStore()
    const ends = recordHeldEnds(store)
    const id = createTaskSession(store)
    await store.sendToSession(id, 'go')
    await turnIdOf(0)
    await store.stopSession(id)
    await vi.waitFor(() => expect(ends).toEqual([{ sessionId: id, end: 'stopped' }]))
  })

  it('is the session being deleted, even though deleting stops its turn first', async () => {
    const store = await readyStore()
    const ends = recordHeldEnds(store)
    const id = createTaskSession(store)
    await store.sendToSession(id, 'go')
    await turnIdOf(0)
    await store.deleteSession(id)
    await vi.waitFor(() => expect(ends).toEqual([{ sessionId: id, end: 'deleted' }]))
  })

  it('is a discard on the desktop, which clears the Held Answer shown', async () => {
    const store = await readyStore()
    const ends = recordHeldEnds(store)
    const id = createTaskSession(store)
    store.setHeldAnswer(id, { text: 'make it faster', channel: 'telegram' })
    expect(store.heldAnswers[id]).toEqual({ text: 'make it faster', channel: 'telegram' })
    store.discardHeldAnswer(id)
    expect(ends).toEqual([{ sessionId: id, end: 'discarded' }])
    expect(store.heldAnswers[id]).toBeUndefined()
  })
})
