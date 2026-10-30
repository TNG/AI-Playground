import { describe, expect, it, vi } from 'vitest'
import { createDemoModeConfig } from '../../kernel/demoModeConfig'
import { LocalSettingsSchema, type LocalSettings } from '../../kernel/localSettings'

function userSettings(overrides: Partial<LocalSettings> = {}): LocalSettings {
  return LocalSettingsSchema.parse(overrides)
}

function registry(...values: string[]): string {
  return ['HKEY_LOCAL_MACHINE\\SOFTWARE\\AI Playground', ...values, ''].join('\r\n')
}

const installKeyOnly = registry('    modelFolderMode    REG_SZ    per-user')

const demoPolicy = registry(
  '    modelFolderMode    REG_SZ    shared',
  '    isDemoModeEnabled    REG_DWORD    0x1',
  '    demoModePasscode    REG_SZ    pbkdf2$600000$policySalt$policyHash',
  '    demoModeResetInSeconds    REG_DWORD    0x12c',
)

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

describe('readEffectiveDemoConfig with a Demo Policy', () => {
  it('lets the policy decide all three values over the user settings', () => {
    const { config } = setup(
      userSettings({
        isDemoModeEnabled: false,
        demoModeResetInSeconds: 60,
        demoModePasscode: 'user-secret',
      }),
    )

    expect(config.readEffectiveDemoConfig({ registryStdout: demoPolicy })).toEqual({
      isDemoModeEnabled: true,
      demoModeResetInSeconds: 300,
      demoModePasscode: 'pbkdf2$600000$policySalt$policyHash',
      source: 'policy',
      sharedInstall: true,
    })
  })

  it('treats a policy without a Reset Timeout as no auto-reset', () => {
    const { config } = setup(userSettings({ demoModeResetInSeconds: 60 }))
    const stdout = registry('    isDemoModeEnabled    REG_DWORD    0x1')

    expect(config.readEffectiveDemoConfig({ registryStdout: stdout })).toMatchObject({
      isDemoModeEnabled: true,
      demoModeResetInSeconds: null,
      demoModePasscode: undefined,
      source: 'policy',
    })
  })

  it('ignores a policy that is switched off and keeps the user settings', () => {
    const { config } = setup(userSettings({ isDemoModeEnabled: true, demoModePasscode: 'mine' }))
    const stdout = registry(
      '    isDemoModeEnabled    REG_DWORD    0x0',
      '    demoModePasscode    REG_SZ    pbkdf2$1$a$b',
    )

    expect(config.readEffectiveDemoConfig({ registryStdout: stdout })).toEqual({
      isDemoModeEnabled: true,
      demoModeResetInSeconds: null,
      demoModePasscode: 'mine',
      source: 'user',
      sharedInstall: true,
    })
  })

  it('reports a Shared Install for any install key, policy or not', () => {
    const { config } = setup(userSettings())

    expect(config.readEffectiveDemoConfig({ registryStdout: installKeyOnly })).toMatchObject({
      source: 'user',
      sharedInstall: true,
    })
    expect(config.readEffectiveDemoConfig({ registryStdout: null })).toMatchObject({
      source: 'user',
      sharedInstall: false,
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

describe('under a Demo Policy', () => {
  const ownValues = {
    isDemoModeEnabled: false,
    demoModeResetInSeconds: 60,
    demoModePasscode: 'user-secret',
  }

  function underPolicy() {
    const settings = userSettings({ ...ownValues, productMode: 'studio' })
    const harness = setup(settings)
    harness.config.resolveIntoSettings({ registryStdout: demoPolicy })
    return { settings, ...harness }
  }

  it('puts the policy values into the live settings without writing them', () => {
    const { settings, writeUserSettings } = underPolicy()

    expect(settings).toMatchObject({
      isDemoModeEnabled: true,
      demoModeResetInSeconds: 300,
      demoModePasscode: 'pbkdf2$600000$policySalt$policyHash',
    })
    expect(writeUserSettings).not.toHaveBeenCalled()
  })

  it("gives every other settings write the user's own Demo Mode values", () => {
    const { settings, config } = underPolicy()
    settings.productMode = 'nvidia'

    const toWrite = config.withUserDemoValues(settings)

    expect(toWrite).toMatchObject({ ...ownValues, productMode: 'nvidia' })
    expect(settings.isDemoModeEnabled).toBe(true)
  })

  it('leaves Demo Mode for this session only', () => {
    const { settings, config, writeUserSettings, onDemoModeChanged } = underPolicy()

    expect(config.leaveDemoMode()).toEqual({ success: true })

    expect(settings.isDemoModeEnabled).toBe(false)
    expect(writeUserSettings).not.toHaveBeenCalled()
    expect(onDemoModeChanged).toHaveBeenCalledWith(false)
    expect(config.currentDemoConfig()).toMatchObject({
      isDemoModeEnabled: false,
      source: 'policy',
      sharedInstall: true,
    })
  })

  it('restores the policy on a fresh read after leaving', () => {
    const { config } = underPolicy()
    config.leaveDemoMode()

    expect(config.readEffectiveDemoConfig({ registryStdout: demoPolicy })).toMatchObject({
      isDemoModeEnabled: true,
      source: 'policy',
    })
  })

  it('enters Demo Mode again for this session only', () => {
    const { settings, config, writeUserSettings, onDemoModeChanged } = underPolicy()
    config.leaveDemoMode()

    expect(config.enterDemoMode()).toEqual({ success: true })

    expect(settings.isDemoModeEnabled).toBe(true)
    expect(writeUserSettings).not.toHaveBeenCalled()
    expect(onDemoModeChanged).toHaveBeenLastCalledWith(true)
  })

  it("falls back to the user's own values when the policy is gone on the next read", () => {
    const { settings, config } = underPolicy()

    const effective = config.resolveIntoSettings({ registryStdout: installKeyOnly })

    expect(effective).toMatchObject({ ...ownValues, source: 'user', sharedInstall: true })
    expect(settings).toMatchObject(ownValues)
  })
})

describe('without a Demo Policy', () => {
  it('writes the live settings unchanged', () => {
    const settings = userSettings({ isDemoModeEnabled: true, demoModePasscode: 'mine' })
    const { config } = setup(settings)
    config.resolveIntoSettings({ registryStdout: installKeyOnly })

    expect(config.withUserDemoValues(settings)).toBe(settings)
    expect(config.currentDemoConfig()).toMatchObject({
      isDemoModeEnabled: true,
      demoModePasscode: 'mine',
      source: 'user',
      sharedInstall: true,
    })
  })

  it('never sees a policy off Windows', () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const { config } = setup(userSettings({ isDemoModeEnabled: false }))

      expect(config.resolveIntoSettings()).toMatchObject({
        isDemoModeEnabled: false,
        source: 'user',
        sharedInstall: false,
      })
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    }
  })
})
