import { describe, expect, it, vi } from 'vitest'
import { createDemoModeConfig } from '../../kernel/demoModeConfig'
import { LocalSettingsSchema, type LocalSettings } from '../../kernel/localSettings'

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-test' },
  shell: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeImage: {},
  BrowserWindow: class {},
  dialog: {},
  net: {},
  screen: {},
}))

const { buildCoreInvokeRegistry } = await import('../../kernel/registries/core')

function setup(initial: Partial<LocalSettings>) {
  const settings = LocalSettingsSchema.parse(initial)
  const onDemoModeChanged = vi.fn()
  const demoModeConfig = createDemoModeConfig({
    settings: () => settings,
    writeUserSettings: vi.fn(),
    onDemoModeChanged,
  })
  const persistLocalSettingsToDisk = vi.fn()
  const registry = buildCoreInvokeRegistry({
    settings,
    demoModeConfig,
    persistLocalSettingsToDisk,
    invalidatePresetCatalog: vi.fn(),
    getServiceRegistry: () => null,
    appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never)
  const updateLocalSettings = (updates: Partial<LocalSettings>) =>
    registry.updateLocalSettings({} as never, updates)
  return {
    settings,
    demoModeConfig,
    onDemoModeChanged,
    persistLocalSettingsToDisk,
    updateLocalSettings,
  }
}

const inDemoMode = {
  isDemoModeEnabled: true,
  demoModePasscode: 'secret',
  demoModeResetInSeconds: 60,
} satisfies Partial<LocalSettings>

describe('updateLocalSettings while Demo Mode is active', () => {
  it.each([
    { isDemoModeEnabled: false },
    { demoModePasscode: 'changed' },
    { demoModeResetInSeconds: 600 },
  ])('refuses %o and changes nothing', (updates) => {
    const { settings, persistLocalSettingsToDisk, updateLocalSettings } = setup(inDemoMode)

    expect(updateLocalSettings(updates)).toMatchObject({ success: false })

    expect(settings).toMatchObject(inDemoMode)
    expect(persistLocalSettingsToDisk).not.toHaveBeenCalled()
  })

  it('refuses a mixed update as a whole', () => {
    const { settings, updateLocalSettings } = setup(inDemoMode)

    expect(updateLocalSettings({ huggingfaceEndpoint: 'x', demoModePasscode: '' })).toMatchObject({
      success: false,
    })

    expect(settings.huggingfaceEndpoint).not.toBe('x')
  })

  it('still applies other settings', () => {
    const { settings, persistLocalSettingsToDisk, updateLocalSettings } = setup(inDemoMode)

    expect(updateLocalSettings({ huggingfaceEndpoint: 'https://hf.example' })).toEqual({
      success: true,
    })

    expect(settings.huggingfaceEndpoint).toBe('https://hf.example')
    expect(persistLocalSettingsToDisk).toHaveBeenCalledOnce()
  })
})

describe('updateLocalSettings outside Demo Mode', () => {
  it.each([
    { isDemoModeEnabled: true },
    { demoModePasscode: 'changed' },
    { demoModeResetInSeconds: 600 },
  ])('still refuses %o: the demoMode rows own those keys', (updates) => {
    const {
      settings,
      demoModeConfig,
      onDemoModeChanged,
      persistLocalSettingsToDisk,
      updateLocalSettings,
    } = setup(inDemoMode)
    demoModeConfig.leaveDemoMode()
    onDemoModeChanged.mockClear()

    expect(updateLocalSettings(updates)).toMatchObject({ success: false })

    expect(settings).toMatchObject({ ...inDemoMode, isDemoModeEnabled: false })
    expect(persistLocalSettingsToDisk).not.toHaveBeenCalled()
    expect(onDemoModeChanged).not.toHaveBeenCalled()
  })

  it('applies other settings', () => {
    const { settings, updateLocalSettings } = setup({})

    expect(updateLocalSettings({ huggingfaceEndpoint: 'https://hf.example' })).toEqual({
      success: true,
    })
    expect(settings.huggingfaceEndpoint).toBe('https://hf.example')
  })
})
