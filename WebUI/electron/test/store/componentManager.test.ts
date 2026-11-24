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

const wizardInstall = vi.fn(async (_name: string) => {})
const wizardRepair = vi.fn(async (_name: string) => {})
const wizardUpdate = vi.fn(async (_name: string) => {})
const wizardShowError = vi.fn((_name: string) => {})

vi.mock('@/assets/js/store/setupWizard', () => ({
  useSetupWizard: () => ({
    installBackend: wizardInstall,
    repairBackend: wizardRepair,
    updateBackend: wizardUpdate,
    showErrorModal: wizardShowError,
    isBusy: false,
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
