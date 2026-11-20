import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { AgentTask } from '@/types/agentTaskIpc'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'
import { runPrompt } from '@/lib/taskSteps'

// Running a Task: the Tasks store creates a Task Session in the background and
// sends all its Steps at once, in one turn; the run ends when that turn settles.
// Driven through the Tasks store against the real Agent store, with a fake
// electronAPI and kernel events delivered through the registered listener.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Assistant',
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
    /** Models not on disk, as the models store would report them. */
    missing: new Set<string>(),
    cloudProviderIds: [] as string[],
    /** What the Assistant preset's Default Settings fill in where a template is silent. */
    defaults: { model: 'Default-4B', contextWindow: 4096 },
  }
})

const getMissingLlmModels = vi.hoisted(() =>
  vi.fn(async (backend: string, model: string | undefined) =>
    model && inference.missing.has(model) ? [{ repo_id: model, type: 'ggufLLM', backend }] : [],
  ),
)

const requestDownload = vi.hoisted(() => vi.fn(async (_models: unknown[]) => {}))

vi.mock('@/assets/js/permissions/permissions', () => ({
  requestDownload: (models: unknown[]) => requestDownload(models),
  requestVramWarning: vi.fn(async () => true),
  notify: vi.fn(),
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    ...inference.live,
    get activeModel() {
      return inference.live.activeModel
    },
    settingsPerPreset: {},
    ensureReadyForInference: vi.fn(),
    getMissingLlmModels,
    bindSessionSettings: vi.fn(),
    loadSettingsForActivePreset: vi.fn(),
    get settingsAvailability() {
      return {
        models: inference.catalog,
        embeddingModels: [],
        services: [],
        cloudEnabled: inference.cloudProviderIds.length > 0,
        cloudProviderIds: inference.cloudProviderIds,
        embeddingBackend: 'llamaCPP',
      }
    },
    inferenceForSettings: (_presetName: string, settings: AgentSessionSettings) => ({
      inference: {
        ...inference.base,
        backend: settings.backend ?? 'llamaCPP',
        activeModel: settings.model ?? inference.defaults.model,
        contextSize: settings.contextSize,
        effectiveContextWindow: settings.contextSize ?? inference.defaults.contextWindow,
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
vi.mock('@/assets/js/store/demoMode', () => ({ useDemoMode: () => ({ enabled: false }) }))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: errorsReport }) }))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US', state: {} }),
}))

vi.mock('@/assets/js/toast', () => ({ show: vi.fn() }))

vi.mock('@/assets/js/tools/agentBridge', () => ({ getAgentToolSpecs: () => [] }))

vi.mock('@/assets/js/store/sessionLifecycle', () => ({ useSessionLifecycle: () => ({}) }))

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
  sessionRef: SESSION,
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
  presetName: 'Assistant',
  settings: { backend: 'llamaCPP', model: 'Live-9B', capabilities: ['files'] },
}

let storedTasks: AgentTask[]
/** Harness Session records on disk besides the open one, as the agent store hydrates them. */
let storedRecords: Record<string, unknown>[]
/** Each Session's picked Agent as main keeps it in `session.json`. */
let storedPicks: Record<string, string>
const kernelListeners = new Set<(event: KernelEvent) => void>()
const pushKernelEvent = (event: KernelEvent) => {
  for (const listener of [...kernelListeners]) listener(event)
}
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

