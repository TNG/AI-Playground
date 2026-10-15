import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { AgentTask } from '@/types/agentTaskIpc'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// The history panel's Task filter: narrowing the list to one Task's Task Sessions.
// Driven through the history store against the real Agent, Tasks and UI stores,
// with Task Sessions created by real Task Runs.

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

const shared = vi.hoisted(() => ({
  preset: null as { preset: unknown } | null,
  prompt: null as { currentMode: string } | null,
}))

vi.mock('@/assets/js/store/presets', async () => {
  const { reactive } = await import('vue')
  shared.preset = reactive({ preset: AGENT as unknown })
  const state = shared.preset
  const { AUDIO_CATEGORY } = await import('@/lib/presetSchemas')
  return {
    AUDIO_CATEGORY,
    usePresets: () => ({
      presets: [AGENT, GAME_AGENT],
      get activePresetWithVariant() {
        return state.preset
      },
      get activePresetName() {
        return (state.preset as { name?: string } | null)?.name ?? null
      },
    }),
  }
})

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset: vi.fn(async () => ({ success: true })) }),
}))

vi.mock('@/assets/js/store/promptArea', async () => {
  const { reactive } = await import('vue')
  shared.prompt = reactive({ currentMode: 'agent' })
  const state = shared.prompt
  return {
    usePromptStore: () => ({
      get currentMode() {
        return state.currentMode
      },
      getCurrentMode: () => state.currentMode,
      setCurrentMode: (mode: string) => {
        state.currentMode = mode
        return true
      },
    }),
  }
})

// One unsent chat thread, as hydration always keeps: never a Task Session.
vi.mock('@/assets/js/store/conversations', () => ({
  useConversations: () => ({
    conversationList: { '100': [] },
    conversationThreadMeta: {},
    conversationRagSelection: {},
    activeKey: '100',
    getThreadKind: () => 'main',
  }),
}))

vi.mock('@/assets/js/store/imageGenerationPresets', () => ({
  useImageGenerationPresets: () => ({ generatedImages: [] }),
  hasDisplayableMedia: () => true,
}))

const inference = vi.hoisted(() => ({
  base: {
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
  },
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    ...inference.base,
    backend: 'llamaCPP',
    activeModel: 'Live-9B',
    settingsPerPreset: {},
    ensureReadyForInference: vi.fn(),
    getMissingLlmModels: vi.fn(async () => []),
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

vi.mock('@/assets/js/store/demoMode', () => ({ useDemoMode: () => ({ enabled: false }) }))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: vi.fn() }) }))

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
  capabilities: ['files'],
}

