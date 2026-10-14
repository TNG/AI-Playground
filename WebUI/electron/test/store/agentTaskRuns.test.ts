import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { AgentTask } from '@/types/agentTaskIpc'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// Running a Task: the Tasks store creates a Task Session in the background and
// sends its Steps one after another, each once the previous Step's turn settled.
// Driven through the Tasks store against the real Agent store, with a fake
// electronAPI and kernel events delivered through the registered listener.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'pick',
  systemPrompt: 'You are the agent.',
} as ChatPreset

const GAME_AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Game Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'games',
  systemPrompt: 'You make games.',
} as ChatPreset

const IMAGE_GEN = { type: 'comfy', category: 'create-images', name: 'Flux' }

const activePreset = vi.hoisted(() => ({ state: null as { preset: unknown } | null }))

vi.mock('@/assets/js/store/presets', async () => {
  const { reactive } = await import('vue')
  activePreset.state = reactive({ preset: AGENT as unknown })
  const state = activePreset.state
  return {
    usePresets: () => ({
      presets: [AGENT, GAME_AGENT],
      get activePresetWithVariant() {
        return state.preset
      },
    }),
  }
})

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset: vi.fn(async () => ({ success: true })) }),
}))

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
  return {
    base,
    live: { ...base, backend: 'llamaCPP', activeModel: 'Live-9B' },
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

const errorsReport = vi.hoisted(() => vi.fn())
vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: errorsReport }) }))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US', state: {} }),
}))

vi.mock('@/assets/js/toast', () => ({ show: vi.fn() }))

vi.mock('@/assets/js/tools/agentBridge', () => ({ getAgentToolSpecs: () => [] }))

const TEMPLATE: AgentSessionSettings = {
  backend: 'llamaCPP',
  model: 'Template-27B',
  contextSize: 32768,
  planningThinkingOnly: false,
  capabilities: ['files', 'web'],
}

