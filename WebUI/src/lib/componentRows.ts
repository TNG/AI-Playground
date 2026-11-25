import type { BackendServiceName } from '@/assets/js/store/backendServices'
import { isComponentAvailableInMode } from './productModeAvailability'
import { setupProgressLabel } from './setupProgress'
import { compareVersions, mapServiceNameToDisplayName, mapStatusToColor } from './utils'

export type ComponentVersion = { version: string; releaseTag?: string }

export type ComponentVersionState = Partial<
  Record<
    BackendServiceName,
    {
      installed?: ComponentVersion
      uiOverride?: ComponentVersion
      target?: ComponentVersion
    }
  >
>

export type ComponentServiceInfo = {
  serviceName: BackendServiceName
  status: BackendStatus
  isSetUp: boolean
  isRequired: boolean
  llamaCppStandardArtifactReady?: boolean
  llamaCppPhisonArtifactReady?: boolean
  llamaCppStandardInstalledVersion?: ComponentVersion
  llamaCppPhisonInstalledVersion?: ComponentVersion
  comfyUiInstalledVariant?: 'xpu' | 'cuda' | 'cpu'
}

export type ComponentRowState =
  | 'notInstalled'
  | 'failed'
  | 'installing'
  | 'starting'
  | 'stopping'
  | 'disabled'
  | 'running'
  | 'installed'

export type DerivedComponentRow = {
  serviceName: BackendServiceName
  displayName: string
  isRequired: boolean
  installed: boolean
  enabled: boolean
  running: boolean
  failed: boolean
  busy: boolean
  availableInCurrentMode: boolean
  state: ComponentRowState
  status: BackendStatus
  displayStatus: BackendStatus
  statusColor: string
  /** The visible version line, or '' when the row has nothing to say. */
  versionDisplay: string
  /** A rule-specific status word, e.g. ComfyUI's "Needs reinstall for CUDA". */
  statusOverride: string | null
  updateAvailable: boolean
  updateTargetText: string
  canInstall: boolean
  canRepair: boolean
  canUninstall: boolean
  isInstalling: boolean
  installProgressText: string | null
}

export type ComponentHealth = {
  running: number
  updates: number
  attention: number
}

export type ComponentRowsInput = {
  serviceNames: readonly BackendServiceName[]
  infoFor: (serviceName: BackendServiceName) => ComponentServiceInfo | undefined
  versionState: ComponentVersionState
  mode: ProductMode | null
  enabledFor: (serviceName: BackendServiceName, info: ComponentServiceInfo | undefined) => boolean
  activity?: ReadonlyMap<BackendServiceName, string>
  progressFor?: (serviceName: BackendServiceName) => SetupProgress | undefined
  phisonVariant?: 'standard' | 'ssd-offload'
  comfyVariantSwitch?: { needed: boolean; targetMode: ProductMode | null }
  /** Live rows say "Disabled" for a switched-off installed Component; draft rows do not. */
  displayDisabled?: boolean
}

function displayNameFor(serviceName: BackendServiceName): string {
  if (serviceName === 'ai-backend') return 'Core Services'
  return mapServiceNameToDisplayName(serviceName)
}

function comparableVersion(serviceName: BackendServiceName, version: string): string {
  if (serviceName === 'openvino-backend') return version.split('.').slice(0, 3).join('.')
  return version
}

function formatVersion(version: ComponentVersion | undefined): string {
  if (!version?.version) return ''
  return version.releaseTag ? `${version.releaseTag} / ${version.version}` : version.version
}

