import { describe, expect, it, vi } from 'vitest'
import { createDemoModeConfig } from '../../kernel/demoModeConfig'
import { LocalSettingsSchema, type LocalSettings } from '../../kernel/localSettings'

function userSettings(overrides: Partial<LocalSettings> = {}): LocalSettings {
  return LocalSettingsSchema.parse(overrides)
}

function setup(settings: LocalSettings) {
  const written: LocalSettings[] = []
  const writeUserSettings = vi.fn((s: LocalSettings) => {
    written.push(structuredClone(s))
  })
  const onDemoModeChanged = vi.fn()
  const config = createDemoModeConfig({
    settings: () => settings,
    writeUserSettings,
    onDemoModeChanged,
  })
  return { config, written, writeUserSettings, onDemoModeChanged }
}

describe('readEffectiveDemoConfig', () => {
  it('takes the effective values from the user settings', () => {
    const { config } = setup(
      userSettings({
        isDemoModeEnabled: true,
        demoModeResetInSeconds: 120,
        demoModePasscode: 'pbkdf2$1$a$b',
      }),
    )

    expect(config.readEffectiveDemoConfig()).toEqual({
      isDemoModeEnabled: true,
      demoModeResetInSeconds: 120,
      demoModePasscode: 'pbkdf2$1$a$b',
      source: 'user',
      sharedInstall: false,
    })
  })

  it('defaults to Demo Mode off when the user never set it', () => {
    const { config } = setup(userSettings())

    expect(config.readEffectiveDemoConfig()).toMatchObject({
      isDemoModeEnabled: false,
      demoModeResetInSeconds: null,
      demoModePasscode: undefined,
      source: 'user',
    })
  })
})

describe('resolveIntoSettings', () => {
  it('leaves the effective values in the live settings object and writes nothing', () => {
    const settings = userSettings({ isDemoModeEnabled: true, demoModeResetInSeconds: 30 })
    const { config, writeUserSettings } = setup(settings)

    const effective = config.resolveIntoSettings()

    expect(effective).toMatchObject({ isDemoModeEnabled: true, source: 'user' })
    expect(settings).toMatchObject({ isDemoModeEnabled: true, demoModeResetInSeconds: 30 })
    expect(writeUserSettings).not.toHaveBeenCalled()
  })
})

describe('leaveDemoMode', () => {
  it('turns Demo Mode off in the live settings and the user file', () => {
    const settings = userSettings({ isDemoModeEnabled: true, demoModePasscode: 'secret' })
    const { config, written, onDemoModeChanged } = setup(settings)

    expect(config.leaveDemoMode()).toEqual({ success: true })

    expect(settings.isDemoModeEnabled).toBe(false)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ isDemoModeEnabled: false, demoModePasscode: 'secret' })
    expect(onDemoModeChanged).toHaveBeenCalledWith(false)
    expect(config.readEffectiveDemoConfig().isDemoModeEnabled).toBe(false)
  })

  it('reports a failed write and keeps Demo Mode on', () => {
    const settings = userSettings({ isDemoModeEnabled: true })
    const { config, writeUserSettings, onDemoModeChanged } = setup(settings)
    writeUserSettings.mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(config.leaveDemoMode()).toEqual({ success: false, error: 'disk full' })

    expect(settings.isDemoModeEnabled).toBe(true)
    expect(onDemoModeChanged).not.toHaveBeenCalled()
  })
})

describe('enterDemoMode', () => {
  it('turns Demo Mode on in the live settings and the user file', () => {
    const settings = userSettings({ demoModeResetInSeconds: 60 })
    const { config, written, onDemoModeChanged } = setup(settings)

    expect(config.enterDemoMode()).toEqual({ success: true })

    expect(settings.isDemoModeEnabled).toBe(true)
    expect(written).toEqual([
      expect.objectContaining({ isDemoModeEnabled: true, demoModeResetInSeconds: 60 }),
    ])
    expect(onDemoModeChanged).toHaveBeenCalledWith(true)
  })
})
