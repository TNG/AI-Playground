import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentTask } from '@/types/agentTaskIpc'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// The Tasks store: building a Task from the Open Session and saving it. Driven
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

describe('the Task draft', () => {
  it('fills the Steps from the Open Session and names the draft after it', async () => {
    const { tasks } = await readyStores()

    tasks.createStepsFromSession()

    expect(tasks.draft.name).toBe('Tidy the docs')
    expect(tasks.draft.steps.map((step) => step.prompt)).toEqual(tasks.stepsFromSession())
    expect(new Set(tasks.draft.steps.map((step) => step.id)).size).toBe(3)
    expect(tasks.draftBlocker).toBeNull()
  })

  it('replaces the Steps already in the draft', async () => {
    const { agentMode, tasks } = await readyStores()
    tasks.createStepsFromSession()
    agentMode.chat.messages = [userMessage('n1', 'only this') as never]

    tasks.createStepsFromSession()

    expect(tasks.draft.steps.map((step) => step.prompt)).toEqual(['only this'])
  })

  it('starts over when another session is opened, so it never mixes two sessions', async () => {
    const { agentMode, tasks } = await readyStores()
    tasks.createStepsFromSession()

    await agentMode.newSession()

    expect(tasks.draft).toEqual({ name: '', steps: [] })
  })

  it('reports why an empty draft cannot be saved', async () => {
    const { tasks } = await readyStores()
    expect(tasks.draftBlocker).toBe('name')
  })

  it('is cleared after a successful save', async () => {
    const { tasks } = await readyStores()
    tasks.createStepsFromSession()

    const result = await tasks.saveDraft()

    expect(result.ok).toBe(true)
    expect(tasks.draft).toEqual({ name: '', steps: [] })
    expect(tasks.tasks).toHaveLength(1)
  })

  it('is kept when the save fails', async () => {
    saveTask.mockImplementation(async () => ({ success: false, error: 'disk full' }))
    const { tasks } = await readyStores()
    tasks.createStepsFromSession()

    await tasks.saveDraft()

    expect(tasks.draft.name).toBe('Tidy the docs')
    expect(tasks.draft.steps).toHaveLength(3)
  })
})

describe('editing the draft’s Steps', () => {
  const prompts = (tasks: { draft: { steps: { prompt: string }[] } }) =>
    tasks.draft.steps.map((step) => step.prompt)

  it('saves the Steps as edited', async () => {
    const { tasks } = await readyStores()
    tasks.createStepsFromSession()
    tasks.draft.steps[0].prompt = 'rename the files\nthen list them'

    await tasks.saveDraft()

    expect(saveTask.mock.calls[0][0].steps.map((step) => step.prompt)).toEqual([
      'rename the files\nthen list them',
      `use this sprite\n\n${ATTACHMENT_LINE}`,
      'now write the readme',
    ])
  })

  it('appends an empty Step, which blocks saving until it is filled', async () => {
    const { tasks } = await readyStores()
    tasks.createStepsFromSession()

    tasks.addStep()

    expect(prompts(tasks)).toHaveLength(4)
    expect(prompts(tasks)[3]).toBe('')
    expect(new Set(tasks.draft.steps.map((step) => step.id)).size).toBe(4)
    expect(tasks.draftBlocker).toBe('empty-step')
  })

  it('removes the chosen Step and keeps the others in order', async () => {
    const { tasks } = await readyStores()
    tasks.createStepsFromSession()

    tasks.removeStep(tasks.draft.steps[1].id)

    expect(prompts(tasks)).toEqual(['rename the files', 'now write the readme'])
  })

  it('moves a Step up and down', async () => {
    const { tasks } = await readyStores()
    tasks.draft.steps = draftOf('Docs', 'one', 'two', 'three').steps

    tasks.moveStep('step-2', 'up')
    expect(prompts(tasks)).toEqual(['one', 'three', 'two'])

    tasks.moveStep('step-0', 'down')
    expect(prompts(tasks)).toEqual(['three', 'one', 'two'])
  })

  it('leaves the order alone when a Step cannot move further', async () => {
    const { tasks } = await readyStores()
    tasks.draft.steps = draftOf('Docs', 'one', 'two').steps

    tasks.moveStep('step-0', 'up')
    tasks.moveStep('step-1', 'down')

    expect(prompts(tasks)).toEqual(['one', 'two'])
  })
})