function advertisedUpdateTarget(
  serviceName: BackendServiceName,
  installed: boolean,
  versionState: ComponentVersionState,
): string {
  if (!installed || serviceName === 'ai-backend') return ''
  const versions = versionState[serviceName]
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

function statusForState(state: ComponentRowState): BackendStatus {
  if (state === 'installed' || state === 'disabled') return 'stopped'
  return state
}

function stateFor(
  installed: boolean,
  failed: boolean,
  status: BackendStatus,
  enabled: boolean,
  displayDisabled: boolean,
): ComponentRowState {
  if (!installed) return 'notInstalled'
  if (failed) return 'failed'
  if (status === 'installing' || status === 'starting' || status === 'stopping') return status
  if (!enabled && displayDisabled) return 'disabled'
  if (status === 'running') return 'running'
  return 'installed'
}

/** Every status, eligibility and attention rule both the wizard (draft) and the manager (live) use. */
export function deriveComponentRows(input: ComponentRowsInput): DerivedComponentRow[] {
  return input.serviceNames.map((serviceName) => {
    const info = input.infoFor(serviceName)
    const isRequired = info?.isRequired ?? serviceName === 'ai-backend'
    const available = isComponentAvailableInMode(input.mode, serviceName)
    const variant = input.phisonVariant ?? 'standard'

    const comfySwitch =
      serviceName === 'comfyui-backend' && (input.comfyVariantSwitch?.needed ?? false)
    const installed = comfySwitch ? false : (info?.isSetUp ?? false)
    const status = comfySwitch
      ? ('notInstalled' as BackendStatus)
      : (info?.status ?? 'notInstalled')

    const activityMessage = input.activity?.get(serviceName)
    const statusBusy = status === 'installing' || status === 'starting' || status === 'stopping'
    const busy = statusBusy || activityMessage !== undefined
    const isInstalling =
      serviceName === 'llamacpp-backend' && variant === 'ssd-offload' ? false : busy

    const enabled = input.enabledFor(serviceName, info)
    const failed = status === 'failed' || status === 'installationFailed'
    const running = status === 'running'

    let state = stateFor(installed, failed, status, enabled, input.displayDisabled ?? false)
    if (serviceName === 'llamacpp-backend' && variant === 'ssd-offload' && statusBusy) {
      state = 'notInstalled'
    }

    let statusColor: string
    if (!installed) statusColor = mapStatusToColor('notInstalled')
    else if (failed) statusColor = mapStatusToColor('failed')
    else if (statusBusy) statusColor = mapStatusToColor(status)
    else if (!enabled && (input.displayDisabled ?? false))
      statusColor = mapStatusToColor('notInstalled')
    else if (running) statusColor = mapStatusToColor('running')
    else statusColor = mapStatusToColor('stopped')

    if (serviceName === 'llamacpp-backend' && !(input.displayDisabled ?? false)) {
      const standardReady = info?.llamaCppStandardArtifactReady ?? false
      const variantStandard = variant === 'standard'
      if (!installed) {
        statusColor = mapStatusToColor('notInstalled')
      } else if (!variantStandard && statusBusy) {
        statusColor = mapStatusToColor('notInstalled')
      } else if (!failed && !statusBusy) {
        if (!standardReady) {
          statusColor = mapStatusToColor('notInstalled')
        } else if (variantStandard && (enabled || running)) {
          statusColor = mapStatusToColor('running')
        } else {
          statusColor = mapStatusToColor('notInstalled')
        }
      }
    }

    let versionDisplay = ''
    if (serviceName === 'ai-backend') {
      versionDisplay = ''
    } else if (serviceName === 'llamacpp-backend' && variant === 'ssd-offload') {
      const standard = info?.llamaCppStandardInstalledVersion
      if (standard?.version) versionDisplay = formatVersion(standard)
      else if (!info?.llamaCppStandardArtifactReady) versionDisplay = 'Not installed'
    } else {
      const installedVersion = input.versionState[serviceName]?.installed
      if (installedVersion?.version) versionDisplay = formatVersion(installedVersion)
      else if (!installed && !comfySwitch) versionDisplay = 'Not installed'
    }

    let installProgressText: string | null = null
    const showsProgress = serviceName !== 'llamacpp-backend' || variant === 'standard'
    if (showsProgress && (isInstalling || activityMessage)) {
      const progress = input.progressFor?.(serviceName)
      if (progress) installProgressText = setupProgressLabel(serviceName, progress)
      else if (activityMessage) installProgressText = activityMessage
      else if (status === 'stopping') installProgressText = 'Stopping...'
      else if (status === 'starting') installProgressText = 'Starting...'
      else installProgressText = 'Preparing...'
    }

    const updateTargetText = advertisedUpdateTarget(serviceName, installed, input.versionState)
    const statusOverride = comfySwitch
      ? `Needs reinstall for ${input.comfyVariantSwitch?.targetMode === 'nvidia' ? 'CUDA' : 'XPU'}`
      : null

    return {
      serviceName,
      displayName: displayNameFor(serviceName),
      isRequired,
      installed,
      enabled,
      running,
      failed,
      busy,
      availableInCurrentMode: available,
      state,
      status,
      displayStatus: statusForState(state),
      statusColor,
      versionDisplay,
      statusOverride,
      updateAvailable: updateTargetText !== '',
      updateTargetText,
      canInstall: !installed && available,
      canRepair: failed && available,
      canUninstall: installed && !isRequired,
      isInstalling,
      installProgressText,
    }
  })
}

/** The health line summarises these same rows; optional Components merely absent never count. */
export function componentHealth(rows: readonly DerivedComponentRow[]): ComponentHealth {
  let running = 0
  let updates = 0
  let attention = 0
  for (const row of rows) {
    if (row.running) running += 1
    if (row.updateAvailable) updates += 1
    if (row.failed || row.updateAvailable || (row.isRequired && !row.running)) attention += 1
  }
  return { running, updates, attention }
}