const task = (id: string, prompts: string[], overrides: Partial<AgentTask> = {}): AgentTask => ({
  id,
  name: `Task ${id}`,
  workspaceDir: '/work/task',
  settingsTemplate: TEMPLATE,
  steps: prompts.map((prompt, index) => ({ id: `${id}-s${index}`, prompt })),
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

const openRecord = {
  id: 'session-open',
  workspaceDir: '/work/open',
  title: 'what I am doing',
  messages: [{ id: 'open-u1', role: 'user', parts: [{ type: 'text', text: 'what I am doing' }] }],
  createdAt: 1,
  updatedAt: 2,
  presetName: 'Agent',
  settings: { backend: 'llamaCPP', model: 'Live-9B', capabilities: ['files'] },
}

let storedTasks: AgentTask[]
let pushKernelEvent: (event: KernelEvent) => void = () => {}
let seq = 10

function pushEvent(payload: Record<string, unknown>): void {
  pushKernelEvent({ ...payload, scope: { kind: 'global' }, seq: ++seq } as KernelEvent)
}

const startTurn = vi.fn(async (_turnId: string, _prompt: string, _config: AgentModeTurnConfig) => ({
  success: true as boolean,
  error: undefined as string | undefined,
}))
const saveSession = vi.fn(async (_record: Record<string, unknown>) => ({ success: true }))
const saveTask = vi.fn(async (_task: AgentTask) => ({ success: true as boolean, error: '' }))
const deleteTask = vi.fn(async (_id: string) => ({ success: true as boolean, error: '' }))

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  seq = 10
  storedTasks = []
  activePreset.state!.preset = AGENT
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
      existsPath: vi.fn(async () => true),
      agentMode: {
        startTurn,
        cancel: vi.fn(async () => {}),
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
        readTasks: vi.fn(async () => ({ success: true, tasks: storedTasks })),
        saveTask,
        deleteTask,
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
const { useAgentTasks } = await import('@/assets/js/store/agentTasks')

async function readyStores(...saved: AgentTask[]) {
  storedTasks = saved
  const agentMode = useAgentMode()
  await agentMode.init()
  const tasks = useAgentTasks()
  await tasks.init()
  return { agentMode, tasks }
}

const sentPrompts = () => startTurn.mock.calls.map(([, prompt]) => prompt)
const sentConfig = (call: number) => startTurn.mock.calls[call][2]

async function turnIdOf(call: number): Promise<string> {
  await vi.waitFor(() => expect(startTurn.mock.calls.length).toBeGreaterThan(call))
  return startTurn.mock.calls[call][0]
}

/** Let the turn the `call`-th `startTurn` started finish normally. */
async function finishTurn(call: number): Promise<void> {
  const turnId = await turnIdOf(call)
  const sessionId = sentConfig(call).sessionId
  for (const chunk of [
    { type: 'start' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'done' },
    { type: 'text-end', id: 't' },
    { type: 'finish' },
  ]) {
    pushEvent({ type: 'agent-chunk', sessionId, turnId, chunk })
  }
  pushEvent({ type: 'agent-turn-done', sessionId, turnId })
}

/** Give the store time to send a further Step, if it (wrongly) would. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 10))
}

const lastSavedTask = (id: string) =>
  saveTask.mock.calls.map(([saved]) => saved).findLast((saved) => saved.id === id)

describe('running a Task', () => {
  it('creates the Task Session in the background, leaving the Open Session alone', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))

    expect(await tasks.runTask('t1')).toEqual({ ok: true })

    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    expect(sessionId).not.toBe('session-open')
    expect(agentMode.sessions[sessionId]).toMatchObject({
      workspaceDir: '/work/task',
      title: 'Task t1',
      presetName: 'Agent',
      taskId: 't1',
      settings: TEMPLATE,
    })
    expect(agentMode.openSessionId).toBe('session-open')
    expect(agentMode.workspaceDir).toBe('/work/open')
    expect(JSON.stringify(agentMode.messages)).toContain('what I am doing')
    expect(JSON.stringify(agentMode.messages)).not.toContain('"one"')
  })

  it('sends each Step only after the previous one settled, then records completed', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two', 'three']))

    await tasks.runTask('t1')
    await turnIdOf(0)
    await settleMicrotasks()
    expect(sentPrompts()).toEqual(['one'])

    await finishTurn(0)
    await turnIdOf(1)
    await settleMicrotasks()
    expect(sentPrompts()).toEqual(['one', 'two'])

    await finishTurn(1)
    await turnIdOf(2)
    await settleMicrotasks()
    expect(sentPrompts()).toEqual(['one', 'two', 'three'])
    const sessionId = sentConfig(0).sessionId
    expect(startTurn.mock.calls.every(([, , config]) => config.sessionId === sessionId)).toBe(true)

    await finishTurn(2)
    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle'))
    const outcome = { kind: 'completed', sessionId, stepCount: 3 }
    expect(tasks.taskState('t1')).toEqual({ idle: expect.objectContaining(outcome) })
    expect(lastSavedTask('t1')?.lastOutcome).toMatchObject(outcome)
    const transcript = JSON.stringify(agentMode.sessions[sessionId].messages)
    expect(transcript).toContain('one')
    expect(transcript).toContain('three')
  })

  it('reports the running Step while the run lasts', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))

    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    expect(tasks.taskState('t1')).toEqual({ running: { stepIndex: 1, stepCount: 2, sessionId } })

    await finishTurn(0)
    await turnIdOf(1)
    expect(tasks.taskState('t1')).toEqual({ running: { stepIndex: 2, stepCount: 2, sessionId } })
  })
})

describe('the settings a run uses', () => {
  it('takes every Step’s turn config from the Settings Template, not the live controls', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    inference.live.activeModel = 'Changed-4B'

    await tasks.runTask('t1')
    await finishTurn(0)
    await turnIdOf(1)

    for (const call of [0, 1]) {
      expect(sentConfig(call)).toMatchObject({
        workspaceDir: '/work/task',
        presetName: 'Agent',
        capabilities: ['files', 'web'],
        modelConfig: { model: 'Template-27B' },
      })
    }
  })

  it('keeps to the template while the Task Session is open and the panel changes', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId

    await agentMode.switchSession(sessionId)
    agentMode.setCapabilityEnabled('web', false)
    inference.live.activeModel = 'Changed-4B'
    await finishTurn(0)
    await turnIdOf(1)

    expect(sentConfig(1)).toMatchObject({
      sessionId,
      capabilities: ['files', 'web'],
      modelConfig: { model: 'Template-27B' },
    })
  })
})

describe('one run per Task', () => {
  it('refuses to run a Task that is already running', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await turnIdOf(0)

    expect(await tasks.runTask('t1')).toEqual({ ok: false, reason: 'running' })
    await settleMicrotasks()
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it('runs different Tasks at the same time, each in its own session', async () => {
    const { tasks } = await readyStores(task('t1', ['a1', 'a2']), task('t2', ['b1']))

    await tasks.runTask('t1')
    await tasks.runTask('t2')
    await turnIdOf(1)

    expect(sentPrompts()).toEqual(['a1', 'b1'])
    expect(sentConfig(0).sessionId).not.toBe(sentConfig(1).sessionId)
    expect(tasks.taskState('t1')).toHaveProperty('running')
    expect(tasks.taskState('t2')).toHaveProperty('running')

    await finishTurn(1)
    await vi.waitFor(() =>
      expect(tasks.taskState('t2')).toEqual({
        idle: expect.objectContaining({ kind: 'completed' }),
      }),
    )
    expect(tasks.taskState('t1')).toHaveProperty('running')
    await settleMicrotasks()
    expect(sentPrompts()).toEqual(['a1', 'b1'])
  })

  it('refuses to delete a running Task', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')

    expect(await tasks.deleteTask('t1')).toBe(false)
    expect(deleteTask).not.toHaveBeenCalled()
    expect(tasks.tasks.map((entry) => entry.id)).toEqual(['t1'])
  })

  it('can run again after the run completed', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await finishTurn(0)
    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle'))

    expect(await tasks.runTask('t1')).toEqual({ ok: true })
    await turnIdOf(1)
    expect(sentConfig(1).sessionId).not.toBe(sentConfig(0).sessionId)
  })
})

describe('a run in the background', () => {
  it('keeps going when another session is opened', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)

    await agentMode.newSession()
    await finishTurn(0)

    await turnIdOf(1)
    expect(sentPrompts()).toEqual(['one', 'two'])
  })

  it('keeps going when the active preset changes', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId

    activePreset.state!.preset = IMAGE_GEN
    await settleMicrotasks()
    activePreset.state!.preset = GAME_AGENT
    await settleMicrotasks()
    await finishTurn(0)

    await turnIdOf(1)
    expect(sentConfig(1)).toMatchObject({ sessionId, presetName: 'Agent' })
    expect(agentMode.sessions[sessionId]).toMatchObject({
      taskId: 't1',
      workspaceDir: '/work/task',
    })
    expect(window.electronAPI.agentMode.cancel).not.toHaveBeenCalled()
  })

  it('keeps going when the Task Session is open and the preset changes', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    await agentMode.switchSession(sessionId)

    activePreset.state!.preset = GAME_AGENT
    await settleMicrotasks()
    await finishTurn(0)

    await turnIdOf(1)
    expect(sentConfig(1)).toMatchObject({ sessionId, modelConfig: { model: 'Template-27B' } })
    expect(window.electronAPI.agentMode.cancel).not.toHaveBeenCalled()
  })
})

/** End the turn the `call`-th `startTurn` started with an error chunk. */
async function failTurn(call: number, errorText: string): Promise<void> {
  const turnId = await turnIdOf(call)
  const sessionId = sentConfig(call).sessionId
  pushEvent({ type: 'agent-chunk', sessionId, turnId, chunk: { type: 'start' } })
  pushEvent({ type: 'agent-chunk', sessionId, turnId, chunk: { type: 'error', errorText } })
  pushEvent({ type: 'agent-turn-done', sessionId, turnId })
}

async function settledOutcome(tasks: ReturnType<typeof useAgentTasks>, id: string) {
  await vi.waitFor(() => expect(tasks.taskState(id)).toHaveProperty('idle'))
  const state = tasks.taskState(id)
  return 'idle' in state ? state.idle : undefined
}

describe('a run that fails', () => {
  it('settles failed on the Step whose turn errored, and sends no further Step', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two', 'three']))
    await tasks.runTask('t1')
    await finishTurn(0)
    const sessionId = sentConfig(0).sessionId

    await failTurn(1, 'model refused')

    const outcome = {
      kind: 'failed',
      sessionId,
      stepIndex: 2,
      stepCount: 3,
      message: 'model refused',
    }
    expect(await settledOutcome(tasks, 't1')).toMatchObject(outcome)
    expect(lastSavedTask('t1')?.lastOutcome).toMatchObject(outcome)
    await settleMicrotasks()
    expect(sentPrompts()).toEqual(['one', 'two'])
  })

  it('settles failed without any turn when the folder is missing', async () => {
    vi.mocked(window.electronAPI.existsPath).mockResolvedValue(false)
    const { tasks } = await readyStores(task('t1', ['one']))

    await tasks.runTask('t1')

    expect(await settledOutcome(tasks, 't1')).toMatchObject({
      kind: 'failed',
      stepIndex: 1,
      message: expect.stringContaining('/work/task'),
    })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('settles failed when main refuses to start the turn', async () => {
    startTurn.mockImplementation(async () => ({ success: false, error: 'refused by main' }))
    const { tasks } = await readyStores(task('t1', ['one', 'two']))

    await tasks.runTask('t1')

    expect(await settledOutcome(tasks, 't1')).toMatchObject({
      kind: 'failed',
      stepIndex: 1,
      message: 'refused by main',
    })
    await settleMicrotasks()
    expect(sentPrompts()).toEqual(['one'])
  })

  it('records the failure in the error sink silently, without toasting it', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await failTurn(0, 'model refused')
    await settledOutcome(tasks, 't1')

    expect(errorsReport).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'agent-tasks/run-failed', surface: 'silent' }),
    )
    const surfaces = errorsReport.mock.calls.map(([error, overrides]) => ({
      ...(error as object),
      ...(overrides as object),
    }))
    expect(surfaces).not.toContainEqual(expect.objectContaining({ surface: 'toast' }))
  })

  it('toasts a failed turn in the Task Session again once the run is over', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await finishTurn(0)
    await settledOutcome(tasks, 't1')
    const sessionId = sentConfig(0).sessionId
    errorsReport.mockClear()

    await agentMode.sendToSession(sessionId, 'more', { useStoredSettings: true })
    await failTurn(1, 'model refused')

    await vi.waitFor(() =>
      expect(errorsReport).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ code: 'agent/turn-failed', surface: 'toast' }),
      ),
    )
  })
})