const SESSION = 'session-1'
let runHarnesses = 0
/** The id main gives the next Session the sessions store creates. */
let nextSessionId = SESSION
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  vi.clearAllMocks()
  kernelListeners.clear()
  // Explicit: a store action left running by the previous test re-activates its own pinia.
  pinia = createPinia()
  setActivePinia(pinia)
  seq = 10
  storedTasks = []
  storedRecords = []
  storedPicks = {}
  nextSessionId = SESSION
  activePreset.state!.preset = AGENT
  inference.live.activeModel = 'Live-9B'
  inference.catalog = []
  inference.missing = new Set()
  inference.cloudProviderIds = []
  requestDownload.mockImplementation(async () => {})
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
        kernelListeners.add(listener)
        return () => kernelListeners.delete(listener)
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
      isFolderPath: vi.fn(async () => true),
      sessions: {
        taskRunHarness: vi.fn(async () => ({
          success: true,
          harness: {
            harnessSessionId: `aipg-agent-run-${++runHarnesses}`,
            workspaceDir: '/work/task',
          },
        })),
        saveTimelineMessages: vi.fn(async () => ({ success: true })),
        harnessSession: vi.fn(async (sessionRef: string, key: string) => ({
          success: true,
          harness: key.startsWith('agent:')
            ? {
                harnessSessionId: `chat-${key.slice(6)}-${sessionRef}`,
                workspaceDir: '/work/files',
              }
            : sessionRef === SESSION
              ? { harnessSessionId: 'session-open', workspaceDir: '/work/open' }
              : { harnessSessionId: `harness-${sessionRef}`, workspaceDir: '/work/open' },
        })),
        delete: vi.fn(async () => ({ success: true })),
        pickAgent: vi.fn(async (id: string, agentId: string | null) => {
          if (agentId) storedPicks[id] = agentId
          else delete storedPicks[id]
          return {
            success: true,
            session: {
              id,
              title: '',
              renamed: false,
              createdAt: 1,
              updatedAt: 1,
              presetsUsed: [],
              ...(agentId ? { pickedAgentId: agentId } : {}),
            },
          }
        }),
        open: vi.fn(async (id: string) => ({
          success: true,
          session: {
            id,
            title: '',
            renamed: false,
            createdAt: 1,
            updatedAt: 1,
            presetsUsed: [],
            ...(storedPicks[id] ? { pickedAgentId: storedPicks[id] } : {}),
            timeline: [],
          },
          missingFiles: [],
          lastPreset: null,
        })),
        create: vi.fn(async () => ({
          success: true,
          session: {
            id: nextSessionId,
            title: '',
            renamed: false,
            createdAt: 1,
            updatedAt: 1,
            presetsUsed: [],
          },
        })),
      },
      agentMode: {
        sessionDocuments: vi.fn(async () => []),
        startTurn,
        cancel: vi.fn(async () => {}),
        saveSession,
        onExecuteTool: vi.fn(() => () => {}),
        submitToolResult: vi.fn(),
        deleteSession: vi.fn(async () => ({ success: true })),
        bootstrapSessions: vi.fn(async () => ({
          status: 'ok',
          activeSessionId: 'session-open',
          sessions: [openRecord, ...storedRecords],
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
        readDrafts: vi.fn(async () => ({ success: true, drafts: [] })),
        saveDraft: vi.fn(async () => ({ success: true })),
        deleteDraft: vi.fn(async () => ({ success: true })),
        trialRunHarness: vi.fn(async (agentId: string) => ({
          success: true,
          harness: {
            harnessSessionId: 'aipg-agent-trial',
            workspaceDir: `/trials/${agentId}/files`,
          },
        })),
        discardTrialRun: vi.fn(async () => ({ success: true })),
        readTrialRuns: vi.fn(async () => ({ success: true, trialRuns: [] })),
        saveTrialRun: vi.fn(async () => ({ success: true })),
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
const { useSessions } = await import('@/assets/js/store/sessions')
const { useQueuedChannelMessages } = await import('@/assets/js/store/queuedChannelMessages')
const { registerChannelSessionPort } = await import('@/lib/channelSessionPort')
const { sessionPort } = await import('@/assets/js/store/channels/sessionPort')
const { whenSessionInView } = await import('@/assets/js/permissions/sessionPromptPort')

async function readyStores(...saved: AgentTask[]) {
  return readyStoresIn({ session: true }, ...saved)
}

async function readyStoresIn(options: { session: boolean }, ...saved: AgentTask[]) {
  storedTasks = saved
  const agentMode = useAgentMode(pinia)
  await agentMode.init()
  if (options.session) await useSessions(pinia).create()
  const tasks = useAgentTasks(pinia)
  await tasks.init()
  return { agentMode, tasks }
}

const sentPrompts = () => startTurn.mock.calls.map(([, prompt]) => prompt)
/** The Steps each sent turn carries, from the run prompt's numbered lines. */
const sentSteps = () =>
  sentPrompts().map((prompt) => [...prompt.matchAll(/^\d+\. (.*)$/gm)].map((line) => line[1]))
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

describe('where an Agent Run runs', () => {
  it('runs in the open Session, not the one the Agent was made in', async () => {
    const { agentMode, tasks } = await readyStores(
      task('t1', ['one'], { sessionRef: 'session-made-in' }),
    )

    expect(await tasks.runTask('t1')).toEqual({ ok: true })

    await turnIdOf(0)
    expect(window.electronAPI.sessions.taskRunHarness).toHaveBeenCalledWith(SESSION)
    expect(agentMode.liveTurnsIn(SESSION).map((turn) => turn.tag.taskRun?.taskName)).toContain(
      'Task t1',
    )
    expect(agentMode.liveTurnsIn('session-made-in')).toEqual([])
  })

  it('runs an Agent saved before Sessions existed', async () => {
    const { sessionRef: _none, ...legacy } = task('old', ['one'])
    const { tasks } = await readyStores(legacy)

    expect(await tasks.runTask('old')).toEqual({ ok: true })

    await turnIdOf(0)
    expect(window.electronAPI.sessions.taskRunHarness).toHaveBeenCalledWith(SESSION)
  })

  it('opens a Session for the run when none is open', async () => {
    nextSessionId = 'session-new'
    const { tasks } = await readyStoresIn({ session: false }, task('t1', ['one']))

    expect(await tasks.runTask('t1')).toEqual({ ok: true })

    await turnIdOf(0)
    expect(window.electronAPI.sessions.taskRunHarness).toHaveBeenCalledWith('session-new')
    expect(useSessions(pinia).openSessionId).toBe('session-new')
  })

  it('stays in the Session it started in when another one is opened', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)

    nextSessionId = 'session-2'
    await useSessions(pinia).create()

    const runsIn = (sessionRef: string) =>
      agentMode.liveTurnsIn(sessionRef).filter((turn) => turn.tag.taskRun)
    expect(runsIn(SESSION)).toHaveLength(1)
    expect(runsIn('session-2')).toEqual([])
  })
})

describe('deleting the Session a run is in', () => {
  it('stops the run and keeps the Agent', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    nextSessionId = 'session-2'
    await useSessions(pinia).create()

    await useSessions(pinia).remove(SESSION)

    expect(await settledOutcome(tasks, 't1')).toMatchObject({ kind: 'stopped' })
    expect(window.electronAPI.agentMode.cancel).toHaveBeenCalled()
    expect(tasks.tasks.map((agent) => agent.id)).toEqual(['t1'])
    expect(lastSavedTask('t1')).not.toHaveProperty('activeRuns')
  })

  it('writes nothing back into the open Session it deleted', async () => {
    const { agentMode } = await readyStores()
    await vi.waitFor(() => expect(agentMode.openSessionId).toBe('session-open'))
    await agentMode.sendToSession('session-open', 'hi')
    await finishTurn(0)
    await settleMicrotasks()
    const saveTimeline = vi.mocked(window.electronAPI.sessions.saveTimelineMessages)
    saveTimeline.mockClear()
    saveSession.mockClear()
    nextSessionId = 'session-2'

    await useSessions(pinia).remove(SESSION)
    await vi.waitFor(() => expect(agentMode.openSessionId).toBe('harness-session-2'))
    await settleMicrotasks()

    expect(saveTimeline.mock.calls.filter(([sessionRef]) => sessionRef === SESSION)).toEqual([])
    expect(saveSession.mock.calls.filter(([record]) => record.id === 'session-open')).toEqual([])
  })

  it('leaves a run in another Session going', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    nextSessionId = 'session-2'
    await useSessions(pinia).create()

    await useSessions(pinia).remove('session-2')
    await settleMicrotasks()

    expect(tasks.taskState('t1')).toHaveProperty('running')
    expect(window.electronAPI.agentMode.cancel).not.toHaveBeenCalled()
  })
})

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
      presetName: 'Assistant',
      taskId: 't1',
      settings: TEMPLATE,
    })
    expect(agentMode.openSessionId).toBe('session-open')
    expect(agentMode.workspaceDir).toBe('/work/open')
    expect(JSON.stringify(agentMode.messages)).toContain('what I am doing')
    expect(JSON.stringify(agentMode.messages)).not.toContain('"one"')
  })

  it('tags the run with its Agent and as started by hand, for the timeline to say so', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')

    await turnIdOf(0)
    expect(agentMode.sessions[sentConfig(0).sessionId].taskRun).toMatchObject({
      taskId: 't1',
      taskName: 'Task t1',
      trigger: 'manual',
    })
  })

  it("keeps the user's input on the run, trimmed, for its Turn to show", async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one']), task('t2', ['two']))
    await tasks.runTask('t1', '  only news from Germany ')
    await turnIdOf(0)
    await tasks.runTask('t2', '   ')
    await turnIdOf(1)

    expect(agentMode.sessions[sentConfig(0).sessionId].taskRun?.input).toBe(
      'only news from Germany',
    )
    expect(agentMode.sessions[sentConfig(1).sessionId].taskRun).not.toHaveProperty('input')
  })

  it('files the Agent Run under Assistant', async () => {
    const { agentMode } = await readyStores(task('t-news', ['one']))
    const tasks = useAgentTasks(pinia)

    await tasks.runTask('t-news')

    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    expect(agentMode.sessions[sessionId]).toMatchObject({ presetName: 'Assistant' })
    expect(sentConfig(0)).toMatchObject({ presetName: 'Assistant' })
  })

  it('sends one turn holding every Step in order, with the run instruction', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two', 'three']))

    await tasks.runTask('t1')
    await turnIdOf(0)
    await finishTurn(0)
    await settledOutcome(tasks, 't1')
    await settleMicrotasks()

    expect(sentPrompts()).toEqual([runPrompt('', ['one', 'two', 'three'])])
    expect(sentPrompts()[0]).toContain('instructions, not a script')
    expect(sentSteps()).toEqual([['one', 'two', 'three']])
  })

  it('carries the Start Prompt in that turn with the follow-the-user clause, and none without', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']), task('t2', ['three']))

    await tasks.runTask('t1', ' only news from Germany ')
    await tasks.runTask('t2')
    await turnIdOf(1)

    expect(sentPrompts()[0]).toBe(runPrompt('only news from Germany', ['one', 'two']))
    expect(sentPrompts()[0]).toContain(
      'Apply it to every step it is relevant to. Where it conflicts with a step, follow the user.',
    )
    expect(sentPrompts()[1]).not.toContain('For this run the user added')
    expect(sentConfig(0).taskRun?.input).toBe('only news from Germany')
    expect(sentConfig(1).taskRun).not.toHaveProperty('input')
  })

  it('ends the run when its turn settles, recording completed', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two', 'three']))

    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    await finishTurn(0)

    await vi.waitFor(() => expect(tasks.taskState('t1')).toHaveProperty('idle'))
    const outcome = { kind: 'completed', sessionId }
    expect(tasks.taskState('t1')).toEqual({ idle: expect.objectContaining(outcome) })
    expect(lastSavedTask('t1')?.lastOutcome).toMatchObject(outcome)
    await settleMicrotasks()
    expect(startTurn).toHaveBeenCalledTimes(1)
    const transcript = JSON.stringify(agentMode.sessions[sessionId].messages)
    expect(transcript).toContain('three')
  })

  it('is running while its turn lasts', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))

    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    expect(tasks.taskState('t1')).toEqual({
      running: { taskId: 't1', sessionId, sessionRef: SESSION },
    })
  })
})

