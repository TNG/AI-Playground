import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentTask } from '@/types/agentTaskIpc'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// The Agents store: saving the Open Session as an Agent and loading it back. Driven
// through its public interface against the real Agent store, with a fake
// electronAPI standing in for the kernel's files.

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'pick',
  systemPrompt: 'You are the agent.',
} as ChatPreset

const catalogRef = vi.hoisted(() => ({
  state: null as { presets: ChatPreset[]; active: ChatPreset | null } | null,
}))

const catalog = new Proxy({} as NonNullable<typeof catalogRef.state>, {
  get: (_target, key) => Reflect.get(catalogRef.state!, key),
  set: (_target, key, value) => Reflect.set(catalogRef.state!, key, value),
})

vi.mock('@/assets/js/store/presets', async () => {
  const { reactive } = await import('vue')
  catalogRef.state = reactive({ presets: [] as ChatPreset[], active: null })
  return {
    usePresets: () => ({
      get presets() {
        return catalog.presets
      },
      get activePresetWithVariant() {
        return catalog.active
      },
    }),
  }
})

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset: vi.fn(async () => ({ success: true })) }),
}))

/** Models not on disk, as the models store would report them. */
let missingModels: Set<string>
const VISION_MODEL = 'Vision-8B'
const VISION_PROJECTOR = 'Vision-8B-mmproj'

const getMissingLlmModels = vi.fn(
  async (backend: string, model: string | undefined, options: { needsVision?: boolean } = {}) => {
    const wanted = [
      model,
      ...(options.needsVision && model === VISION_MODEL ? [VISION_PROJECTOR] : []),
    ]
    return wanted
      .filter((name): name is string => !!name && missingModels.has(name))
      .map((repo_id) => ({ repo_id, type: 'ggufLLM', backend }))
  },
)

const requestDownload = vi.fn(async (_models: unknown[]) => {})

vi.mock('@/assets/js/permissions/permissions', () => ({
  requestDownload: (models: unknown[]) => requestDownload(models),
  requestVramWarning: vi.fn(async () => true),
  notify: vi.fn(),
}))

/** The presets' Default Settings bags, as textInference keeps them. */
const settingsPerPreset = vi.hoisted(() => ({}) as Record<string, Record<string, unknown>>)

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    backend: 'llamaCPP',
    activeModel: 'Live-9B',
    settingsPerPreset,
    embeddingBackend: 'llamaCPP',
    getMissingLlmModels,
    inferenceForSettings: (_preset: string, settings: AgentSessionSettings) => ({
      inference: {
        backend: settings.backend ?? 'llamaCPP',
        activeModel: settings.model,
        modelSupportsVision: settings.model === VISION_MODEL,
      },
    }),
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

const report = vi.fn()
vi.mock('@/assets/js/store/demoMode', () => ({ useDemoMode: () => ({ enabled: false }) }))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report }) }))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US', state: {} }),
}))

vi.mock('@/assets/js/toast', () => ({ show: vi.fn() }))

vi.mock('@/assets/js/tools/agentBridge', () => ({ getAgentToolSpecs: () => [] }))

const SETTINGS: AgentSessionSettings = {
  backend: 'llamaCPP',
  model: 'Stored-27B',
  contextSize: 32768,
  planningThinkingOnly: false,
  capabilities: ['files', 'web'],
}

const ATTACHMENT_LINE = '\n\nAttached files, saved in the workspace: @attachments/sprite.png'

const userMessage = (id: string, ...texts: string[]) => ({
  id,
  role: 'user',
  parts: texts.map((text) => ({ type: 'text', text })),
})

const assistantMessage = (id: string, text: string) => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
})

type SessionFixture = { id: string; title: string; workspaceDir: string; messages: unknown[] }

let openRecord: SessionFixture
let openSessionSettings: AgentSessionSettings
let storedTasks: AgentTask[]

const saveTask = vi.fn(async (_task: AgentTask) => ({ success: true as boolean, error: '' }))
const readTasks = vi.fn(async () => ({ success: true as const, tasks: storedTasks }))