describe('what the Task will be saved with', () => {
  it('summarises the Open Session’s folder and the panel’s Session Settings', async () => {
    const { tasks } = await readyStores()

    expect(tasks.draftTemplate).toEqual({
      workspaceDir: '/work/open',
      backend: 'llamaCPP',
      model: 'Stored-27B',
      capabilityCount: 2,
    })
  })

  it('follows changes made in the panel', async () => {
    const { agentMode, tasks } = await readyStores()

    agentMode.setCapabilityEnabled('web', false)

    expect(tasks.draftTemplate.capabilityCount).toBe(1)
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

describe('steps from the Open Session', () => {
  it('turns each user message into one Step prompt, in order', async () => {
    const { tasks } = await readyStores()

    expect(tasks.stepsFromSession()).toEqual([
      'rename the files',
      `use this sprite\n\n${ATTACHMENT_LINE}`,
      'now write the readme',
    ])
  })

  it('keeps the attachment line verbatim', async () => {
    openRecord.messages = [userMessage('u1', `make a game${ATTACHMENT_LINE}`)]
    const { tasks } = await readyStores()

    expect(tasks.stepsFromSession()).toEqual([`make a game${ATTACHMENT_LINE}`])
  })

  it('includes a message that was marked "not run" after a restart', async () => {
    const { agentMode, tasks } = await readyStores()

    expect(agentMode.notRunMessages[openRecord.id]).toBe('u3')
    expect(tasks.stepsFromSession().at(-1)).toBe('now write the readme')
  })

  it('returns nothing for a Draft Session', async () => {
    const { agentMode, tasks } = await readyStores()

    await agentMode.newSession()

    expect(tasks.stepsFromSession()).toEqual([])
  })
})

describe('editing a saved Task', () => {
  it('works on a copy, and is dirty only while the copy differs from the saved Task', async () => {
    storedTasks = [savedTask('task-1', { steps: [{ id: 's1', prompt: 'go' }] })]
    const { agentMode, tasks } = await readyStores()
    const sessionSettings = JSON.stringify(agentMode.openSessionSettings)

    expect(tasks.beginEdit('task-1')).toBe(true)
    expect(tasks.editingTaskId).toBe('task-1')
    expect(tasks.editDraft).toEqual({
      name: 'Task task-1',
      workspaceDir: '/work/open',
      steps: [{ id: 's1', prompt: 'go' }],
      settingsTemplate: SETTINGS,
    })
    expect(tasks.editDirty).toBe(false)

    tasks.editDraft!.name = 'Renamed'
    tasks.editDraft!.steps[0].prompt = 'go faster'
    tasks.editDraft!.workspaceDir = '/work/elsewhere'

    expect(tasks.editDirty).toBe(true)
    expect(tasks.tasks[0]).toMatchObject({
      name: 'Task task-1',
      workspaceDir: '/work/open',
      steps: [{ id: 's1', prompt: 'go' }],
    })
    expect(JSON.stringify(agentMode.openSessionSettings)).toBe(sessionSettings)
    expect(agentMode.workspaceDir).toBe('/work/open')
    expect(saveTask).not.toHaveBeenCalled()

    tasks.editDraft!.name = 'Task task-1'
    tasks.editDraft!.steps[0].prompt = 'go'
    tasks.editDraft!.workspaceDir = '/work/open'
    expect(tasks.editDirty).toBe(false)
  })

  it('refuses to edit a Task that does not exist', async () => {
    const { tasks } = await readyStores()

    expect(tasks.beginEdit('missing')).toBe(false)
    expect(tasks.editingTaskId).toBeNull()
    expect(tasks.editDraft).toBeNull()
  })

  it('edits one Task at a time and leaves the creation draft alone', async () => {
    storedTasks = [savedTask('task-1'), savedTask('task-2')]
    const { tasks } = await readyStores()
    tasks.createStepsFromSession()

    tasks.beginEdit('task-1')
    tasks.beginEdit('task-2')

    expect(tasks.editingTaskId).toBe('task-2')
    expect(tasks.editDraft?.name).toBe('Task task-2')
    expect(tasks.draft.name).toBe('Tidy the docs')
  })
})

describe('saving an edited Task', () => {
  const outcome = {
    kind: 'completed' as const,
    at: 5,
    sessionId: 'session-run',
    stepCount: 1,
  }

  it.each([
    ['an empty name', { name: ' ' }, 'name'],
    ['no Steps', { steps: [] }, 'no-steps'],
    ['an empty Step', { steps: [{ id: 's1', prompt: '  ' }] }, 'empty-step'],
    ['no folder', { workspaceDir: '' }, 'no-folder'],
  ])('is refused with %s, and the draft is kept', async (_case, change, reason) => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()
    tasks.beginEdit('task-1')
    Object.assign(tasks.editDraft!, change)

    expect(tasks.editBlocker).toBe(reason)
    expect(await tasks.saveEdit()).toEqual({ ok: false, reason })
    expect(saveTask).not.toHaveBeenCalled()
    expect(tasks.editingTaskId).toBe('task-1')
    expect(tasks.editDirty).toBe(true)
  })

  it('does not depend on the Open Session having a folder', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    agentMode.workspaceDir = ''
    tasks.beginEdit('task-1')

    expect(tasks.editBlocker).toBeNull()
  })

  it('updates the Task in place, keeping its identity, position and last outcome', async () => {
    storedTasks = [
      savedTask('task-1'),
      savedTask('task-2', { createdAt: 10, updatedAt: 11, lastOutcome: outcome }),
      savedTask('task-3'),
    ]
    const { tasks } = await readyStores()
    tasks.beginEdit('task-2')
    tasks.editDraft!.name = ' Nightly docs '
    tasks.editDraft!.workspaceDir = '/work/docs'
    tasks.editDraft!.steps = [
      { id: 's1', prompt: 'build' },
      { id: 's2', prompt: 'publish' },
    ]

    const result = await tasks.saveEdit()

    expect(result.ok).toBe(true)
    const saved = saveTask.mock.calls[0][0]
    expect(saved).toEqual({
      id: 'task-2',
      name: 'Nightly docs',
      workspaceDir: '/work/docs',
      settingsTemplate: SETTINGS,
      steps: [
        { id: 's1', prompt: 'build' },
        { id: 's2', prompt: 'publish' },
      ],
      createdAt: 10,
      updatedAt: expect.any(Number),
      lastOutcome: outcome,
    })
    expect(saved.updatedAt).toBeGreaterThan(11)
    expect(tasks.tasks.map((task) => task.id)).toEqual(['task-1', 'task-2', 'task-3'])
    expect(tasks.tasks[1]).toEqual(saved)
    expect(tasks.editingTaskId).toBeNull()
    expect(tasks.editDraft).toBeNull()
  })

  it('keeps editing and leaves the Task unchanged when the file cannot be written', async () => {
    saveTask.mockImplementation(async () => ({ success: false, error: 'disk full' }))
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()
    tasks.beginEdit('task-1')
    tasks.editDraft!.name = 'Renamed'

    expect(await tasks.saveEdit()).toEqual({ ok: false, reason: 'persist-failed' })

    expect(tasks.tasks[0].name).toBe('Task task-1')
    expect(tasks.editDraft?.name).toBe('Renamed')
  })
})

describe('typing while an edit is being saved', () => {
  it('keeps the edit open with the later typing still unsaved', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()
    let finishWrite = () => {}
    saveTask.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve({ success: true, error: '' })
        }),
    )
    tasks.beginEdit('task-1')
    tasks.editDraft!.name = 'Saved name'

    const saving = tasks.saveEdit()
    await vi.waitFor(() => expect(saveTask).toHaveBeenCalledTimes(1))
    tasks.editDraft!.name = 'Typed during save'
    finishWrite()
    await saving

    expect(saveTask.mock.calls[0][0].name).toBe('Saved name')
    expect(tasks.tasks[0].name).toBe('Saved name')
    expect(tasks.editingTaskId).toBe('task-1')
    expect(tasks.editDirty).toBe(true)
  })
})

