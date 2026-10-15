import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { AgentTask, AgentTaskSchedule } from '@/types/agentTaskIpc'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// Scheduled Runs: the Tasks store's ticker starts a Task Run by itself when a
// Task's Next Run arrives, skips slots that find a run in flight or that were
// missed, and moves the Next Run on either way. Driven through the Tasks store
// against the real Agent store, with a fake electronAPI and a fake clock.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'pick',
  systemPrompt: 'You are the agent.',
} as ChatPreset

const IMAGE_GEN = { type: 'comfy', category: 'create-images', name: 'Flux' }

const activePreset = vi.hoisted(() => ({ state: null as { preset: unknown } | null }))

vi.mock('@/assets/js/store/presets', async () => {
  const { reactive } = await import('vue')
  activePreset.state = reactive({ preset: AGENT as unknown })
  const state = activePreset.state
  return {
    usePresets: () => ({
      presets: [AGENT],
      get activePresetWithVariant() {
        return state.preset
      },
    }),
  }
})

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset: vi.fn(async () => ({ success: true })) }),
}))

const inference = vi.hoisted(() => ({
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
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    ...inference,
    backend: 'llamaCPP',
    activeModel: 'Live-9B',
    settingsPerPreset: {},
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
    inferenceForSettings: (_presetName: string, settings: AgentSessionSettings) => ({
      inference: { ...inference, backend: settings.backend, activeModel: settings.model },
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

const demo = vi.hoisted(() => ({ enabled: false }))
vi.mock('@/assets/js/store/demoMode', () => ({ useDemoMode: () => demo }))

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
  capabilities: ['files'],
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const TICK = 30_000
const NOW = Date.UTC(2026, 9, 15, 12, 0)

const every10Minutes = (overrides: Partial<AgentTaskSchedule> = {}): AgentTaskSchedule => ({
  every: 10,
  unit: 'minutes',
  startAt: NOW + 10 * MINUTE,
  enabled: true,
  ...overrides,
})

const task = (id: string, overrides: Partial<AgentTask> = {}): AgentTask => ({
  id,
  name: `Task ${id}`,
  workspaceDir: '/work/task',
  settingsTemplate: TEMPLATE,
  steps: [
    { id: `${id}-s0`, prompt: `${id} one` },
    { id: `${id}-s1`, prompt: `${id} two` },
  ],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

/** A Task whose Schedule next fires ten minutes from NOW. */
const scheduledTask = (id: string, overrides: Partial<AgentTask> = {}): AgentTask =>
  task(id, { schedule: every10Minutes(), nextRunAt: NOW + 10 * MINUTE, ...overrides })

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
const saveTask = vi.fn(async (_task: AgentTask) => ({ success: true as boolean, error: '' }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  setActivePinia(createPinia())
  seq = 10
  storedTasks = []
  demo.enabled = false
  activePreset.state!.preset = AGENT
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
        saveTask,
        deleteTask: vi.fn(async () => ({ success: true })),
      },
      getLocaleSettings: vi.fn(async () => ({ languageOverride: null })),
      games: { read: vi.fn(async () => null), list: vi.fn(async () => []) },
    },
  } as unknown as Window & typeof globalThis
})

afterEach(async () => {
  vi.useRealTimers()
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

/** Let the clock run to `at`, firing the ticker on the way. */
async function runClockTo(at: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(at - Date.now())
}

const sentPrompts = () => startTurn.mock.calls.map(([, prompt]) => prompt)
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

/** Give the store time to start a run, if it (wrongly) would. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 10))
}

const savedCopies = (id: string) =>
  saveTask.mock.calls.map(([saved]) => saved).filter((saved) => saved.id === id)

const lastSavedTask = (id: string) => savedCopies(id).at(-1)

describe('a Schedule reaching its Next Run', () => {
  it('starts a Scheduled Run: a new Task Session sending the first Step', async () => {
    const { agentMode, tasks } = await readyStores(scheduledTask('t1'))

    await runClockTo(NOW + 10 * MINUTE)

    await turnIdOf(0)
    expect(sentPrompts()).toEqual(['t1 one'])
    const sessionId = sentConfig(0).sessionId
    expect(agentMode.sessions[sessionId]).toMatchObject({
      taskId: 't1',
      workspaceDir: '/work/task',
      presetName: 'Agent',
      settings: TEMPLATE,
    })
    expect(tasks.taskState('t1')).toEqual({ running: { stepIndex: 1, stepCount: 2, sessionId } })
  })

  it('moves the Next Run to the following slot and saves it', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    await runClockTo(NOW + 10 * MINUTE)

    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 20 * MINUTE)
    expect(lastSavedTask('t1')?.nextRunAt).toBe(NOW + 20 * MINUTE)
  })

  it('does nothing before the slot', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    await runClockTo(NOW + 10 * MINUTE - TICK)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(saveTask).not.toHaveBeenCalled()
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 10 * MINUTE)
  })

  it('runs every Step of the Scheduled Run, one after another', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)

    await finishTurn(0)
    await turnIdOf(1)
    expect(sentPrompts()).toEqual(['t1 one', 't1 two'])
    await finishTurn(1)

    await vi.waitFor(() =>
      expect(tasks.taskState('t1')).toEqual({
        idle: expect.objectContaining({ kind: 'completed', sessionId: sentConfig(0).sessionId }),
      }),
    )
    expect(lastSavedTask('t1')).toMatchObject({ nextRunAt: NOW + 20 * MINUTE })
  })

  it('fires outside Agent Mode without opening its session', async () => {
    activePreset.state!.preset = IMAGE_GEN
    const { agentMode } = await readyStores(scheduledTask('t1'))

    await runClockTo(NOW + 10 * MINUTE)

    await turnIdOf(0)
    expect(sentConfig(0)).toMatchObject({ presetName: 'Agent', workspaceDir: '/work/task' })
    expect(agentMode.openSessionId).toBe('session-open')
    expect(agentMode.workspaceDir).toBe('/work/open')
  })

  it('fires again at the next slot once the run is over', async () => {
    await readyStores(scheduledTask('t1', { steps: [{ id: 's0', prompt: 'only' }] }))
    await runClockTo(NOW + 10 * MINUTE)
    await finishTurn(0)
    await settleMicrotasks()

    await runClockTo(NOW + 20 * MINUTE)

    await turnIdOf(1)
    expect(sentPrompts()).toEqual(['only', 'only'])
    expect(sentConfig(1).sessionId).not.toBe(sentConfig(0).sessionId)
  })

  it('still fires when a hidden window’s ticks come a minute apart', async () => {
    await readyStores(scheduledTask('t1'))

    vi.setSystemTime(NOW + 10 * MINUTE + 50_000)
    await vi.advanceTimersByTimeAsync(TICK)

    await turnIdOf(0)
    expect(sentPrompts()).toEqual(['t1 one'])
  })

  it('starts each due Task in its own session', async () => {
    await readyStores(scheduledTask('t1'), scheduledTask('t2'))

    await runClockTo(NOW + 10 * MINUTE)

    await turnIdOf(1)
    expect(sentPrompts().sort()).toEqual(['t1 one', 't2 one'])
    expect(sentConfig(0).sessionId).not.toBe(sentConfig(1).sessionId)
  })
})

describe('a slot that finds a Task Run in flight', () => {
  it('is skipped while a manual run lasts, and the Next Run moves on', async () => {
    const { agentMode, tasks } = await readyStores(scheduledTask('t1'))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    const sessionsBefore = Object.keys(agentMode.sessions)

    await runClockTo(NOW + 10 * MINUTE)
    await settleMicrotasks()

    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(tasks.taskState('t1')).toEqual({ running: { stepIndex: 1, stepCount: 2, sessionId } })
    expect(lastSavedTask('t1')).not.toHaveProperty('lastOutcome')
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 20 * MINUTE)
    expect(lastSavedTask('t1')?.nextRunAt).toBe(NOW + 20 * MINUTE)
    expect(errorsReport).not.toHaveBeenCalled()
  })

  it('is skipped while the previous Scheduled Run is still going', async () => {
    const { agentMode, tasks } = await readyStores(scheduledTask('t1'))
    await runClockTo(NOW + 10 * MINUTE)
    await turnIdOf(0)
    const sessionsBefore = Object.keys(agentMode.sessions)

    await runClockTo(NOW + 20 * MINUTE)
    await settleMicrotasks()

    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 30 * MINUTE)
  })

  it('is not made up when the run ends before the next slot', async () => {
    const { tasks } = await readyStores(scheduledTask('t1', { steps: [{ id: 's', prompt: 'x' }] }))
    await tasks.runTask('t1')
    await runClockTo(NOW + 10 * MINUTE)
    await finishTurn(0)
    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle'))

    await runClockTo(NOW + 20 * MINUTE - TICK)
    await settleMicrotasks()

    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it('is not blocked by the user’s own turn in an earlier Task Session', async () => {
    const { agentMode } = await readyStores(
      scheduledTask('t1', { steps: [{ id: 's', prompt: 'x' }] }),
    )
    await runClockTo(NOW + 10 * MINUTE)
    await finishTurn(0)
    await settleMicrotasks()
    const earlier = sentConfig(0).sessionId
    await agentMode.switchSession(earlier)
    void agentMode.generate('my own follow-up')
    await turnIdOf(1)

    await runClockTo(NOW + 20 * MINUTE)

    await turnIdOf(2)
    expect(sentPrompts()).toEqual(['x', 'my own follow-up', 'x'])
    expect(sentConfig(2).sessionId).not.toBe(earlier)
  })
})

describe('a slot that was missed', () => {
  it('is skipped when the machine slept through it, and the Next Run moves on', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    // Asleep: the clock jumps past the slot without the ticker running.
    vi.setSystemTime(NOW + 15 * MINUTE)
    await vi.advanceTimersByTimeAsync(TICK)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(tasks.taskState('t1')).toEqual({ idle: undefined })
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 20 * MINUTE)
    expect(lastSavedTask('t1')?.nextRunAt).toBe(NOW + 20 * MINUTE)
  })

  it('is skipped at launch when it fell while the app was closed', async () => {
    const { tasks } = await readyStores(
      scheduledTask('t1', {
        schedule: every10Minutes({ startAt: NOW - 2 * HOUR - 3 * MINUTE }),
        nextRunAt: NOW - HOUR,
      }),
    )

    // Slots at -2h03, …, -3m, then +7m.
    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 7 * MINUTE)
    expect(lastSavedTask('t1')?.nextRunAt).toBe(NOW + 7 * MINUTE)
    await vi.advanceTimersByTimeAsync(TICK)
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('leaves a future Next Run alone at launch', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    expect(tasks.taskSchedule('t1').nextRunAt).toBe(NOW + 10 * MINUTE)
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('settles an interrupted run at launch without starting a new one', async () => {
    const { tasks } = await readyStores(
      scheduledTask('t1', {
        nextRunAt: NOW - 5 * MINUTE,
        schedule: every10Minutes({ startAt: NOW - 5 * MINUTE }),
        activeRun: { sessionId: 'session-old', stepIndex: 1, stepCount: 2 },
      }),
    )

    expect(lastSavedTask('t1')).toMatchObject({
      lastOutcome: { kind: 'failed', reason: 'app-closed' },
      nextRunAt: NOW + 5 * MINUTE,
    })
    expect(lastSavedTask('t1')).not.toHaveProperty('activeRun')
    expect(tasks.taskState('t1')).toHaveProperty('idle')
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()
  })
})

describe('running a scheduled Task by hand', () => {
  it('leaves the Schedule and Next Run as they were', async () => {
    const { tasks } = await readyStores(scheduledTask('t1', { steps: [{ id: 's', prompt: 'x' }] }))

    await tasks.runTask('t1')
    await finishTurn(0)
    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle'))

    expect(tasks.taskSchedule('t1')).toEqual({
      schedule: every10Minutes(),
      nextRunAt: NOW + 10 * MINUTE,
    })
    expect(savedCopies('t1').length).toBeGreaterThan(0)
    for (const saved of savedCopies('t1')) {
      expect(saved).toMatchObject({ schedule: every10Minutes(), nextRunAt: NOW + 10 * MINUTE })
    }
  })
})

describe('a Schedule that must not fire', () => {
  it('never fires while paused', async () => {
    const { tasks } = await readyStores(
      task('t1', { schedule: every10Minutes({ enabled: false }) }),
    )

    await runClockTo(NOW + HOUR)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(tasks.taskSchedule('t1')).toEqual({ schedule: every10Minutes({ enabled: false }) })
  })

  it('stops firing once paused, and fires again once resumed', async () => {
    const { tasks } = await readyStores(task('t1', { steps: [{ id: 's', prompt: 'x' }] }))
    await tasks.setSchedule('t1', every10Minutes({ enabled: false }))
    await runClockTo(NOW + 30 * MINUTE)
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()

    await tasks.setSchedule('t1', every10Minutes())
    await runClockTo(NOW + 40 * MINUTE)

    await turnIdOf(0)
    expect(sentPrompts()).toEqual(['x'])
  })

  it('never fires once removed', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    await tasks.removeSchedule('t1')
    await runClockTo(NOW + HOUR)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
  })

  it('never fires once its Task is deleted', async () => {
    const { tasks } = await readyStores(scheduledTask('t1'))

    expect(await tasks.deleteTask('t1')).toBe(true)
    await runClockTo(NOW + HOUR)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('does not write a Task back while its delete is in flight', async () => {
    let finishDelete: () => void = () => {}
    const { tasks } = await readyStores(scheduledTask('t1'))
    vi.mocked(window.electronAPI.agentMode.deleteTask).mockImplementation(
      () => new Promise((resolve) => (finishDelete = () => resolve({ success: true }))),
    )

    const deleted = tasks.deleteTask('t1')
    await runClockTo(NOW + 10 * MINUTE)
    finishDelete()

    expect(await deleted).toBe(true)
    await settleMicrotasks()
    expect(saveTask).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('never fires in demo mode', async () => {
    demo.enabled = true
    const { agentMode } = await readyStores(scheduledTask('t1'))
    const sessionsBefore = Object.keys(agentMode.sessions)

    await runClockTo(NOW + HOUR)
    await settleMicrotasks()

    expect(startTurn).not.toHaveBeenCalled()
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
  })
})
