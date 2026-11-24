import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ComponentRow } from '@/assets/js/store/componentManager'

// The live Component Manager reads the machine as it is: every row's vocabulary
// comes from installed vs enabled and running vs stopped, the health line is a
// derivation over those same rows, and a toggle applies at once and persists the
// disabled set. `window.electronAPI` is the only boundary, so it is mocked.

const backendState = await vi.hoisted(async () => {
  const { ref } = await import('vue')
  return {
    info: ref([] as Array<Record<string, unknown>>),
    versionState: ref({} as Record<string, unknown>),
    setupProgress: ref(new Map()),
  }
})

const wizardState = await vi.hoisted(async () => {
  const { ref } = await import('vue')
  return {
    preferredDeviceOptions: ref([] as Array<Record<string, unknown>>),
    pendingPreferredDevice: ref(null as PreferredDevice | null),
  }
})

const wizardInstall = vi.fn(async (_name: string) => {})
const wizardRepair = vi.fn(async (_name: string) => {})
const wizardUpdate = vi.fn(async (_name: string) => {})
const wizardShowError = vi.fn((_name: string) => {})
const preferredDeviceKey = vi.fn((pref: PreferredDevice | null) =>
  pref ? `gpu:${pref.uuid ?? pref.instanceId ?? pref.gpuDeviceId ?? pref.name}` : null,
)
const setPendingPreferredDevice = vi.fn((pref: PreferredDevice) => {
  wizardState.pendingPreferredDevice.value = pref
})
const applyPreferredDevice = vi.fn(async () => {})

vi.mock('@/assets/js/store/setupWizard', () => ({
  useSetupWizard: () => ({
    installBackend: wizardInstall,
    repairBackend: wizardRepair,
    updateBackend: wizardUpdate,
    showErrorModal: wizardShowError,
    isBusy: false,
    get preferredDeviceOptions() {
      return wizardState.preferredDeviceOptions.value
    },
    get pendingPreferredDevice() {
      return wizardState.pendingPreferredDevice.value
    },
    preferredDeviceKey,
    setPendingPreferredDevice,
    applyPreferredDevice,
  }),
}))

const startService = vi.fn(async (name: string) => {
  setStatus(name, 'running')
  return 'running'
})
const stopService = vi.fn(async (name: string) => {
  setStatus(name, 'stopped')
  return 'stopped'
})
const uninstallService = vi.fn(async (_name: string) => {})

vi.mock('@/assets/js/store/backendServices', () => {
  return {
    allBackendServiceNames: [
      'ai-backend',
      'home-agent-backend',
      'qwen3-tts-backend',
      'whisper-backend',
      'llamacpp-backend',
      'openvino-backend',
      'comfyui-backend',
    ],
    useBackendServices: () => ({
      get info() {
        return backendState.info.value
      },
      get versionState() {
        return backendState.versionState.value
      },
      get latestSetupProgress() {
        return backendState.setupProgress.value
      },
      getServiceErrorDetails: () => null,
      startService,
      stopService,
      uninstallService,
    }),
  }
})

vi.mock('@/assets/js/store/productMode', () => ({
  useProductMode: () => ({ productMode: 'essentials' }),
}))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ state: {} }),
}))

const report = vi.fn()
vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report }) }))

const holdsState = await vi.hoisted(async () => {
  const { ref } = await import('vue')
  return { holds: ref([] as Array<{ component: string; work: string }>) }
})
vi.mock('@/assets/js/store/componentHolds', () => ({
  useComponentHolds: () => ({
    get anyInFlightWork() {
      return holdsState.holds.value.length > 0
    },
    workFor: (component: string) =>
      holdsState.holds.value.find((entry) => entry.component === component)?.work ?? null,
  }),
}))

const localSettings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))

const getLocalSettings = vi.fn(async () => localSettings.value)
const updateLocalSettings = vi.fn(async (updates: Record<string, unknown>) => {
  localSettings.value = { ...localSettings.value, ...updates }
  return { success: true }
})

vi.stubGlobal('window', {
  electronAPI: { getLocalSettings, updateLocalSettings },
})

