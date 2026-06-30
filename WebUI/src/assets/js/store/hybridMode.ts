import { acceptHMRUpdate, defineStore } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'

/**
 * A remote OpenAI-compatible provider (e.g. a self-hosted or cloud LLM
 * endpoint). The API key is NOT stored here — only an encrypted blob on disk
 * via safeStorage in the main process (see `window.electronAPI.hybridProvider`).
 * `models` holds the ids fetched from the provider's `GET /v1/models`.
 */
export type HybridProvider = {
  id: string
  name: string
  baseUrl: string
  models: string[]
}

// Seed provider shown on first open. The user fills in base URL + key.
const DEFAULT_PROVIDER: HybridProvider = {
  id: 'custom',
  name: 'Custom',
  baseUrl: '',
  models: [],
}

export const useHybridMode = defineStore(
  'hybridMode',
  () => {
    // Mirrors `isHybridModeEnabled` from local settings. Hydrated on init().
    const isFeatureEnabled = ref(false)

    const providers = ref<HybridProvider[]>([{ ...DEFAULT_PROVIDER }])
    const selectedProviderId = ref<string>(DEFAULT_PROVIDER.id)

    // Decrypted API keys, kept in memory for the session only (never persisted
    // in the renderer). Populated lazily from safeStorage via loadApiKey().
    const apiKeyCache = reactive<Record<string, string>>({})

    const selectedProvider = computed<HybridProvider | undefined>(() =>
      providers.value.find((p) => p.id === selectedProviderId.value),
    )

    const activeProviderBaseUrl = computed<string | undefined>(() => {
      const url = selectedProvider.value?.baseUrl?.trim()
      if (!url) return undefined
      // Normalize: callers append `/v1/`, so strip a trailing slash (and a
      // trailing `/v1` if the user pasted the full base) to avoid `//v1/`.
      return url.replace(/\/+$/, '').replace(/\/v1$/, '')
    })

    const activeProviderApiKey = computed<string | undefined>(() => {
      const id = selectedProviderId.value
      return id ? apiKeyCache[id] : undefined
    })

    function selectProvider(id: string) {
      selectedProviderId.value = id
    }

    function addProvider(provider: Omit<HybridProvider, 'models'> & { models?: string[] }) {
      providers.value.push({ models: [], ...provider })
    }

    function updateProvider(id: string, patch: Partial<Omit<HybridProvider, 'id'>>) {
      const provider = providers.value.find((p) => p.id === id)
      if (provider) Object.assign(provider, patch)
    }

    async function removeProvider(id: string) {
      providers.value = providers.value.filter((p) => p.id !== id)
      delete apiKeyCache[id]
      await window.electronAPI.hybridProvider.deleteKey(id).catch(() => undefined)
      if (selectedProviderId.value === id) {
        selectedProviderId.value = providers.value[0]?.id ?? ''
      }
    }

    /** Persist the key (encrypted) and cache the plaintext for this session. */
    async function saveApiKey(
      id: string,
      key: string,
    ): Promise<{ success: boolean; error?: string }> {
      const result = await window.electronAPI.hybridProvider.saveKey(id, key)
      if (result.success) {
        const trimmed = key.trim()
        if (trimmed) apiKeyCache[id] = trimmed
        else delete apiKeyCache[id]
      }
      return result
    }

    /** Pull the decrypted key from safeStorage into the in-memory cache. */
    async function loadApiKey(id: string): Promise<string | null> {
      const key = await window.electronAPI.hybridProvider.getKey(id)
      if (key) apiKeyCache[id] = key
      return key
    }

    /**
     * Fetch the provider's model ids from `GET {baseUrl}/v1/models` and store
     * them on the provider. Returns the list on success.
     */
    async function fetchModels(id: string): Promise<string[]> {
      const provider = providers.value.find((p) => p.id === id)
      if (!provider) throw new Error('Provider not found')
      const base = provider.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
      if (!base) throw new Error('Base URL is required')

      // Ensure we have the key (it may only live on disk after a restart).
      const key = apiKeyCache[id] ?? (await loadApiKey(id)) ?? ''
      const headers: HeadersInit = key ? { Authorization: `Bearer ${key}` } : {}

      const response = await fetch(`${base}/v1/models`, { headers })
      if (!response.ok) {
        throw new Error(`Failed to fetch models: HTTP ${response.status}`)
      }
      const json = (await response.json()) as { data?: Array<{ id: string }> }
      const ids = (json.data ?? []).map((m) => m.id).filter(Boolean)
      provider.models = ids
      return ids
    }

    async function toggleFeature(enabled: boolean) {
      isFeatureEnabled.value = enabled
      await window.electronAPI.updateLocalSettings({ isHybridModeEnabled: enabled })
    }

    /** Hydrate the feature flag and decrypted keys on startup. */
    async function initConfig() {
      try {
        const localSettings = await window.electronAPI.getLocalSettings()
        isFeatureEnabled.value = !!localSettings.isHybridModeEnabled
      } catch (e) {
        console.error('hybridMode.initConfig: getLocalSettings failed:', e)
        isFeatureEnabled.value = false
      }
      if (!isFeatureEnabled.value) return
      // Re-load each provider's key from safeStorage into the session cache.
      await Promise.all(providers.value.map((p) => loadApiKey(p.id).catch(() => null)))
    }

    // Persisted providers/selection rehydrate after this store is created, so a
    // simple init() loop can miss the restored selection. Watch the selected
    // provider and lazily pull its key into the cache the first time we see it,
    // so the chat path always has the bearer token available after a restart.
    watch(
      () => selectedProviderId.value,
      (id) => {
        if (isFeatureEnabled.value && id && apiKeyCache[id] === undefined) {
          loadApiKey(id).catch(() => null)
        }
      },
      { immediate: true },
    )

    initConfig()

    return {
      isFeatureEnabled,
      providers,
      selectedProviderId,
      selectedProvider,
      activeProviderBaseUrl,
      activeProviderApiKey,
      selectProvider,
      addProvider,
      updateProvider,
      removeProvider,
      saveApiKey,
      loadApiKey,
      fetchModels,
      toggleFeature,
      initConfig,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      // Never persist API keys here — they live encrypted on disk via safeStorage.
      pick: ['providers', 'selectedProviderId'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useHybridMode, import.meta.hot))
}