describe('a Task whose Settings Template has a problem', () => {
  const missingModel = { field: 'model', value: 'Template-27B' }

  it('reports the missing model', async () => {
    inference.catalog = [{ name: 'Other-9B', type: 'llamaCPP' }]
    const { tasks } = await readyStores(task('t1', ['one']))

    expect(tasks.taskProblems('t1')).toEqual([missingModel])
  })

  it('reports nothing for a healthy Task', async () => {
    inference.catalog = [{ name: 'Template-27B', type: 'llamaCPP' }]
    const { tasks } = await readyStores(task('t1', ['one']))

    expect(tasks.taskProblems('t1')).toEqual([])
  })

  it('clears the problem once the model is back', async () => {
    inference.catalog = [{ name: 'Other-9B', type: 'llamaCPP' }]
    const { tasks } = await readyStores(task('t1', ['one']))

    inference.catalog = [...inference.catalog, { name: 'Template-27B', type: 'llamaCPP' }]

    expect(tasks.taskProblems('t1')).toEqual([])
  })

  it('refuses to run with the reason, creating no Task Session and no outcome', async () => {
    inference.catalog = [{ name: 'Other-9B', type: 'llamaCPP' }]
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    const sessionsBefore = Object.keys(agentMode.sessions)

    expect(await tasks.runTask('t1')).toEqual({
      ok: false,
      reason: 'settings-problems',
      problems: [missingModel],
      message: 'model “Template-27B” is no longer available.',
    })

    await settleMicrotasks()
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(startTurn).not.toHaveBeenCalled()
    expect(saveSession).not.toHaveBeenCalled()
    expect(tasks.taskState('t1')).toEqual({ idle: undefined })
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('fails the run at the next Step when the model goes missing mid-run', async () => {
    inference.catalog = [{ name: 'Template-27B', type: 'llamaCPP' }]
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')

    inference.catalog = [{ name: 'Other-9B', type: 'llamaCPP' }]
    await finishTurn(0)

    expect(await settledOutcome(tasks, 't1')).toMatchObject({
      kind: 'failed',
      stepIndex: 2,
      message: 'model “Template-27B” is no longer available.',
    })
    expect(sentPrompts()).toEqual(['one'])
  })

  it('runs once the problem is fixed', async () => {
    inference.catalog = [{ name: 'Other-9B', type: 'llamaCPP' }]
    const { tasks } = await readyStores(task('t1', ['one']))
    expect((await tasks.runTask('t1')).ok).toBe(false)

    inference.catalog = [{ name: 'Template-27B', type: 'llamaCPP' }]

    expect(await tasks.runTask('t1')).toEqual({ ok: true })
    await turnIdOf(0)
    expect(sentPrompts()).toEqual(['one'])
  })
})

describe('stopping a run', () => {
  const cancel = () => vi.mocked(window.electronAPI.agentMode.cancel)

  async function expectStopped(tasks: ReturnType<typeof useAgentTasks>, stepIndex: number) {
    expect(await settledOutcome(tasks, 't1')).toMatchObject({ kind: 'stopped', stepIndex })
    expect(lastSavedTask('t1')?.lastOutcome).toMatchObject({ kind: 'stopped', stepIndex })
    await settleMicrotasks()
  }

  it('cancels a running Step and sends no further Step', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two', 'three']))
    await tasks.runTask('t1')
    await finishTurn(0)
    const turnId = await turnIdOf(1)
    const sessionId = sentConfig(1).sessionId

    await tasks.stopTask('t1')

    expect(cancel()).toHaveBeenCalledWith(sessionId, turnId)
    await expectStopped(tasks, 2)
    expect(sentPrompts()).toEqual(['one', 'two'])
  })

  it.each(['queued', 'paused'] as const)('cancels a %s Step', async (state) => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    const turnId = await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    pushEvent({ type: 'agent-turn-state', sessionId, turnId, state })

    await tasks.stopTask('t1')

    expect(cancel()).toHaveBeenCalledWith(sessionId, turnId)
    await expectStopped(tasks, 1)
    expect(sentPrompts()).toEqual(['one'])
  })

  it('settles stopped when the Task Session’s turn is stopped directly', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    await agentMode.switchSession(sessionId)

    await agentMode.stop()

    await expectStopped(tasks, 1)
    expect(sentPrompts()).toEqual(['one'])
  })

  it('does not send a Step that was being handed off when stopped', async () => {
    let release: () => void = () => {}
    vi.mocked(window.electronAPI.existsPath).mockImplementation(
      () => new Promise<boolean>((resolve) => (release = () => resolve(true))),
    )
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')

    await tasks.stopTask('t1')
    release()

    await expectStopped(tasks, 1)
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('ignores a stop for a Task that is not running', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.stopTask('t1')
    expect(tasks.taskState('t1')).toEqual({ idle: undefined })
    expect(saveTask).not.toHaveBeenCalled()
  })
})

