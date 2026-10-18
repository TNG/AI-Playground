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

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({ presets: [AGENT], activePresetWithVariant: AGENT }),
}))

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

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    backend: 'llamaCPP',
    activeModel: 'Live-9B',
    settingsPerPreset: {},
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

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
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

async function readyStores() {
  const agentMode = useAgentMode()
  await agentMode.init()
  const tasks = useAgentTasks()
  await tasks.init()
  return { agentMode, tasks }
}

const draftOf = (name: string, ...prompts: string[]) => ({
  name,
  steps: prompts.map((prompt, index) => ({ id: `step-${index}`, prompt })),
})

describe('saving a Task', () => {
  it.each([
    ['an empty name', draftOf('  ', 'go'), 'name'],
    ['no Steps', draftOf('Docs'), 'no-steps'],
    ['an empty Step', draftOf('Docs', 'go', ' \n '), 'empty-step'],
  ])('refuses %s without persisting', async (_case, draft, reason) => {
    const { tasks } = await readyStores()

    expect(await tasks.saveTask(draft)).toEqual({ ok: false, reason })
    expect(saveTask).not.toHaveBeenCalled()
    expect(tasks.tasks).toEqual([])
  })

  it('refuses when the Open Session has no folder', async () => {
    const { agentMode, tasks } = await readyStores()
    agentMode.workspaceDir = ''

    expect(await tasks.saveTask(draftOf('Docs', 'go'))).toEqual({ ok: false, reason: 'no-folder' })
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('persists the Steps with the Open Session’s folder and Session Settings', async () => {
    const { tasks } = await readyStores()

    const result = await tasks.saveTask(draftOf(' Docs ', 'rename', `sprite${ATTACHMENT_LINE}`))

    expect(result.ok).toBe(true)
    expect(saveTask).toHaveBeenCalledTimes(1)
    const saved = saveTask.mock.calls[0][0]
    expect(saved).toMatchObject({
      name: 'Docs',
      workspaceDir: '/work/open',
      settingsTemplate: SETTINGS,
      steps: [{ prompt: 'rename' }, { prompt: `sprite${ATTACHMENT_LINE}` }],
    })
    expect(saved.lastOutcome).toBeUndefined()
    expect(tasks.tasks).toEqual([saved])
  })

  it('captures what the panel holds now, not what the session was sent with', async () => {
    const { agentMode, tasks } = await readyStores()
    agentMode.setCapabilityEnabled('web', false)
    agentMode.setPlanningThinkingOnly(true)

    await tasks.saveTask(draftOf('Docs', 'go'))

    expect(saveTask.mock.calls[0][0].settingsTemplate).toMatchObject({
      model: 'Stored-27B',
      capabilities: ['files'],
      planningThinkingOnly: true,
    })
  })

  it('keeps the list unchanged and reports when the file cannot be written', async () => {
    saveTask.mockImplementation(async () => ({ success: false, error: 'disk full' }))
    const { tasks } = await readyStores()

    const result = await tasks.saveTask(draftOf('Docs', 'go'))

    expect(result).toEqual({ ok: false, reason: 'persist-failed' })
    expect(tasks.tasks).toEqual([])
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'agent-tasks/save-failed', surface: 'toast' }),
    )
  })

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
    storedTasks = [
      {
        id: 'task-1',
        name: 'Docs',
        workspaceDir: '/work/open',
        settingsTemplate: SETTINGS,
        steps: [{ id: 's1', prompt: 'go' }],
        createdAt: 1,
        updatedAt: 1,
      },
    ]

    const { tasks } = await readyStores()

    expect(tasks.tasks).toEqual(storedTasks)
  })
})