describe('discarding an edit', () => {
  it('drops the draft and leaves the saved Task as it was', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()
    tasks.beginEdit('task-1')
    tasks.editDraft!.name = 'Renamed'
    tasks.editDraft!.steps.push({ id: 's2', prompt: 'more' })

    tasks.discardEdit()

    expect(tasks.editingTaskId).toBeNull()
    expect(tasks.editDraft).toBeNull()
    expect(tasks.editDirty).toBe(false)
    expect(tasks.tasks).toEqual([savedTask('task-1')])
    expect(saveTask).not.toHaveBeenCalled()
  })
})

describe('deleting the Task being edited', () => {
  it('ends the edit', async () => {
    storedTasks = [savedTask('task-1'), savedTask('task-2')]
    const { tasks } = await readyStores()
    tasks.beginEdit('task-1')
    tasks.editDraft!.name = 'Renamed'

    expect(await tasks.deleteTask('task-1')).toBe(true)

    expect(tasks.editingTaskId).toBeNull()
    expect(tasks.editDraft).toBeNull()
  })

  it('keeps editing when another Task is deleted', async () => {
    storedTasks = [savedTask('task-1'), savedTask('task-2')]
    const { tasks } = await readyStores()
    tasks.beginEdit('task-1')

    await tasks.deleteTask('task-2')

    expect(tasks.editingTaskId).toBe('task-1')
  })
})

