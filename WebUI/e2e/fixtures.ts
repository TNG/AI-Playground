import { test as base, type Page } from '@playwright/test'

type MockServiceOverride = {
  serviceName: string
  status: string
  baseUrl: string
  port: number
  isSetUp: boolean
  isRequired: boolean
  devices: unknown[]
  sttDevices?: unknown[]
  errorDetails: unknown
  installedVersion?: { version: string; releaseTag?: string }
}

type MockOverrides = {
  services?: MockServiceOverride[]
  modeCatalog?: unknown[]
  productMode?: string
}

const DEFAULT_SERVICES: MockServiceOverride[] = [
  {
    serviceName: 'ai-backend',
    status: 'notInstalled',
    baseUrl: 'http://127.0.0.1:59000',
    port: 59000,
    isSetUp: false,
    isRequired: true,
    devices: [],
    sttDevices: [],
    errorDetails: null,
  },
  {
    serviceName: 'llamacpp-backend',
    status: 'notInstalled',
    baseUrl: 'http://127.0.0.1:39000',
    port: 39000,
    isSetUp: false,
    isRequired: false,
    devices: [],
    sttDevices: [],
    errorDetails: null,
  },
  {
    serviceName: 'openvino-backend',
    status: 'notInstalled',
    baseUrl: 'http://127.0.0.1:29000',
    port: 29000,
    isSetUp: false,
    isRequired: false,
    devices: [],
    sttDevices: [],
    errorDetails: null,
  },
  {
    serviceName: 'comfyui-backend',
    status: 'notInstalled',
    baseUrl: 'http://127.0.0.1:49000',
    port: 49000,
    isSetUp: false,
    isRequired: false,
    devices: [],
    sttDevices: [],
    errorDetails: null,
  },
]

const RUNNING_SERVICES: MockServiceOverride[] = [
  {
    serviceName: 'ai-backend',
    status: 'running',
    baseUrl: 'http://127.0.0.1:59000',
    port: 59000,
    isSetUp: true,
    isRequired: true,
    devices: [],
    sttDevices: [],
    errorDetails: null,
  },
  {
    serviceName: 'llamacpp-backend',
    status: 'running',
    baseUrl: 'http://127.0.0.1:39000',
    port: 39000,
    isSetUp: true,
    isRequired: false,
    devices: [],
    sttDevices: [],
    errorDetails: null,
  },
  {
    serviceName: 'openvino-backend',
    status: 'notInstalled',
    baseUrl: 'http://127.0.0.1:29000',
    port: 29000,
    isSetUp: false,
    isRequired: false,
    devices: [],
    sttDevices: [],
    errorDetails: null,
  },
  {
    serviceName: 'comfyui-backend',
    status: 'notInstalled',
    baseUrl: 'http://127.0.0.1:49000',
    port: 49000,
    isSetUp: false,
    isRequired: false,
    devices: [],
    sttDevices: [],
    errorDetails: null,
  },
]

const DEFAULT_MODE_CATALOG = [
  {
    mode: 'studio',
    experimental: false,
    ui: {
      i18n: {
        titleOne: 'AI',
        titleTwo: 'Playground Studio',
        description: 'Full-featured mode with all backends and capabilities.',
        supportedHardware: 'Intel Arc GPUs, Intel Core Ultra processors',
      },
    },
  },
  {
    mode: 'essentials',
    experimental: false,
    ui: {
      i18n: {
        titleOne: 'AI',
        titleTwo: 'Playground Essentials',
        subtitle: '(Recommended)',
        description: 'Lightweight mode for quick chat and basic image generation.',
        supportedHardware: 'Intel integrated and discrete GPUs',
      },
    },
  },
]

