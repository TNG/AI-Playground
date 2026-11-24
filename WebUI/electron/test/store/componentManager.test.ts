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
  }
})

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
