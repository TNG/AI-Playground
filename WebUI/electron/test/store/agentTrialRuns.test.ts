import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { AgentDraft, AgentTask, TrialRunRecord } from '@/types/agentTaskIpc'
import type { InFlightWorkItem } from '@/types/lifecycleIpc'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// Trial Runs: the Agents store runs an Agent's Draft from the Agent Library in a
// fresh Harness Session that belongs to no Session. Driven through the Agents
// store against the real Agent Mode store, with a fake electronAPI and kernel
// events delivered through the registered listener.

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
vi.mock('@/assets/js/store/demoMode', () => ({ useDemoMode: () => ({ enabled: false }) }))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: errorsReport }) }))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({
    langName: 'en-US',
    state: {
      AGENT_SESSION_NEEDS_INPUT: "Session '{title}' needs your input",
      AGENT_LIBRARY_TRIAL_RUN_NEEDS_INPUT: "Trial Run of '{name}' needs your input",
      AGENT_SESSION_OPEN: 'Open',
    },
  }),
}))

const toastShow = vi.hoisted(() => vi.fn())
vi.mock('@/assets/js/toast', () => ({ show: (...args: unknown[]) => toastShow(...args) }))

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
  presetName: 'Agent',
  settings: { backend: 'llamaCPP', model: 'Live-9B', capabilities: ['files'] },
}

