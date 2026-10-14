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

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    backend: 'llamaCPP',
    activeModel: 'Live-9B',
    settingsPerPreset: {},
    embeddingBackend: 'llamaCPP',
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
let storedTasks: AgentTask[]

const saveTask = vi.fn(async (_task: AgentTask) => ({ success: true as boolean, error: '' }))
const readTasks = vi.fn(async () => ({ success: true as const, tasks: storedTasks }))

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  storedTasks = []
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
              settings: SETTINGS,
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