describe('the settings a run uses', () => {
  it('takes the run turn’s config from the Settings Template, not the live controls', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    inference.live.activeModel = 'Changed-4B'

    await tasks.runTask('t1')
    await turnIdOf(0)

    expect(sentConfig(0)).toMatchObject({
      workspaceDir: '/work/task',
      presetName: 'Assistant',
      capabilities: ['files', 'web'],
      modelConfig: { model: 'Template-27B' },
    })
  })
})

/** Lists one folder beside the Workspace in the Session's folder list. */
function giveSessionAFolder(hostPath = '/Users/ada/session-notes'): void {
  const sessions = useSessions(pinia)
  const session = sessions.sessions[SESSION]
  sessions.sessions = {
    ...sessions.sessions,
    [SESSION]: {
      ...session,
      folderList: {
        workspaceId: 'ws',
        folders: [
          { id: 'ws', hostPath: '/sessions/s/files', access: 'read-write', slug: 'files' },
          { id: 'f1', hostPath, access: 'read-write', slug: 'session-notes' },
        ],
      },
    },
  }
}

describe('the folders a run reaches', () => {
  const ofAgent = {
    id: 'a1',
    hostPath: '/Users/ada/inbox',
    slug: 'mail',
    access: 'read-only' as const,
  }

  it('are only its Agent’s when it uses only these', async () => {
    const template = { ...TEMPLATE, folderOverrides: { folders: [ofAgent] } }
    const { tasks } = await readyStores(task('t1', ['one', 'two'], { settingsTemplate: template }))
    giveSessionAFolder()

    await tasks.runTask('t1')
    await turnIdOf(0)

    expect(sentConfig(0).folderOverrides).toEqual({ folders: [ofAgent] })
  })

  it('are the Session’s when its Agent inherits them, which main resolves', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    giveSessionAFolder()

    await tasks.runTask('t1')
    await turnIdOf(0)

    expect(sentConfig(0).folderOverrides).toBeUndefined()
  })

  it('fail before any turn when an inherited Session folder is missing', async () => {
    vi.mocked(window.electronAPI.isFolderPath).mockImplementation(
      async (hostPath: string) => hostPath !== '/Users/ada/session-notes',
    )
    const { tasks } = await readyStores(task('t1', ['one']))
    giveSessionAFolder()

    await tasks.runTask('t1')

    expect(await settledOutcome(tasks, 't1')).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('/Users/ada/session-notes'),
    })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('do not include a missing Session folder its Agent replaces', async () => {
    vi.mocked(window.electronAPI.isFolderPath).mockImplementation(
      async (hostPath: string) => hostPath !== '/Users/ada/session-notes',
    )
    const template = { ...TEMPLATE, folderOverrides: { folders: [ofAgent] } }
    const { tasks } = await readyStores(task('t1', ['one'], { settingsTemplate: template }))
    giveSessionAFolder()

    await tasks.runTask('t1')

    await turnIdOf(0)
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

    expect(sentSteps()).toEqual([['a1', 'a2'], ['b1']])
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
    expect(startTurn).toHaveBeenCalledTimes(2)
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

    expect(await settledOutcome(tasks, 't1')).toMatchObject({ kind: 'completed' })
    expect(window.electronAPI.agentMode.cancel).not.toHaveBeenCalled()
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

    expect(await settledOutcome(tasks, 't1')).toMatchObject({ kind: 'completed', sessionId })
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

    expect(await settledOutcome(tasks, 't1')).toMatchObject({ kind: 'completed', sessionId })
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
  it('settles failed when its turn errored, and sends nothing more', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two', 'three']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId

    await failTurn(0, 'model refused')

    const outcome = { kind: 'failed', sessionId, message: 'model refused' }
    expect(await settledOutcome(tasks, 't1')).toMatchObject(outcome)
    expect(lastSavedTask('t1')?.lastOutcome).toMatchObject(outcome)
    await settleMicrotasks()
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it('records on the run how it failed, so its timeline Turn can show it', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId

    await failTurn(0, 'model refused')

    const end = { kind: 'failed', message: 'model refused' }
    await vi.waitFor(() => expect(agentMode.sessions[sessionId].taskRun?.end).toEqual(end))
    const saved = vi.mocked(window.electronAPI.sessions.saveTimelineMessages).mock.calls.at(-1)
    expect(JSON.stringify(saved?.[1])).toContain(
      '"end":{"kind":"failed","message":"model refused"}',
    )
  })

  it('settles failed without any turn when the folder is missing', async () => {
    vi.mocked(window.electronAPI.existsPath).mockResolvedValue(false)
    const { tasks } = await readyStores(task('t1', ['one']))

    await tasks.runTask('t1')

    expect(await settledOutcome(tasks, 't1')).toMatchObject({
      kind: 'failed',
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
      message: 'refused by main',
    })
    await settleMicrotasks()
    expect(startTurn).toHaveBeenCalledTimes(1)
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

describe('a run a Channel started', () => {
  const ORIGIN = { channel: 'telegram' as const, replyTo: 'msg-9' }
  const startable = (prompts: string[]) => task('t1', prompts, { startableFromChannel: true })

  it('answers the start with the refusal when its first Step is refused', async () => {
    vi.mocked(window.electronAPI.existsPath).mockResolvedValue(false)
    const { tasks } = await readyStores(startable(['one']))

    const result = await tasks.startFromChannel('t1', SESSION, ORIGIN)

    expect(result).toEqual({
      ok: false,
      reason: 'not-started',
      message: expect.stringContaining('/work/task'),
    })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('puts a Start Prompt into the first Step and onto the run, as a desktop start does', async () => {
    const { agentMode, tasks } = await readyStores(startable(['one', 'two']))

    expect(
      await tasks.startFromChannel('t1', SESSION, ORIGIN, '  only news from Germany '),
    ).toEqual({ ok: true })

    await turnIdOf(0)
    expect(sentPrompts()).toEqual([runPrompt('only news from Germany', ['one', 'two'])])
    expect(agentMode.sessions[sentConfig(0).sessionId].taskRun).toMatchObject({
      trigger: 'channel',
      channel: 'telegram',
      input: 'only news from Germany',
    })
  })

  it('sends one turn with every Step, answering the Channel and asking for its result', async () => {
    const { tasks } = await readyStores(startable(['one', 'two']))

    expect(await tasks.startFromChannel('t1', SESSION, ORIGIN)).toEqual({ ok: true })
    await finishTurn(0)

    expect(await settledOutcome(tasks, 't1')).toMatchObject({ kind: 'completed' })
    await settleMicrotasks()
    expect(sentSteps()).toEqual([['one', 'two']])
    expect(sentConfig(0).taskRun).toEqual({ taskName: 'Task t1', notifiesResult: true })
    expect(sentConfig(0).answer).toEqual(ORIGIN)
  })

  it('continues the run as a Follow-up when a Channel answers its result', async () => {
    const { tasks } = await readyStores(startable(['ask me which city', 'forecast it']))
    registerChannelSessionPort({ harness: () => '', session: () => '', trialRun: () => '' })
    await tasks.startFromChannel('t1', SESSION, ORIGIN)
    const run = sentConfig(0).sessionId
    await finishTurn(0)
    await settledOutcome(tasks, 't1')

    const reply = { channel: 'telegram' as const, replyTo: 'msg-12' }
    const sent = await sessionPort()!.send(
      { sessionRef: SESSION, harnessSessionId: run },
      'Berlin',
      reply,
    )

    expect(sent).toMatchObject({ ok: true })
    await turnIdOf(1)
    expect(sentConfig(1)).toMatchObject({
      sessionId: run,
      answer: reply,
      followUp: { agentId: 't1', agentName: 'Task t1' },
    })
    expect(sentConfig(1).taskRun).toBeUndefined()
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

  it('runs once the problem is fixed', async () => {
    inference.catalog = [{ name: 'Other-9B', type: 'llamaCPP' }]
    const { tasks } = await readyStores(task('t1', ['one']))
    expect((await tasks.runTask('t1')).ok).toBe(false)

    inference.catalog = [{ name: 'Template-27B', type: 'llamaCPP' }]

    expect(await tasks.runTask('t1')).toEqual({ ok: true })
    await turnIdOf(0)
    expect(sentSteps()).toEqual([['one']])
  })
})

describe('running a Task whose chat model is not downloaded', () => {
  const decline = async () => {
    const { createCancellation } = await import('@/assets/js/errors/appError')
    throw createCancellation({ technicalMessage: 'Download cancelled by user' })
  }

  it('asks to download the model before any Task Session exists, then starts the run', async () => {
    inference.missing = new Set(['Template-27B'])
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    const sessionsBefore = Object.keys(agentMode.sessions)
    let finishDownload = () => {}
    requestDownload.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )

    const running = tasks.runTask('t1')
    await vi.waitFor(() => expect(requestDownload).toHaveBeenCalledTimes(1))

    expect(requestDownload.mock.calls[0][0]).toEqual([
      expect.objectContaining({ repo_id: 'Template-27B' }),
    ])
    expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
    expect(tasks.taskState('t1')).toEqual({ idle: undefined })
    finishDownload()

    expect(await running).toEqual({ ok: true })
    await turnIdOf(0)
    expect(sentSteps()).toEqual([['one', 'two']])
  })

  it.each([
    ['declining', decline, 'download-declined'],
    [
      'a failed download',
      async () => {
        throw new Error('Not enough disk space')
      },
      'download-failed',
    ],
  ])(
    'refuses the run after %s, creating no Task Session and no outcome',
    async (_c, outcome, reason) => {
      inference.missing = new Set(['Template-27B'])
      requestDownload.mockImplementation(outcome)
      const { agentMode, tasks } = await readyStores(task('t1', ['one']))
      const sessionsBefore = Object.keys(agentMode.sessions)

      expect(await tasks.runTask('t1')).toMatchObject({
        ok: false,
        reason,
        message: expect.stringContaining('Template-27B'),
      })

      await settleMicrotasks()
      expect(Object.keys(agentMode.sessions)).toEqual(sessionsBefore)
      expect(startTurn).not.toHaveBeenCalled()
      expect(saveSession).not.toHaveBeenCalled()
      expect(saveTask).not.toHaveBeenCalled()
      expect(tasks.taskState('t1')).toEqual({ idle: undefined })
    },
  )

  it('reports a failed download through the error sink, naming the error', async () => {
    inference.missing = new Set(['Template-27B'])
    requestDownload.mockRejectedValue(new Error('Not enough disk space'))
    const { tasks } = await readyStores(task('t1', ['one']))

    expect(await tasks.runTask('t1')).toMatchObject({ error: 'Not enough disk space' })
    expect(errorsReport).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'agent-tasks/model-download-failed', surface: 'toast' }),
    )
  })

  it('does not ask when the Settings Template has a problem; that refusal comes first', async () => {
    inference.catalog = [{ name: 'Other-9B', type: 'llamaCPP' }]
    inference.missing = new Set(['Template-27B'])
    const { tasks } = await readyStores(task('t1', ['one']))

    expect(await tasks.runTask('t1')).toMatchObject({ ok: false, reason: 'settings-problems' })
    expect(requestDownload).not.toHaveBeenCalled()
  })

  it('refuses a second Run while the first waits on the download', async () => {
    inference.missing = new Set(['Template-27B'])
    const { agentMode, tasks } = await readyStores(task('t1', ['one']))
    const sessionsBefore = Object.keys(agentMode.sessions).length
    let finishDownload = () => {}
    requestDownload.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )

    const first = tasks.runTask('t1')
    await vi.waitFor(() => expect(requestDownload).toHaveBeenCalledTimes(1))

    expect(await tasks.runTask('t1')).toEqual({ ok: false, reason: 'running' })
    finishDownload()
    expect(await first).toEqual({ ok: true })
    expect(requestDownload).toHaveBeenCalledTimes(1)
    expect(Object.keys(agentMode.sessions)).toHaveLength(sessionsBefore + 1)
  })

  it('starts without asking when the model is already downloaded', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))

    expect(await tasks.runTask('t1')).toEqual({ ok: true })
    expect(requestDownload).not.toHaveBeenCalled()
  })

  it('never asks for a cloud model', async () => {
    inference.missing = new Set(['cloud-model'])
    inference.cloudProviderIds = ['custom']
    const cloud = { ...TEMPLATE, backend: 'cloud' as const, model: 'cloud-model' }
    const { tasks } = await readyStores(task('t1', ['one'], { settingsTemplate: cloud }))

    expect(await tasks.runTask('t1')).toEqual({ ok: true })
    expect(requestDownload).not.toHaveBeenCalled()
  })
})

describe('stopping a run', () => {
  const cancel = () => vi.mocked(window.electronAPI.agentMode.cancel)

  async function expectStopped(tasks: ReturnType<typeof useAgentTasks>) {
    expect(await settledOutcome(tasks, 't1')).toMatchObject({ kind: 'stopped' })
    expect(lastSavedTask('t1')?.lastOutcome).toMatchObject({ kind: 'stopped' })
    await settleMicrotasks()
  }

  it('cancels the run turn and settles stopped, sending nothing more', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two', 'three']))
    await tasks.runTask('t1')
    const turnId = await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId

    await tasks.stopTask('t1')

    expect(cancel()).toHaveBeenCalledWith(sessionId, turnId)
    await expectStopped(tasks)
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it.each(['queued', 'paused'] as const)('cancels a %s run turn', async (state) => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    const turnId = await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    pushEvent({ type: 'agent-turn-state', sessionId, turnId, state })

    await tasks.stopTask('t1')

    expect(cancel()).toHaveBeenCalledWith(sessionId, turnId)
    await expectStopped(tasks)
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it('settles stopped when the Task Session’s turn is stopped directly', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    await agentMode.switchSession(sessionId)

    await agentMode.stop()

    await expectStopped(tasks)
    expect(startTurn).toHaveBeenCalledTimes(1)
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

    await expectStopped(tasks)
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

    expect(lastSavedTask('t1')?.activeRuns).toEqual([{ sessionId, sessionRef: SESSION }])
    await finishTurn(0)
    await settledOutcome(tasks, 't1')
    const saved = lastSavedTask('t1')!
    expect(saved.lastOutcome).toMatchObject({ kind: 'completed' })
    expect(saved).not.toHaveProperty('activeRuns')
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
    expect(lastSavedTask('t1')).not.toHaveProperty('activeRuns')
  })

  it('settles a Task left with a run marker as failed on init, and runs it again', async () => {
    const interrupted = task('t1', ['one', 'two', 'three'], {
      activeRuns: [{ sessionId: 'session-old', sessionRef: SESSION }],
    })
    const { tasks } = await readyStores(interrupted)

    const outcome = { kind: 'failed', sessionId: 'session-old', reason: 'app-closed' }
    expect(tasks.taskState('t1')).toEqual({ idle: expect.objectContaining(outcome) })
    const saved = lastSavedTask('t1')!
    expect(saved.lastOutcome).toMatchObject(outcome)
    expect(saved).not.toHaveProperty('activeRuns')
    expect(startTurn).not.toHaveBeenCalled()

    expect(await tasks.runTask('t1')).toEqual({ ok: true })
    await turnIdOf(0)
    expect(sentSteps()).toEqual([['one', 'two', 'three']])
  })

  it('settles a marker from when runs counted Steps the same way, without the Step', async () => {
    const marker = { sessionId: 'session-old', sessionRef: SESSION, stepIndex: 2, stepCount: 3 }
    const { tasks } = await readyStores(task('t1', ['one'], { activeRuns: [marker] }))

    const outcome = { kind: 'failed', sessionId: 'session-old', reason: 'app-closed' }
    expect(tasks.taskState('t1')).toEqual({ idle: expect.objectContaining(outcome) })
    expect(lastSavedTask('t1')!.lastOutcome).not.toHaveProperty('stepIndex')
    expect(lastSavedTask('t1')!.lastOutcome).not.toHaveProperty('stepCount')
  })

  it('records on the run that the app closed, so its timeline Turn shows the error', async () => {
    vi.mocked(window.electronAPI.agentMode.bootstrapSessions).mockResolvedValue({
      status: 'ok',
      activeSessionId: 'session-open',
      sessions: [
        openRecord,
        {
          id: 'session-old',
          workspaceDir: '/work/task',
          title: 'Task t1',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
          presetName: 'Assistant',
          settings: TEMPLATE,
          taskId: 't1',
          sessionRef: SESSION,
          taskRun: { taskName: 'Task t1', startedAt: 1, trigger: 'manual' },
        },
      ],
    } as never)
    const interrupted = task('t1', ['one', 'two'], {
      activeRuns: [{ sessionId: 'session-old', sessionRef: SESSION }],
    })

    const { agentMode } = await readyStores(interrupted)

    await vi.waitFor(() =>
      expect(agentMode.sessions['session-old'].taskRun?.end).toEqual({
        kind: 'failed',
        message: 'The app closed during the run.',
      }),
    )
  })

  it('reattaches a run whose turn main still holds, and ends it with that turn', async () => {
    const sessionId = 'session-old'
    const turnId = 'turn-live'
    vi.mocked(window.electronAPI.agentMode.bootstrapSessions).mockResolvedValue({
      status: 'ok',
      activeSessionId: 'session-open',
      sessions: [
        openRecord,
        {
          id: sessionId,
          workspaceDir: '/work/task',
          title: 'Task t1',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
          presetName: 'Assistant',
          settings: TEMPLATE,
          taskId: 't1',
        },
      ],
    } as never)
    vi.mocked(window.electronAPI.getKernelSnapshot).mockResolvedValue({
      scope: { kind: 'global' },
      sequence: 5,
      state: {
        services: [],
        agentTurns: [
          {
            sessionId,
            turnId,
            state: 'running',
            chunks: [],
            toolProgress: {},
            toolImages: {},
          },
        ],
        activeArtifactRun: null,
        chatTurns: [],
        activities: [],
        inferenceProfile: null,
      },
    })
    const { agentMode, tasks } = await readyStores(
      task('t1', ['one', 'two'], {
        activeRuns: [{ sessionId, sessionRef: SESSION, scheduled: true }],
      }),
    )

    expect(tasks.taskState('t1')).toEqual({
      running: { taskId: 't1', sessionId, sessionRef: SESSION },
    })
    expect(tasks.isSessionLockedByTask(sessionId)).toBe(true)
    expect(saveTask.mock.calls.some(([saved]) => saved.lastOutcome?.reason === 'app-closed')).toBe(
      false,
    )

    await vi.waitFor(() => expect(agentMode.sessionTurns[sessionId]?.state).toBe('running'))
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

    expect(await settledOutcome(tasks, 't1')).toMatchObject({ kind: 'completed', sessionId })
    expect(lastSavedTask('t1')).not.toHaveProperty('activeRuns')
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('keeps the interrupted Task Session’s "not run" message and resend action', async () => {
    const interruptedSession = {
      id: 'session-old',
      workspaceDir: '/work/task',
      title: 'Task t1',
      messages: [{ id: 'old-u1', role: 'user', parts: [{ type: 'text', text: 'one' }] }],
      createdAt: 1,
      updatedAt: 2,
      presetName: 'Assistant',
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
        activeRuns: [{ sessionId: 'session-old', sessionRef: SESSION }],
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
    await settledOutcome(tasks, 't1')
    expect(tasks.isSessionLockedByTask(sessionId)).toBe(false)
  })

  it('refuses anyone else sending into the Task Session mid-turn', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId

    expect(await agentMode.sendToSession(sessionId, 'answer')).toMatchObject({
      ok: false,
      reason: 'task-locked',
    })
  })

  it('accepts a send into the session once the run has settled', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    await finishTurn(0)
    await settledOutcome(tasks, 't1')

    expect(await agentMode.sendToSession(sessionId, 'answer')).toEqual({ ok: true })
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

  it('makes the open Task Session’s settings read-only while its run lasts', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    expect(tasks.openSessionSettingsReadOnly).toBe(false)

    await agentMode.switchSession(sessionId)
    expect(tasks.openSessionSettingsReadOnly).toBe(true)

    await finishTurn(0)
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
})

describe('an Agent with a Draft', () => {
  it('runs as saved until the Draft is saved', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.editDraft('t1', {
      steps: [{ id: 'n1', prompt: 'drafted' }],
      settingsTemplate: { ...TEMPLATE, model: 'Edited-9B' },
    })

    expect(await tasks.runTask('t1')).toEqual({ ok: true })
    await turnIdOf(0)

    expect(sentSteps()).toEqual([['one']])
    expect(sentConfig(0)).toMatchObject({ modelConfig: { model: 'Template-27B' } })
  })

  it('keeps a run in flight on the Steps it started with when the Draft is saved', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    await tasks.editDraft('t1', {
      steps: [
        { id: 'n1', prompt: 'first' },
        { id: 'n2', prompt: 'second' },
      ],
    })

    expect((await tasks.saveAgentDraft('t1')).ok).toBe(true)
    await finishTurn(0)
    await settledOutcome(tasks, 't1')
    expect(await tasks.runTask('t1')).toEqual({ ok: true })
    await turnIdOf(1)
    expect(sentSteps()).toEqual([
      ['one', 'two'],
      ['first', 'second'],
    ])
  })
})

describe('an Agent picked in the prompt bar', () => {
  it('is remembered per Session', async () => {
    const { tasks } = await readyStores(task('t1', ['one']), task('t2', ['two']))
    const sessions = useSessions(pinia)

    expect(await tasks.pickAgent('t1')).toBe(true)
    expect(tasks.pickedAgent?.id).toBe('t1')
    expect(storedPicks).toEqual({ [SESSION]: 't1' })

    nextSessionId = 'session-2'
    await sessions.create()
    expect(tasks.pickedAgent).toBeUndefined()

    await sessions.open(SESSION)
    expect(tasks.pickedAgent?.id).toBe('t1')
  })

  it('is cleared by picking Assistant again', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))

    await tasks.pickAgent('t1')
    await tasks.pickAgent(null)

    expect(tasks.pickedAgent).toBeUndefined()
    expect(storedPicks).toEqual({})
  })

  it('cannot be an Agent that exists only as a Draft', async () => {
    const { tasks } = await readyStores()
    const draft = await tasks.createAgentDraft()

    expect(await tasks.pickAgent(draft.agentId)).toBe(false)
    expect(tasks.pickedAgent).toBeUndefined()
    expect(storedPicks).toEqual({})
  })

  it('is only in effect while Assistant is the agent preset', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.pickAgent('t1')

    activePreset.state!.preset = GAME_AGENT
    await settleMicrotasks()

    expect(tasks.pickedAgent).toBeUndefined()
    expect(tasks.pickedAgentIn(SESSION)?.id).toBe('t1')
  })

  it('runs its Steps in the open Session with ▶, the typed text as the Start Prompt', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.pickAgent('t1')

    expect(await tasks.runPickedAgent('only the headlines')).toEqual({ ok: true })

    await turnIdOf(0)
    expect(window.electronAPI.sessions.taskRunHarness).toHaveBeenCalledWith(SESSION)
    expect(sentPrompts()).toEqual([runPrompt('only the headlines', ['one', 'two'])])
    expect(agentMode.liveTurnsIn(SESSION).map((turn) => turn.tag.taskRun?.taskName)).toContain(
      'Task t1',
    )
  })

  it("blocks the prompt bar with its Settings Template's problems, not the Session's", async () => {
    inference.catalog = [{ name: 'Live-9B', type: 'llamaCPP' }]
    const { tasks } = await readyStores(task('t1', ['one']))
    expect(tasks.agentSettingsProblems).toEqual([])

    await tasks.pickAgent('t1')

    expect(tasks.agentSettingsProblems).toEqual([{ field: 'model', value: 'Template-27B' }])
  })

  it("leaves the Session's own Assistant settings as they were", async () => {
    inference.catalog = [{ name: 'Template-27B', type: 'llamaCPP' }]
    const { agentMode, tasks } = await readyStores(task('t1', ['one']))
    const before = { ...agentMode.openSessionSettings }
    const sessionProblems = [{ field: 'model', value: 'Live-9B' }]
    expect(tasks.agentSettingsProblems).toEqual(sessionProblems)

    await tasks.pickAgent('t1')
    expect(agentMode.openSessionSettings).toEqual(before)
    expect(tasks.agentSettingsProblems).toEqual([])

    await tasks.pickAgent(null)
    expect(agentMode.openSessionSettings).toEqual(before)
    expect(tasks.agentSettingsProblems).toEqual(sessionProblems)
  })

  it('runs nothing with ▶ when no Agent is picked', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))

    expect(await tasks.runPickedAgent('hello')).toEqual({ ok: false, reason: 'no-task' })
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('falls back to Assistant in every Session that picked it when deleted', async () => {
    const { tasks } = await readyStores(task('t1', ['one']), task('t2', ['two']))
    const sessions = useSessions(pinia)
    await tasks.pickAgent('t1')
    nextSessionId = 'session-2'
    await sessions.create()
    await tasks.pickAgent('t1')
    nextSessionId = 'session-3'
    await sessions.create()
    await tasks.pickAgent('t2')

    expect(await tasks.deleteTask('t1')).toBe(true)

    expect(tasks.pickedAgentIn(SESSION)).toBeUndefined()
    expect(tasks.pickedAgentIn('session-2')).toBeUndefined()
    expect(tasks.pickedAgentIn('session-3')?.id).toBe('t2')
    expect(storedPicks).toEqual({ 'session-3': 't2' })
  })
})