const savedTask = (id: string, overrides: Partial<AgentTask> = {}): AgentTask => ({
  id,
  name: `Task ${id}`,
  workspaceDir: '/work/open',
  settingsTemplate: SETTINGS,
  steps: [{ id: 's1', prompt: 'go' }],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

const stepsOf = (...prompts: string[]) => draftOf('', ...prompts).steps

describe('the Open Session’s Steps', () => {
  it('start empty and are kept on the session’s record once edited', async () => {
    const { agentMode } = await readyStores()
    expect(agentMode.openSteps).toEqual([])

    agentMode.setOpenSteps(stepsOf('search the news', 'summarise it'))

    expect(agentMode.openSteps.map((step) => step.prompt)).toEqual([
      'search the news',
      'summarise it',
    ])
    expect(agentMode.sessions[openRecord.id].steps?.map((step) => step.prompt)).toEqual([
      'search the news',
      'summarise it',
    ])
  })

  it('are cleared by a new session and come back with the session they belong to', async () => {
    const { agentMode } = await readyStores()
    agentMode.setOpenSteps(stepsOf('search the news'))

    await agentMode.newSession()
    expect(agentMode.openSteps).toEqual([])

    await agentMode.switchSession(openRecord.id)
    expect(agentMode.openSteps.map((step) => step.prompt)).toEqual(['search the news'])
  })
})

describe('saving the Open Session as an Agent', () => {
  it('says why it cannot be saved yet', async () => {
    const { agentMode, tasks } = await readyStores()

    expect(tasks.saveAgentBlocker(' ')).toBe('name')
    expect(tasks.saveAgentBlocker('News')).toBe('no-steps')
    agentMode.setOpenSteps(stepsOf('search', ' '))
    expect(tasks.saveAgentBlocker('News')).toBe('empty-step')
  })

  it('saves the folder, the panel’s settings and the Steps, and links the session', async () => {
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('search the news', 'summarise it'))
    agentMode.setCapabilityEnabled('web', false)

    const result = await tasks.saveAgent(' News ')

    expect(result.ok).toBe(true)
    const saved = saveTask.mock.calls[0][0]
    expect(saved).toMatchObject({
      name: 'News',
      workspaceDir: '/work/open',
      settingsTemplate: { model: 'Stored-27B', capabilities: ['files'] },
      steps: [{ prompt: 'search the news' }, { prompt: 'summarise it' }],
    })
    expect(agentMode.openTaskId).toBe(saved.id)
    expect(agentMode.sessions[openRecord.id].taskId).toBe(saved.id)
    expect(tasks.openSessionTask?.id).toBe(saved.id)
  })

  it('leaves the session unlinked when the file cannot be written', async () => {
    saveTask.mockImplementation(async () => ({ success: false, error: 'disk full' }))
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('search the news'))

    expect(await tasks.saveAgent('News')).toEqual({ ok: false, reason: 'persist-failed' })
    expect(agentMode.openTaskId).toBeUndefined()
  })

  it('keeps the Steps it saved even when they are edited afterwards', async () => {
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('search the news'))
    await tasks.saveAgent('News')

    agentMode.setOpenSteps(stepsOf('search the news', 'find a source'))

    expect(tasks.tasks[0].steps.map((step) => step.prompt)).toEqual(['search the news'])
  })
})

describe('updating an Agent', () => {
  const outcome = { kind: 'completed' as const, at: 5, sessionId: 'session-run', stepCount: 1 }

  it('overwrites it in place, keeping its identity, position, schedule and last outcome', async () => {
    const schedule = { every: 1, unit: 'days' as const, startAt: 100, enabled: true }
    storedTasks = [
      savedTask('task-1'),
      savedTask('task-2', { createdAt: 10, updatedAt: 11, lastOutcome: outcome, schedule }),
      savedTask('task-3'),
    ]
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('search', 'find a source', 'summarise'))

    const result = await tasks.updateAgent('task-2', ' Nightly news ')

    expect(result.ok).toBe(true)
    const saved = saveTask.mock.calls.at(-1)![0]
    expect(saved).toMatchObject({
      id: 'task-2',
      name: 'Nightly news',
      workspaceDir: '/work/open',
      settingsTemplate: SETTINGS,
      createdAt: 10,
      lastOutcome: outcome,
      schedule,
    })
    expect(saved.steps.map((step) => step.prompt)).toEqual(['search', 'find a source', 'summarise'])
    expect(saved.updatedAt).toBeGreaterThan(11)
    expect(tasks.tasks.map((task) => task.id)).toEqual(['task-1', 'task-2', 'task-3'])
    expect(agentMode.openTaskId).toBe('task-2')
  })

  it.each([
    ['an empty name', ' ', ['go'], 'name'],
    ['no Steps', 'News', [], 'no-steps'],
    ['an empty Step', 'News', ['  '], 'empty-step'],
  ])('is refused with %s', async (_case, name, prompts, reason) => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf(...prompts))

    expect(await tasks.updateAgent('task-1', name)).toEqual({ ok: false, reason })
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('refuses an Agent that does not exist', async () => {
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('go'))

    expect(await tasks.updateAgent('missing', 'News')).toEqual({ ok: false, reason: 'no-task' })
  })

  it('puts the saved Agent back when the file cannot be written', async () => {
    saveTask.mockImplementation(async () => ({ success: false, error: 'disk full' }))
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('changed'))

    expect(await tasks.updateAgent('task-1', 'Renamed')).toEqual({
      ok: false,
      reason: 'persist-failed',
    })
    expect(tasks.tasks[0]).toEqual(savedTask('task-1'))
    expect(agentMode.openTaskId).toBeUndefined()
  })
})