describe('editing a Task’s Settings Template', () => {
  const EDITED: AgentSessionSettings = {
    backend: 'openVINO',
    device: { id: 'NPU', uuid: null },
    model: 'Edited-NPU',
    contextSize: 4096,
    contextSizeEdited: true,
    thinkingEnabled: false,
    planningThinkingOnly: true,
    capabilities: ['files', 'rag', 'mcp:search'],
    embeddingModel: 'Embed-small',
    toolDelegationEnabled: false,
    builtinToolEnablement: { comfyUI: false },
    builtinToolPresetEnablement: { 'Draft Image': false },
    builtinToolDefaultPresets: { 'comfyUI:image': 'Fast Image' },
  }

  it('saves the edited template, and leaves the Open Session and the defaults alone', async () => {
    storedTasks = [savedTask('task-1')]
    const { agentMode, tasks } = await readyStores()
    const sessionSettings = JSON.stringify(agentMode.openSessionSettings)
    const defaults = JSON.stringify({
      capabilities: agentMode.defaultCapabilities,
      planning: agentMode.planningThinkingOnly,
    })
    const sessionWrites = vi.mocked(window.electronAPI.agentMode.saveSession).mock.calls.length
    tasks.beginEdit('task-1')

    tasks.editTemplate({ backend: 'openVINO', device: { id: 'NPU', uuid: null } })
    tasks.editTemplate({ model: 'Edited-NPU', contextSize: 4096, contextSizeEdited: true })
    tasks.editTemplate({ thinkingEnabled: false, planningThinkingOnly: true })
    tasks.editTemplate({ capabilities: ['files', 'rag', 'mcp:search'] })
    tasks.editTemplate({ embeddingModel: 'Embed-small', toolDelegationEnabled: false })
    tasks.editTemplate({
      builtinToolEnablement: { comfyUI: false },
      builtinToolPresetEnablement: { 'Draft Image': false },
      builtinToolDefaultPresets: { 'comfyUI:image': 'Fast Image' },
    })

    expect(tasks.editDirty).toBe(true)
    expect(tasks.tasks[0].settingsTemplate).toEqual(SETTINGS)
    expect((await tasks.saveEdit()).ok).toBe(true)

    expect(saveTask.mock.calls[0][0].settingsTemplate).toEqual({ ...SETTINGS, ...EDITED })
    expect(tasks.tasks[0].settingsTemplate).toEqual({ ...SETTINGS, ...EDITED })
    expect(JSON.stringify(agentMode.openSessionSettings)).toBe(sessionSettings)
    expect(
      JSON.stringify({
        capabilities: agentMode.defaultCapabilities,
        planning: agentMode.planningThinkingOnly,
      }),
    ).toBe(defaults)
    expect(vi.mocked(window.electronAPI.agentMode.saveSession).mock.calls.length).toBe(
      sessionWrites,
    )
  })

  it('is clean again once the template is edited back', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()
    tasks.beginEdit('task-1')

    tasks.editTemplate({ model: 'Other-9B' })
    expect(tasks.editDirty).toBe(true)
    tasks.editTemplate({ model: SETTINGS.model })

    expect(tasks.editDirty).toBe(false)
  })

  it('is dropped by Discard, keeping the saved template', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()
    tasks.beginEdit('task-1')
    tasks.editTemplate({ model: 'Other-9B', capabilities: [] })

    tasks.discardEdit()

    expect(tasks.tasks[0].settingsTemplate).toEqual(SETTINGS)
    tasks.beginEdit('task-1')
    expect(tasks.editDraft?.settingsTemplate).toEqual(SETTINGS)
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('ignores template edits when no Task is being edited', async () => {
    storedTasks = [savedTask('task-1')]
    const { tasks } = await readyStores()

    tasks.editTemplate({ model: 'Other-9B' })

    expect(tasks.editDraft).toBeNull()
    expect(tasks.tasks[0].settingsTemplate).toEqual(SETTINGS)
  })
})

