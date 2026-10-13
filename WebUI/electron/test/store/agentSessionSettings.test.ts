import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ChatPreset } from '@/assets/js/store/presets'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'

// Session Settings for the Agent preset: each Agent Session keeps its own backend
// and model, a Draft Session starts from the Default Settings (the preset's saved
// bag), and the other presets keep sharing one bag per preset.

type Bag = Record<string, unknown>

const AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Agent',
  backends: ['llamaCPP', 'openVINO'],
  agentPreset: true,
  agentWorkspace: 'pick',
} as ChatPreset

const GAME_AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Game Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'games',
  agentCapabilities: ['game-studio'],
} as ChatPreset

const PRESETS = [AGENT, GAME_AGENT]
const activePreset = ref<ChatPreset>(AGENT)

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    presets: PRESETS,
    get activePresetWithVariant() {
      return activePreset.value
    },
  }),
}))

const presetSwitchingMock = vi.hoisted(() => ({ switchPreset: vi.fn() }))
vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => presetSwitchingMock,
}))

/**
 * Stands in for the chat settings store, honouring the same binding contract: the
 * active preset's live values load from the bound session (or the preset's bag when
 * the session has none, reporting what it loaded), and edits go to the session for
 * the Agent preset and to the preset's bag for every other preset.
 */
const chat = vi.hoisted(() => {
  type Binding = { load: (d: Bag) => Bag | null; save: (b: Bag) => void }
  const state = {
    binding: null as Binding | null,
    live: { backend: 'llamaCPP', selectedModels: {} as Record<string, string | null> },
    settingsPerPreset: {} as Record<string, Bag>,
    presetName: () => 'Agent',
  }
  const current = (): Bag => ({
    backend: state.live.backend,
    selectedModels: { ...state.live.selectedModels },
  })
  const apply = (bag: Bag) => {
    state.live.backend = (bag.backend as string) ?? 'llamaCPP'
    state.live.selectedModels = { ...((bag.selectedModels as Record<string, string>) ?? {}) }
  }
  const sessionScoped = () => state.presetName() === 'Agent'
  return {
    state,
    store: {
      get backend() {
        return state.live.backend
      },
      get activeModel() {
        return state.live.selectedModels[state.live.backend] ?? undefined
      },
      get settingsPerPreset() {
        return state.settingsPerPreset
      },
      ensureReadyForInference: async () => {},
      bindSessionSettings: (binding: Binding | null) => {
        state.binding = binding
      },
      loadSettingsForActivePreset: () => {
        const defaults = state.settingsPerPreset[state.presetName()] ?? {}
        const sessionBag = sessionScoped() ? (state.binding?.load(defaults) ?? null) : null
        apply(sessionBag ?? defaults)
        if (sessionScoped() && !sessionBag) state.binding?.save(current())
      },
    },
    edit(change: { backend?: string; model?: string }) {
      if (change.backend) state.live.backend = change.backend
      if (change.model !== undefined) state.live.selectedModels[state.live.backend] = change.model
      const name = state.presetName()
      if (sessionScoped() && state.binding) {
        state.binding.save(current())
        return
      }
      state.settingsPerPreset[name] = { ...state.settingsPerPreset[name], ...current() }
    },
  }
})

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => chat.store,
  backendToAipgBackendName: { llamaCPP: 'llama_cpp', openVINO: 'openvino' },
}))

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({ checkModelAlreadyLoaded: vi.fn().mockResolvedValue([]) }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: vi.fn() }),
}))

vi.mock('@/assets/js/tools/agentBridge', () => ({
  getAgentToolSpecs: () => [],
}))

vi.mock('@ai-sdk/vue', () => ({
  Chat: class {
    messages: unknown[] = []
    error = undefined
    sendMessage = vi.fn(async function (this: { messages: unknown[] }, m: { text: string }) {
      this.messages = [
        ...this.messages,
        { id: `u${this.messages.length}`, role: 'user', parts: [{ type: 'text', text: m.text }] },
      ]
    })
    stop = vi.fn()
  },
}))

const saveSession = vi.fn(async (_record: { id: string; settings?: AgentSessionSettings }) => ({
  success: true,
}))

const ok = async () => ({ success: true as const })