describe('running again', () => {
  it.each([
    ['failed', () => failTurn(0, 'boom')],
    ['stopped', (tasks: ReturnType<typeof useAgentTasks>) => tasks.stopTask('t1')],
  ] as const)('runs again after %s, keeping only the latest outcome', async (_kind, end) => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    await end(tasks)
    await settledOutcome(tasks, 't1')

    expect(await tasks.runTask('t1')).toEqual({ ok: true })
    await finishTurn(1)

    await vi.waitFor(() =>
      expect(tasks.taskState('t1')).toEqual({
        idle: expect.objectContaining({ kind: 'completed', sessionId: sentConfig(1).sessionId }),
      }),
    )
    const saved = lastSavedTask('t1')!
    expect(saved.lastOutcome).toEqual(
      expect.objectContaining({ kind: 'completed', sessionId: sentConfig(1).sessionId }),
    )
    expect(saved.lastOutcome).not.toHaveProperty('message')
    expect(saved.lastOutcome).not.toHaveProperty('stepIndex')
  })
})

describe('the app closing during a run', () => {
  it('persists a run marker while the run lasts and clears it with the outcome', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId

    expect(lastSavedTask('t1')?.activeRun).toMatchObject({ sessionId, stepIndex: 1 })
    await finishTurn(0)
    await turnIdOf(1)
    await vi.waitFor(() => expect(lastSavedTask('t1')?.activeRun).toMatchObject({ stepIndex: 2 }))

    await finishTurn(1)
    await settledOutcome(tasks, 't1')
    const saved = lastSavedTask('t1')!
    expect(saved.lastOutcome).toMatchObject({ kind: 'completed' })
    expect(saved).not.toHaveProperty('activeRun')
  })

  it.each([
    ['failed', () => failTurn(0, 'boom')],
    ['stopped', (tasks: ReturnType<typeof useAgentTasks>) => tasks.stopTask('t1')],
  ] as const)('clears the marker when the run ends %s', async (_kind, end) => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)

    await end(tasks)

    await settledOutcome(tasks, 't1')
    expect(lastSavedTask('t1')).not.toHaveProperty('activeRun')
  })

  it('settles a Task left with a run marker as failed on init, and runs it again', async () => {
    const interrupted = task('t1', ['one', 'two', 'three'], {
      activeRun: { sessionId: 'session-old', stepIndex: 2, stepCount: 3 },
    })
    const { tasks } = await readyStores(interrupted)

    const outcome = {
      kind: 'failed',
      sessionId: 'session-old',
      stepIndex: 2,
      stepCount: 3,
      reason: 'app-closed',
    }
    expect(tasks.taskState('t1')).toEqual({ idle: expect.objectContaining(outcome) })
    const saved = lastSavedTask('t1')!
    expect(saved.lastOutcome).toMatchObject(outcome)
    expect(saved).not.toHaveProperty('activeRun')
    expect(startTurn).not.toHaveBeenCalled()

    expect(await tasks.runTask('t1')).toEqual({ ok: true })
    await turnIdOf(0)
    expect(sentPrompts()).toEqual(['one'])
  })

  it('keeps the interrupted Task Session’s "not run" message and resend action', async () => {
    const interruptedSession = {
      id: 'session-old',
      workspaceDir: '/work/task',
      title: 'Task t1',
      messages: [{ id: 'old-u1', role: 'user', parts: [{ type: 'text', text: 'one' }] }],
      createdAt: 1,
      updatedAt: 2,
      presetName: 'Agent',
      settings: TEMPLATE,
      taskId: 't1',
    }
    vi.mocked(window.electronAPI.agentMode.bootstrapSessions).mockResolvedValue({
      status: 'ok',
      activeSessionId: 'session-open',
      sessions: [openRecord, interruptedSession],
    } as never)
    const { agentMode, tasks } = await readyStores(
      task('t1', ['one'], {
        activeRun: { sessionId: 'session-old', stepIndex: 1, stepCount: 1 },
      }),
    )

    expect(agentMode.notRunMessages['session-old']).toBe('old-u1')
    expect(tasks.isSessionLockedByTask('session-old')).toBe(false)
    await agentMode.switchSession('session-old')
    expect(agentMode.canResendNotRun).toBe(true)
  })
})

