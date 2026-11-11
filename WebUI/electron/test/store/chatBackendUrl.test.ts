import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as vue from 'vue'
import { reactive } from 'vue'

// A chat turn is sent straight to the chat backend whatever the Channels are doing.

Object.assign(globalThis, vue)

const LLAMACPP_URL = 'http://127.0.0.1:39100'
const CHANNELS_SERVICE_URL = 'http://127.0.0.1:58000'

const channels = vi.hoisted(() => ({ on: false }))

vi.mock('@/assets/js/store/backendServices', () => ({
  useBackendServices: () =>
    reactive({
      info: [
        { serviceName: 'llamacpp-backend', baseUrl: LLAMACPP_URL, status: 'running' },
        { serviceName: 'home-agent-backend', baseUrl: CHANNELS_SERVICE_URL, status: 'running' },
      ],
    }),
}))
vi.mock('@/assets/js/store/homeAgent', () => ({
  useHomeAgent: () => ({
    get isHomeAgentActive() {
      return channels.on
    },
  }),
}))
vi.mock('@/assets/js/store/models', () => ({ useModels: () => reactive({ models: [] }) }))
vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () =>
    reactive({
      presets: [],
      selectableChatTypePresets: [],
      activePresetName: null,
      activeVariantName: {},
    }),
}))
vi.mock('@/assets/js/store/developerSettings', () => ({
  useDeveloperSettings: () => reactive({}),
}))
vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => reactive({ enabled: false, activeProviderBaseUrl: undefined }),
  CLOUD_DEFAULT_MODEL: 'default',
  ASSUME_ALL_CAPABILITIES: false,
}))
vi.mock('@/assets/js/store/conversations', () => ({
  useConversations: () =>
    reactive({ activeKey: '', conversationList: {}, getThreadRagHashes: () => [] }),
  HOME_AGENT_CHAT_PRESET_NAME: 'Home Agent',
}))
vi.mock('@/assets/js/store/modelPreferences', () => ({
  useModelPreferences: () => reactive({ favorites: [] }),
}))
vi.mock('@/assets/js/store/activities', () => ({ useActivities: () => ({}) }))
vi.mock('@/assets/js/store/i18n', () => ({ useI18N: () => ({ state: {} }) }))
vi.mock('@/assets/js/store/ui', () => ({ useUIStore: () => reactive({}) }))
vi.mock('@/assets/js/toast.ts', () => ({ show: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('@/assets/js/permissions/permissions', () => ({
  notify: vi.fn(),
  requestDownload: vi.fn(),
}))

const { useTextInference } = await import('@/assets/js/store/textInference')

describe('chat backend URL', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    channels.on = false
  })

  it('is the chat backend while no Channel is on', () => {
    expect(useTextInference().currentBackendUrl).toBe(LLAMACPP_URL)
  })

  it('is still the chat backend while a Channel is on', () => {
    channels.on = true
    expect(useTextInference().currentBackendUrl).toBe(LLAMACPP_URL)
  })
})
