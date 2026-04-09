import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useBackendServices, type BackendServiceName } from './backendServices'
import { useProductMode } from './productMode'
import { useGlobalSetup } from './globalSetup'
import { usePresets } from './presets'
import { usePresetSwitching } from './presetSwitching'
import { useSpeechToText } from './speechToText'
import { useDemoMode } from './demoMode'
import { mapStatusToColor, mapToDisplayStatus } from '@/lib/utils'
import * as toast from '@/assets/js/toast'
import type { ErrorDetails } from '../../../../electron/subprocesses/service'

const backends: BackendServiceName[] = [
  'ai-backend',
  'llamacpp-backend',
  'openvino-backend',
  'comfyui-backend',
]

function isBackendAvailableInProductMode(
  mode: ProductMode | null,
  serviceName: BackendServiceName,
): boolean {
  if (mode === 'nvidia' && serviceName === 'openvino-backend') return false
  return true
}

export type BackendRowViewModel = {
  serviceName: BackendServiceName
  displayName: string
  isRequired: boolean
  isSetUp: boolean
  status: BackendStatus
  enabled: boolean
  availableInCurrentMode: boolean
  toggleDisabled: boolean
  isInstalling: boolean
  statusColor: string
  statusText: string
  versionDisplay: string
  errorDetails: ErrorDetails | null
  toggleTooltip: string
}