let storedTasks: AgentTask[]
let storedDrafts: AgentDraft[]
/** Main's Trial Run folders: the Harness Session each Agent's holds, and its kept progress. */
let trialFolders: Record<string, { harnessSessionId: string; run?: TrialRunRecord }>
const reportInFlightWork = vi.fn((_work: InFlightWorkItem[]) => {})
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
let trialHarnesses = 0
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
  storedDrafts = []
  trialFolders = {}
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
        harnessSession: vi.fn(async (sessionRef: string) => ({
          success: true,
          harness:
            sessionRef === SESSION
              ? { harnessSessionId: 'session-open', workspaceDir: '/work/open' }
              : { harnessSessionId: `harness-${sessionRef}`, workspaceDir: '/work/open' },
        })),
        delete: vi.fn(async () => ({ success: true })),
        open: vi.fn(async (id: string) => ({
          success: true,
          session: {
            id,
            title: '',
            renamed: false,
            createdAt: 1,
            updatedAt: 1,
            presetsUsed: [],
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
        readDrafts: vi.fn(async () => ({ success: true, drafts: storedDrafts })),
        saveDraft: vi.fn(async () => ({ success: true })),
        deleteDraft: vi.fn(async () => ({ success: true })),
        trialRunHarness: vi.fn(async (agentId: string) => {
          const harnessSessionId = `aipg-agent-trial-${++trialHarnesses}`
          trialFolders[agentId] = { harnessSessionId }
          return {
            success: true,
            harness: { harnessSessionId, workspaceDir: `/trials/${agentId}/files` },
          }
        }),
        discardTrialRun: vi.fn(async (agentId: string) => {
          delete trialFolders[agentId]
          return { success: true }
        }),
        readTrialRuns: vi.fn(async () => ({
          success: true,
          trialRuns: Object.values(trialFolders).flatMap((folder) =>
            folder.run ? [structuredClone(folder.run)] : [],
          ),
        })),
        saveTrialRun: vi.fn(async (run: TrialRunRecord) => {
          const folder = trialFolders[run.agentId]
          if (folder?.harnessSessionId === run.harnessSessionId) folder.run = structuredClone(run)
          return { success: true }
        }),
      },
      reportInFlightWork,
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
const { useAgentTrialRuns } = await import('@/assets/js/store/agentTrialRuns')
const { useSessions } = await import('@/assets/js/store/sessions')
const { useUIStore } = await import('@/assets/js/store/ui')
const { trialRunItems } = await import('@/lib/trialRunTimeline')

async function readyStores(...saved: AgentTask[]) {
  return readyStoresIn({ session: true }, ...saved)
}

async function readyStoresIn(options: { session: boolean }, ...saved: AgentTask[]) {
  storedTasks = saved
  const trials = useAgentTrialRuns(pinia)
  const agentMode = useAgentMode(pinia)
  await agentMode.init()
  if (options.session) await useSessions(pinia).create()
  const tasks = useAgentTasks(pinia)
  await tasks.init()
  await trials.init()
  return { agentMode, tasks, trials }
}

const sentPrompts = () => startTurn.mock.calls.map(([, prompt]) => prompt)
/** A Step's turn carries the run's framing; its last line, minus `Step i of n: `, is the Step. */
const sentSteps = () =>
  sentPrompts().map((prompt) => (prompt.split('\n').at(-1) ?? '').replace(/^Step \d+ of \d+: /, ''))
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

const draftOf = (
  id: string,
  prompts: string[],
  overrides: Partial<AgentDraft> = {},
): AgentDraft => ({
  agentId: id,
  name: `Draft ${id}`,
  settingsTemplate: TEMPLATE,
  steps: prompts.map((prompt, index) => ({ id: `${id}-d${index}`, prompt })),
  updatedAt: 5,
  ...overrides,
})

describe('a Trial Run', () => {
  it('runs the Draft’s Steps, not the saved Agent’s', async () => {
    storedDrafts = [draftOf('t1', ['draft step'])]
    const { trials } = await readyStores(task('t1', ['saved step']))

    expect(await trials.startTrialRun('t1')).toEqual({ ok: true })

    await turnIdOf(0)
    expect(sentSteps()).toEqual(['draft step'])
    expect(window.electronAPI.agentMode.trialRunHarness).toHaveBeenCalledWith('t1')
  })

  it('runs a saved Agent that has no Draft', async () => {
    const { trials } = await readyStores(task('t1', ['saved step']))

    expect(await trials.startTrialRun('t1')).toEqual({ ok: true })

    await turnIdOf(0)
    expect(sentSteps()).toEqual(['saved step'])
  })

  it('runs an Agent that exists only as a Draft', async () => {
    storedDrafts = [draftOf('new-1', ['first'])]
    const { trials } = await readyStores()

    expect(await trials.startTrialRun('new-1')).toEqual({ ok: true })

    await turnIdOf(0)
    expect(sentSteps()).toEqual(['first'])
  })

  it('runs the Draft as it is when Run is pressed, unsaved Step edits included', async () => {
    const { tasks, trials } = await readyStores(task('t1', ['saved step']))
    await tasks.editDraft('t1', { steps: [{ id: 'x', prompt: 'just typed' }] })

    await trials.startTrialRun('t1')

    await turnIdOf(0)
    expect(sentSteps()).toEqual(['just typed'])
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('belongs to no Session', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two'])]
    const { agentMode, trials } = await readyStores(task('t1', ['saved']))

    await trials.startTrialRun('t1')
    await finishTurn(0)
    await finishTurn(1)
    await vi.waitFor(() => expect(trials.trialRuns.t1?.state).toBe('completed'))

    expect(sentConfig(0).sessionRef).toBeUndefined()
    expect(sentConfig(1).sessionRef).toBeUndefined()
    expect(window.electronAPI.sessions.taskRunHarness).not.toHaveBeenCalled()
    expect(window.electronAPI.sessions.saveTimelineMessages).not.toHaveBeenCalled()
    expect(agentMode.liveTurnsIn(SESSION).map((turn) => turn.tag.harnessSessionId)).not.toContain(
      trials.trialRuns.t1.harnessSessionId,
    )
    expect(Object.keys(useSessions(pinia).sessions)).toEqual([SESSION])
  })

  it('runs its Steps one after another and ends after the last', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two', 'three'])]
    const { trials } = await readyStores()

    await trials.startTrialRun('t1')
    await finishTurn(0)
    await finishTurn(1)
    await finishTurn(2)

    await vi.waitFor(() => expect(trials.trialRuns.t1?.state).toBe('completed'))
    expect(sentSteps()).toEqual(['one', 'two', 'three'])
  })

  it('stops when the user stops it', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two'])]
    const { trials } = await readyStores()
    await trials.startTrialRun('t1')
    const turnId = await turnIdOf(0)

    await trials.stopTrialRun('t1')
    await settleMicrotasks()

    expect(trials.trialRuns.t1.state).toBe('stopped')
    expect(window.electronAPI.agentMode.cancel).toHaveBeenCalledWith(
      trials.trialRuns.t1.harnessSessionId,
      turnId,
    )
    expect(sentSteps()).toEqual(['one'])
  })

  it('can be stopped while it waits on its chat model, and then does not start', async () => {
    inference.missing = new Set(['Template-27B'])
    let finishDownload = () => {}
    requestDownload.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()
    const started = trials.startTrialRun('t1')
    await vi.waitFor(() => expect(requestDownload).toHaveBeenCalled())

    await trials.stopTrialRun('t1')

    expect(trials.trialRunInFlight('t1')).toBe(false)
    finishDownload()
    expect(await started).toEqual({ ok: false, reason: 'stopped' })
    await settleMicrotasks()
    expect(window.electronAPI.agentMode.trialRunHarness).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
    expect(trials.trialRuns.t1).toBeUndefined()
  })

  it('is refused while the Agent already has one in flight', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()
    await trials.startTrialRun('t1')
    await turnIdOf(0)

    expect(await trials.startTrialRun('t1')).toEqual({ ok: false, reason: 'running' })
    expect(window.electronAPI.agentMode.trialRunHarness).toHaveBeenCalledTimes(1)
  })

  it('runs beside a Trial Run of another Agent', async () => {
    storedDrafts = [draftOf('t1', ['one']), draftOf('t2', ['two'])]
    const { trials } = await readyStores()

    await trials.startTrialRun('t1')
    expect(await trials.startTrialRun('t2')).toEqual({ ok: true })

    await turnIdOf(1)
    expect(sentSteps().sort()).toEqual(['one', 'two'])
  })

  it('throws the previous Trial Run of the Agent away when the next one starts', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { agentMode, trials } = await readyStores()
    await trials.startTrialRun('t1')
    await finishTurn(0)
    await vi.waitFor(() => expect(trials.trialRuns.t1?.state).toBe('completed'))
    const previous = trials.trialRuns.t1.harnessSessionId
    expect(agentMode.sessions[previous]).toBeDefined()

    await trials.startTrialRun('t1')

    expect(trials.trialRuns.t1.harnessSessionId).not.toBe(previous)
    expect(agentMode.sessions[previous]).toBeUndefined()
    expect(window.electronAPI.agentMode.deleteSession).toHaveBeenCalledWith(previous)
  })

  it('keeps the last Trial Run until the next one starts', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { agentMode, tasks, trials } = await readyStores()
    await trials.startTrialRun('t1')
    await finishTurn(0)
    await vi.waitFor(() => expect(trials.trialRuns.t1?.state).toBe('completed'))

    await tasks.editDraft('t1', { steps: [{ id: 'x', prompt: 'changed' }] })

    const record = agentMode.sessions[trials.trialRuns.t1.harnessSessionId]
    expect(record.messages.length).toBeGreaterThan(0)
    expect(window.electronAPI.agentMode.deleteSession).not.toHaveBeenCalled()
  })

  it('is thrown away with the Agent', async () => {
    const { agentMode, tasks, trials } = await readyStores(task('t1', ['one']))
    await trials.startTrialRun('t1')
    await finishTurn(0)
    await vi.waitFor(() => expect(trials.trialRuns.t1?.state).toBe('completed'))
    const harness = trials.trialRuns.t1.harnessSessionId

    await tasks.deleteTask('t1')

    expect(trials.trialRuns.t1).toBeUndefined()
    expect(agentMode.sessions[harness]).toBeUndefined()
    expect(window.electronAPI.agentMode.discardTrialRun).toHaveBeenCalledWith('t1')
  })

  it('is not started for a Draft without Steps', async () => {
    storedDrafts = [draftOf('t1', [])]
    const { trials } = await readyStores()

    expect(await trials.startTrialRun('t1')).toEqual({ ok: false, reason: 'no-steps' })
    expect(window.electronAPI.agentMode.trialRunHarness).not.toHaveBeenCalled()
  })

  it('asks before downloading the Draft’s chat model, and does not start when declined', async () => {
    inference.missing = new Set(['Template-27B'])
    requestDownload.mockImplementation(async () => {
      const { createCancellation } = await import('@/assets/js/errors/appError')
      throw createCancellation({ technicalMessage: 'declined' })
    })
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()

    const result = await trials.startTrialRun('t1')

    expect(result).toMatchObject({ ok: false, reason: 'download-declined' })
    expect(requestDownload).toHaveBeenCalled()
    expect(window.electronAPI.agentMode.trialRunHarness).not.toHaveBeenCalled()
  })

  it('fails when a Step fails, keeping why', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two'])]
    const { trials } = await readyStores()
    await trials.startTrialRun('t1')
    const turnId = await turnIdOf(0)
    const sessionId = sentConfig(0).sessionId
    pushEvent({ type: 'agent-chunk', sessionId, turnId, chunk: { type: 'start' } })
    pushEvent({
      type: 'agent-chunk',
      sessionId,
      turnId,
      chunk: { type: 'error', errorText: 'boom' },
    })
    pushEvent({ type: 'agent-turn-done', sessionId, turnId })

    await vi.waitFor(() => expect(trials.trialRuns.t1?.state).toBe('failed'))
    await settleMicrotasks()
    expect(trials.trialRuns.t1.message).toContain('boom')
    expect(sentSteps()).toEqual(['one'])
  })

  it('shows in the Agent Library as a conversation, one Step after another', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two'])]
    const { trials } = await readyStores()
    await trials.startTrialRun('t1')
    await finishTurn(0)
    await turnIdOf(1)

    const running = trialRunItems(trials.trialRunView('t1')!)
    expect(running).toMatchObject([
      { prompt: { text: sentPrompts()[0], step: 1 } },
      { prompt: { text: sentPrompts()[1], step: 2 } },
    ])

    await finishTurn(1)
    await vi.waitFor(() => expect(trials.trialRuns.t1?.state).toBe('completed'))
    const ended = trialRunItems(trials.trialRunView('t1')!)
    expect(ended).toHaveLength(2)
    expect(ended[1]).toMatchObject({
      kind: 'agent',
      footer: { actions: ['copy', 'speak'], text: 'done' },
    })
  })

  it('puts the input it was started with into Step 1, and shows Step 1 as sent', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two'])]
    const { trials } = await readyStores()

    await trials.startTrialRun('t1', { input: 'Only sports' })
    await finishTurn(0)
    await turnIdOf(1)

    expect(sentPrompts()[0]).toContain('For this run the user added: "Only sports"')
    expect(sentPrompts()[1]).not.toContain('Only sports')
    expect(trialRunItems(trials.trialRunView('t1')!)[0]).toMatchObject({
      prompt: { text: sentPrompts()[0], step: 1 },
    })
  })
})