describe('what the next send runs on', () => {
  it("is the picked Agent's Settings Template, not the Session's settings", async () => {
    const { tasks } = await readyStores(
      task('t1', ['one'], { settingsTemplate: { ...TEMPLATE, backend: 'openVINO' } }),
    )

    await tasks.pickAgent('t1')

    expect(tasks.nextSendInference).toEqual({
      backend: 'openVINO',
      model: 'Template-27B',
      contextWindow: 32768,
    })
  })

  it("fills what the template leaves out from the Assistant's Default Settings, not the Session", async () => {
    const { tasks } = await readyStores(task('t1', ['one'], { settingsTemplate: {} }))

    await tasks.pickAgent('t1')

    expect(tasks.nextSendInference).toEqual({
      backend: 'llamaCPP',
      model: 'Default-4B',
      contextWindow: 4096,
    })
  })

  it("is the Session's own inference with no Agent picked, and again once unpicked", async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    const session = { backend: 'llamaCPP', model: 'Live-9B', contextWindow: 8192 }
    expect(tasks.nextSendInference).toEqual(session)

    await tasks.pickAgent('t1')
    await tasks.pickAgent(null)

    expect(tasks.nextSendInference).toEqual(session)
  })

  it('follows a different Agent when one is picked', async () => {
    const { tasks } = await readyStores(
      task('t1', ['one']),
      task('t2', ['two'], { settingsTemplate: { ...TEMPLATE, model: 'Other-14B' } }),
    )
    await tasks.pickAgent('t1')

    await tasks.pickAgent('t2')

    expect(tasks.nextSendInference.model).toBe('Other-14B')
  })

  it("follows the picked Agent's saved Settings Template, never its unsaved Draft", async () => {
    inference.catalog = [
      { name: 'Template-27B', type: 'llamaCPP' },
      { name: 'Other-14B', type: 'llamaCPP' },
    ]
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.pickAgent('t1')

    await tasks.editDraftSettings('t1', { model: 'Other-14B', contextSize: 16384 })
    expect(tasks.nextSendInference.model).toBe('Template-27B')

    expect((await tasks.saveAgentDraft('t1')).ok).toBe(true)
    expect(tasks.nextSendInference).toEqual({
      backend: 'llamaCPP',
      model: 'Other-14B',
      contextWindow: 16384,
    })
  })
})

