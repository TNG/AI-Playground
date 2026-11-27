import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as vue from 'vue'
import { reactive } from 'vue'

// A chat turn is sent straight to the chat backend, never through the Channels service.

Object.assign(globalThis, vue)

const LLAMACPP_URL = 'http://127.0.0.1:39100'
const CHANNELS_SERVICE_URL = 'http://127.0.0.1:58000'

vi.mock('@/assets/js/store/backendServices', () => ({
  useBackendServices: () =>
    reactive({
      info: [
        { serviceName: 'llamacpp-backend', baseUrl: LLAMACPP_URL, status: 'running' },
        { serviceName: 'home-agent-backend', baseUrl: CHANNELS_SERVICE_URL, status: 'running' },
      ],
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
  })

  it('is the chat backend', () => {
    expect(useTextInference().currentBackendUrl).toBe(LLAMACPP_URL)
  })
})
