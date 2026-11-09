import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentDraft, AgentTask } from '@/types/agentTaskIpc'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// The Agents store's Drafts, as the Agent Library edits them: creating an Agent as a
// Draft, saving and discarding Drafts, and deleting. Driven through its public interface
// against the real Agent store, with a fake electronAPI standing in for the kernel's files.

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
  state: null as { presets: ChatPreset[]; active: ChatPreset | null; saved: boolean } | null,
}))

const catalog = new Proxy({} as NonNullable<typeof catalogRef.state>, {
  get: (_target, key) => Reflect.get(catalogRef.state!, key),
  set: (_target, key, value) => Reflect.set(catalogRef.state!, key, value),
})

const addPreset = vi.fn(async (preset: ChatPreset) => {
  if (!catalog.saved) return false
  catalog.presets = [...catalog.presets.filter((entry) => entry.name !== preset.name), preset]
  return true
})
const removeUserPreset = vi.fn(async (name: string) => {
  catalog.presets = catalog.presets.filter((entry) => entry.name !== name)
  return true
})

vi.mock('@/assets/js/store/presets', async () => {
  const { reactive } = await import('vue')
  catalogRef.state = reactive({ presets: [] as ChatPreset[], active: null, saved: true })
  return {
    usePresets: () => ({
      get presets() {
        return catalog.presets
      },
      get activePresetWithVariant() {
        return catalog.active
      },
      addPreset,
      removeUserPreset,
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

/** What the backends can serve right now; an empty model list checks no model. */
const availability = vi.hoisted(() => ({
  models: [] as { name: string; type: string }[],
  embeddingModels: [] as { name: string; type: string }[],
  services: [] as unknown[],
  cloudEnabled: false,
  cloudProviderIds: [] as string[],
  embeddingBackend: 'llamaCPP',
}))

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
    settingsAvailability: availability,
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
let storedDrafts: AgentDraft[]

const saveTask = vi.fn(async (task: AgentTask) => {
  storedTasks = storedTasks.some((entry) => entry.id === task.id)
    ? storedTasks.map((entry) => (entry.id === task.id ? task : entry))
    : [...storedTasks, task]
  return { success: true as boolean, error: '' }
})
const readTasks = vi.fn(async () => ({ success: true as const, tasks: storedTasks }))
const deleteTask = vi.fn(async (id: string) => {
  storedTasks = storedTasks.filter((entry) => entry.id !== id)
  storedDrafts = storedDrafts.filter((entry) => entry.agentId !== id)
  return { success: true as boolean, error: '' }
})
const readDrafts = vi.fn(async () => ({ success: true as const, drafts: storedDrafts }))
const saveDraft = vi.fn(async (draft: AgentDraft) => {
  const index = storedDrafts.findIndex((entry) => entry.agentId === draft.agentId)
  storedDrafts =
    index >= 0
      ? storedDrafts.map((entry, at) => (at === index ? draft : entry))
      : [...storedDrafts, draft]
  return { success: true as boolean, error: '' }
})
const deleteDraft = vi.fn(async (agentId: string) => {
  storedDrafts = storedDrafts.filter((entry) => entry.agentId !== agentId)
  return { success: true as boolean, error: '' }
})

const SESSION = 'session-1'
let runHarnesses = 0

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  for (const key of Object.keys(settingsPerPreset)) delete settingsPerPreset[key]
  catalog.presets = [{ ...AGENT, image: 'data:image/png;base64,AGENT', extendedDescription: 'How' }]
  catalog.active = AGENT
  catalog.saved = true
  storedTasks = []
  storedDrafts = []
  missingModels = new Set()
  availability.models = []
  openSessionSettings = SETTINGS
  requestDownload.mockImplementation(async () => {})
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
        deleteTask,
        readDrafts,
        saveDraft,
        deleteDraft,
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

async function readyStores(options: { session?: boolean } = {}) {
  const agentMode = useAgentMode()
  await agentMode.init()
  if (options.session !== false) await useSessions().create()
  const tasks = useAgentTasks()
  await tasks.init()
  return { agentMode, tasks }
}

const savedAgent = (id: string, overrides: Partial<AgentTask> = {}): AgentTask => ({
  id,
  name: `Agent ${id}`,
  settingsTemplate: SETTINGS,
  steps: [{ id: 's1', prompt: 'go' }],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

const stepsOf = (...prompts: string[]) =>
  prompts.map((prompt, index) => ({ id: `step-${index}`, prompt }))

describe('creating an Agent', () => {
  it('makes a Draft only, kept on disk and listed in the library', async () => {
    const { tasks } = await readyStores()

    const draft = await tasks.createAgentDraft()

    expect(tasks.tasks).toEqual([])
    expect(saveTask).not.toHaveBeenCalled()
    expect(storedDrafts.map((entry) => entry.agentId)).toEqual([draft.agentId])
    expect(tasks.libraryAgents).toEqual([
      expect.objectContaining({ id: draft.agentId, name: '', hasDraft: true, saved: false }),
    ])
  })

  it('is saved as a new Agent, with its description, image, Steps and settings', async () => {
    const { tasks } = await readyStores()
    const { agentId } = await tasks.createAgentDraft()
    await tasks.editDraft(agentId, {
      name: ' News digest ',
      description: 'Reads the news',
      image: 'data:image/png;base64,NEWS',
      steps: stepsOf('search the news', 'summarise it'),
      settingsTemplate: SETTINGS,
    })

    expect(await tasks.saveAgentDraft(agentId)).toEqual(expect.objectContaining({ ok: true }))

    expect(tasks.tasks).toEqual([
      expect.objectContaining({
        id: agentId,
        name: 'News digest',
        description: 'Reads the news',
        image: 'data:image/png;base64,NEWS',
        steps: stepsOf('search the news', 'summarise it'),
        settingsTemplate: SETTINGS,
      }),
    ])
    expect(storedTasks.map((task) => task.id)).toEqual([agentId])
    expect(storedDrafts).toEqual([])
    expect(tasks.libraryAgents).toEqual([
      expect.objectContaining({ id: agentId, name: 'News digest', hasDraft: false, saved: true }),
    ])
  })
})

describe('saving a Draft', () => {
  it.each([
    ['an empty name', { name: '  ', steps: stepsOf('go') }, 'name'],
    ['no Steps', { name: 'Docs', steps: [] }, 'no-steps'],
    ['an empty Step', { name: 'Docs', steps: stepsOf('go', ' \n ') }, 'empty-step'],
  ])('is blocked by %s, saying why and keeping the Draft', async (_case, edit, reason) => {
    const { tasks } = await readyStores()
    const { agentId } = await tasks.createAgentDraft()
    await tasks.editDraft(agentId, edit)

    expect(tasks.draftBlocker(agentId)).toBe(reason)
    expect(await tasks.saveAgentDraft(agentId)).toEqual({ ok: false, reason })

    expect(saveTask).not.toHaveBeenCalled()
    expect(tasks.tasks).toEqual([])
    expect(storedDrafts.map((entry) => entry.agentId)).toEqual([agentId])
  })

  it('replaces the saved Agent’s editable fields, keeping its identity and Schedules', async () => {
    const schedules = [
      { every: 1, unit: 'days' as const, startAt: 5, enabled: true, sessionRef: SESSION },
    ]
    const lastOutcome = { kind: 'completed' as const, at: 4, stepCount: 1 }
    storedTasks = [
      savedAgent('a', { description: 'old', image: 'data:old', schedules, lastOutcome }),
      savedAgent('b'),
    ]
    const { tasks } = await readyStores()
    const scheduled = tasks.tasks[0].schedules
    await tasks.editDraft('a', { name: 'Renamed', steps: stepsOf('new step') })
    await tasks.editDraft('a', { description: undefined, image: 'data:new' })

    expect((await tasks.saveAgentDraft('a')).ok).toBe(true)

    const { updatedAt, ...saved } = tasks.tasks[0]
    expect(saved).toEqual({
      id: 'a',
      name: 'Renamed',
      image: 'data:new',
      settingsTemplate: SETTINGS,
      steps: stepsOf('new step'),
      createdAt: 1,
      schedules: scheduled,
      lastOutcome,
    })
    expect(updatedAt).toBeGreaterThan(1)
    expect(tasks.tasks[1]).toEqual(savedAgent('b'))
    expect(storedTasks[0]).toEqual(tasks.tasks[0])
    expect(storedDrafts).toEqual([])
  })

  it('keeps the Draft and the saved Agent when the file cannot be written', async () => {
    storedTasks = [savedAgent('a')]
    const { tasks } = await readyStores()
    await tasks.editDraft('a', { name: 'Renamed' })
    saveTask.mockImplementationOnce(async () => ({ success: false, error: 'disk full' }))

    expect(await tasks.saveAgentDraft('a')).toEqual({ ok: false, reason: 'persist-failed' })

    expect(tasks.tasks).toEqual([savedAgent('a')])
    expect(storedDrafts.map((entry) => entry.name)).toEqual(['Renamed'])
  })
})

describe('editing a saved Agent', () => {
  it('goes to its Draft and leaves the saved Agent as it is', async () => {
    storedTasks = [savedAgent('a'), savedAgent('b')]
    const { tasks } = await readyStores()

    await tasks.editDraft('a', { name: 'Edited', steps: stepsOf('edited step') })

    expect(tasks.tasks).toEqual([savedAgent('a'), savedAgent('b')])
    expect(saveTask).not.toHaveBeenCalled()
    expect(storedDrafts).toEqual([
      expect.objectContaining({
        agentId: 'a',
        name: 'Edited',
        steps: stepsOf('edited step'),
        settingsTemplate: SETTINGS,
      }),
    ])
    expect(tasks.libraryAgents).toEqual([
      expect.objectContaining({ id: 'a', name: 'Edited', hasDraft: true, saved: true }),
      expect.objectContaining({ id: 'b', name: 'Agent b', hasDraft: false, saved: true }),
    ])
  })

  it('is discarded back to the saved Agent', async () => {
    storedTasks = [savedAgent('a')]
    const { tasks } = await readyStores()
    await tasks.editDraft('a', { name: 'Edited' })

    expect(await tasks.discardAgentDraft('a')).toBe(true)

    expect(storedDrafts).toEqual([])
    expect(tasks.libraryAgents).toEqual([
      expect.objectContaining({ id: 'a', name: 'Agent a', hasDraft: false }),
    ])
  })

  it('is read back on the next start', async () => {
    storedTasks = [savedAgent('a')]
    const first = await readyStores()
    await first.tasks.editDraft('a', { name: 'Edited' })

    setActivePinia(createPinia())
    const { tasks } = await readyStores()

    expect(tasks.libraryAgents).toEqual([
      expect.objectContaining({ id: 'a', name: 'Edited', hasDraft: true }),
    ])
  })

  it('reports when the Draft cannot be written', async () => {
    storedTasks = [savedAgent('a')]
    const { tasks } = await readyStores()
    saveDraft.mockImplementationOnce(async () => ({ success: false, error: 'disk full' }))

    expect(await tasks.editDraft('a', { name: 'Edited' })).toBe(false)

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'agent-library/draft-save-failed', surface: 'toast' }),
    )
  })
})

describe('deleting an Agent', () => {
  it('removes its Draft with it', async () => {
    storedTasks = [savedAgent('a'), savedAgent('b')]
    const { tasks } = await readyStores()
    await tasks.editDraft('a', { name: 'Edited' })

    expect(await tasks.deleteTask('a')).toBe(true)

    expect(storedDrafts).toEqual([])
    expect(tasks.libraryAgents.map((agent) => agent.id)).toEqual(['b'])
  })

  it('removes an Agent that only exists as a Draft', async () => {
    const { tasks } = await readyStores()
    const { agentId } = await tasks.createAgentDraft()

    expect(await tasks.deleteTask(agentId)).toBe(true)

    expect(storedDrafts).toEqual([])
    expect(tasks.libraryAgents).toEqual([])
  })
})

describe('editing an Agent’s Settings Template', () => {
  it('goes to its Draft, keeping the other settings and leaving every Session’s alone', async () => {
    storedTasks = [savedAgent('a')]
    const { agentMode, tasks } = await readyStores()
    const sessionSettings = structuredClone(agentMode.openSessionSettings)

    await tasks.editDraftSettings('a', { model: 'Other-9B' })
    await tasks.editDraftSettings('a', { thinkingEnabled: false })

    expect(storedDrafts).toEqual([
      expect.objectContaining({
        agentId: 'a',
        settingsTemplate: { ...SETTINGS, model: 'Other-9B', thinkingEnabled: false },
      }),
    ])
    expect(tasks.tasks).toEqual([savedAgent('a')])
    expect(agentMode.openSessionSettings).toEqual(sessionSettings)
    expect(saveTask).not.toHaveBeenCalled()
  })

  it('adds, switches and removes Mounted Folders, saved with the Agent', async () => {
    storedTasks = [savedAgent('a')]
    const { tasks } = await readyStores()

    await tasks.editDraftSettings('a', {
      mountedFolders: [{ hostPath: '/data/notes' }, { hostPath: '/data/out' }],
    })
    await tasks.editDraftSettings('a', {
      mountedFolders: [{ hostPath: '/data/notes', access: 'read-write' }],
    })
    expect((await tasks.saveAgentDraft('a')).ok).toBe(true)

    expect(tasks.tasks[0].settingsTemplate).toEqual({
      ...SETTINGS,
      mountedFolders: [{ hostPath: '/data/notes', access: 'read-write' }],
    })
  })

  it('blocks Save while a setting cannot be used, naming the problem', async () => {
    storedTasks = [savedAgent('a')]
    availability.models = [{ name: 'Stored-27B', type: 'llamaCPP' }]
    const { tasks } = await readyStores()

    await tasks.editDraftSettings('a', { model: 'Gone-9B' })

    expect(tasks.draftSettingsProblems('a')).toEqual([{ field: 'model', value: 'Gone-9B' }])
    expect(tasks.draftBlocker('a')).toBe('settings')
    expect(await tasks.saveAgentDraft('a')).toEqual({ ok: false, reason: 'settings' })
    expect(saveTask).not.toHaveBeenCalled()

    await tasks.editDraftSettings('a', { model: 'Stored-27B' })

    expect(tasks.draftSettingsProblems('a')).toEqual([])
    expect(tasks.draftBlocker('a')).toBeNull()
    expect((await tasks.saveAgentDraft('a')).ok).toBe(true)
  })

  it('names a missing name before unusable settings', async () => {
    availability.models = [{ name: 'Stored-27B', type: 'llamaCPP' }]
    const { tasks } = await readyStores()
    const { agentId } = await tasks.createAgentDraft()
    await tasks.editDraftSettings(agentId, { backend: 'llamaCPP', model: 'Gone-9B' })

    expect(tasks.draftBlocker(agentId)).toBe('name')
  })
})