describe('following up on a picked Agent’s run', () => {
  const FOLLOW_UP = { agentId: 't1', agentName: 'Task t1' }

  /** Let the turn the `call`-th `startTurn` started finish; resolves with its Harness Session. */
  async function runToEnd(call: number): Promise<string> {
    await turnIdOf(call)
    const harness = sentConfig(call).sessionId
    await finishTurn(call)
    await settleMicrotasks()
    return harness
  }

  it('continues the Harness Session of the Agent’s latest run in the open Session', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.pickAgent('t1')
    await tasks.runPickedAgent('')
    const run = await runToEnd(0)

    expect(await tasks.followUpPickedAgent('why that image?')).toEqual({ ok: true })

    await turnIdOf(1)
    expect(sentPrompts()[1]).toBe('why that image?')
    const config = sentConfig(1)
    expect(config.sessionId).toBe(run)
    expect(config.sessionRef).toBe(SESSION)
    expect(config.followUp).toEqual(FOLLOW_UP)
    expect(config.followedRun).toEqual({ taskName: 'Task t1', startedAt: expect.any(Number) })
    expect(config.taskRun).toBeUndefined()
    expect(window.electronAPI.sessions.harnessSession).not.toHaveBeenCalledWith(
      SESSION,
      expect.stringMatching(/^agent:/),
    )
  })

  it('keeps continuing the same run until the Agent is run again', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.pickAgent('t1')
    await tasks.runPickedAgent('')
    const first = await runToEnd(0)
    await tasks.followUpPickedAgent('first question')
    await runToEnd(1)
    await tasks.followUpPickedAgent('second question')
    await runToEnd(2)
    await tasks.runPickedAgent('')
    const second = await runToEnd(3)
    await tasks.followUpPickedAgent('about the new run')
    await turnIdOf(4)

    expect(second).not.toBe(first)
    expect(startTurn.mock.calls.map(([, , config]) => config.sessionId)).toEqual([
      first,
      first,
      first,
      second,
      second,
    ])
  })

  it('reaches its own Agent’s run when another Agent ran since', async () => {
    const { tasks } = await readyStores(task('t1', ['one']), task('t2', ['two']))
    await tasks.pickAgent('t1')
    await tasks.runPickedAgent('')
    const run = await runToEnd(0)
    await tasks.pickAgent('t2')
    await tasks.runPickedAgent('')
    await runToEnd(1)
    await tasks.pickAgent('t1')

    await tasks.followUpPickedAgent('back to you')

    await turnIdOf(2)
    expect(sentConfig(2).sessionId).toBe(run)
  })

  it('continues a scheduled run, found among the Harness Sessions on disk', async () => {
    storedRecords = [
      runRecord('aipg-agent-manual', { startedAt: 100, trigger: 'manual' }),
      runRecord('aipg-agent-scheduled', { startedAt: 200, trigger: 'scheduled' }),
      runRecord('aipg-agent-elsewhere', { startedAt: 300 }, 'session-other'),
    ]
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.pickAgent('t1')

    expect(await tasks.followUpPickedAgent('what did you find this morning?')).toEqual({
      ok: true,
    })

    await turnIdOf(0)
    expect(sentConfig(0).sessionId).toBe('aipg-agent-scheduled')
  })

  it('is refused with “Run {agent} first” when the Agent has not run in this Session', async () => {
    storedRecords = [runRecord('aipg-agent-elsewhere', { startedAt: 300 }, 'session-other')]
    const { agentMode, tasks } = await readyStores(task('t1', ['one']))
    await tasks.pickAgent('t1')
    const before = Object.keys(agentMode.sessions)

    expect(await tasks.followUpPickedAgent('hello')).toEqual({
      ok: false,
      reason: 'never-run',
      message: 'Run Task t1 first',
    })

    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()
    expect(window.electronAPI.sessions.harnessSession).not.toHaveBeenCalledWith(
      SESSION,
      expect.stringMatching(/^agent:/),
    )
    expect(Object.keys(agentMode.sessions)).toEqual(before)
  })

  it('takes no Follow-up on a chat with the Agent from before Follow-ups, which still loads', async () => {
    storedRecords = [
      {
        id: `chat-t1-${SESSION}`,
        workspaceDir: '/work/files',
        title: 'Task t1',
        messages: [{ id: 'old-u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        createdAt: 1,
        updatedAt: 2,
        presetName: 'Assistant',
        sessionRef: SESSION,
        agentChat: FOLLOW_UP,
      },
    ]
    const { agentMode, tasks } = await readyStores(task('t1', ['one']))
    await tasks.pickAgent('t1')

    expect(agentMode.sessions[`chat-t1-${SESSION}`]?.agentChat).toEqual(FOLLOW_UP)
    expect(await tasks.followUpPickedAgent('hello')).toEqual(
      expect.objectContaining({ ok: false, reason: 'never-run' }),
    )
  })

  it('runs on the Agent’s saved Settings Template, as its run did', async () => {
    const folders = [
      { id: 'n1', hostPath: '/data/news', slug: 'news', access: 'read-only' as const },
    ]
    const { tasks } = await readyStores(
      task('t1', ['one'], { settingsTemplate: { ...TEMPLATE, folderOverrides: { folders } } }),
    )
    giveSessionAFolder()
    await tasks.pickAgent('t1')
    await tasks.runPickedAgent('')
    await runToEnd(0)

    await tasks.followUpPickedAgent('hello')

    await turnIdOf(1)
    const config = sentConfig(1)
    expect(config.modelConfig.model).toBe('Template-27B')
    expect(config.capabilities).toEqual(['files', 'web'])
    expect(config.folderOverrides?.folders?.map((folder) => folder.hostPath)).toEqual([
      '/data/news',
    ])
  })

  it('marks its prompt in the Session timeline as a Follow-up, not a Step', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.pickAgent('t1')
    await tasks.runPickedAgent('')
    await runToEnd(0)

    await tasks.followUpPickedAgent('why?')
    await finishTurn(1)

    await vi.waitFor(() =>
      expect(savedTimelineUserMessages(SESSION).at(-1)?.metadata).toEqual(
        expect.objectContaining({ followUp: FOLLOW_UP }),
      ),
    )
    expect(savedTimelineUserMessages(SESSION)[0].metadata).not.toHaveProperty('followUp')
  })

  it('answers a question the run ended on, with its Steps still in context', async () => {
    const { agentMode, tasks } = await readyStores(task('t1', ['ask me which city', 'forecast it']))
    await tasks.pickAgent('t1')
    await tasks.runPickedAgent('')
    const run = await runToEnd(0)
    expect(tasks.pickedAgentComposer).toMatchObject({ primary: 'send' })

    expect(await tasks.followUpPickedAgent('Berlin')).toEqual({ ok: true })

    await turnIdOf(1)
    expect(sentConfig(1).sessionId).toBe(run)
    const transcript = JSON.stringify(agentMode.sessions[run].messages)
    expect(transcript).toContain('1. ask me which city')
    expect(transcript).toContain('2. forecast it')
  })

  it.each([
    ['completes', (call: number) => finishTurn(call)],
    ['fails', (call: number) => failTurn(call, 'boom')],
  ] as const)('leaves the Agent’s last outcome alone when it %s', async (_how, end) => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.pickAgent('t1')
    await tasks.runPickedAgent('')
    await runToEnd(0)
    const outcome = await settledOutcome(tasks, 't1')
    const saves = saveTask.mock.calls.length

    await tasks.followUpPickedAgent('more')
    await end(1)
    await settleMicrotasks()

    expect(tasks.taskState('t1')).toEqual({ idle: outcome })
    expect(saveTask.mock.calls.slice(saves).map(([saved]) => saved.lastOutcome)).not.toContainEqual(
      expect.objectContaining({ kind: 'failed' }),
    )
  })

  it('is refused with the reason when the Settings Template has a problem', async () => {
    inference.catalog = [{ name: 'Other-9B', type: 'llamaCPP' }]
    storedRecords = [runRecord('aipg-agent-manual', { startedAt: 100 })]
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.pickAgent('t1')

    expect(await tasks.followUpPickedAgent('hello')).toEqual(
      expect.objectContaining({ ok: false, reason: 'settings-problems' }),
    )
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('asks to download the Agent’s chat model first', async () => {
    inference.missing = new Set(['Template-27B'])
    storedRecords = [runRecord('aipg-agent-manual', { startedAt: 100 })]
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.pickAgent('t1')

    await tasks.followUpPickedAgent('hello')

    expect(requestDownload.mock.calls[0][0]).toEqual([
      expect.objectContaining({ repo_id: 'Template-27B' }),
    ])
    await turnIdOf(0)
  })

  it('sends nothing when no Agent is picked', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))

    expect(await tasks.followUpPickedAgent('hello')).toEqual({ ok: false, reason: 'no-task' })
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()
  })
})

