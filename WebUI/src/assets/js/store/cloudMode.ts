import { acceptHMRUpdate, defineStore } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'
import { createAppError, extractMessage } from '../errors/appError'

/**
 * A remote OpenAI-compatible provider (e.g. a self-hosted or cloud LLM
 * endpoint). The API key is NOT stored here — only an encrypted blob on disk
 * via safeStorage in the main process (see `window.electronAPI.cloudProvider`).
 * `models` holds the ids fetched from the provider's `GET /v1/models`.
 */
export type CloudProvider = {
  id: string
  name: string
  baseUrl: string
  models: string[]
}

// Model id offered when a provider exposes no models (none fetched, or the
// provider doesn't implement /v1/models). Many OpenAI-compatible endpoints serve
// a single model and accept a request with a placeholder model id, so this lets
// the user select Cloud Mode and chat without first specifying a model.
export const CLOUD_DEFAULT_MODEL = 'default'

// Seed provider shown on first open. The user fills in base URL + key.
const DEFAULT_PROVIDER: CloudProvider = {
  id: 'custom',
  name: 'Custom',
  baseUrl: '',
  models: [],
}

export const useCloudMode = defineStore(
  'cloudMode',
  () => {
    // Mirrors `isCloudModeEnabled` from local settings. Hydrated on init().
    const isFeatureEnabled = ref(false)

    const providers = ref<CloudProvider[]>([{ ...DEFAULT_PROVIDER }])
    const selectedProviderId = ref<string>(DEFAULT_PROVIDER.id)

    // Decrypted API keys, kept in memory for the session only (never persisted
    // in the renderer). Populated lazily from safeStorage via loadApiKey().
    const apiKeyCache = reactive<Record<string, string>>({})

    const selectedProvider = computed<CloudProvider | undefined>(() =>
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

    // Loopback base URL of the main-process Cloud proxy (see cloudProxy.ts).
    // All cloud networking flows through it, so upstream failures are logged in
    // the Node console instead of surfacing as opaque fetch errors in the browser.
    const proxyUrl = ref<string>('')

    async function ensureProxyUrl(): Promise<string> {
      if (!proxyUrl.value) {
        proxyUrl.value = await window.electronAPI.cloudProvider.getProxyUrl()
      }
      return proxyUrl.value
    }

    function selectProvider(id: string) {
      selectedProviderId.value = id
    }

    function addProvider(provider: Omit<CloudProvider, 'models'> & { models?: string[] }) {
      providers.value.push({ models: [], ...provider })
    }

    function updateProvider(id: string, patch: Partial<Omit<CloudProvider, 'id'>>) {
      const provider = providers.value.find((p) => p.id === id)
      if (provider) Object.assign(provider, patch)
    }

    async function removeProvider(id: string) {
      providers.value = providers.value.filter((p) => p.id !== id)
      delete apiKeyCache[id]
      await window.electronAPI.cloudProvider.deleteKey(id).catch(() => undefined)
      if (selectedProviderId.value === id) {
        selectedProviderId.value = providers.value[0]?.id ?? ''
      }
    }

    /** Persist the key (encrypted) and cache the plaintext for this session. */
    async function saveApiKey(
      id: string,
      key: string,
    ): Promise<{ success: boolean; error?: string }> {
      const result = await window.electronAPI.cloudProvider.saveKey(id, key)
      if (result.success) {
        const trimmed = key.trim()
        if (trimmed) apiKeyCache[id] = trimmed
        else delete apiKeyCache[id]
      }
      return result
    }

    /** Pull the decrypted key from safeStorage into the in-memory cache. */
    async function loadApiKey(id: string): Promise<string | null> {
      const key = await window.electronAPI.cloudProvider.getKey(id)
      if (key) apiKeyCache[id] = key
      return key
    }

    /**
     * Fetch the provider's model ids via the main-process proxy
     * (`GET {proxy}/v1/models`, routed to the provider's `{baseUrl}/v1/models`)
     * and store them on the provider. The proxy attaches the API key and logs
     * upstream failures in the Node console; here we only surface a concise
     * message. Returns the list on success.
     */
    async function fetchModels(id: string): Promise<string[]> {
      const provider = providers.value.find((p) => p.id === id)
      if (!provider) throw new Error('Provider not found')
      const base = provider.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
      if (!base) throw new Error('Base URL is required')

      const proxy = await ensureProxyUrl()
      const url = `${proxy}/v1/models`

      let response: Response
      try {
        // Only routing headers — the key stays in main and is attached there.
        response = await fetch(url, {
          headers: { 'X-Cloud-Upstream': base, 'X-Cloud-Provider': id },
        })
      } catch (e) {
        throw createAppError({
          category: 'inference',
          code: 'cloud/fetch-models-unreachable',
          surface: 'inline',
          userMessage: 'Could not reach the Cloud Mode proxy. Try restarting the app.',
          technicalMessage: `GET ${url} threw: ${extractMessage(e)}`,
          context: { providerId: id, upstream: base },
          cause: e,
        })
      }

      if (!response.ok) {
        // The proxy relays the provider's status/body and has already logged the
        // full detail to the Node console; surface a concise message here.
        const body = await response.text().catch(() => '')
        const snippet = body.trim().slice(0, 300)
        throw createAppError({
          category: 'inference',
          code: 'cloud/fetch-models-http-error',
          surface: 'inline',
          userMessage:
            `Failed to fetch models: HTTP ${response.status} ${response.statusText}` +
            (snippet ? ` — ${snippet}` : ''),
          technicalMessage: `GET ${url} (upstream ${base}) -> ${response.status}: ${body}`,
          context: { providerId: id, upstream: base, status: response.status },
        })
      }

      let json: { data?: Array<{ id: string }> }
      try {
        json = (await response.json()) as { data?: Array<{ id: string }> }
      } catch (e) {
        throw createAppError({
          category: 'inference',
          code: 'cloud/fetch-models-bad-json',
          surface: 'inline',
          userMessage: 'Provider response was not valid JSON (expected an OpenAI /v1/models list).',
          technicalMessage: `GET ${url} returned unparseable JSON: ${extractMessage(e)}`,
          context: { providerId: id, upstream: base },
          cause: e,
        })
      }

      const ids = (json.data ?? []).map((m) => m.id).filter(Boolean)
      provider.models = ids
      return ids
    }

    /**
     * Refresh the selected provider's model list, overwriting it only if the
     * request succeeds. Failures are swallowed here (the main-process proxy logs
     * the detail in the Node console) so a background refresh never disrupts the
     * UI or clobbers a previously-fetched list. No-op without a base URL.
     */
    async function refreshSelectedProviderModels(): Promise<void> {
      const id = selectedProviderId.value
      const provider = providers.value.find((p) => p.id === id)
      if (!id || !provider?.baseUrl.trim()) return
      try {
        await fetchModels(id) // overwrites provider.models on success
      } catch {
        /* keep the existing list; the proxy already logged the reason */
      }
    }

    async function toggleFeature(enabled: boolean) {
      isFeatureEnabled.value = enabled
      await window.electronAPI.updateLocalSettings({ isCloudModeEnabled: enabled })
      // Warm up the proxy so the chat backend URL is ready before first use.
      if (enabled) ensureProxyUrl().catch(() => undefined)
    }

    /** Hydrate the feature flag and decrypted keys on startup. */
    async function initConfig() {
      try {
        const localSettings = await window.electronAPI.getLocalSettings()
        isFeatureEnabled.value = !!localSettings.isCloudModeEnabled
      } catch (e) {
        console.error('cloudMode.initConfig: getLocalSettings failed:', e)
        isFeatureEnabled.value = false
      }
      if (!isFeatureEnabled.value) return
      // Start/resolve the proxy up front so the chat backend URL is ready.
      ensureProxyUrl().catch(() => undefined)
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
      proxyUrl,
      ensureProxyUrl,
      selectProvider,
      addProvider,
      updateProvider,
      removeProvider,
      saveApiKey,
      loadApiKey,
      fetchModels,
      refreshSelectedProviderModels,
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
  import.meta.hot.accept(acceptHMRUpdate(useCloudMode, import.meta.hot))
}