/** Run the Agent's Trial Run of one Step to its end; its Harness Session. */
async function trialToEnd(
  trials: ReturnType<typeof useAgentTrialRuns>,
  agentId: string,
  call: number,
): Promise<string> {
  await trials.startTrialRun(agentId)
  await finishTurn(call)
  await vi.waitFor(() => expect(trials.trialRuns[agentId]?.state).toBe('completed'))
  return trials.trialRuns[agentId].harnessSessionId
}

/** Send a Follow-up to the Agent's Trial Run and let it finish. */
async function followUpToEnd(
  trials: ReturnType<typeof useAgentTrialRuns>,
  agentId: string,
  prompt: string,
  call: number,
): Promise<void> {
  expect(await trials.followUpTrialRun(agentId, prompt)).toEqual({ ok: true })
  await finishTurn(call)
  await settleMicrotasks()
}

describe('a Follow-up to a Trial Run', () => {
  it('continues the Trial Run’s Harness Session, on the Draft as the run started', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { tasks, trials } = await readyStores()
    const trial = await trialToEnd(trials, 't1', 0)
    await tasks.editDraftSettings('t1', { model: 'Edited-4B' })

    expect(await trials.followUpTrialRun('t1', 'why that answer?')).toEqual({ ok: true })

    await turnIdOf(1)
    expect(sentPrompts()[1]).toBe('why that answer?')
    expect(sentConfig(1)).toMatchObject({
      sessionId: trial,
      capabilities: ['files', 'web'],
      modelConfig: { model: 'Template-27B' },
      followUp: { agentId: 't1', agentName: 'Draft t1' },
    })
    expect(sentConfig(1).sessionRef).toBeUndefined()
    expect(sentConfig(1).taskRun).toBeUndefined()
  })

  it('continues after a Follow-up in the same Harness Session', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()
    const trial = await trialToEnd(trials, 't1', 0)
    await followUpToEnd(trials, 't1', 'first', 1)

    expect(await trials.followUpTrialRun('t1', 'second')).toEqual({ ok: true })

    await turnIdOf(2)
    expect(sentConfig(2).sessionId).toBe(trial)
  })

  it('is refused before the Agent had a Trial Run, starting nothing', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()

    expect(await trials.followUpTrialRun('t1', 'hello')).toMatchObject({
      ok: false,
      reason: 'never-run',
    })
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()
    expect(window.electronAPI.agentMode.trialRunHarness).not.toHaveBeenCalled()
  })

  it('is refused while the Trial Run is still running', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two'])]
    const { trials } = await readyStores()
    await trials.startTrialRun('t1')
    await turnIdOf(0)

    expect(await trials.followUpTrialRun('t1', 'hello')).toEqual({ ok: false, reason: 'running' })
  })

  it('keeps the Trial Run in flight while it runs, and Stop stops it', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()
    const trial = await trialToEnd(trials, 't1', 0)
    await trials.followUpTrialRun('t1', 'why?')
    const turnId = await turnIdOf(1)

    await vi.waitFor(() => expect(trials.trialRunInFlight('t1')).toBe(true))
    await trials.stopTrialRun('t1')

    expect(window.electronAPI.agentMode.cancel).toHaveBeenCalledWith(trial, turnId)
    expect(trials.trialRunInFlight('t1')).toBe(false)
    expect(trials.trialRuns.t1.state).toBe('completed')
  })

  it('shows as a plain prompt after the Steps, not as another Step', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()
    await trialToEnd(trials, 't1', 0)
    await followUpToEnd(trials, 't1', 'why?', 1)

    const items = trialRunItems(trials.trialRunView('t1')!)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ prompt: { step: 1 } })
    expect(items[1]).toMatchObject({ prompt: { text: 'why?' } })
    expect(items[1].kind === 'agent' && items[1].prompt?.step).toBeUndefined()
  })

  it('is thrown away with its Trial Run when the next Trial Run starts', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { agentMode, trials } = await readyStores()
    const previous = await trialToEnd(trials, 't1', 0)
    await followUpToEnd(trials, 't1', 'why?', 1)

    const next = await trialToEnd(trials, 't1', 2)

    expect(next).not.toBe(previous)
    expect(agentMode.sessions[previous]).toBeUndefined()
    expect(window.electronAPI.agentMode.deleteSession).toHaveBeenCalledWith(previous)
    const prompts = trialRunItems(trials.trialRunView('t1')!).map((item) =>
      item.kind === 'agent' ? item.prompt?.text : undefined,
    )
    expect(prompts).not.toContain('why?')

    await trials.followUpTrialRun('t1', 'and now?')
    await turnIdOf(3)
    expect(sentConfig(3).sessionId).toBe(next)
  })
})