describe('loading an Agent', () => {
  const NPU_SETTINGS: AgentSessionSettings = {
    ...SETTINGS,
    backend: 'openVINO',
    model: 'Saved-NPU',
    capabilities: ['files'],
  }

  it('opens a new Draft Session set up as the Agent is', async () => {
    storedTasks = [
      savedTask('task-1', {
        workspaceDir: '/work/news',
        settingsTemplate: NPU_SETTINGS,
        steps: [
          { id: 's1', prompt: 'search the news' },
          { id: 's2', prompt: 'summarise it' },
        ],
      }),
    ]
    const { agentMode, tasks } = await readyStores()

    expect(await tasks.loadAgent('task-1')).toBe(true)

    expect(agentMode.openSessionId).not.toBe(openRecord.id)
    expect(agentMode.sessions[agentMode.openSessionId]).toBeUndefined()
    expect(agentMode.workspaceDir).toBe('/work/news')
    expect(agentMode.openSessionSettings).toMatchObject({ model: 'Saved-NPU', backend: 'openVINO' })
    expect(agentMode.openSteps.map((step) => step.prompt)).toEqual([
      'search the news',
      'summarise it',
    ])
    expect(agentMode.openTaskId).toBe('task-1')
    expect(tasks.openSessionTask?.id).toBe('task-1')
  })

  it('works on a copy, so editing the loaded Steps leaves the Agent alone', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    await tasks.loadAgent('task-1')

    agentMode.setOpenSteps(stepsOf('go', 'and more'))

    expect(tasks.tasks[0]).toEqual(savedTask('task-1'))
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('leaves the session it came from untouched', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('my own step'))

    await tasks.loadAgent('task-1')
    await agentMode.switchSession(openRecord.id)

    expect(agentMode.openSteps.map((step) => step.prompt)).toEqual(['my own step'])
    expect(agentMode.openTaskId).toBeUndefined()
  })

  it('refuses an Agent that does not exist', async () => {
    const { agentMode, tasks } = await readyStores()

    expect(await tasks.loadAgent('missing')).toBe(false)
    expect(agentMode.openSessionId).toBe(openRecord.id)
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

  it('unlinks the Open Session when it was loaded from the deleted Agent', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    await tasks.loadAgent('task-1')

    await tasks.deleteTask('task-1')

    expect(agentMode.openTaskId).toBeUndefined()
    expect(agentMode.openSteps.map((step) => step.prompt)).toEqual(['go'])
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

describe('saving an Agent whose chat model is not downloaded', () => {
  it('saves without asking for a download', async () => {
    missingModels = new Set(['Stored-27B'])
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('go'))

    expect((await tasks.saveAgent('News')).ok).toBe(true)
    expect(getMissingLlmModels).not.toHaveBeenCalled()
    expect(requestDownload).not.toHaveBeenCalled()
    expect(saveTask).toHaveBeenCalledTimes(1)
  })

  it('updates without asking for a download', async () => {
    storedTasks = [savedTask('task-1')]
    missingModels = new Set(['Stored-27B'])
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('go'))

    expect((await tasks.updateAgent('task-1', 'Renamed')).ok).toBe(true)
    expect(requestDownload).not.toHaveBeenCalled()
    expect(saveTask.mock.calls.at(-1)![0].name).toBe('Renamed')
  })
})

describe('renaming an Agent', () => {
  it('changes only its name, whatever the Open Session holds', async () => {
    storedTasks = [savedTask('task-1'), savedTask('task-2')]
    const { agentMode, tasks } = await readyStores()
    agentMode.setOpenSteps(stepsOf('something else entirely'))

    const result = await tasks.renameAgent('task-2', ' Nightly ')

    expect(result.ok).toBe(true)
    expect(saveTask.mock.calls.at(-1)![0]).toMatchObject({
      ...savedTask('task-2'),
      name: 'Nightly',
      updatedAt: expect.any(Number),
    })
    expect(tasks.tasks[1].steps).toEqual(savedTask('task-2').steps)
    expect(agentMode.openTaskId).toBeUndefined()
  })

  it('refuses an empty name and writes nothing for the same name', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()

    expect(await tasks.renameAgent('task-1', '  ')).toEqual({ ok: false, reason: 'name' })
    expect((await tasks.renameAgent('task-1', 'Task task-1')).ok).toBe(true)
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('puts the old name back when the file cannot be written', async () => {
    saveTask.mockImplementation(async () => ({ success: false, error: 'disk full' }))
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()

    expect(await tasks.renameAgent('task-1', 'New')).toEqual({
      ok: false,
      reason: 'persist-failed',
    })
    expect(tasks.tasks[0].name).toBe('Task task-1')
  })
})

describe('unsaved changes to a loaded Agent', () => {
  it('are none right after loading, and show once a Step or setting changes', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    expect(tasks.openSessionAgentChanged).toBe(false)

    await tasks.loadAgent('task-1')
    expect(tasks.openSessionAgentChanged).toBe(false)

    agentMode.setOpenSteps(stepsOf('go', 'and more'))
    expect(tasks.openSessionAgentChanged).toBe(true)

    agentMode.setOpenSteps(stepsOf('go'))
    expect(tasks.openSessionAgentChanged).toBe(false)

    agentMode.setCapabilityEnabled('web', false)
    expect(tasks.openSessionAgentChanged).toBe(true)
  })

  it('are gone once the Agent is updated', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    await tasks.loadAgent('task-1')
    agentMode.setOpenSteps(stepsOf('go', 'and more'))

    await tasks.updateAgent('task-1', 'Task task-1')

    expect(tasks.openSessionAgentChanged).toBe(false)
  })
})