function fakeWindow(): void {
  const storage = new Map<string, string>()
  const shim = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }
  globalThis.localStorage = shim as unknown as Storage
  globalThis.sessionStorage = shim as unknown as Storage
  globalThis.window = {
    electronAPI: {
      agentMode: {
        cancel: vi.fn(async () => {}),
        onExecuteTool: vi.fn(),
        bootstrapSessions: vi.fn(async () => ({ status: 'empty' })),
        migrateSessions: vi.fn(),
        saveSession,
        saveActiveSessionId: vi.fn(ok),
        deleteSession: vi.fn(ok),
        readWorkspaceState: vi.fn(async () => ({
          success: true,
          section: { workspaceDir: '/work', lastWorkspaceByKind: { pick: '/work' } },
        })),
        migrateWorkspaceState: vi.fn(ok),
        writeWorkspaceState: vi.fn(ok),
      },
      getLocaleSettings: vi.fn(async () => ({ languageOverride: null })),
      games: { read: vi.fn(async () => null), list: vi.fn(async () => []) },
    },
  } as unknown as Window & typeof globalThis
}

const { useAgentMode } = await import('@/assets/js/store/agentMode')

beforeEach(() => {
  setActivePinia(createPinia())
  fakeWindow()
  vi.clearAllMocks()
  activePreset.value = AGENT
  presetSwitchingMock.switchPreset.mockImplementation(async (name: string) => {
    activePreset.value = PRESETS.find((p) => p.name === name) ?? AGENT
    chat.store.loadSettingsForActivePreset()
    return { success: true }
  })
  chat.state.binding = null
  chat.state.presetName = () => activePreset.value.name
  chat.state.live = { backend: 'llamaCPP', selectedModels: {} }
  chat.state.settingsPerPreset = {
    Agent: { backend: 'llamaCPP', selectedModels: { llamaCPP: 'Default-9B' } },
  }
})

afterEach(() => {
  // @ts-expect-error test teardown of the fakes
  delete globalThis.window
})

async function startedStore() {
  const store = useAgentMode()
  await store.init()
  await store.newSession()
  return store
}

function savedSettings(id: string): AgentSessionSettings | undefined {
  const calls = saveSession.mock.calls.filter(([record]) => record.id === id)
  return calls.at(-1)?.[0].settings
}

const live = () => ({ backend: chat.store.backend, model: chat.store.activeModel })

describe('Agent Session Settings', () => {
  it('starts a Draft Session from the Default Settings', async () => {
    await startedStore()
    expect(live()).toEqual({ backend: 'llamaCPP', model: 'Default-9B' })
  })

  it('stores the settings with the transcript when the first turn ends', async () => {
    const store = await startedStore()
    chat.edit({ model: 'Picked-27B' })
    await store.generate('build it')

    expect(savedSettings(store.activeSessionId)).toEqual({
      backend: 'llamaCPP',
      model: 'Picked-27B',
    })
  })

  it('writes nothing for a Draft Session left before its first turn', async () => {
    const store = await startedStore()
    chat.edit({ model: 'Picked-27B' })
    await store.newSession()

    expect(saveSession).not.toHaveBeenCalled()
  })

  it('keeps edits in one session out of the others and out of the defaults', async () => {
    const store = await startedStore()
    await store.generate('first')
    const first = store.activeSessionId

    await store.newSession()
    chat.edit({ backend: 'openVINO', model: 'Phi-4' })
    await store.generate('second')
    const second = store.activeSessionId

    expect(savedSettings(first)).toEqual({ backend: 'llamaCPP', model: 'Default-9B' })
    expect(savedSettings(second)).toEqual({ backend: 'openVINO', model: 'Phi-4' })
    expect(chat.state.settingsPerPreset.Agent).toEqual({
      backend: 'llamaCPP',
      selectedModels: { llamaCPP: 'Default-9B' },
    })
  })

  it("shows a session's own settings again when switching back to it", async () => {
    const store = await startedStore()
    chat.edit({ backend: 'openVINO', model: 'Phi-4' })
    await store.generate('first')
    const first = store.activeSessionId

    await store.newSession()
    expect(live()).toEqual({ backend: 'llamaCPP', model: 'Default-9B' })

    await store.switchSession(first)
    expect(live()).toEqual({ backend: 'openVINO', model: 'Phi-4' })
  })

  it('does not change a session when the user edits after leaving it', async () => {
    const store = await startedStore()
    await store.generate('first')
    const first = store.activeSessionId
    await store.newSession()
    chat.edit({ model: 'Other-4B' })

    expect(store.sessions[first].settings).toEqual({ backend: 'llamaCPP', model: 'Default-9B' })
  })

  it('leaves Game Agent on its shared per-preset settings', async () => {
    const store = await startedStore()
    await presetSwitchingMock.switchPreset('Game Agent')
    chat.edit({ model: 'Coder-14B' })

    expect(chat.state.settingsPerPreset['Game Agent']).toMatchObject({
      selectedModels: { llamaCPP: 'Coder-14B' },
    })
    expect(store.sessions[store.activeSessionId]?.settings).toBeUndefined()
  })
})