describe('the Trial Run composer', () => {
  it('makes Run primary with Send disabled before any Trial Run', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()

    expect(trials.trialComposer('t1')).toEqual({
      primary: 'run',
      sendEnabled: false,
      reason: 'never-run',
    })
  })

  it('makes Send primary once the Trial Run ran, and after its Follow-ups', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()
    await trialToEnd(trials, 't1', 0)
    expect(trials.trialComposer('t1')).toEqual({ primary: 'send', sendEnabled: true })

    await followUpToEnd(trials, 't1', 'why?', 1)
    expect(trials.trialComposer('t1')).toEqual({ primary: 'send', sendEnabled: true })
  })

  it('makes Run primary once the Draft is edited after the run started, Send still enabled', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { tasks, trials } = await readyStores()
    await trialToEnd(trials, 't1', 0)
    await settleMicrotasks()

    await tasks.editDraft('t1', { steps: [{ id: 'x', prompt: 'changed' }] })

    expect(trials.trialComposer('t1')).toEqual({
      primary: 'run',
      sendEnabled: true,
      reason: 'agent-edited',
    })
  })

  it('keeps Send primary when the Draft the run used is saved after it', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { tasks, trials } = await readyStores(task('t1', ['saved step']))
    await trialToEnd(trials, 't1', 0)
    await settleMicrotasks()

    expect(await tasks.saveAgentDraft('t1')).toMatchObject({ ok: true })

    expect(trials.trialComposer('t1')).toEqual({ primary: 'send', sendEnabled: true })
  })

  it('keeps Send primary when a Draft edit is undone', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { tasks, trials } = await readyStores()
    await trialToEnd(trials, 't1', 0)
    await settleMicrotasks()

    await tasks.editDraft('t1', { steps: [{ id: 'x', prompt: 'changed' }] })
    await tasks.editDraft('t1', { steps: [{ id: 'x', prompt: 'one' }] })

    expect(trials.trialComposer('t1')).toEqual({ primary: 'send', sendEnabled: true })
  })

  it('makes Run primary when discarding the Draft leaves a different saved Agent', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { tasks, trials } = await readyStores(task('t1', ['saved step']))
    await trialToEnd(trials, 't1', 0)
    await settleMicrotasks()

    await tasks.discardAgentDraft('t1')

    expect(trials.trialComposer('t1')).toMatchObject({ primary: 'run', reason: 'agent-edited' })
  })

  it('makes Send primary after a stopped Trial Run', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two'])]
    const { trials } = await readyStores()
    await trials.startTrialRun('t1')
    await turnIdOf(0)
    await trials.stopTrialRun('t1')

    expect(trials.trialComposer('t1')).toEqual({ primary: 'send', sendEnabled: true })
  })
})