type ServiceOverrides = {
  status?: BackendStatus
  isSetUp?: boolean
  isRequired?: boolean
}

function service(name: BackendServiceName, overrides: ServiceOverrides = {}) {
  return {
    serviceName: name,
    status: 'stopped' as BackendStatus,
    isSetUp: true,
    isRequired: false,
    devices: [],
    errorDetails: null,
    ...overrides,
  }
}

function setStatus(name: string, status: BackendStatus) {
  backendState.info.value = backendState.info.value.map((entry) =>
    entry.serviceName === name ? { ...entry, status } : entry,
  )
}

function seed(entries: ReturnType<typeof service>[], versionState = {}) {
  backendState.info.value = entries
  backendState.versionState.value = versionState
}

function row(manager: { rows: ComponentRow[] }, name: string): ComponentRow {
  return manager.rows.find((entry) => entry.serviceName === name)!
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  localSettings.value = {}
  seed([])
  holdsState.holds.value = []
  wizardState.preferredDeviceOptions.value = []
  wizardState.pendingPreferredDevice.value = null
})

describe('Component Manager row vocabulary', () => {
  it('reads a running Component as Running and a switched-off one as Disabled', async () => {
    seed([
      service('ai-backend', { status: 'running', isRequired: true }),
      service('comfyui-backend', { status: 'running' }),
    ])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'ai-backend').subtitle).toMatch(/^Running/)
    expect(row(manager, 'comfyui-backend').subtitle).toMatch(/^Running/)

    await manager.setEnabled('comfyui-backend', false)

    expect(row(manager, 'comfyui-backend').subtitle).toMatch(/^Disabled/)
    expect(row(manager, 'comfyui-backend').enabled).toBe(false)
  })

  it('reads an enabled on-demand Component as Installed until it runs', async () => {
    seed([service('whisper-backend', { status: 'notYetStarted' })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'whisper-backend').subtitle).toMatch(/^Installed/)
    expect(row(manager, 'whisper-backend').enabled).toBe(true)
  })

  it('shows a not-installed Component as not installed and refuses to enable it', async () => {
    seed([service('home-agent-backend', { status: 'notInstalled', isSetUp: false })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'home-agent-backend').subtitle).toMatch(/^Not Installed$/)
    expect(row(manager, 'home-agent-backend').enabled).toBe(false)
    expect(row(manager, 'home-agent-backend').toggleDisabled).toBe(true)

    await manager.setEnabled('home-agent-backend', true)

    expect(startService).not.toHaveBeenCalled()
  })
})

