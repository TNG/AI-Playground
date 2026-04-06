import { acceptHMRUpdate, defineStore } from 'pinia'
import { ModelLists } from './models'
import { useModels } from './models'

type GlobalSetupState =
  | 'running'
  | 'verifyBackend'
  | 'autoInstalling'
  | 'selectProductMode'
  | 'manageInstallations'
  | 'loading'
  | 'failed'

export const useGlobalSetup = defineStore(
  'globalSetup',
  () => {
    const state = reactive<KVObject>({
      isAdminExec: false,
      device: '',
      version: '0.0.0.1',
    })

    const defaultBackendBaseUrl = ref('http://127.0.0.1:9999')

    const models = ref<ModelLists>({
      embedding: new Array<string>(),
    })

    const loadingState = ref<GlobalSetupState>('verifyBackend')
    const errorMessage = ref('')

    const productMode = ref<ProductMode | null>(null)

    const hardwareRecommendation = ref<HardwareRecommendationResult | null>(null)

    async function syncProductModeToMain() {
      if (productMode.value) {
        await window.electronAPI.updateLocalSettings({ productMode: productMode.value })
      }
    }

    async function initSetup() {
      await syncProductModeToMain()

      const setupData = await window.electronAPI.getInitSetting()
      const apiServiceInformation = await window.electronAPI.getServices()

      const modelsStore = useModels()
      modelsStore.initPaths(setupData.modelPaths)
      models.value = setupData.modelLists

      state.isAdminExec = setupData.isAdminExec
      state.version = setupData.version
      const aiBackendInfo = apiServiceInformation.find((item) => item.serviceName === 'ai-backend')
      if (!aiBackendInfo) {
        throw new Error('ai-backend service not found')
      }
      defaultBackendBaseUrl.value = aiBackendInfo.baseUrl
    }

    return {
      state,
      models,
      apiHost: defaultBackendBaseUrl,
      loadingState,
      errorMessage,
      productMode,
      hardwareRecommendation,
      syncProductModeToMain,
      initSetup,
    }
  },
  {
    persist: {
      pick: ['productMode'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGlobalSetup, import.meta.hot))
}