/** A finished Agent Run of `t1` on disk, as its Harness Session record. */
function runRecord(
  id: string,
  run: { startedAt: number; trigger?: 'manual' | 'scheduled' },
  sessionRef = SESSION,
): Record<string, unknown> {
  return {
    id,
    workspaceDir: '/work/task',
    title: 'Task t1',
    messages: [{ id: `${id}-u1`, role: 'user', parts: [{ type: 'text', text: 'one' }] }],
    createdAt: run.startedAt,
    updatedAt: run.startedAt,
    presetName: 'Assistant',
    settings: TEMPLATE,
    taskId: 't1',
    sessionRef,
    taskRun: { taskId: 't1', taskName: 'Task t1', ...run },
  }
}

/** The user messages the Session's saved timeline holds, the last save of each winning. */
function savedTimelineUserMessages(sessionRef: string): { id: string; metadata?: object }[] {
  const save = vi.mocked(window.electronAPI.sessions.saveTimelineMessages)
  const latest = new Map<string, { id: string; role: string; metadata?: object }>()
  for (const [ref, messages] of save.mock.calls) {
    if (ref !== sessionRef) continue
    for (const message of messages as { id: string; role: string; metadata?: object }[]) {
      latest.set(message.id, message)
    }
  }
  return [...latest.values()].filter((message) => message.role === 'user')
}

