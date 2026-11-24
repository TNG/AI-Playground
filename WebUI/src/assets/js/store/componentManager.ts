import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, toRaw } from 'vue'
import {
  allBackendServiceNames,
  useBackendServices,
  type BackendServiceName,
} from './backendServices'
import { useProductMode } from './productMode'
import { useSetupWizard } from './setupWizard'
import { useI18N } from './i18n'
import { useErrors } from './errors'
import { compareVersions, mapServiceNameToDisplayName, mapStatusToColor } from '@/lib/utils'
import { updateLocalSettingsReported } from '@/lib/localSettingsUpdate'
import { setupProgressLabel } from '@/lib/setupProgress'

/** What the health line summarises, derived once from the live rows. */
export type ComponentHealth = {
  running: number
  updates: number
  attention: number
}

export type ComponentRow = {
  serviceName: BackendServiceName
  displayName: string
  isRequired: boolean
  installed: boolean
  enabled: boolean
  running: boolean
  availableInCurrentMode: boolean
  updateAvailable: boolean
  /** The version the inline "Update to <version>" action installs; '' when there is none. */
  updateTargetText: string
  failed: boolean
  /** Offers Install: nothing on disk and available in the current Hardware Mode. */
  canInstall: boolean
  /** Offers Repair and its error log: broken but available in the current Hardware Mode. */
  canRepair: boolean
  statusText: string
  statusColor: string
  /** The installed version, or '' when nothing is on disk. */
  versionText: string
  /** The row's visible subtitle: the status word, then the version. */
  subtitle: string
  toggleDisabled: boolean
  isInstalling: boolean
  installProgressText: string | null
}

function displayNameFor(serviceName: BackendServiceName): string {
  if (serviceName === 'ai-backend') return 'Core Services'
  return mapServiceNameToDisplayName(serviceName)
}

/** OpenVINO weekly builds differ in the fourth segment; only the first three decide a version. */
function comparableVersion(serviceName: BackendServiceName, version: string): string {
  if (serviceName === 'openvino-backend') return version.split('.').slice(0, 3).join('.')
  return version
}

function formatVersion(version: { version: string; releaseTag?: string } | undefined): string {
  if (!version?.version) return ''
  return version.releaseTag ? `${version.releaseTag} / ${version.version}` : version.version
}