async function injectElectronMock(page: Page, overrides?: MockOverrides) {
  const services = overrides?.services ?? DEFAULT_SERVICES
  const modeCatalog = overrides?.modeCatalog ?? DEFAULT_MODE_CATALOG
  const productMode = overrides?.productMode

  await page.addInitScript(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ services, modeCatalog, productMode }: any) => {
      const noop = () => {}
      const asyncNoop = () => Promise.resolve()
      const asyncEmptyArray = () => Promise.resolve([])

      const w = window as Record<string, unknown>
      w.envVars = {
        platformTitle: 'from Intel®',
        debugToolsEnabled: true,
        productVersion: '3.1.0-alpha',
      }

      w.electronAPI = {
        startDrag: noop,
        getFilePath: () => '/mock/path',
        getServices: () => Promise.resolve(services),
        updateServiceSettings: () => Promise.resolve('running'),
        uninstall: asyncNoop,
        selectDevice: asyncNoop,
        selectSttDevice: asyncNoop,
        detectDevices: asyncNoop,
        startService: (name: string) => {
          const svc = services.find((s: Record<string, unknown>) => s.serviceName === name)
          if (svc) svc.status = 'running'
          return Promise.resolve('running')
        },
        stopService: (name: string) => {
          const svc = services.find((s: Record<string, unknown>) => s.serviceName === name)
          if (svc) svc.status = 'stopped'
          return Promise.resolve('stopped')
        },
        setUpService: noop,
        updatePresetsFromIntelRepo: () => Promise.resolve({ updated: false }),
        reloadPresets: asyncEmptyArray,
        getUserPresetsPath: () => Promise.resolve('/mock/presets'),
        loadUserPresets: asyncEmptyArray,
        saveUserPreset: () => Promise.resolve(true),
        resolveBackendVersion: () => Promise.resolve(undefined),
        getInstalledBackendVersion: () => Promise.resolve(undefined),
        getGitHubRepoUrl: () =>
          Promise.resolve('https://github.com/intel/ai-playground/blob/main/'),
        openDevTools: noop,
        getDeveloperSettings: () => Promise.resolve({ openDevConsoleOnStartup: false }),
        openUrl: noop,
        changeWindowMessageFilter: noop,
        getWinSize: () => Promise.resolve({ width: 1440, height: 951, maxChatContentHeight: 600 }),
        getLocaleSettings: () => Promise.resolve({ locale: 'en-US', languageOverride: null }),
        getThemeSettings: () =>
          Promise.resolve({ currentTheme: 'dark', availableThemes: ['dark', 'light'] }),
        updateLocalSettings: () => Promise.resolve({ success: true }),
        getLocalSettings: () =>
          Promise.resolve({
            debug: false,
            deviceArchOverride: null,
            isAdminExec: false,
            availableThemes: ['dark', 'light'],
            currentTheme: 'dark',
            productMode,
            isDemoModeEnabled: false,
            demoModeResetInSeconds: null,
            languageOverride: null,
            remoteRepository: '',
            huggingfaceEndpoint: '',
          }),
        detectHardwareForModeRecommendation: () =>
          Promise.resolve({
            success: true,
            recommendedMode: 'essentials',
            detectedDevices: [],
            hasNvidiaGpu: false,
            modeCatalog,
          }),
        setWinSize: asyncNoop,
        showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
        showMessageBox: () => Promise.resolve(0),
        showMessageBoxSync: () => Promise.resolve(0),
        showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
        dragWinToMoveStart: noop,
        dragWinToMove: noop,
        dragWinToMoveStop: noop,
        setIgnoreMouseEvents: noop,
        miniWindow: noop,
        exitApp: noop,
        getInitialPage: () => Promise.resolve('create'),
        getDemoModeSettings: () =>
          Promise.resolve({
            isDemoModeEnabled: false,
            demoModeResetInSeconds: null,
          }),
        saveImage: noop,
        saveImageToMediaInput: () => Promise.resolve('/mock/media'),
        openImageWin: noop,
        wakeupApiService: noop,
        screenChange: noop,
        webServiceExit: noop,
        existsPath: () => Promise.resolve(false),
        addDocumentToRAGList: (doc: unknown) => Promise.resolve(doc),
        embedInputUsingRag: asyncEmptyArray,
        getEmbeddingServerUrl: () =>
          Promise.resolve({ success: true, url: 'http://127.0.0.1:39001' }),
        getInitSetting: () =>
          Promise.resolve({
            modelLists: { embedding: [] },
            modelPaths: {
              llamaCpp: '/mock/models/llamacpp',
              openVino: '/mock/models/openvino',
              comfyUI: '/mock/models/comfyui',
            },
            isAdminExec: false,
            version: '3.1.0-alpha',
          }),
        updateModelPaths: () => Promise.resolve({ embedding: [] }),
        restorePathsSettings: asyncNoop,
        refreshLLMModles: asyncEmptyArray,
        loadModels: asyncEmptyArray,
        zoomIn: asyncNoop,
        zoomOut: asyncNoop,
        getDownloadedLLMs: asyncEmptyArray,
        getDownloadedGGUFLLMs: asyncEmptyArray,
        getDownloadedOpenVINOLLMModels: asyncEmptyArray,
        getDownloadedEmbeddingModels: asyncEmptyArray,
        getComfyUIModels: asyncEmptyArray,
        getPlatform: () => Promise.resolve('linux'),
        openImageWithSystem: noop,
        openImageInFolder: noop,
        setFullScreen: noop,
        onDebugLog: noop,
        wakeupComfyUIService: noop,
        getComfyUiDefaultParameters: () => Promise.resolve(''),
        getLlamaCppDefaultParameters: () => Promise.resolve(''),
        onServiceSetUpProgress: noop,
        onServiceInfoUpdate: noop,
        onShowToast: noop,
        ensureBackendReadiness: () => Promise.resolve({ success: true }),
        ensureComfyUIBackendRunning: () => Promise.resolve({ success: true }),
        startTranscriptionServer: () => Promise.resolve({ success: true }),
        stopTranscriptionServer: () => Promise.resolve({ success: true }),
        getTranscriptionServerUrl: () =>
          Promise.resolve({ success: true, url: 'http://127.0.0.1:29001' }),
        reportClientEvent: noop,
        comfyui: {
          isGitInstalled: () => Promise.resolve(true),
          isComfyUIInstalled: () => Promise.resolve(false),
          getGitRef: () => Promise.resolve(undefined),
          isPackageInstalled: () => Promise.resolve(false),
          installPypiPackage: asyncNoop,
          isCustomNodeInstalled: () => Promise.resolve(false),
          downloadCustomNode: () => Promise.resolve(true),
          uninstallCustomNode: () => Promise.resolve(true),
          listInstalledCustomNodes: asyncEmptyArray,
        },
        mcp: {
          listServers: asyncEmptyArray,
          startServer: () => Promise.resolve({ state: 'running' }),
          stopServer: () => Promise.resolve({ state: 'stopped' }),
          getServerStatus: () => Promise.resolve({ state: 'stopped' }),
          listServerTools: asyncEmptyArray,
          invokeServerTool: () => Promise.resolve({}),
          openConfig: noop,
          openConfigInFolder: noop,
          reloadConfig: asyncEmptyArray,
          addServer: asyncNoop,
          getServerConfig: () => Promise.resolve({ command: '', type: 'stdio' }),
          updateServer: asyncNoop,
          removeServer: asyncNoop,
        },
      }
    },
    { services, modeCatalog, productMode },
  )
}

type AppFixtures = {
  /** Page with mocks injected and navigated to / — default (not-installed) service state */
  appPage: Page
  /** Page with mocks injected and navigated to / — services running, app in "running" state */
  runningAppPage: Page
}

export const test = base.extend<AppFixtures>({
  appPage: async ({ page }, use) => {
    await injectElectronMock(page)
    await page.goto('/')
    await use(page)
  },
  runningAppPage: async ({ page }, use) => {
    await injectElectronMock(page, {
      services: RUNNING_SERVICES,
      productMode: 'essentials',
    })
    await page.goto('/')
    await use(page)
  },
})

export { injectElectronMock }
export { expect } from '@playwright/test'
export { DEFAULT_SERVICES, RUNNING_SERVICES, DEFAULT_MODE_CATALOG }
export type { MockServiceOverride, MockOverrides }
