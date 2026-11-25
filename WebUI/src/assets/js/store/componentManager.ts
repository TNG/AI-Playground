import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, toRaw } from 'vue'
import {
  allBackendServiceNames,
  useBackendServices,
  type BackendServiceName,
} from './backendServices'
import { useProductMode } from './productMode'
import { useSetupWizard } from './setupWizard'
import { useComponentHolds } from './componentHolds'
import { useI18N } from './i18n'
import { useErrors } from './errors'
import {
  componentHealth,
  deriveComponentRows,
  type ComponentHealth,
  type ComponentRowState,
  type DerivedComponentRow,
} from '@/lib/componentRows'
import { isComponentAvailableInMode } from '@/lib/productModeAvailability'
import { updateLocalSettingsReported } from '@/lib/localSettingsUpdate'
import { fillTemplate } from '@/lib/fillTemplate'
import type { ComponentWork } from '@/types/componentChange'

export type { ComponentHealth }

export type ComponentRow = DerivedComponentRow & {
  statusText: string
  toggleDisabled: boolean
  /** What stops working if it is uninstalled; '' when it cannot be uninstalled. */
  uninstallStopsText: string
  /** The work holding this Component right now; null when it is free to change. */
  inUseWork: ComponentWork | null
  /** Why the row's change actions are blocked, e.g. "Finish the running turn first". */
  inUseReason: string | null
}

const STATE_LABELS: Record<ComponentRowState, { key: string; fallback: string }> = {
  notInstalled: { key: 'BACKEND_STATUS_NOT_INSTALLED', fallback: 'Not Installed' },
  failed: { key: 'BACKEND_STATUS_FAILED', fallback: 'Failed' },
  installing: { key: 'BACKEND_STATUS_INSTALLING', fallback: 'Installing' },
  starting: { key: 'BACKEND_STATUS_STARTING', fallback: 'Starting' },
  stopping: { key: 'BACKEND_STATUS_STOPPING', fallback: 'Stopping' },
  disabled: { key: 'BACKEND_STATUS_DISABLED', fallback: 'Disabled' },
  running: { key: 'BACKEND_STATUS_RUNNING', fallback: 'Running' },
  installed: { key: 'BACKEND_STATUS_INSTALLED', fallback: 'Installed' },
}