describe('locking the Task Session', () => {
  it('locks only the Task Session, for the whole run, and lifts on completion', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId

    expect(tasks.isSessionLockedByTask(sessionId)).toBe(true)
    expect(tasks.isSessionLockedByTask('session-open')).toBe(false)

    await finishTurn(0)
    expect(tasks.isSessionLockedByTask(sessionId)).toBe(true)
    await turnIdOf(1)
    expect(tasks.isSessionLockedByTask(sessionId)).toBe(true)

    await finishTurn(1)
    await settledOutcome(tasks, 't1')
    expect(tasks.isSessionLockedByTask(sessionId)).toBe(false)
  })

  it.each([
    ['failed', () => failTurn(0, 'boom')],
    ['stopped', (tasks: ReturnType<typeof useAgentTasks>) => tasks.stopTask('t1')],
  ] as const)('lifts the lock when the run ends %s', async (_kind, end) => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId

    await end(tasks)

    await settledOutcome(tasks, 't1')
    expect(tasks.isSessionLockedByTask(sessionId)).toBe(false)
  })

  it('names the Task holding a session', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await turnIdOf(0)

    expect(tasks.taskLockingSession(sentConfig(0).sessionId)).toMatchObject({
      id: 't1',
      name: 'Task t1',
    })
    expect(tasks.taskLockingSession('session-open')).toBeUndefined()
  })

  it('makes the open Task Session’s settings read-only while its run lasts', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    expect(tasks.openSessionSettingsReadOnly).toBe(false)

    await agentMode.switchSession(sessionId)
    expect(tasks.openSessionSettingsReadOnly).toBe(true)
    await finishTurn(0)
    await turnIdOf(1)
    expect(tasks.openSessionSettingsReadOnly).toBe(true)

    await finishTurn(1)
    await settledOutcome(tasks, 't1')
    expect(tasks.openSessionSettingsReadOnly).toBe(false)
  })

  it.each([
    ['failed', () => failTurn(0, 'boom')],
    ['stopped', (tasks: ReturnType<typeof useAgentTasks>) => tasks.stopTask('t1')],
  ] as const)('makes the settings editable again when the run ends %s', async (_kind, end) => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    await agentMode.switchSession(sentConfig(0).sessionId)
    expect(tasks.openSessionSettingsReadOnly).toBe(true)

    await end(tasks)

    await settledOutcome(tasks, 't1')
    expect(tasks.openSessionSettingsReadOnly).toBe(false)
  })

  it('keeps an earlier Task Session editable while a later run of its Task is in flight', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await finishTurn(0)
    await settledOutcome(tasks, 't1')
    const earlier = sentConfig(0).sessionId
    await tasks.runTask('t1')
    await turnIdOf(1)

    await agentMode.switchSession(earlier)

    expect(agentMode.sessions[earlier].taskId).toBe('t1')
    expect(tasks.openSessionSettingsReadOnly).toBe(false)
  })

  it('names the Task the Open Session came from, until that Task is deleted', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one']))
    expect(tasks.openSessionTask).toBeUndefined()
    await tasks.runTask('t1')
    await finishTurn(0)
    await settledOutcome(tasks, 't1')

    await agentMode.switchSession(sentConfig(0).sessionId)
    expect(tasks.openSessionTask).toMatchObject({ id: 't1', name: 'Task t1' })

    expect(await tasks.deleteTask('t1')).toBe(true)
    expect(tasks.openSessionTask).toBeUndefined()
  })

  it('takes the user’s own message in the Task Session once the run is over', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await finishTurn(0)
    await settledOutcome(tasks, 't1')
    const sessionId = sentConfig(0).sessionId
    await agentMode.switchSession(sessionId)

    void agentMode.generate('my own follow-up')

    await turnIdOf(1)
    expect(sentPrompts()).toEqual(['one', 'my own follow-up'])
    expect(sentConfig(1).sessionId).toBe(sessionId)
  })
})