const SESSION = 'session-1'
let runHarnesses = 0

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  for (const key of Object.keys(settingsPerPreset)) delete settingsPerPreset[key]
  catalog.presets = [AGENT]
  catalog.active = AGENT
  storedTasks = []
  missingModels = new Set()
  openSessionSettings = SETTINGS
  requestDownload.mockImplementation(async () => {})
  saveTask.mockImplementation(async () => ({ success: true, error: '' }))
  openRecord = {
    id: 'session-open',
    title: 'Tidy the docs',
    workspaceDir: '/work/open',
    messages: [
      userMessage('u1', 'rename the files'),
      assistantMessage('a1', 'renamed'),
      userMessage('u2', 'use this sprite', `${ATTACHMENT_LINE}`),
      assistantMessage('a2', 'done'),
      userMessage('u3', 'now write the readme'),
    ],
  }
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
      onKernelEvent: vi.fn((_listener: (event: KernelEvent) => void) => () => {}),
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
        harnessSession: vi.fn(async () => ({
          success: true,
          harness: { harnessSessionId: 'session-open', workspaceDir: '/work/open' },
        })),
        saveTimelineMessages: vi.fn(async () => ({ success: true })),
        delete: vi.fn(async () => ({ success: true })),
        list: vi.fn(async () => ({ success: true, sessions: [] })),
        create: vi.fn(async () => ({
          success: true,
          session: {
            id: SESSION,
            title: '',
            renamed: false,
            createdAt: 1,
            updatedAt: 1,
            presetsUsed: [],
          },
        })),
      },
      agentMode: {
        startTurn: vi.fn(async () => ({ success: true })),
        cancel: vi.fn(),
        saveSession: vi.fn(async () => ({ success: true })),
        onExecuteTool: vi.fn(() => () => {}),
        submitToolResult: vi.fn(),
        deleteSession: vi.fn(async () => ({ success: true })),
        bootstrapSessions: vi.fn(async () => ({
          status: 'ok',
          activeSessionId: openRecord.id,
          sessions: [
            {
              ...openRecord,
              createdAt: 1,
              updatedAt: 2,
              presetName: 'Agent',
              settings: openSessionSettings,
            },
          ],
        })),
        migrateSessions: vi.fn(),
        saveActiveSessionId: vi.fn(async () => ({ success: true })),
        readWorkspaceState: vi.fn(async () => ({
          success: true,
          section: {
            workspaceDir: openRecord.workspaceDir,
            lastWorkspaceByKind: { pick: openRecord.workspaceDir },
          },
        })),
        migrateWorkspaceState: vi.fn(async () => ({ success: true })),
        writeWorkspaceState: vi.fn(async () => ({ success: true })),
        readTasks,
        saveTask,
        deleteTask: vi.fn(async () => ({ success: true })),
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

const openSessionRef = () => useSessions().openSessionId ?? ''

async function readyStores(options: { session?: boolean } = {}) {
  const agentMode = useAgentMode()
  await agentMode.init()
  if (options.session !== false) await useSessions().create()
  const tasks = useAgentTasks()
  await tasks.init()
  return { agentMode, tasks }
}

describe('the saved Agents', () => {
  it('tells the user when the saved Tasks cannot be read', async () => {
    readTasks.mockImplementationOnce(
      async () => ({ success: false, error: 'agent tasks file unreadable' }) as never,
    )

    const { tasks } = await readyStores()

    expect(tasks.tasks).toEqual([])
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'agent-tasks/read-failed', surface: 'toast' }),
    )
  })

  it('reads saved Tasks back on the next start', async () => {
    storedTasks = [savedTask('task-1')]

    const { tasks } = await readyStores()

    expect(tasks.tasks).toEqual(storedTasks)
  })

  it('lists an Agent saved before Sessions existed', async () => {
    const { sessionRef: _none, ...legacy } = savedTask('old')
    storedTasks = [{ ...legacy, workspaceDir: '/work/open' }, savedTask('task-1')]

    const { tasks } = await readyStores()

    expect(tasks.tasks.map((task) => task.id)).toEqual(['old', 'task-1'])
  })

  it('lists every Agent in every Session, whichever Session it was made in', async () => {
    storedTasks = [savedTask('mine'), savedTask('theirs', { sessionRef: 'session-2' })]
    const { tasks } = await readyStores()

    expect(tasks.tasks.map((task) => task.id)).toEqual(['mine', 'theirs'])
    await useSessions().create()
    expect(tasks.tasks.map((task) => task.id)).toEqual(['mine', 'theirs'])
  })
})