describe('saving a Task whose chat model is not downloaded', () => {
  it('asks to download the model, and saves the new Task once it downloaded', async () => {
    missingModels = new Set(['Stored-27B'])
    const { tasks } = await readyStores()
    let finishDownload = () => {}
    requestDownload.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )

    const saving = tasks.saveTask(draftOf('Docs', 'go'))
    await vi.waitFor(() => expect(requestDownload).toHaveBeenCalledTimes(1))

    expect(requestDownload.mock.calls[0][0]).toEqual([
      expect.objectContaining({ repo_id: 'Stored-27B' }),
    ])
    expect(saveTask).not.toHaveBeenCalled()
    finishDownload()
    expect((await saving).ok).toBe(true)
    expect(saveTask).toHaveBeenCalledTimes(1)
    expect(tasks.tasks).toHaveLength(1)
  })

  it.each([
    [
      'declining',
      async () => {
        const { createCancellation } = await import('@/assets/js/errors/appError')
        throw createCancellation({ technicalMessage: 'Download cancelled by user' })
      },
      'download-declined',
    ],
    [
      'a failed download',
      async () => {
        throw new Error('Not enough disk space')
      },
      'download-failed',
    ],
  ])('saves nothing after %s, and says why', async (_case, outcome, reason) => {
    missingModels = new Set(['Stored-27B'])
    requestDownload.mockImplementation(outcome)
    const { tasks } = await readyStores()
    tasks.createStepsFromSession()

    const result = await tasks.saveDraft()

    expect(result).toMatchObject({
      ok: false,
      reason,
      message: expect.stringContaining('Stored-27B'),
    })
    expect(saveTask).not.toHaveBeenCalled()
    expect(tasks.tasks).toEqual([])
    expect(tasks.draft.name).toBe('Tidy the docs')
  })

  it('names the download error in the message', async () => {
    missingModels = new Set(['Stored-27B'])
    requestDownload.mockRejectedValue(new Error('Not enough disk space'))
    const { tasks } = await readyStores()

    const result = await tasks.saveTask(draftOf('Docs', 'go'))

    expect(result).toMatchObject({ error: 'Not enough disk space' })
    expect(!result.ok && 'message' in result && result.message).toContain('Not enough disk space')
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'agent-tasks/model-download-failed', surface: 'inline' }),
    )
  })

  it('saves without asking when the model is already downloaded', async () => {
    const { tasks } = await readyStores()

    expect((await tasks.saveTask(draftOf('Docs', 'go'))).ok).toBe(true)
    expect(requestDownload).not.toHaveBeenCalled()
  })

  it('never asks for a cloud model', async () => {
    missingModels = new Set(['Stored-27B', 'cloud-model'])
    openSessionSettings = { ...SETTINGS, backend: 'cloud', model: 'cloud-model' }
    const { tasks } = await readyStores()

    expect((await tasks.saveTask(draftOf('Docs', 'go'))).ok).toBe(true)
    expect(requestDownload).not.toHaveBeenCalled()
  })

  it('asks for the vision projector too when a Step hands the model an image', async () => {
    missingModels = new Set([VISION_PROJECTOR])
    openSessionSettings = { ...SETTINGS, model: VISION_MODEL }
    const { tasks } = await readyStores()

    await tasks.saveTask(draftOf('Docs', `use this sprite${ATTACHMENT_LINE}`))

    expect(requestDownload.mock.calls[0][0]).toEqual([
      expect.objectContaining({ repo_id: VISION_PROJECTOR }),
    ])
  })

  it('does not ask for the vision projector when no Step carries an image', async () => {
    missingModels = new Set([VISION_PROJECTOR])
    openSessionSettings = { ...SETTINGS, model: VISION_MODEL }
    const { tasks } = await readyStores()

    expect((await tasks.saveTask(draftOf('Docs', 'write the readme'))).ok).toBe(true)
    expect(requestDownload).not.toHaveBeenCalled()
  })
})