describe('Component Manager live enable/disable', () => {
  it('starts an installed, stopped Component when it is enabled', async () => {
    seed([service('llamacpp-backend', { status: 'stopped' })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()
    await manager.setEnabled('llamacpp-backend', false)
    await manager.setEnabled('llamacpp-backend', true)

    expect(startService).toHaveBeenCalledWith('llamacpp-backend')
    expect(row(manager, 'llamacpp-backend').subtitle).toMatch(/^Running/)
  })

  it('stops a running Component when it is disabled', async () => {
    seed([service('comfyui-backend', { status: 'running' })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    await manager.setEnabled('comfyui-backend', false)

    expect(stopService).toHaveBeenCalledWith('comfyui-backend')
    expect(updateLocalSettings).toHaveBeenCalledWith({
      disabledBackends: ['comfyui-backend'],
    })
  })

  it('remembers the disabled set across a relaunch', async () => {
    seed([service('comfyui-backend', { status: 'running' })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()
    await manager.setEnabled('comfyui-backend', false)

    setActivePinia(createPinia())
    const reopened = useComponentManager()
    await reopened.hydrateFromSettings()

    expect(row(reopened, 'comfyui-backend').enabled).toBe(false)
    expect(row(reopened, 'comfyui-backend').subtitle).toMatch(/^Disabled/)
  })
})

describe('Component Manager health line', () => {
  it('counts running, updates and attention from the rows', async () => {
    seed(
      [
        service('ai-backend', { status: 'running', isRequired: true }),
        service('comfyui-backend', { status: 'failed' }),
        service('home-agent-backend', { status: 'notInstalled', isSetUp: false }),
        service('llamacpp-backend', { status: 'running' }),
      ],
      { 'llamacpp-backend': { installed: { version: 'b6000' }, target: { version: 'b6100' } } },
    )
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(manager.health).toEqual({ running: 2, updates: 1, attention: 2 })
  })

  it('counts a required Component that is not running as needing attention', async () => {
    seed([service('ai-backend', { status: 'stopped', isRequired: true })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(manager.health.attention).toBe(1)
  })

  it('never reports an optional Component that was not installed', async () => {
    seed([
      service('ai-backend', { status: 'running', isRequired: true }),
      service('home-agent-backend', { status: 'notInstalled', isSetUp: false }),
    ])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(manager.health.attention).toBe(0)
  })
})

describe('Component Manager live install', () => {
  it('offers Install only on a not-installed Component, whose switch stays off', async () => {
    seed([service('home-agent-backend', { status: 'notInstalled', isSetUp: false })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    const target = row(manager, 'home-agent-backend')
    expect(target.canInstall).toBe(true)
    expect(target.updateAvailable).toBe(false)
    expect(target.enabled).toBe(false)
    expect(target.toggleDisabled).toBe(true)
  })

  it('does not offer Install on an installed Component and refuses to install it', async () => {
    seed([service('comfyui-backend', { status: 'running' })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'comfyui-backend').canInstall).toBe(false)

    await manager.install('comfyui-backend')

    expect(wizardInstall).not.toHaveBeenCalled()
  })

  it('installs a not-installed Component through the wizard action', async () => {
    seed([service('home-agent-backend', { status: 'notInstalled', isSetUp: false })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    await manager.install('home-agent-backend')

    expect(wizardInstall).toHaveBeenCalledWith('home-agent-backend')
  })
})

describe('Component Manager live repair', () => {
  it('offers Repair and the error log only on the failed row', async () => {
    seed([
      service('comfyui-backend', { status: 'failed' }),
      service('llamacpp-backend', { status: 'running' }),
    ])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'comfyui-backend').canRepair).toBe(true)
    expect(row(manager, 'comfyui-backend').failed).toBe(true)
    expect(row(manager, 'llamacpp-backend').canRepair).toBe(false)
    expect(row(manager, 'llamacpp-backend').failed).toBe(false)
  })

  it('repairs a failed Component through the wizard action and leaves its neighbour alone', async () => {
    seed([
      service('comfyui-backend', { status: 'failed' }),
      service('llamacpp-backend', { status: 'running' }),
    ])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    await manager.repair('comfyui-backend')
    await manager.repair('llamacpp-backend')

    expect(wizardRepair).toHaveBeenCalledTimes(1)
    expect(wizardRepair).toHaveBeenCalledWith('comfyui-backend')
  })

  it('opens the failed Component error log', async () => {
    seed([service('comfyui-backend', { status: 'installationFailed' })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    manager.showErrorLog('comfyui-backend')

    expect(wizardShowError).toHaveBeenCalledWith('comfyui-backend')
  })
})

describe('Component Manager live update', () => {
  it('advertises the newer version and updates through the wizard action', async () => {
    seed([service('llamacpp-backend', { status: 'running' })], {
      'llamacpp-backend': { installed: { version: 'b6000' }, target: { version: 'b6100' } },
    })
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    const target = row(manager, 'llamacpp-backend')
    expect(target.updateAvailable).toBe(true)
    expect(target.updateTargetText).toBe('b6100')

    await manager.update('llamacpp-backend')

    expect(wizardUpdate).toHaveBeenCalledWith('llamacpp-backend')
  })

  it('does not advertise or apply a downgrade from the row', async () => {
    seed([service('llamacpp-backend', { status: 'running' })], {
      'llamacpp-backend': { installed: { version: 'b6100' }, target: { version: 'b6000' } },
    })
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'llamacpp-backend').updateAvailable).toBe(false)
    expect(row(manager, 'llamacpp-backend').updateTargetText).toBe('')

    await manager.update('llamacpp-backend')

    expect(wizardUpdate).not.toHaveBeenCalled()
  })

  it('never offers an update for a Component that is not installed', async () => {
    seed([service('comfyui-backend', { status: 'notInstalled', isSetUp: false })], {
      'comfyui-backend': { target: { version: 'v0.4.0' } },
    })
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'comfyui-backend').updateAvailable).toBe(false)
  })
})

describe('Component Manager install progress', () => {
  it('reads progress from the service while it installs', async () => {
    seed([
      service('comfyui-backend', { status: 'installing' }),
      service('llamacpp-backend', { status: 'running' }),
    ])
    backendState.setupProgress.value = new Map([
      ['comfyui-backend', { step: 'install comfyUI', debugMessage: '' }],
    ])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'comfyui-backend').isInstalling).toBe(true)
    expect(row(manager, 'comfyui-backend').installProgressText).toBe('Installing ComfyUI... (3/6)')
    expect(row(manager, 'llamacpp-backend').isInstalling).toBe(false)
  })

  it('shows the same progress when the tab is reopened', async () => {
    seed([service('comfyui-backend', { status: 'installing' })])
    backendState.setupProgress.value = new Map([
      ['comfyui-backend', { step: 'install comfyUI', debugMessage: '' }],
    ])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const first = useComponentManager()
    await first.hydrateFromSettings()
    const before = row(first, 'comfyui-backend').installProgressText

    setActivePinia(createPinia())
    const reopened = useComponentManager()
    await reopened.hydrateFromSettings()

    expect(row(reopened, 'comfyui-backend').isInstalling).toBe(true)
    expect(row(reopened, 'comfyui-backend').installProgressText).toBe(before)
  })
})

describe('Component Manager default GPU', () => {
  const arc: PreferredDevice = {
    name: 'Intel Arc B580',
    gpuDeviceId: '0x56a0',
    uuid: 'uuid-arc-b580',
  }

  function seedDeviceOptions(options: PreferredDevice[]) {
    wizardState.preferredDeviceOptions.value = options.map((value) => ({
      key: preferredDeviceKey(value)!,
      label: value.name,
      category: 'dgpu' as DeviceCategory,
      value,
    }))
  }

  it('saves a new default for new presets only when the override is off', async () => {
    seedDeviceOptions([arc])
    wizardState.pendingPreferredDevice.value = arc
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    await manager.setPreferredDevice(arc, false)

    expect(updateLocalSettings).toHaveBeenCalledWith({ preferredDevice: arc })
    expect(setPendingPreferredDevice).toHaveBeenCalledWith(arc)
    expect(applyPreferredDevice).not.toHaveBeenCalled()
    expect(manager.selectedDeviceKey).toBe(`gpu:${arc.uuid}`)
  })

  it('rewrites existing preset device selections when the override is on', async () => {
    seedDeviceOptions([arc])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    await manager.setPreferredDevice(arc, true)

    expect(updateLocalSettings).toHaveBeenCalledWith({ preferredDevice: arc })
    expect(applyPreferredDevice).toHaveBeenCalledWith(arc)
  })

  it('hides the default GPU section when no device options are detected', async () => {
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(manager.deviceOptions).toEqual([])
    expect(manager.selectedDeviceKey).toBeNull()
  })

  it('shows the detected options when there are any', async () => {
    seedDeviceOptions([arc])
    wizardState.pendingPreferredDevice.value = arc
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(manager.deviceOptions).toHaveLength(1)
    expect(manager.deviceOptions[0]?.label).toBe('Intel Arc B580')
  })
})

describe('Component Manager in-use guard', () => {
  it('blocks the affected Component, names the work and re-enables it when the work ends', async () => {
    seed([service('comfyui-backend', { status: 'running' })])
    holdsState.holds.value = [{ component: 'comfyui-backend', work: 'media-run' }]
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'comfyui-backend').inUseWork).toBe('media-run')
    expect(row(manager, 'comfyui-backend').inUseReason).toMatch(/generation/)
    expect(row(manager, 'comfyui-backend').toggleDisabled).toBe(true)

    holdsState.holds.value = []
    expect(row(manager, 'comfyui-backend').inUseWork).toBeNull()
    expect(row(manager, 'comfyui-backend').toggleDisabled).toBe(false)
  })

  it('refuses to disable a Component the work holds', async () => {
    seed([service('llamacpp-backend', { status: 'running' })])
    holdsState.holds.value = [{ component: 'llamacpp-backend', work: 'turn' }]
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    await manager.setEnabled('llamacpp-backend', false)

    expect(stopService).not.toHaveBeenCalled()
    expect(localSettings.value.disabledBackends).toBeUndefined()
  })

  it('leaves unrelated Components usable while another is held', async () => {
    seed([
      service('llamacpp-backend', { status: 'running' }),
      service('comfyui-backend', { status: 'running' }),
    ])
    holdsState.holds.value = [{ component: 'llamacpp-backend', work: 'turn' }]
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'comfyui-backend').inUseWork).toBeNull()
    await manager.setEnabled('comfyui-backend', false)

    expect(stopService).toHaveBeenCalledWith('comfyui-backend')
  })

  it('refuses repair and update of a held Component', async () => {
    seed([service('comfyui-backend', { status: 'failed' })], {
      'comfyui-backend': { installed: { version: 'v0.3.0' }, target: { version: 'v0.4.0' } },
    })
    holdsState.holds.value = [{ component: 'comfyui-backend', work: 'media-run' }]
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    await manager.repair('comfyui-backend')
    await manager.update('comfyui-backend')

    expect(wizardRepair).not.toHaveBeenCalled()
    expect(wizardUpdate).not.toHaveBeenCalled()
  })

  it('reports whether any In-flight Work exists, for the Hardware Mode change', async () => {
    seed([])
    holdsState.holds.value = []
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(manager.anyInFlightWork).toBe(false)

    holdsState.holds.value = [{ component: 'openvino-backend', work: 'speech-turn' }]
    expect(manager.anyInFlightWork).toBe(true)
  })
})

describe('Component Manager uninstall', () => {
  it('offers Uninstall on an optional installed Component and never on a required one', async () => {
    seed([
      service('ai-backend', { status: 'running', isRequired: true }),
      service('comfyui-backend', { status: 'running' }),
    ])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'comfyui-backend').canUninstall).toBe(true)
    expect(row(manager, 'ai-backend').canUninstall).toBe(false)
  })

  it('does not offer Uninstall on a Component that is not on disk', async () => {
    seed([service('home-agent-backend', { status: 'notInstalled', isSetUp: false })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'home-agent-backend').canUninstall).toBe(false)
  })

  it('names what stops working for each optional Component', async () => {
    seed([
      service('comfyui-backend', { status: 'running' }),
      service('llamacpp-backend', { status: 'running' }),
      service('home-agent-backend', { status: 'running' }),
    ])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    expect(row(manager, 'comfyui-backend').uninstallStopsText).toMatch(/Image, video and 3D/)
    expect(row(manager, 'llamacpp-backend').uninstallStopsText).toMatch(/GGUF/)
    expect(row(manager, 'home-agent-backend').uninstallStopsText).toMatch(/Channels/)
  })

  it('removes an optional Component only through the existing uninstall IPC', async () => {
    seed([service('comfyui-backend', { status: 'running' })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    await manager.uninstall('comfyui-backend')

    expect(uninstallService).toHaveBeenCalledWith('comfyui-backend')
  })

  it('refuses a required Component even when the action bypasses the row', async () => {
    seed([service('ai-backend', { status: 'running', isRequired: true })])
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    await manager.uninstall('ai-backend')

    expect(uninstallService).not.toHaveBeenCalled()
  })

  it('refuses a Component the In-flight Work holds, with the same reason', async () => {
    seed([service('comfyui-backend', { status: 'running' })])
    holdsState.holds.value = [{ component: 'comfyui-backend', work: 'media-run' }]
    const { useComponentManager } = await import('@/assets/js/store/componentManager')
    const manager = useComponentManager()
    await manager.hydrateFromSettings()

    await manager.uninstall('comfyui-backend')

    expect(row(manager, 'comfyui-backend').inUseReason).toMatch(/generation/)
    expect(uninstallService).not.toHaveBeenCalled()
  })
})