describe('a prompt sent while an Agent Run is in flight in its Session', () => {
  /** Main's one-turn-per-Session ledger, as its kernel event reports it. */
  function setSessionTurns(turns: Record<string, { turnId: string; kind: 'agent' | 'chat' }>) {
    pushEvent({ type: 'session-turns', turns })
  }

  /** Whether `promise` has settled yet, and with what. */
  function track<T>(promise: Promise<T>): { settled: boolean; value?: T } {
    const state: { settled: boolean; value?: T } = { settled: false }
    void promise.then((value) => {
      state.settled = true
      state.value = value
    })
    return state
  }

  it('goes ahead at once when the Session has no run', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))

    expect(await tasks.afterAgentRun(SESSION)).toBe(true)
  })

  it('waits until the run’s turn settled', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)

    const prompt = track(tasks.afterAgentRun(SESSION))
    await settleMicrotasks()
    expect(prompt.settled).toBe(false)

    await finishTurn(0)

    await vi.waitFor(() => expect(prompt).toEqual({ settled: true, value: true }))
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it('names the Agent Run it waits for, until it goes ahead', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await turnIdOf(0)

    const prompt = tasks.afterAgentRun(SESSION)
    expect(tasks.queuedPrompts).toEqual({ [SESSION]: { behind: 'agent-run', name: 'Task t1' } })

    await finishTurn(0)
    await prompt
    expect(tasks.queuedPrompts).toEqual({})
  })

  it('waits for main to let go of the last Step’s turn too', async () => {
    const { tasks } = await readyStores(task('t1', ['one']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    setSessionTurns({ [SESSION]: { turnId: 'step-1', kind: 'agent' } })

    const prompt = track(tasks.afterAgentRun(SESSION))
    await finishTurn(0)
    await settledOutcome(tasks, 't1')
    await settleMicrotasks()
    expect(prompt.settled).toBe(false)

    setSessionTurns({})

    await vi.waitFor(() => expect(prompt).toEqual({ settled: true, value: true }))
  })

  it('does not hold back a prompt in another Session', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)

    expect(await tasks.afterAgentRun('session-2')).toBe(true)
    expect(tasks.queuedPrompts).toEqual({})
  })

  it('goes ahead when the run is stopped', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const prompt = tasks.afterAgentRun(SESSION)

    await tasks.stopTask('t1')

    expect(await prompt).toBe(true)
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it('goes ahead when a Step fails', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const prompt = tasks.afterAgentRun(SESSION)

    await failTurn(0, 'model crashed')

    expect(await prompt).toBe(true)
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it('is dropped when cancelled, and the run goes on', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const prompt = tasks.afterAgentRun(SESSION)

    tasks.cancelQueuedPrompt(SESSION)

    expect(await prompt).toBe(false)
    expect(tasks.queuedPrompts).toEqual({})
    expect(tasks.taskState('t1')).toEqual({ running: expect.objectContaining({ taskId: 't1' }) })
  })

  it('is handed back to its own Session, and said so, when another Session is opened', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)
    const prompt = tasks.afterAgentRun(SESSION, 'summarise the logs')

    await useSessions(pinia).open('session-2')

    expect(await prompt).toBe(false)
    expect(errorsReport).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'toast', severity: 'info' }),
    )
    expect(tasks.takeUnsentPrompt('session-2')).toBeUndefined()
    expect(tasks.takeUnsentPrompt(SESSION)).toBe('summarise the logs')
    expect(tasks.takeUnsentPrompt(SESSION)).toBeUndefined()
  })

  it('waits until the Channel messages queued in its Session have run', async () => {
    const { tasks } = await readyStores()
    const queuedChannelMessages = useQueuedChannelMessages(pinia)
    queuedChannelMessages.publish(SESSION, [{ id: 'q1', channel: 'telegram', text: 'add Kyoto' }])

    const prompt = track(tasks.afterAgentRun(SESSION))
    expect(tasks.queuedPrompts).toEqual({ [SESSION]: { behind: 'channel-messages' } })

    queuedChannelMessages.publish(SESSION, [])
    queuedChannelMessages.setSending(SESSION, true)
    await settleMicrotasks()
    expect(prompt.settled).toBe(false)

    setSessionTurns({ [SESSION]: { turnId: 'from-telegram', kind: 'agent' } })
    queuedChannelMessages.setSending(SESSION, false)
    await settleMicrotasks()
    expect(prompt.settled).toBe(false)

    setSessionTurns({})

    await vi.waitFor(() => expect(prompt).toEqual({ settled: true, value: true }))
    expect(tasks.queuedPrompts).toEqual({})
  })

  it('knows the run in the Session and stops it from there, as the prompt bar does', async () => {
    const { tasks } = await readyStores(task('t1', ['one', 'two']))
    await tasks.runTask('t1')
    await turnIdOf(0)

    expect(tasks.agentRunIn(SESSION)?.id).toBe('t1')
    expect(tasks.agentRunIn('session-2')).toBeUndefined()

    await tasks.stopRunIn(SESSION)

    expect(tasks.agentRunIn(SESSION)).toBeUndefined()
    expect(startTurn).toHaveBeenCalledTimes(1)
  })
})