export const useComponentManager = defineStore('componentManager', () => {
  const backendServices = useBackendServices()
  const productMode = useProductMode()
  const wizard = useSetupWizard()
  const languages = useI18N().state
  const errors = useErrors()

  const disabledBackends = ref(new Set<BackendServiceName>())
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

  function isAvailableInCurrentMode(serviceName: BackendServiceName): boolean {
    return !(productMode.productMode === 'nvidia' && serviceName === 'openvino-backend')
  }

  function advertisedUpdateTarget(
    serviceName: BackendServiceName,
    installed: boolean,
    versionState: Record<string, unknown>,
  ): string {
    if (!installed || serviceName === 'ai-backend') return ''
    const versions = versionState[serviceName] as
      | {
          installed?: { version: string; releaseTag?: string }
          uiOverride?: { version: string; releaseTag?: string }
          target?: { version: string; releaseTag?: string }
        }
      | undefined
    const installedVersion = versions?.installed?.version
    const target = versions?.uiOverride ?? versions?.target
    if (!installedVersion || !target?.version) return ''
    const isNewer =
      compareVersions(
        comparableVersion(serviceName, installedVersion),
        comparableVersion(serviceName, target.version),
      ) < 0
    return isNewer ? formatVersion(target) : ''
  }

  const rows = computed<ComponentRow[]>(() =>
    allBackendServiceNames.map((serviceName) => {
      const info = backendServices.info.find((entry) => entry.serviceName === serviceName)
      const installed = info?.isSetUp ?? false
      const status = info?.status ?? ('notInstalled' as BackendStatus)
      const isRequired = info?.isRequired ?? serviceName === 'ai-backend'
      const available = isAvailableInCurrentMode(serviceName)
      const enabled = installed && (isRequired || !disabledBackends.value.has(serviceName))
      const running = status === 'running'
      const failed = status === 'failed' || status === 'installationFailed'
      const busy = status === 'installing' || status === 'starting' || status === 'stopping'

      let statusText: string
      if (!installed) statusText = label('BACKEND_STATUS_NOT_INSTALLED', 'Not Installed')
      else if (failed) statusText = label('BACKEND_STATUS_FAILED', 'Failed')
      else if (status === 'installing')
        statusText = label('BACKEND_STATUS_INSTALLING', 'Installing')
      else if (status === 'starting') statusText = label('BACKEND_STATUS_STARTING', 'Starting')
      else if (status === 'stopping') statusText = label('BACKEND_STATUS_STOPPING', 'Stopping')
      else if (!enabled) statusText = label('BACKEND_STATUS_DISABLED', 'Disabled')
      else if (running) statusText = label('BACKEND_STATUS_RUNNING', 'Running')
      else statusText = label('BACKEND_STATUS_INSTALLED', 'Installed')

      let statusColor: string
      if (!installed) statusColor = mapStatusToColor('notInstalled')
      else if (failed) statusColor = mapStatusToColor('failed')
      else if (busy) statusColor = mapStatusToColor(status)
      else if (!enabled) statusColor = mapStatusToColor('notInstalled')
      else if (running) statusColor = mapStatusToColor('running')
      else statusColor = mapStatusToColor('stopped')

      const versionText = installed
        ? formatVersion(
            (
              backendServices.versionState[serviceName] as {
                installed?: { version: string; releaseTag?: string }
              }
            )?.installed,
          )
        : ''

      const progress = busy ? backendServices.latestSetupProgress.get(serviceName) : undefined
      const updateText = advertisedUpdateTarget(
        serviceName,
        installed,
        backendServices.versionState as unknown as Record<string, unknown>,
      )
      const installProgressText = busy
        ? status === 'installing'
          ? progress
            ? setupProgressLabel(serviceName, progress)
            : label('BACKEND_STATUS_INSTALLING', 'Installing')
          : status === 'starting'
            ? label('BACKEND_STATUS_STARTING', 'Starting')
            : label('BACKEND_STATUS_STOPPING', 'Stopping')
        : null

      return {
        serviceName,
        displayName: displayNameFor(serviceName),
        isRequired,
        installed,
        enabled,
        running,
        availableInCurrentMode: available,
        failed,
        updateAvailable: updateText !== '',
        updateTargetText: updateText,
        canInstall: !installed && available,
        canRepair: failed && available,
        statusText,
        statusColor,
        versionText,
        subtitle: versionText ? `${statusText} · ${versionText}` : statusText,
        toggleDisabled: isRequired || !installed || busy || !available,
        isInstalling: busy,
        installProgressText,
      }
    }),
  )

  const health = computed<ComponentHealth>(() => {
    let running = 0
    let updates = 0
    let attention = 0
    for (const row of rows.value) {
      if (row.running) running += 1
      if (row.updateAvailable) updates += 1
      if (row.failed || row.updateAvailable || (row.isRequired && !row.running)) attention += 1
    }
    return { running, updates, attention }
  })

  function rowFor(serviceName: BackendServiceName): ComponentRow | undefined {
    return rows.value.find((entry) => entry.serviceName === serviceName)
  }

  function isBackendName(name: string): name is BackendServiceName {
    return (allBackendServiceNames as readonly string[]).includes(name)
  }

  async function hydrateFromSettings(): Promise<void> {
    try {
      const settings = await window.electronAPI.getLocalSettings()
      const persisted = settings.disabledBackends ?? []
      disabledBackends.value = new Set(persisted.filter(isBackendName))
    } catch (error) {
      errors.report(error, { category: 'backend', surface: 'silent' })
    }
    hydrated.value = true
  }

  function persistDisabled(): void {
    void updateLocalSettingsReported({ disabledBackends: [...disabledBackends.value] }, 'silent')
  }

  async function setEnabled(serviceName: BackendServiceName, enabled: boolean): Promise<void> {
    const info = backendServices.info.find((entry) => entry.serviceName === serviceName)

    if (enabled) {
      if (!info?.isSetUp) return
      if (disabledBackends.value.delete(serviceName)) {
        disabledBackends.value = new Set(disabledBackends.value)
        persistDisabled()
      }
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
    disabledBackends.value.add(serviceName)
    disabledBackends.value = new Set(disabledBackends.value)
    persistDisabled()
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
    if (!rowFor(serviceName)?.canInstall) return
    await wizard.installBackend(serviceName)
  }

  async function repair(serviceName: BackendServiceName): Promise<void> {
    if (!rowFor(serviceName)?.canRepair) return
    await wizard.repairBackend(serviceName)
  }

  async function update(serviceName: BackendServiceName): Promise<void> {
    if (!rowFor(serviceName)?.updateAvailable) return
    await wizard.updateBackend(serviceName)
  }

  return {
    rows,
    health,
    disabledBackends,
    hydrated,
    deviceOptions,
    selectedDeviceKey,
    hydrateFromSettings,
    setPreferredDevice,
    setEnabled,
    install,
    repair,
    update,
    showErrorLog,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useComponentManager, import.meta.hot))
}