export const useSetupWizard = defineStore('setupWizard', () => {
  const backendServices = useBackendServices()
  const productModeStore = useProductMode()
  const globalSetup = useGlobalSetup()
  const presetsStore = usePresets()
  const presetSwitching = usePresetSwitching()
  const demoMode = useDemoMode()
  const speechToText = useSpeechToText()

  const pendingProductMode = ref<ProductMode | null>(null)
  const installSelection = ref(new Set<BackendServiceName>())
  const installingServiceNames = ref(new Set<BackendServiceName>())
  const disabledBackends = ref(new Set<BackendServiceName>())
  const wizardDirty = ref(false)

  const errorModalOpen = ref(false)
  const errorModalServiceName = ref<BackendServiceName | null>(null)
  const errorModalDetails = ref<ErrorDetails | null>(null)

  const backendRows = computed<BackendRowViewModel[]>(() => {
    return backends.map((serviceName) => {
      const info = backendServices.info.find((s) => s.serviceName === serviceName)
      const available = isBackendAvailableInProductMode(pendingProductMode.value, serviceName)
      const isRequired = info?.isRequired ?? serviceName === 'ai-backend'
      const isSetUp = info?.isSetUp ?? false
      const status = info?.status ?? ('notInstalled' as BackendStatus)
      const isInstalling = installingServiceNames.value.has(serviceName)
      const enabled = isRequired || installSelection.value.has(serviceName)
      const toggleDisabled = isRequired || !available || isInstalling

      let toggleTooltip = ''
      if (isRequired) {
        toggleTooltip = 'Required — cannot be disabled'
      } else if (!available) {
        toggleTooltip = 'Not available in this product mode'
      } else if (isInstalling) {
        toggleTooltip = 'Installation in progress'
      } else if (isSetUp && enabled) {
        toggleTooltip = 'Toggle off to stop this component'
      } else if (isSetUp && !enabled) {
        toggleTooltip = 'Toggle on to start this component'
      } else if (!isSetUp && enabled) {
        toggleTooltip = 'Toggle off to skip installation'
      } else {
        toggleTooltip = 'Toggle on to install this component'
      }

      let versionDisplay = ''
      if (serviceName === 'ai-backend') {
        versionDisplay = globalSetup.state.version ?? ''
      } else {
        const vs = backendServices.versionState[serviceName]
        if (vs.installed?.version) {
          versionDisplay = vs.installed.releaseTag
            ? `${vs.installed.releaseTag} / ${vs.installed.version}`
            : vs.installed.version
        } else if (!isSetUp) {
          versionDisplay = 'Not installed'
        }
      }

      return {
        serviceName,
        displayName: mapServiceNameToDisplayName(serviceName),
        isRequired,
        isSetUp,
        status,
        enabled,
        availableInCurrentMode: available,
        toggleDisabled,
        isInstalling,
        statusColor: mapStatusToColor(status),
        statusText: mapToDisplayStatus(status) ?? status,
        versionDisplay,
        errorDetails: backendServices.getServiceErrorDetails(serviceName),
        toggleTooltip,
      }
    })
  })

  const isBusy = computed(() => installingServiceNames.value.size > 0)

  const rowsNeedingInstall = computed(() =>
    backendRows.value.filter(
      (r) =>
        r.enabled &&
        r.availableInCurrentMode &&
        (r.status === 'notInstalled' || r.status === 'failed' || r.status === 'installationFailed'),
    ),
  )

  const primaryLabel = computed(() => {
    if (isBusy.value) return 'Installing...'
    if (rowsNeedingInstall.value.length > 0) return 'Install & Continue'
    return 'Continue'
  })

  const canClose = computed(() => {
    return backendRows.value
      .filter((r) => r.availableInCurrentMode)
      .every((r) => r.status === 'running' || !r.isRequired)
  })

  const canRunPrimary = computed(() => {
    if (isBusy.value) return false
    if (!pendingProductMode.value) return false
    return true
  })

  function seedInstallSelection() {
    const newSelection = new Set<BackendServiceName>()
    for (const serviceName of backends) {
      const info = backendServices.info.find((s) => s.serviceName === serviceName)
      if (!info) continue
      if (info.isRequired) continue
      if (!isBackendAvailableInProductMode(pendingProductMode.value, serviceName)) continue
      if (disabledBackends.value.has(serviceName)) continue
      if (info.isSetUp || !info.isRequired) {
        newSelection.add(serviceName)
      }
    }
    installSelection.value = newSelection
  }

  async function toggleBackend(serviceName: BackendServiceName, value: boolean) {
    const info = backendServices.info.find((s) => s.serviceName === serviceName)
    if (value) {
      installSelection.value.add(serviceName)
      disabledBackends.value.delete(serviceName)
      disabledBackends.value = new Set(disabledBackends.value)
      if (info?.isSetUp && (info.status === 'stopped' || info.status === 'notYetStarted')) {
        await backendServices.startService(serviceName)
      }
    } else {
      installSelection.value.delete(serviceName)
      disabledBackends.value.add(serviceName)
      disabledBackends.value = new Set(disabledBackends.value)
      if (info?.status === 'running') {
        await backendServices.stopService(serviceName)
      }
    }
    installSelection.value = new Set(installSelection.value)
  }

  function setPendingMode(mode: ProductMode) {
    pendingProductMode.value = mode
    for (const sn of backends) {
      const wasAvailable = isBackendAvailableInProductMode(
        productModeStore.productMode ?? pendingProductMode.value,
        sn,
      )
      const nowAvailable = isBackendAvailableInProductMode(mode, sn)
      if (nowAvailable && !wasAvailable) {
        const info = backendServices.info.find((s) => s.serviceName === sn)
        if (info && !info.isSetUp && !info.isRequired) {
          installSelection.value.add(sn)
        }
      }
    }
    installSelection.value = new Set(installSelection.value)
  }

  async function openWizard() {
    if (!productModeStore.hardwareRecommendation) {
      await productModeStore.detectRecommendation()
    }
    pendingProductMode.value = productModeStore.productMode
    seedInstallSelection()
    wizardDirty.value = false
    globalSetup.loadingState = 'setupWizard'
  }

  let initialLoadingPollHandle: ReturnType<typeof setTimeout> | null = null

  async function initialize() {
    if (!backendServices.serviceInfoUpdateReceived) {
      globalSetup.loadingState = 'verifyBackend'
      if (initialLoadingPollHandle !== null) {
        clearTimeout(initialLoadingPollHandle)
      }
      initialLoadingPollHandle = setTimeout(() => {
        initialLoadingPollHandle = null
        void initialize()
      }, 1000)
      return
    }

    if (initialLoadingPollHandle !== null) {
      clearTimeout(initialLoadingPollHandle)
      initialLoadingPollHandle = null
    }

    await productModeStore.ensureReady()

    if (!productModeStore.hardwareRecommendation) {
      await productModeStore.detectRecommendation()
    }

    pendingProductMode.value = productModeStore.productMode
    seedInstallSelection()
    wizardDirty.value = false
    globalSetup.loadingState = 'setupWizard'
  }

  async function syncPresetsForCurrentProductMode() {
    await productModeStore.syncToMain()
    await presetsStore.reloadAfterProductModeChange()
    await presetSwitching.reconcileActivePresetAfterCatalogReload()
    if (demoMode.enabled) {
      await demoMode.refreshFromMainConfig()
    }
  }

  async function commitAndInstall() {
    if (!pendingProductMode.value) return

    if (pendingProductMode.value !== productModeStore.productMode) {
      await productModeStore.selectMode(pendingProductMode.value)
    }
    await syncPresetsForCurrentProductMode()

    const toInstall = backendRows.value.filter(
      (r) =>
        r.enabled &&
        r.availableInCurrentMode &&
        (r.status === 'notInstalled' || r.status === 'failed' || r.status === 'installationFailed'),
    )

    if (toInstall.length > 0) {
      wizardDirty.value = true
      for (const row of toInstall) {
        installingServiceNames.value.add(row.serviceName)
      }
      installingServiceNames.value = new Set(installingServiceNames.value)

      for (const row of toInstall) {
        if (row.status === 'failed' || row.status === 'installationFailed') {
          await repairBackend(row.serviceName)
        } else {
          await installBackend(row.serviceName)
        }
      }
    }

    await dismiss()
  }

  async function installBackend(name: BackendServiceName) {
    wizardDirty.value = true
    installingServiceNames.value.add(name)
    installingServiceNames.value = new Set(installingServiceNames.value)
    const result = await backendServices.setUpService(name)
    if (result.success) {
      await restartBackend(name)
    } else {
      const msg = result.errorDetails
        ? 'Setup failed - Click the info icon for details'
        : 'Setup failed'
      toast.error(msg)
      installingServiceNames.value.delete(name)
      installingServiceNames.value = new Set(installingServiceNames.value)
    }
  }

  async function repairBackend(name: BackendServiceName) {
    installingServiceNames.value.add(name)
    installingServiceNames.value = new Set(installingServiceNames.value)
    const stopStatus = await backendServices.stopService(name)
    if (stopStatus !== 'stopped') {
      toast.error('Service failed to stop')
      return
    }
    await installBackend(name)
  }

  async function restartBackend(name: BackendServiceName) {
    installingServiceNames.value.add(name)
    installingServiceNames.value = new Set(installingServiceNames.value)
    const stopStatus = await backendServices.stopService(name)
    if (stopStatus !== 'stopped') {
      toast.error('Service failed to stop')
      installingServiceNames.value.delete(name)
      installingServiceNames.value = new Set(installingServiceNames.value)
      return
    }

    try {
      const startStatus = await backendServices.startService(name)
      if (startStatus !== 'running') {
        const errorDetails = backendServices.getServiceErrorDetails(name)
        const msg = errorDetails
          ? 'Service failed to start - Click the info icon for details'
          : 'Service failed to start'
        toast.error(msg)
      }
    } catch (error) {
      const errorDetails = backendServices.getServiceErrorDetails(name)
      const msg = errorDetails
        ? 'Service startup failed - Click the info icon for details'
        : `Service startup failed: ${error instanceof Error ? error.message : String(error)}`
      toast.error(msg)
    }

    installingServiceNames.value.delete(name)
    installingServiceNames.value = new Set(installingServiceNames.value)
  }

  async function dismiss() {
    await globalSetup.initSetup()
    globalSetup.loadingState = 'running'

    for (const serviceName of backends) {
      const info = backendServices.info.find((s) => s.serviceName === serviceName)
      if (!info?.isSetUp) continue
      if (info.isRequired || installSelection.value.has(serviceName)) {
        if (info.status !== 'running') {
          backendServices.startService(serviceName)
        }
      }
    }

    speechToText.initialize()
  }

  function showErrorModal(serviceName: BackendServiceName) {
    errorModalServiceName.value = serviceName
    errorModalDetails.value = backendServices.getServiceErrorDetails(serviceName)
    errorModalOpen.value = true
  }

  function closeErrorModal() {
    errorModalOpen.value = false
    errorModalServiceName.value = null
    errorModalDetails.value = null
  }

  return {
    pendingProductMode,
    installSelection,
    installingServiceNames,
    wizardDirty,
    backendRows,
    isBusy,
    rowsNeedingInstall,
    primaryLabel,
    canClose,
    canRunPrimary,

    errorModalOpen,
    errorModalServiceName,
    errorModalDetails,

    initialize,
    openWizard,
    setPendingMode,
    seedInstallSelection,
    toggleBackend,
    commitAndInstall,
    dismiss,
    installBackend,
    repairBackend,
    restartBackend,
    showErrorModal,
    closeErrorModal,
  }
})

function mapServiceNameToDisplayName(serviceName: string) {
  switch (serviceName) {
    case 'comfyui-backend':
      return 'ComfyUI'
    case 'ai-backend':
      return 'AI Playground'
    case 'llamacpp-backend':
      return 'Llama.cpp - GGUF'
    case 'openvino-backend':
      return 'OpenVINO'
    default:
      return serviceName
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSetupWizard, import.meta.hot))
}