const lastReport = () => reportInFlightWork.mock.calls.at(-1)?.[0] ?? []
const trialWork = () => lastReport().filter((item) => item.kind === 'trial-run')

function snapshotWith(agentTurns: KernelSnapshot['state']['agentTurns']): KernelSnapshot {
  return {
    scope: { kind: 'global' },
    sequence: 5,
    state: {
      services: [],
      agentTurns,
      activeArtifactRun: null,
      chatTurns: [],
      activities: [],
      inferenceProfile: null,
    },
  }
}

/** A new window over the same main: fresh stores, the Harness Session records main kept. */
async function reloadWindow(
  records: Record<string, unknown>[],
  agentTurns: KernelSnapshot['state']['agentTurns'],
) {
  const { unregisterAgentModeIpc } = await import('@/assets/js/store/agentModeIpc')
  unregisterAgentModeIpc()
  kernelListeners.clear()
  startTurn.mockClear()
  pinia = createPinia()
  setActivePinia(pinia)
  vi.mocked(window.electronAPI.agentMode.bootstrapSessions).mockResolvedValue({
    status: 'ok',
    activeSessionId: 'session-open',
    sessions: [openRecord, ...records],
  } as never)
  vi.mocked(window.electronAPI.getKernelSnapshot).mockResolvedValue(snapshotWith(agentTurns))
  return readyStores()
}