describe('typing while a new Task’s model downloads', () => {
  it('keeps what was typed meanwhile in the draft', async () => {
    missingModels = new Set(['Stored-27B'])
    let finishDownload = () => {}
    requestDownload.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )
    const { tasks } = await readyStores()
    tasks.createStepsFromSession()

    const saving = tasks.saveDraft()
    await vi.waitFor(() => expect(requestDownload).toHaveBeenCalledTimes(1))
    tasks.draft.name = 'Typed during download'
    finishDownload()
    await saving

    expect(saveTask.mock.calls[0][0].name).toBe('Tidy the docs')
    expect(tasks.draft.name).toBe('Typed during download')
  })
})

describe('saving an edited Task whose chat model is not downloaded', () => {
  it('asks even when the model did not change, and saves once it downloaded', async () => {
    storedTasks = [savedTask('task-1')]
    missingModels = new Set(['Stored-27B'])
    const { tasks } = await readyStores()
    tasks.beginEdit('task-1')
    tasks.editDraft!.name = 'Renamed'

    const result = await tasks.saveEdit()

    expect(requestDownload).toHaveBeenCalledTimes(1)
    expect(requestDownload.mock.calls[0][0]).toEqual([
      expect.objectContaining({ repo_id: 'Stored-27B' }),
    ])
    expect(result.ok).toBe(true)
    expect(saveTask.mock.calls[0][0].name).toBe('Renamed')
    expect(tasks.editingTaskId).toBeNull()
  })

  it('checks the model the edit picked', async () => {
    storedTasks = [savedTask('task-1')]
    missingModels = new Set(['Other-9B'])
    const { tasks } = await readyStores()
    tasks.beginEdit('task-1')
    tasks.editTemplate({ model: 'Other-9B' })

    await tasks.saveEdit()

    expect(requestDownload.mock.calls[0][0]).toEqual([
      expect.objectContaining({ repo_id: 'Other-9B' }),
    ])
  })

  it('keeps the editor open and the Task unchanged when the download is declined', async () => {
    const { createCancellation } = await import('@/assets/js/errors/appError')
    storedTasks = [savedTask('task-1')]
    missingModels = new Set(['Stored-27B'])
    requestDownload.mockRejectedValue(createCancellation())
    const { tasks } = await readyStores()
    tasks.beginEdit('task-1')
    tasks.editDraft!.name = 'Renamed'

    const result = await tasks.saveEdit()

    expect(result).toMatchObject({ ok: false, reason: 'download-declined' })
    expect(saveTask).not.toHaveBeenCalled()
    expect(tasks.tasks[0].name).toBe('Task task-1')
    expect(tasks.editingTaskId).toBe('task-1')
    expect(tasks.editDraft?.name).toBe('Renamed')
  })
})