export const useComponentManager = defineStore('componentManager', () => {
  const backendServices = useBackendServices()
  const productMode = useProductMode()
  const wizard = useSetupWizard()
  const componentHolds = useComponentHolds()
  const languages = useI18N().state
  const errors = useErrors()

  const hydrated = ref(false)

  const deviceOptions = computed(() => wizard.preferredDeviceOptions)
  const selectedDeviceKey = computed(() => wizard.preferredDeviceKey(wizard.pendingPreferredDevice))

  async function setPreferredDevice(
    pref: PreferredDevice,
    overrideExisting: boolean,
  ): Promise<void> {
    const raw = toRaw(pref)
    const saved = await updateLocalSettingsReported({ preferredDevice: raw })
    if (!saved) return
    wizard.setPendingPreferredDevice(raw)
    if (overrideExisting) await wizard.applyPreferredDevice(raw)
  }

  function label(key: string, fallback: string): string {
    return languages[key] || fallback
  }

  const IN_USE_REASON: Record<ComponentWork, { key: string; fallback: string }> = {
    turn: {
      key: 'COMPONENT_MANAGER_IN_USE_TURN',
      fallback: 'Finish the running turn first.',
    },
    'agent-run': {
      key: 'COMPONENT_MANAGER_IN_USE_AGENT_RUN',
      fallback: 'Finish the running agent run first.',
    },
    'media-run': {
      key: 'COMPONENT_MANAGER_IN_USE_MEDIA_RUN',
      fallback: 'Finish the running generation first.',
    },
    'speech-turn': {
      key: 'COMPONENT_MANAGER_IN_USE_SPEECH_TURN',
      fallback: 'Finish the running speech turn first.',
    },
    'model-download': {
      key: 'COMPONENT_MANAGER_IN_USE_DOWNLOAD',
      fallback: 'Wait for the model download to finish.',
    },
  }

  function inUseReason(work: ComponentWork | null): string | null {
    if (!work) return null
    const entry = IN_USE_REASON[work]
    return label(entry.key, entry.fallback)
  }

  /** What an optional Component's removal costs: feature keys, not internals. */
  const UNINSTALL_STOPS: Partial<Record<BackendServiceName, { key: string; fallback: string }>> = {
    'home-agent-backend': {
      key: 'COMPONENT_MANAGER_UNINSTALL_STOPS_CHANNELS',
      fallback: 'Channels stop working: Telegram, Slack and LAN chat.',
    },
    'qwen3-tts-backend': {
      key: 'COMPONENT_MANAGER_UNINSTALL_STOPS_TTS',
      fallback: 'Text to Speech stops working.',
    },
    'whisper-backend': {
      key: 'COMPONENT_MANAGER_UNINSTALL_STOPS_STT',
      fallback: 'Speech to Text stops working.',
    },
    'llamacpp-backend': {
      key: 'COMPONENT_MANAGER_UNINSTALL_STOPS_LLAMACPP',
      fallback: 'Local GGUF chat and agent runs stop working.',
    },
    'openvino-backend': {
      key: 'COMPONENT_MANAGER_UNINSTALL_STOPS_OPENVINO',
      fallback: 'OpenVINO chat, embedding and transcription stop working.',
    },
    'comfyui-backend': {
      key: 'COMPONENT_MANAGER_UNINSTALL_STOPS_COMFYUI',
      fallback: 'Image, video and 3D generation stop working.',
    },
  }

  function uninstallStopsText(
    serviceName: BackendServiceName,
    canUninstall: boolean,
    displayName: string,
  ): string {
    if (!canUninstall) return ''
    const entry = UNINSTALL_STOPS[serviceName]
    if (entry) return label(entry.key, entry.fallback)
    return fillTemplate(
      label('COMPONENT_MANAGER_UNINSTALL_STOPS_GENERIC', '{name} stops working.'),
      { name: displayName },
    )
  }

  const hardwareMode = computed(() => productMode.productMode)
  const hardwareModeChangeBlocked = computed(() => componentHolds.anyInFlightWork)
  const hardwareModeChangeReason = computed(() =>
    hardwareModeChangeBlocked.value
      ? label('COMPONENT_MANAGER_HARDWARE_MODE_BLOCKED', 'Finish the running work first.')
      : null,
  )

  /**
   * Applies a Hardware Mode change in place: no restart, unavailable Components
   * stopped but kept on disk, newly available ones only offered. Presets reload
   * through the wizard's existing product-mode sync path.
   */
  async function changeHardwareMode(mode: ProductMode): Promise<void> {
    if (componentHolds.anyInFlightWork) return
    const previous = productMode.productMode
    if (previous === mode) return

    const becameUnavailable = allBackendServiceNames.filter(
      (serviceName) =>
        isComponentAvailableInMode(previous, serviceName) &&
        !isComponentAvailableInMode(mode, serviceName),
    )

    await productMode.selectMode(mode)

    for (const serviceName of becameUnavailable) {
      const info = backendServices.info.find((entry) => entry.serviceName === serviceName)
      if (info?.status !== 'running') continue
      try {
        await backendServices.stopService(serviceName)
      } catch (error) {
        errors.report(error, { category: 'backend', code: 'component/stop-failed' })
      }
    }

    await wizard.syncPresetsForCurrentProductMode()
  }

  function comfyVariantSwitch(): { needed: boolean; targetMode: ProductMode | null } {
    const mode = productMode.productMode
    const installedVariant = backendServices.info.find(
      (entry) => entry.serviceName === 'comfyui-backend',
    )?.comfyUiInstalledVariant
    if (installedVariant) {
      return {
        needed: mode === 'nvidia' ? installedVariant !== 'cuda' : installedVariant === 'cuda',
        targetMode: mode,
      }
    }
    return {
      needed: wizard.comfyUiNeedsVariantSwitch,
      targetMode: wizard.pendingProductMode ?? mode,
    }
  }

  const derivedRows = computed<DerivedComponentRow[]>(() =>
    deriveComponentRows({
      serviceNames: allBackendServiceNames,
      infoFor: (serviceName) =>
        backendServices.info.find((entry) => entry.serviceName === serviceName),
      versionState: backendServices.versionState,
      mode: productMode.productMode,
      enabledFor: (serviceName, info) => {
        if (!(info?.isSetUp ?? false)) return false
        return (
          (info?.isRequired ?? serviceName === 'ai-backend') ||
          !wizard.disabledBackends.has(serviceName)
        )
      },
      progressFor: (serviceName) => backendServices.latestSetupProgress.get(serviceName),
      phisonVariant: backendServices.llamaCppBuildVariant,
      comfyVariantSwitch: comfyVariantSwitch(),
      displayDisabled: true,
    }),
  )

  const rows = computed<ComponentRow[]>(() =>
    derivedRows.value.map((row) => {
      const inUseWork = row.installed ? componentHolds.workFor(row.serviceName) : null
      const labelEntry = STATE_LABELS[row.state]
      return {
        ...row,
        statusText: row.statusOverride ?? label(labelEntry.key, labelEntry.fallback),
        uninstallStopsText: uninstallStopsText(row.serviceName, row.canUninstall, row.displayName),
        toggleDisabled:
          row.isRequired ||
          !row.installed ||
          row.busy ||
          !row.availableInCurrentMode ||
          (inUseWork !== null && row.enabled),
        inUseWork,
        inUseReason: inUseReason(inUseWork),
      }
    }),
  )

  const health = computed<ComponentHealth>(() => componentHealth(rows.value))

  function rowFor(serviceName: BackendServiceName): ComponentRow | undefined {
    return rows.value.find((entry) => entry.serviceName === serviceName)
  }

  async function hydrateFromSettings(): Promise<void> {
    await wizard.restoreDisabledBackends()
    // The mode catalog is normally filled by the wizard; the manager needs it too.
    if (!productMode.hardwareRecommendation) await productMode.detectRecommendation()
    // The wizard seeds this only when it opens, so a cold start would show an
    // empty Default GPU row here. Reading it never persists the fallback.
    await wizard.ensurePreferredDeviceSeeded()
    hydrated.value = true
  }

  async function setEnabled(serviceName: BackendServiceName, enabled: boolean): Promise<void> {
    const info = backendServices.info.find((entry) => entry.serviceName === serviceName)

    if (enabled) {
      if (!info?.isSetUp) return
      wizard.setBackendDisabled(serviceName, false)
      if (info.status === 'stopped' || info.status === 'notYetStarted') {
        try {
          await backendServices.startService(serviceName)
        } catch (error) {
          errors.report(error, { category: 'backend', code: 'component/start-failed' })
        }
      }
      return
    }

    if (info?.isRequired) return
    if (componentHolds.workFor(serviceName)) return
    wizard.setBackendDisabled(serviceName, true)
    if (info?.status === 'running') {
      try {
        await backendServices.stopService(serviceName)
      } catch (error) {
        errors.report(error, { category: 'backend', code: 'component/stop-failed' })
      }
    }
  }

  function showErrorLog(serviceName: BackendServiceName): void {
    if (!rowFor(serviceName)?.failed) return
    wizard.showErrorModal(serviceName)
  }

  async function install(serviceName: BackendServiceName): Promise<void> {
    const row = rowFor(serviceName)
    if (!row?.canInstall || row.inUseWork) return
    await wizard.installBackend(serviceName)
  }

  async function repair(serviceName: BackendServiceName): Promise<void> {
    const row = rowFor(serviceName)
    if (!row?.canRepair || row.inUseWork) return
    await wizard.repairBackend(serviceName)
  }

  async function update(serviceName: BackendServiceName): Promise<void> {
    const row = rowFor(serviceName)
    if (!row?.updateAvailable || row.inUseWork) return
    await wizard.updateBackend(serviceName)
  }

  async function uninstall(serviceName: BackendServiceName): Promise<void> {
    const row = rowFor(serviceName)
    if (!row?.canUninstall || row.inUseWork) return
    try {
      await backendServices.uninstallService(serviceName)
    } catch (error) {
      errors.report(error, { category: 'backend', code: 'component/uninstall-failed' })
    }
  }

  return {
    rows,
    health,
    hydrated,
    deviceOptions,
    selectedDeviceKey,
    hardwareMode,
    hardwareModeChangeBlocked,
    hardwareModeChangeReason,
    hydrateFromSettings,
    setPreferredDevice,
    changeHardwareMode,
    setEnabled,
    install,
    repair,
    update,
    uninstall,
    showErrorLog,
    anyInFlightWork: computed(() => componentHolds.anyInFlightWork),
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useComponentManager, import.meta.hot))
}