describe('a Trial Run outliving the Agent Library', () => {
  it('is In-flight Work while it runs, and no longer once it ended', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two'])]
    const { trials } = await readyStores()

    await trials.startTrialRun('t1')
    await finishTurn(0)
    await turnIdOf(1)

    expect(trialWork()).toEqual([
      {
        kind: 'trial-run',
        agentId: 't1',
        sessionId: trials.trialRuns.t1.harnessSessionId,
        name: 'Draft t1',
        state: { status: 'step', index: 2, count: 2 },
      },
    ])

    await finishTurn(1)
    await vi.waitFor(() => expect(trials.trialRuns.t1?.state).toBe('completed'))
    expect(trialWork()).toEqual([])
  })

  it('is In-flight Work while its chat model is being downloaded', async () => {
    inference.missing = new Set(['Template-27B'])
    let finishDownload = () => {}
    requestDownload.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()

    const started = trials.startTrialRun('t1')
    await vi.waitFor(() => expect(requestDownload).toHaveBeenCalled())

    expect(trialWork()).toEqual([
      { kind: 'trial-run', agentId: 't1', name: 'Draft t1', state: { status: 'starting' } },
    ])
    finishDownload()
    await started
  })

  it('lists every Agent whose Trial Run is in flight, for the header', async () => {
    storedDrafts = [draftOf('t1', ['one']), draftOf('t2', ['two'])]
    const { trials } = await readyStores()
    expect(trials.trialRunsInFlight).toEqual([])

    await trials.startTrialRun('t1')
    await trials.startTrialRun('t2')
    await turnIdOf(1)
    expect([...trials.trialRunsInFlight].sort()).toEqual(['t1', 't2'])

    await finishTurn(0)
    await vi.waitFor(() => expect(trials.trialRunsInFlight).toHaveLength(1))
  })

  it('finds a Trial Run by its Agent and by its Harness Session', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()
    expect(trials.trialRunSessionOf('t1')).toBeUndefined()

    await trials.startTrialRun('t1')
    const sessionId = sentConfig(0).sessionId
    expect(trials.trialRunSessionOf('t1')).toBe(sessionId)
    expect(trials.trialRunOfSession(sessionId)?.agentId).toBe('t1')
    expect(trials.trialRunOfSession('session-elsewhere')).toBeUndefined()
  })

  it('toasts its pause by the Agent’s name, and Open shows it in the Agent Library', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { trials } = await readyStores()
    await trials.startTrialRun('t1')
    const turnId = await turnIdOf(0)

    pushEvent({
      type: 'agent-turn-state',
      sessionId: sentConfig(0).sessionId,
      turnId,
      state: 'paused',
    })

    expect(toastShow).toHaveBeenCalledTimes(1)
    const [text, options] = toastShow.mock.calls[0] as [
      string,
      { action: { label: string; run: () => void } },
    ]
    expect(text).toBe("Trial Run of 'Draft t1' needs your input")
    expect(options.action.label).toBe('Open')
    options.action.run()
    expect(useUIStore(pinia).agentLibrary).toEqual({ agentId: 't1', showTrialRun: true })
  })

  it('names a paused Follow-up after the Agent as it is now', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const { tasks, trials } = await readyStores()
    await trials.startTrialRun('t1')
    await finishTurn(0)
    await vi.waitFor(() => expect(trials.trialRuns.t1?.state).toBe('completed'))
    await tasks.editDraft('t1', { name: '  Renamed  ' })

    await trials.followUpTrialRun('t1', 'and then?')
    const turnId = await turnIdOf(1)
    pushEvent({
      type: 'agent-turn-state',
      sessionId: sentConfig(1).sessionId,
      turnId,
      state: 'paused',
    })

    expect(toastShow.mock.calls[0][0]).toBe("Trial Run of 'Renamed' needs your input")
  })

  it('is picked up by a reloaded window, and runs its next Step when the live one ends', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two'])]
    const first = await readyStores()
    await first.trials.startTrialRun('t1')
    const turnId = await turnIdOf(0)
    const harness = first.trials.trialRuns.t1.harnessSessionId
    const record = JSON.parse(JSON.stringify(first.agentMode.sessions[harness]))

    const { trials } = await reloadWindow(
      [record],
      [
        {
          sessionId: harness,
          turnId,
          state: 'running',
          chunks: [],
          toolProgress: {},
          toolImages: {},
        },
      ],
    )

    expect(trials.trialRuns.t1).toMatchObject({ state: 'running', stepIndex: 1, stepCount: 2 })
    expect(trials.trialRunsInFlight).toEqual(['t1'])
    for (const chunk of [{ type: 'start' }, { type: 'finish' }]) {
      pushEvent({ type: 'agent-chunk', sessionId: harness, turnId, chunk })
    }
    pushEvent({ type: 'agent-turn-done', sessionId: harness, turnId })

    await turnIdOf(0)
    expect(sentSteps()).toEqual(['two'])
    expect(sentConfig(0).sessionId).toBe(harness)
    await finishTurn(0)
    await vi.waitFor(() => expect(trials.trialRuns.t1?.state).toBe('completed'))
  })

  it('runs its next Step when the live one ended while the reloaded window was starting', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two'])]
    const first = await readyStores()
    await first.trials.startTrialRun('t1')
    const turnId = await turnIdOf(0)
    const harness = first.trials.trialRuns.t1.harnessSessionId
    const record = JSON.parse(JSON.stringify(first.agentMode.sessions[harness]))
    const readTrialRuns = vi.mocked(window.electronAPI.agentMode.readTrialRuns)
    const reads = readTrialRuns.mock.calls.length
    const read = readTrialRuns.getMockImplementation()!
    let releaseRead = () => {}
    const held = new Promise<void>((resolve) => (releaseRead = resolve))
    readTrialRuns.mockImplementationOnce(async () => {
      await held
      return read()
    })

    const reloading = reloadWindow(
      [record],
      [
        {
          sessionId: harness,
          turnId,
          state: 'running',
          chunks: [],
          toolProgress: {},
          toolImages: {},
        },
      ],
    )
    await vi.waitFor(() => expect(readTrialRuns.mock.calls.length).toBeGreaterThan(reads))
    for (const chunk of [{ type: 'start' }, { type: 'finish' }]) {
      pushEvent({ type: 'agent-chunk', sessionId: harness, turnId, chunk })
    }
    pushEvent({ type: 'agent-turn-done', sessionId: harness, turnId })
    vi.mocked(window.electronAPI.getKernelSnapshot).mockResolvedValue(snapshotWith([]))
    await vi.waitFor(() => expect(useAgentMode(pinia).sessionTurns[harness]).toBeUndefined())
    await settleMicrotasks()
    releaseRead()
    const { trials } = await reloading

    await turnIdOf(0)
    expect(sentSteps()).toEqual(['two'])
    await finishTurn(0)
    await vi.waitFor(() => expect(trials.trialRuns.t1?.state).toBe('completed'))
  })

  it('ends as failed when the reload cut it off between Steps', async () => {
    storedDrafts = [draftOf('t1', ['one', 'two'])]
    const first = await readyStores()
    await first.trials.startTrialRun('t1')
    await turnIdOf(0)
    const harness = first.trials.trialRuns.t1.harnessSessionId
    const record = JSON.parse(JSON.stringify(first.agentMode.sessions[harness]))

    const { trials } = await reloadWindow([record], [])

    expect(trials.trialRuns.t1.state).toBe('failed')
    expect(trials.trialRunsInFlight).toEqual([])
    expect(trialFolders.t1.run?.state).toBe('failed')
    await settleMicrotasks()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('keeps the last Trial Run visible across a reload', async () => {
    storedDrafts = [draftOf('t1', ['one'])]
    const first = await readyStores()
    await first.trials.startTrialRun('t1')
    await finishTurn(0)
    await vi.waitFor(() => expect(first.trials.trialRuns.t1?.state).toBe('completed'))
    const harness = first.trials.trialRuns.t1.harnessSessionId
    const record = JSON.parse(JSON.stringify(first.agentMode.sessions[harness]))

    const { trials } = await reloadWindow([record], [])

    expect(trials.trialRuns.t1).toMatchObject({ state: 'completed', harnessSessionId: harness })
    expect(trialRunItems(trials.trialRunView('t1')!)).toHaveLength(1)
  })
})