describe('editing a Task while it runs', () => {
  it('leaves the run on the Steps and settings it started with; the next run uses the edit', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId

    tasks.beginEdit('t1')
    tasks.editDraft!.steps = [
      { id: 'n1', prompt: 'first' },
      { id: 'n2', prompt: 'second' },
    ]
    tasks.editDraft!.workspaceDir = '/work/edited'
    tasks.editDraft!.settingsTemplate = { ...TEMPLATE, model: 'Edited-9B' }
    expect((await tasks.saveEdit()).ok).toBe(true)

    expect(tasks.taskState('t1')).toEqual({ running: { stepIndex: 1, stepCount: 2, sessionId } })
    expect(lastSavedTask('t1')).toMatchObject({
      steps: [{ prompt: 'first' }, { prompt: 'second' }],
      activeRun: { sessionId, stepIndex: 1 },
    })

    await finishTurn(0)
    await turnIdOf(1)
    expect(sentPrompts()).toEqual(['one', 'two'])
    expect(sentConfig(1)).toMatchObject({
      sessionId,
      workspaceDir: '/work/task',
      modelConfig: { model: 'Template-27B' },
    })
    await vi.waitFor(() => expect(lastSavedTask('t1')?.activeRun).toMatchObject({ stepIndex: 2 }))
    expect(lastSavedTask('t1')?.steps.map((step) => step.prompt)).toEqual(['first', 'second'])

    await finishTurn(1)
    await settledOutcome(tasks, 't1')
    expect(lastSavedTask('t1')).toMatchObject({
      steps: [{ prompt: 'first' }, { prompt: 'second' }],
      lastOutcome: { kind: 'completed' },
    })

    expect(await tasks.runTask('t1')).toEqual({ ok: true })
    await turnIdOf(2)
    expect(sentPrompts().at(-1)).toBe('first')
    expect(sentConfig(2)).toMatchObject({
      workspaceDir: '/work/edited',
      modelConfig: { model: 'Edited-9B' },
    })
  })

  it('runs the saved version while an edit is unsaved', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    tasks.beginEdit('t1')
    tasks.editDraft!.steps = [{ id: 'n1', prompt: 'unsaved' }]

    expect(await tasks.runTask('t1')).toEqual({ ok: true })

    await turnIdOf(0)
    expect(sentPrompts()).toEqual(['one'])
    expect(tasks.editDirty).toBe(true)
    expect(tasks.editDraft?.steps.map((step) => step.prompt)).toEqual(['unsaved'])
  })

  it('still refuses to delete the running Task being edited, and keeps the edit', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    tasks.beginEdit('t1')

    expect(await tasks.deleteTask('t1')).toBe(false)
    expect(tasks.editingTaskId).toBe('t1')
  })

  it('reports the draft template’s problems as it is edited', async () => {
    inference.catalog = [
      { name: 'Template-27B', type: 'llamaCPP' },
      { name: 'Other-9B', type: 'llamaCPP' },
    ]
    const { tasks } = await readyStores(task('t1', ['one']))
    tasks.beginEdit('t1')
    expect(tasks.editProblems).toEqual([])

    tasks.editTemplate({ model: 'Deleted-4B' })
    expect(tasks.editProblems).toEqual([{ field: 'model', value: 'Deleted-4B' }])
    expect(tasks.taskProblems('t1')).toEqual([])

    tasks.editTemplate({ model: 'Other-9B' })
    expect(tasks.editProblems).toEqual([])
  })

  it('saves an edited template with a problem, which then refuses Run', async () => {
    inference.catalog = [{ name: 'Template-27B', type: 'llamaCPP' }]
    const { tasks } = await readyStores(task('t1', ['one']))
    tasks.beginEdit('t1')
    tasks.editTemplate({ model: 'Deleted-4B' })

    expect((await tasks.saveEdit()).ok).toBe(true)

    expect(lastSavedTask('t1')?.settingsTemplate.model).toBe('Deleted-4B')
    expect(await tasks.runTask('t1')).toMatchObject({ ok: false, reason: 'settings-problems' })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('reports no problems when no Task is being edited', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))

    expect(tasks.editProblems).toEqual([])
  })

  it('saves a Task whose Settings Template has a problem', async () => {
    inference.catalog = [{ name: 'Other-9B', type: 'llamaCPP' }]
    const { tasks } = await readyStores(task('t1', ['one']))
    tasks.beginEdit('t1')
    tasks.editDraft!.steps = [{ id: 'n1', prompt: 'reworded' }]

    expect(tasks.editBlocker).toBeNull()
    expect((await tasks.saveEdit()).ok).toBe(true)
    expect(tasks.taskProblems('t1')).toEqual([{ field: 'model', value: 'Template-27B' }])
  })
})