const savedTask = (id: string, overrides: Partial<AgentTask> = {}): AgentTask => ({
  id,
  name: `Task ${id}`,
  sessionRef: SESSION,
  settingsTemplate: SETTINGS,
  steps: [{ id: 's1', prompt: 'go' }],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

describe('scheduling an Agent made in another Session', () => {
  it('sets the Schedule in the Session given, leaving the Agent where it was made', async () => {
    storedTasks = [savedTask('old', { sessionRef: 'session-made-in' })]
    const { tasks } = await readyStores()

    const schedule = { every: 1, unit: 'days' as const, startAt: 100, enabled: true }
    expect(await tasks.setSchedule('old', schedule, openSessionRef())).toMatchObject({ ok: true })

    expect(saveTask.mock.calls.at(-1)![0]).toMatchObject({
      sessionRef: 'session-made-in',
      schedules: [{ sessionRef: SESSION, ...schedule }],
    })
  })
})

describe('deleting a Session', () => {
  it('keeps every Agent, dropping the Schedules that ran in it', async () => {
    const daily = { every: 1, unit: 'days' as const, startAt: 100, enabled: true }
    const nextRunAt = Date.now() + 60_000
    const here = { sessionRef: SESSION, ...daily, nextRunAt }
    const there = { sessionRef: 'session-2', ...daily, nextRunAt }
    storedTasks = [
      savedTask('mine', { schedules: [here, there] }),
      savedTask('theirs', { sessionRef: 'session-2', schedules: [here] }),
    ]
    const { tasks } = await readyStores()

    await useSessions().remove(SESSION)

    await vi.waitFor(() => expect(tasks.tasks[0].schedules).toEqual([there]))
    const { sessionRef: _gone, ...mine } = savedTask('mine', { schedules: [there] })
    expect(tasks.tasks).toEqual([mine, savedTask('theirs', { sessionRef: 'session-2' })])
    expect(window.electronAPI.agentMode.deleteTask).not.toHaveBeenCalled()
  })
})

describe('deleting a Task', () => {
  it('removes it from the file and the list, and keeps the sessions', async () => {
    storedTasks = [savedTask('task-1'), savedTask('task-2')]
    const runSession = {
      id: 'session-run',
      title: 'Task task-1',
      workspaceDir: '/work/open',
      messages: [userMessage('r1', 'go'), assistantMessage('r2', 'went')],
      createdAt: 3,
      updatedAt: 4,
      presetName: 'Agent',
      settings: SETTINGS,
    }
    const bootstrap = vi.mocked(window.electronAPI.agentMode.bootstrapSessions)
    const opened = (await bootstrap()) as { status: 'ok'; sessions: unknown[] }
    bootstrap.mockResolvedValueOnce({
      ...opened,
      sessions: [...opened.sessions, runSession],
    } as never)
    const { agentMode, tasks } = await readyStores()

    expect(await tasks.deleteTask('task-1')).toBe(true)

    expect(window.electronAPI.agentMode.deleteTask).toHaveBeenCalledWith('task-1')
    expect(tasks.tasks.map((task) => task.id)).toEqual(['task-2'])
    expect(window.electronAPI.agentMode.deleteSession).not.toHaveBeenCalled()
    expect(Object.keys(agentMode.sessions)).toEqual(
      expect.arrayContaining([openRecord.id, runSession.id]),
    )
  })

  it('keeps the Task and reports when the file cannot be written', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()
    vi.mocked(window.electronAPI.agentMode.deleteTask).mockResolvedValueOnce({
      success: false,
      error: 'disk full',
    })

    expect(await tasks.deleteTask('task-1')).toBe(false)

    expect(tasks.tasks.map((task) => task.id)).toEqual(['task-1'])
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'agent-tasks/delete-failed', surface: 'toast' }),
    )
  })
})

describe('a Task’s state', () => {
  it('is idle with no outcome for a Task that never ran', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()

    expect(tasks.taskState('task-1')).toEqual({ idle: undefined })
  })

  it('is idle with the last outcome for a Task that ran', async () => {
    const lastOutcome = {
      kind: 'failed' as const,
      at: 5,
      sessionId: 'session-run',
      stepIndex: 2,
      stepCount: 3,
      message: 'model not available',
    }
    storedTasks = [savedTask('task-1', { lastOutcome })]
    const { tasks } = await readyStores()

    expect(tasks.taskState('task-1')).toEqual({ idle: lastOutcome })
  })
})