const task = (id: string, name: string, prompts: string[] = ['go']): AgentTask => ({
  id,
  name,
  workspaceDir: `/work/${id}`,
  settingsTemplate: TEMPLATE,
  steps: prompts.map((prompt, index) => ({ id: `${id}-s${index}`, prompt })),
  createdAt: 1,
  updatedAt: 1,
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

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  seq = 10
  storedTasks = []
  shared.preset!.preset = AGENT
  shared.prompt!.currentMode = 'agent'
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
        saveSession: vi.fn(async () => ({ success: true })),
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
        saveTask: vi.fn(async () => ({ success: true, error: '' })),
        deleteTask: vi.fn(async () => ({ success: true, error: '' })),
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
const { useUIStore } = await import('@/assets/js/store/ui')
const { useHistorySessions } = await import('@/assets/js/store/historySessions')

async function readyStores(...saved: AgentTask[]) {
  storedTasks = saved
  const agentMode = useAgentMode()
  await agentMode.init()
  const tasks = useAgentTasks()
  await tasks.init()
  return { agentMode, tasks, ui: useUIStore(), history: useHistorySessions() }
}

const sentConfig = (call: number) => startTurn.mock.calls[call][2]

async function turnIdOf(call: number): Promise<string> {
  await vi.waitFor(() => expect(startTurn.mock.calls.length).toBeGreaterThan(call))
  return startTurn.mock.calls[call][0]
}

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

async function failTurn(call: number): Promise<void> {
  const turnId = await turnIdOf(call)
  const sessionId = sentConfig(call).sessionId
  pushEvent({ type: 'agent-chunk', sessionId, turnId, chunk: { type: 'start' } })
  pushEvent({ type: 'agent-chunk', sessionId, turnId, chunk: { type: 'error', errorText: 'x' } })
  pushEvent({ type: 'agent-turn-done', sessionId, turnId })
}

async function settled(tasks: ReturnType<typeof useAgentTasks>, id: string): Promise<void> {
  await vi.waitFor(() => expect(tasks.taskState(id)).toHaveProperty('idle'))
}

/** Run the Task once and return its Task Session's id; `end` decides how the run ends. */
async function runOnce(
  tasks: ReturnType<typeof useAgentTasks>,
  id: string,
  end: 'complete' | 'fail' | 'stop' | 'leave-running',
): Promise<string> {
  const call = startTurn.mock.calls.length
  expect(await tasks.runTask(id)).toEqual({ ok: true })
  await turnIdOf(call)
  const sessionId = sentConfig(call).sessionId
  if (end === 'complete') await finishTurn(call)
  else if (end === 'fail') await failTurn(call)
  else if (end === 'stop') await tasks.stopTask(id)
  if (end !== 'leave-running') await settled(tasks, id)
  return sessionId
}

const visibleIds = (history: ReturnType<typeof useHistorySessions>) =>
  history.visibleEntries.map((entry) => entry.id).sort()

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('showing a Task’s sessions from Manage Tasks', () => {
  it('lists only that Task’s Task Sessions, in any state, with the history panel open', async () => {
    const { tasks, ui, history } = await readyStores(task('a', 'Alpha'), task('b', 'Beta'))
    const completed = await runOnce(tasks, 'a', 'complete')
    const failed = await runOnce(tasks, 'a', 'fail')
    const stopped = await runOnce(tasks, 'a', 'stop')
    const running = await runOnce(tasks, 'a', 'leave-running')
    await runOnce(tasks, 'b', 'complete')
    ui.openTasks()

    history.showTaskSessions('a')

    expect(visibleIds(history)).toEqual([completed, failed, stopped, running].sort())
    expect(history.pinnedDraft).toBeNull()
    expect(history.taskFilter).toEqual({ id: 'a', name: 'Alpha' })
    expect(ui.showHistory).toBe(true)
    expect(ui.showTasks).toBe(false)
  })
})

describe('the Task filter while it is active', () => {
  it('starts on a clean search and narrows further by search text', async () => {
    const { tasks, history } = await readyStores(task('a', 'Alpha', ['build the landing page']))
    const first = await runOnce(tasks, 'a', 'complete')
    history.query = 'something unrelated'

    history.showTaskSessions('a')
    expect(history.query).toBe('')
    expect(visibleIds(history)).toEqual([first])

    history.query = 'nothing like it'
    expect(visibleIds(history)).toEqual([])
    history.query = 'landing'
    expect(visibleIds(history)).toEqual([first])
  })

  it('shows a new Task Session as soon as a run creates it', async () => {
    const { tasks, history } = await readyStores(task('a', 'Alpha'))
    history.showTaskSessions('a')
    expect(visibleIds(history)).toEqual([])

    const running = await runOnce(tasks, 'a', 'leave-running')

    expect(visibleIds(history)).toEqual([running])
  })

  it('keeps listing a Task Session after it is continued as an ordinary session', async () => {
    const { agentMode, tasks, history } = await readyStores(task('a', 'Alpha'))
    const sessionId = await runOnce(tasks, 'a', 'complete')
    await agentMode.switchSession(sessionId)
    void agentMode.generate('my own follow-up')
    await finishTurn(1)

    history.showTaskSessions('a')

    expect(visibleIds(history)).toEqual([sessionId])
  })

  it('names the Task live, so a rename shows', async () => {
    const { tasks, history } = await readyStores(task('a', 'Alpha'))
    history.showTaskSessions('a')

    tasks.beginEdit('a')
    tasks.editDraft!.name = 'Renamed'
    await tasks.saveEdit()

    expect(history.taskFilter).toEqual({ id: 'a', name: 'Renamed' })
  })

  it('lists nothing for a Task that never ran', async () => {
    const { history } = await readyStores(task('a', 'Alpha'))

    history.showTaskSessions('a')

    expect(history.visibleEntries).toEqual([])
    expect(history.pinnedDraft).toBeNull()
    expect(history.taskFilter).toEqual({ id: 'a', name: 'Alpha' })
  })

  it('opens a session from the filtered list as from the unfiltered one', async () => {
    const { agentMode, tasks, history } = await readyStores(task('a', 'Alpha'))
    const sessionId = await runOnce(tasks, 'a', 'complete')
    history.showTaskSessions('a')

    await history.select(history.visibleEntries[0])

    expect(agentMode.openSessionId).toBe(sessionId)
    expect(history.isActive(history.visibleEntries[0])).toBe(true)
  })
})

describe('clearing the Task filter', () => {
  async function filtered() {
    const stores = await readyStores(task('a', 'Alpha'), task('b', 'Beta'))
    const sessionId = await runOnce(stores.tasks, 'a', 'complete')
    stores.history.filter = 'all'
    stores.history.showTaskSessions('a')
    return { ...stores, sessionId }
  }

  it('returns to the current filter when its chip is cleared', async () => {
    const { history } = await filtered()

    history.clearTaskFilter()

    expect(history.taskFilter).toBeNull()
    expect(history.filter).toBe('current')
    expect(visibleIds(history)).toContain('session-open')
  })

  it('clears when the history panel closes, so reopening shows the normal view', async () => {
    const { ui, history } = await filtered()

    ui.closeHistory()
    await flush()
    ui.openHistory()
    await flush()

    expect(history.taskFilter).toBeNull()
    expect(history.filter).toBe('current')
    expect(visibleIds(history)).toContain('session-open')
  })

  it('clears to current when the filtered Task is deleted, its sessions staying listed', async () => {
    const { tasks, history, sessionId } = await filtered()

    expect(await tasks.deleteTask('a')).toBe(true)
    await flush()

    expect(history.taskFilter).toBeNull()
    expect(history.filter).toBe('current')
    expect(visibleIds(history)).toEqual(['session-open', sessionId].sort())
    history.filter = 'all'
    expect(visibleIds(history)).toEqual(['session-open', sessionId].sort())
  })

  it('stays when another Task is deleted', async () => {
    const { tasks, history, sessionId } = await filtered()

    expect(await tasks.deleteTask('b')).toBe(true)
    await flush()

    expect(history.taskFilter).toEqual({ id: 'a', name: 'Alpha' })
    expect(visibleIds(history)).toEqual([sessionId])
  })

  it('clears on "+", which still starts a blank Draft Session', async () => {
    const { agentMode, history, sessionId } = await filtered()
    await history.select(history.visibleEntries[0])
    expect(agentMode.openSessionId).toBe(sessionId)

    await history.startNew()

    expect(history.taskFilter).toBeNull()
    expect(agentMode.openSessionId).not.toBe(sessionId)
    expect(agentMode.messages).toEqual([])
  })

  it('clears when the user leaves Agent mode', async () => {
    const { history } = await filtered()

    shared.prompt!.currentMode = 'chat'
    await flush()
    shared.prompt!.currentMode = 'agent'
    await flush()

    expect(history.taskFilter).toBeNull()
  })

  it('clears when the user leaves the Agent preset', async () => {
    const { history } = await filtered()

    shared.preset!.preset = GAME_AGENT
    await flush()
    shared.preset!.preset = AGENT
    await flush()

    expect(history.taskFilter).toBeNull()
  })
})

describe('picking a Task in the history panel', () => {
  it('lists every Task by name with its Task Session count, zero-session Tasks included', async () => {
    const { tasks, history } = await readyStores(
      task('n', 'Nightly report'),
      task('b', 'build site'),
      task('a', 'Audit deps'),
    )
    await runOnce(tasks, 'n', 'complete')
    await runOnce(tasks, 'n', 'fail')
    await runOnce(tasks, 'a', 'leave-running')

    expect(history.taskPickerEntries).toEqual([
      { id: 'a', name: 'Audit deps', sessionCount: 1 },
      { id: 'b', name: 'build site', sessionCount: 0 },
      { id: 'n', name: 'Nightly report', sessionCount: 2 },
    ])
  })

  it('shows a rename at once and re-sorts by the new name', async () => {
    const { tasks, history } = await readyStores(task('a', 'Alpha'), task('b', 'Beta'))

    tasks.beginEdit('b')
    tasks.editDraft!.name = 'Aardvark'
    await tasks.saveEdit()

    expect(history.taskPickerEntries.map((entry) => entry.name)).toEqual(['Aardvark', 'Alpha'])
  })

  it('drops a deleted Task, while its Task Sessions stay in the list', async () => {
    const { tasks, history } = await readyStores(task('a', 'Alpha'), task('b', 'Beta'))
    const sessionId = await runOnce(tasks, 'a', 'complete')

    expect(await tasks.deleteTask('a')).toBe(true)

    expect(history.taskPickerEntries).toEqual([{ id: 'b', name: 'Beta', sessionCount: 0 }])
    expect(visibleIds(history)).toContain(sessionId)
  })

  it('counts a new Task Session as soon as a run creates it', async () => {
    const { tasks, history } = await readyStores(task('a', 'Alpha'))
    expect(history.taskPickerEntries).toEqual([{ id: 'a', name: 'Alpha', sessionCount: 0 }])

    await runOnce(tasks, 'a', 'leave-running')

    expect(history.taskPickerEntries).toEqual([{ id: 'a', name: 'Alpha', sessionCount: 1 }])
  })

  it('counts a Task Session out once it is deleted', async () => {
    const { agentMode, tasks, history } = await readyStores(task('a', 'Alpha'))
    const first = await runOnce(tasks, 'a', 'complete')
    await runOnce(tasks, 'a', 'complete')
    expect(history.taskPickerEntries).toEqual([{ id: 'a', name: 'Alpha', sessionCount: 2 }])

    await agentMode.deleteSession(first)

    expect(history.taskPickerEntries).toEqual([{ id: 'a', name: 'Alpha', sessionCount: 1 }])
  })

  it('offers nothing outside Agent mode with the Agent preset', async () => {
    const { history } = await readyStores(task('a', 'Alpha'))
    expect(history.tasksAvailable).toBe(true)

    shared.preset!.preset = GAME_AGENT
    await flush()
    expect(history.tasksAvailable).toBe(false)
    expect(history.taskPickerEntries).toEqual([])

    shared.preset!.preset = AGENT
    await flush()
    shared.prompt!.currentMode = 'chat'
    expect(history.tasksAvailable).toBe(false)
    expect(history.taskPickerEntries).toEqual([])
  })

  it('applies the same Task filter as Show sessions but keeps the search text', async () => {
    const { tasks, ui, history } = await readyStores(
      task('a', 'Alpha', ['build the landing page']),
      task('b', 'Beta'),
    )
    const sessionId = await runOnce(tasks, 'a', 'complete')
    await runOnce(tasks, 'b', 'complete')
    ui.openHistory()
    history.query = 'landing'

    history.setTaskFilter('a')

    expect(history.query).toBe('landing')
    expect(history.taskFilter).toEqual({ id: 'a', name: 'Alpha' })
    expect(visibleIds(history)).toEqual([sessionId])

    history.clearTaskFilter()
    expect(history.filter).toBe('current')
  })
})

describe('the "From task" marker on Task Session rows', () => {
  const entryOf = (history: ReturnType<typeof useHistorySessions>, id: string) =>
    history.visibleEntries.find((entry) => entry.id === id)!

  it('names the session’s Task', async () => {
    const { tasks, history } = await readyStores(task('a', 'Alpha'))
    const sessionId = await runOnce(tasks, 'a', 'complete')

    expect(history.taskMarker(entryOf(history, sessionId))).toEqual({ id: 'a', name: 'Alpha' })
  })

  it('shows a Task’s new name after a rename while the row title stays', async () => {
    const { tasks, history } = await readyStores(task('a', 'Alpha'))
    const sessionId = await runOnce(tasks, 'a', 'complete')
    const title = entryOf(history, sessionId).title

    tasks.beginEdit('a')
    tasks.editDraft!.name = 'Renamed'
    await tasks.saveEdit()

    expect(history.taskMarker(entryOf(history, sessionId))).toEqual({
      id: 'a',
      name: 'Renamed',
    })
    expect(entryOf(history, sessionId).title).toBe(title)
  })

  it('is absent for a session of a deleted Task and for one no Task created', async () => {
    const { tasks, history } = await readyStores(task('a', 'Alpha'))
    const sessionId = await runOnce(tasks, 'a', 'complete')

    expect(await tasks.deleteTask('a')).toBe(true)

    expect(history.taskMarker(entryOf(history, sessionId))).toBeNull()
    expect(history.taskMarker(entryOf(history, 'session-open'))).toBeNull()
  })

  it('applies its Task’s filter when clicked', async () => {
    const { tasks, ui, history } = await readyStores(task('a', 'Alpha'), task('b', 'Beta'))
    const sessionId = await runOnce(tasks, 'a', 'complete')
    await runOnce(tasks, 'b', 'complete')
    ui.openHistory()

    history.setTaskFilter(history.taskMarker(entryOf(history, sessionId))!.id)

    expect(history.taskFilter).toEqual({ id: 'a', name: 'Alpha' })
    expect(visibleIds(history)).toEqual([sessionId])
    history.clearTaskFilter()
    expect(history.filter).toBe('current')
  })

  it('is hidden on every row while a Task filter is active', async () => {
    const { tasks, ui, history } = await readyStores(task('a', 'Alpha'))
    const sessionId = await runOnce(tasks, 'a', 'complete')
    ui.openHistory()

    history.setTaskFilter('a')

    expect(history.taskMarker(entryOf(history, sessionId))).toBeNull()
  })

  it('is absent in other modes and presets', async () => {
    const { tasks, history } = await readyStores(task('a', 'Alpha'))
    const sessionId = await runOnce(tasks, 'a', 'complete')
    history.filter = 'all'

    shared.preset!.preset = GAME_AGENT
    await flush()
    expect(history.taskMarker(entryOf(history, sessionId))).toBeNull()

    shared.preset!.preset = AGENT
    await flush()
    shared.prompt!.currentMode = 'chat'
    expect(history.taskMarker(entryOf(history, sessionId))).toBeNull()
  })
})

describe('a Task filter for no existing Task', () => {
  it('is not applied, and does not wake when a Task with that id appears', async () => {
    const { tasks, history } = await readyStores()

    history.showTaskSessions('later')
    tasks.tasks = [task('later', 'Later')]
    await flush()

    expect(history.taskFilter).toBeNull()
    expect(visibleIds(history)).toEqual(['session-open'])
  })
})