describe('a running Follow-up', () => {
  const reported = () =>
    vi.mocked(window.electronAPI.reportInFlightWork).mock.calls.at(-1)?.[0] ?? []

  async function followUpRunning() {
    window.electronAPI.reportInFlightWork = vi.fn()
    const stores = await readyStores(task('t1', ['ask me which city', 'forecast it']))
    await stores.tasks.pickAgent('t1')
    await stores.tasks.runPickedAgent('')
    await turnIdOf(0)
    const run = sentConfig(0).sessionId
    await finishTurn(0)
    const outcome = await settledOutcome(stores.tasks, 't1')
    await stores.tasks.followUpPickedAgent('Berlin')
    const turnId = await turnIdOf(1)
    await vi.waitFor(() => expect(stores.agentMode.sessionTurns[run]).toBeDefined())
    return { ...stores, run, turnId, outcome }
  }

  it('is the Agent Run in flight in its Session', async () => {
    const { tasks } = await followUpRunning()

    expect(tasks.agentRunIn(SESSION)?.id).toBe('t1')
    expect(tasks.agentRunIn('session-2')).toBeUndefined()
  })

  it('is reported as the Agent Run running', async () => {
    const { run } = await followUpRunning()

    await vi.waitFor(() =>
      expect(reported()).toEqual([
        {
          kind: 'task-run',
          taskId: 't1',
          sessionId: run,
          name: 'Task t1',
          state: { status: 'running' },
        },
      ]),
    )
  })

  it('is stopped as the Agent Run, leaving the Agent’s last outcome alone', async () => {
    const { tasks, run, turnId, outcome } = await followUpRunning()
    const saves = saveTask.mock.calls.length

    await tasks.stopRunIn(SESSION)

    expect(vi.mocked(window.electronAPI.agentMode.cancel)).toHaveBeenCalledWith(run, turnId)
    await settleMicrotasks()
    expect(tasks.taskState('t1')).toEqual({ idle: outcome })
    expect(saveTask.mock.calls.length).toBe(saves)
  })

  it('holds a prompt sent meanwhile as behind the Agent Run', async () => {
    const { tasks } = await followUpRunning()

    void tasks.afterAgentRun(SESSION)

    expect(tasks.queuedPrompts).toEqual({ [SESSION]: { behind: 'agent-run', name: 'Task t1' } })
  })
})

describe('a question an Agent Run asks', () => {
  async function runAsking(before?: (stores: Awaited<ReturnType<typeof readyStores>>) => void) {
    const stores = await readyStores(task('t1', ['one']))
    stores.agentMode.setViewShown(true)
    before?.(stores)
    await stores.tasks.runTask('t1')
    await turnIdOf(0)
    const asked = { shown: false }
    const shown = whenSessionInView(sentConfig(0).sessionId).then(() => {
      asked.shown = true
    })
    await settleMicrotasks()
    return { ...stores, asked, shown }
  }

  it('shows at once while its Session is showing', async () => {
    const { asked } = await runAsking()
    expect(asked.shown).toBe(true)
  })

  it('shows at once while its Session is showing under a Media Mode', async () => {
    const { asked } = await runAsking(({ agentMode }) => agentMode.setViewShown(false))
    expect(asked.shown).toBe(true)
  })

  it('waits while another Session is showing, and shows once its own is opened', async () => {
    const stores = await readyStores(task('t1', ['one']))
    stores.agentMode.setViewShown(true)
    await stores.tasks.runTask('t1')
    await turnIdOf(0)
    const sessions = useSessions(pinia)
    nextSessionId = 'session-2'
    await sessions.create()

    const asked = { shown: false }
    const shown = whenSessionInView(sentConfig(0).sessionId).then(() => {
      asked.shown = true
    })
    await settleMicrotasks()
    expect(asked.shown).toBe(false)

    await sessions.open(SESSION)
    await shown
    expect(asked.shown).toBe(true)
  })

  it('waits while a Library covers its Session, and shows once it closes', async () => {
    const { agentMode, asked, shown } = await runAsking(({ agentMode }) =>
      agentMode.setLibraryShowing({ library: 'model' }),
    )
    expect(asked.shown).toBe(false)

    agentMode.setLibraryHidden('model')
    await shown
    expect(asked.shown).toBe(true)
  })
})
