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

describe('saveDemoConfig', () => {
  const hashed = 'pbkdf2$600000$c2FsdA==$aGFzaA=='

  it('writes Demo Mode, the hashed passcode and the Reset Timeout to the user file', () => {
    const settings = userSettings()
    const { config, written } = setup(settings)

    const result = config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 300,
    })

    expect(result).toEqual({ success: true })
    expect(written).toEqual([
      expect.objectContaining({
        isDemoModeEnabled: true,
        demoModePasscode: hashed,
        demoModeResetInSeconds: 300,
      }),
    ])
    expect(config.readEffectiveDemoConfig()).toMatchObject({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 300,
      source: 'user',
    })
  })

  it('is refused while Demo Mode is active and writes nothing', () => {
    const settings = userSettings({ isDemoModeEnabled: true, demoModePasscode: 'old' })
    const { config, writeUserSettings } = setup(settings)

    const result = config.saveDemoConfig({
      isDemoModeEnabled: false,
      demoModePasscode: hashed,
      demoModeResetInSeconds: null,
    })

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/Demo Mode/) })
    expect(writeUserSettings).not.toHaveBeenCalled()
    expect(settings).toMatchObject({ isDemoModeEnabled: true, demoModePasscode: 'old' })
  })

  it('refuses to turn Demo Mode on without a passcode', () => {
    const settings = userSettings()
    const { config, writeUserSettings } = setup(settings)

    const result = config.saveDemoConfig({ isDemoModeEnabled: true, demoModeResetInSeconds: null })

    expect(result).toMatchObject({ success: false })
    expect(writeUserSettings).not.toHaveBeenCalled()
    expect(settings.isDemoModeEnabled).toBe(false)
  })

  it('keeps the stored passcode when none is given', () => {
    const settings = userSettings({ demoModePasscode: hashed, demoModeResetInSeconds: 60 })
    const { config, written } = setup(settings)

    const result = config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: undefined,
      demoModeResetInSeconds: null,
    })

    expect(result).toEqual({ success: true })
    expect(written).toEqual([
      expect.objectContaining({
        isDemoModeEnabled: true,
        demoModePasscode: hashed,
        demoModeResetInSeconds: null,
      }),
    ])
  })

  it.each([
    ['a plain-text passcode', { demoModePasscode: 'secret', demoModeResetInSeconds: null }],
    ['a zero Reset Timeout', { demoModePasscode: hashed, demoModeResetInSeconds: 0 }],
    ['a fractional Reset Timeout', { demoModePasscode: hashed, demoModeResetInSeconds: 1.5 }],
  ])('refuses %s', (_label, values) => {
    const settings = userSettings()
    const { config, writeUserSettings } = setup(settings)

    const result = config.saveDemoConfig({ isDemoModeEnabled: true, ...values })

    expect(result).toMatchObject({ success: false })
    expect(writeUserSettings).not.toHaveBeenCalled()
  })

  it('reports a failed write and leaves the live settings as they were', () => {
    const settings = userSettings({ demoModeResetInSeconds: 60 })
    const { config, writeUserSettings, onDemoModeChanged } = setup(settings)
    writeUserSettings.mockImplementation(() => {
      throw new Error('read-only')
    })

    const result = config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 300,
    })

    expect(result).toEqual({ success: false, error: 'read-only' })
    expect(settings).toMatchObject({
      isDemoModeEnabled: false,
      demoModePasscode: undefined,
      demoModeResetInSeconds: 60,
    })
    expect(onDemoModeChanged).not.toHaveBeenCalled()
  })

  it('announces a change of Demo Mode, and only a change', () => {
    const settings = userSettings()
    const { config, onDemoModeChanged } = setup(settings)

    config.saveDemoConfig({
      isDemoModeEnabled: false,
      demoModePasscode: hashed,
      demoModeResetInSeconds: null,
    })
    expect(onDemoModeChanged).not.toHaveBeenCalled()

    config.saveDemoConfig({ isDemoModeEnabled: true, demoModeResetInSeconds: null })
    expect(onDemoModeChanged).toHaveBeenCalledExactlyOnceWith(true)
  })
})
