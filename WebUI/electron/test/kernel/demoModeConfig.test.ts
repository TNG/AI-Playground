import { describe, expect, it, vi } from 'vitest'
import { createDemoModeConfig } from '../../kernel/demoModeConfig'
import type { ElevatedRunResult, RegistryValueChange } from '../../adapters/elevatedRegistry'
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

describe('applyEffectiveDemoConfig', () => {
  it('leaves the effective values in the live settings object and writes nothing', () => {
    const settings = userSettings({ isDemoModeEnabled: true, demoModeResetInSeconds: 30 })
    const { config, writeUserSettings } = setup(settings)

    const effective = config.applyEffectiveDemoConfig()

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

  it('writes Demo Mode, the hashed passcode and the Reset Timeout to the user file', async () => {
    const settings = userSettings()
    const { config, written } = setup(settings)

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 300,
    })

    expect(result).toEqual({ success: true, enteredDemoMode: true })
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

  it('is refused while Demo Mode is active and writes nothing', async () => {
    const settings = userSettings({ isDemoModeEnabled: true, demoModePasscode: 'old' })
    const { config, writeUserSettings } = setup(settings)

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: false,
      demoModePasscode: hashed,
      demoModeResetInSeconds: null,
    })

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/Demo Mode/) })
    expect(writeUserSettings).not.toHaveBeenCalled()
    expect(settings).toMatchObject({ isDemoModeEnabled: true, demoModePasscode: 'old' })
  })

  it('refuses to turn Demo Mode on without a passcode', async () => {
    const settings = userSettings()
    const { config, writeUserSettings } = setup(settings)

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModeResetInSeconds: null,
    })

    expect(result).toMatchObject({ success: false })
    expect(writeUserSettings).not.toHaveBeenCalled()
    expect(settings.isDemoModeEnabled).toBe(false)
  })

  it('keeps the stored passcode when none is given', async () => {
    const settings = userSettings({ demoModePasscode: hashed, demoModeResetInSeconds: 60 })
    const { config, written } = setup(settings)

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: undefined,
      demoModeResetInSeconds: null,
    })

    expect(result).toEqual({ success: true, enteredDemoMode: true })
    expect(written).toEqual([
      expect.objectContaining({
        isDemoModeEnabled: true,
        demoModePasscode: hashed,
        demoModeResetInSeconds: null,
      }),
    ])
  })

  it("keeps a user's hand-written plain passcode when none is given", async () => {
    const settings = userSettings({ demoModePasscode: 'secret' })
    const { config, written } = setup(settings)

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModeResetInSeconds: 120,
    })

    expect(result).toEqual({ success: true, enteredDemoMode: true })
    expect(written).toEqual([
      expect.objectContaining({ isDemoModeEnabled: true, demoModePasscode: 'secret' }),
    ])
  })

  it.each([
    ['a plain-text passcode', { demoModePasscode: 'secret', demoModeResetInSeconds: null }],
    ['a zero Reset Timeout', { demoModePasscode: hashed, demoModeResetInSeconds: 0 }],
    ['a fractional Reset Timeout', { demoModePasscode: hashed, demoModeResetInSeconds: 1.5 }],
    [
      'a passcode that is not a hash',
      { demoModePasscode: 'pbkdf2$1$a" & calc & "$b', demoModeResetInSeconds: null },
    ],
  ])('refuses %s', async (_label, values) => {
    const settings = userSettings()
    const { config, writeUserSettings } = setup(settings)

    const result = await config.saveDemoConfig({ isDemoModeEnabled: true, ...values })

    expect(result).toMatchObject({ success: false })
    expect(writeUserSettings).not.toHaveBeenCalled()
  })

  it('reports a failed write and leaves the live settings as they were', async () => {
    const settings = userSettings({ demoModeResetInSeconds: 60 })
    const { config, writeUserSettings, onDemoModeChanged } = setup(settings)
    writeUserSettings.mockImplementation(() => {
      throw new Error('read-only')
    })

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 300,
    })

    expect(result).toEqual({ success: false, error: 'read-only' })
    expect(settings).toMatchObject({ isDemoModeEnabled: false, demoModeResetInSeconds: 60 })
    expect(settings.demoModePasscode).toBeUndefined()
    expect(onDemoModeChanged).not.toHaveBeenCalled()
  })

  it('announces a change of Demo Mode, and only a change', async () => {
    const settings = userSettings()
    const { config, onDemoModeChanged } = setup(settings)

    await config.saveDemoConfig({
      isDemoModeEnabled: false,
      demoModePasscode: hashed,
      demoModeResetInSeconds: null,
    })
    expect(onDemoModeChanged).not.toHaveBeenCalled()

    await config.saveDemoConfig({ isDemoModeEnabled: true, demoModeResetInSeconds: null })
    expect(onDemoModeChanged).toHaveBeenCalledExactlyOnceWith(true)
  })
})

describe('under a Demo Policy', () => {
  const userValues = {
    isDemoModeEnabled: false,
    demoModeResetInSeconds: 60,
    demoModePasscode: 'user-secret',
  }

  function underPolicy() {
    const settings = userSettings({ ...userValues, productMode: 'studio' })
    const harness = setup(settings)
    harness.config.applyEffectiveDemoConfig({ registryStdout: demoPolicy })
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

    const toWrite = config.toUserSettingsFile(settings)

    expect(toWrite).toMatchObject({ ...userValues, productMode: 'nvidia' })
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

    const effective = config.applyEffectiveDemoConfig({ registryStdout: installKeyOnly })

    expect(effective).toMatchObject({ ...userValues, source: 'user', sharedInstall: true })
    expect(settings).toMatchObject(userValues)
  })
})

describe('without a Demo Policy', () => {
  it('writes the live settings unchanged', () => {
    const settings = userSettings({ isDemoModeEnabled: true, demoModePasscode: 'mine' })
    const { config } = setup(settings)
    config.applyEffectiveDemoConfig({ registryStdout: installKeyOnly })

    expect(config.toUserSettingsFile(settings)).toBe(settings)
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

      expect(config.applyEffectiveDemoConfig()).toMatchObject({
        isDemoModeEnabled: false,
        source: 'user',
        sharedInstall: false,
      })
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    }
  })
})

describe('saveDemoConfig on a Shared Install', () => {
  const hashed = 'pbkdf2$600000$c2FsdA==$aGFzaA=='

  function sharedInstall(
    machineValues: Record<string, string | number>,
    own: Partial<LocalSettings> = {},
  ) {
    const machine = new Map<string, string | number>([
      ['modelFolderMode', 'shared'],
      ...Object.entries(machineValues),
    ])
    const registryStdout = () =>
      registry(
        ...[...machine].map(([name, value]) =>
          typeof value === 'number'
            ? `    ${name}    REG_DWORD    0x${value.toString(16)}`
            : `    ${name}    REG_SZ    ${value}`,
        ),
      )
    const runs: RegistryValueChange[][] = []
    const rollbacks: RegistryValueChange[][] = []
    let outcome: ElevatedRunResult = { ok: true }
    const runElevated = vi.fn(
      async (changes: RegistryValueChange[], rollback: RegistryValueChange[]) => {
        runs.push(changes)
        rollbacks.push(rollback)
        if (!outcome.ok) return outcome
        for (const change of changes) {
          if (change.action === 'delete') machine.delete(change.name)
          else machine.set(change.name, change.data)
        }
        return outcome
      },
    )
    const settings = userSettings(own)
    const written: LocalSettings[] = []
    const writeUserSettings = vi.fn((s: LocalSettings) => {
      written.push(structuredClone(s))
    })
    const onDemoModeChanged = vi.fn()
    const config = createDemoModeConfig({
      settings: () => settings,
      writeUserSettings,
      onDemoModeChanged,
      runElevated,
      readProbe: () => ({ registryStdout: registryStdout() }),
    })
    config.applyEffectiveDemoConfig()
    return {
      config,
      settings,
      machine,
      runs,
      rollbacks,
      written,
      writeUserSettings,
      onDemoModeChanged,
      failWith: (result: ElevatedRunResult) => {
        outcome = result
      },
    }
  }

  it('writes the Demo Policy, enabling it last, and never the user file', async () => {
    const { config, runs, writeUserSettings } = sharedInstall({})

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 300,
    })

    expect(result).toEqual({ success: true, enteredDemoMode: true })
    expect(runs).toEqual([
      [
        { action: 'set', name: 'demoModePasscode', type: 'REG_SZ', data: hashed },
        { action: 'set', name: 'demoModeResetInSeconds', type: 'REG_DWORD', data: 300 },
        { action: 'set', name: 'isDemoModeEnabled', type: 'REG_DWORD', data: 1 },
      ],
    ])
    expect(writeUserSettings).not.toHaveBeenCalled()
  })

  it('makes the new policy live and announces Demo Mode', async () => {
    const { config, settings, onDemoModeChanged } = sharedInstall({}, { demoModePasscode: 'mine' })

    await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 300,
    })

    expect(config.currentDemoConfig()).toEqual({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 300,
      source: 'policy',
      sharedInstall: true,
    })
    expect(config.toUserSettingsFile(settings)).toMatchObject({ demoModePasscode: 'mine' })
    expect(onDemoModeChanged).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('hands the runner a rollback to the previous policy', async () => {
    const { config, rollbacks } = sharedInstall({
      isDemoModeEnabled: 1,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 60,
    })
    config.leaveDemoMode()

    await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: 'pbkdf2$1$bmV3$bmV3',
      demoModeResetInSeconds: null,
    })

    expect(rollbacks).toEqual([
      [
        { action: 'set', name: 'demoModePasscode', type: 'REG_SZ', data: hashed },
        { action: 'set', name: 'demoModeResetInSeconds', type: 'REG_DWORD', data: 60 },
        { action: 'set', name: 'isDemoModeEnabled', type: 'REG_DWORD', data: 1 },
      ],
    ])
  })

  it('rolls a new policy back by removing it', async () => {
    const { config, rollbacks } = sharedInstall({})

    await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 300,
    })

    expect(rollbacks).toEqual([
      [
        { action: 'delete', name: 'isDemoModeEnabled' },
        { action: 'delete', name: 'demoModePasscode' },
        { action: 'delete', name: 'demoModeResetInSeconds' },
      ],
    ])
  })

  it('leaves a hand-written plain passcode out of the rollback', async () => {
    const { config, rollbacks } = sharedInstall({
      isDemoModeEnabled: 1,
      demoModePasscode: 'teacher',
    })
    config.leaveDemoMode()

    await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: null,
    })

    expect(rollbacks).toEqual([
      [
        { action: 'delete', name: 'demoModeResetInSeconds' },
        { action: 'set', name: 'isDemoModeEnabled', type: 'REG_DWORD', data: 1 },
      ],
    ])
  })

  it('keeps a session-only Leave when only the Reset Timeout of the policy changes', async () => {
    const { config, settings, onDemoModeChanged } = sharedInstall({
      isDemoModeEnabled: 1,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 60,
    })
    config.leaveDemoMode()
    onDemoModeChanged.mockClear()

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModeResetInSeconds: 600,
    })

    expect(result).toEqual({ success: true, enteredDemoMode: false })
    expect(config.currentDemoConfig()).toMatchObject({
      isDemoModeEnabled: false,
      demoModeResetInSeconds: 600,
      source: 'policy',
    })
    expect(settings.isDemoModeEnabled).toBe(false)
    expect(onDemoModeChanged).not.toHaveBeenCalled()
  })

  it("enters Demo Mode when removing the policy hands over to the user's own Demo Mode", async () => {
    const { config, onDemoModeChanged } = sharedInstall(
      { isDemoModeEnabled: 1, demoModePasscode: hashed },
      { isDemoModeEnabled: true, demoModePasscode: 'mine' },
    )
    config.leaveDemoMode()

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: false,
      demoModeResetInSeconds: null,
    })

    expect(result).toEqual({ success: true, enteredDemoMode: true })
    expect(config.currentDemoConfig()).toMatchObject({ isDemoModeEnabled: true, source: 'user' })
    expect(onDemoModeChanged).toHaveBeenLastCalledWith(true)
  })

  it('removes a Reset Timeout that was cleared', async () => {
    const { config, runs } = sharedInstall({
      isDemoModeEnabled: 1,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 60,
    })
    config.leaveDemoMode()

    await config.saveDemoConfig({ isDemoModeEnabled: true, demoModeResetInSeconds: null })

    expect(runs).toEqual([
      [
        { action: 'set', name: 'demoModePasscode', type: 'REG_SZ', data: hashed },
        { action: 'delete', name: 'demoModeResetInSeconds' },
        { action: 'set', name: 'isDemoModeEnabled', type: 'REG_DWORD', data: 1 },
      ],
    ])
  })

  it('turns the policy off by deleting all three values, Demo Mode first', async () => {
    const { config, runs, machine, settings } = sharedInstall(
      { isDemoModeEnabled: 1, demoModePasscode: hashed, demoModeResetInSeconds: 60 },
      { demoModeResetInSeconds: 30 },
    )
    config.leaveDemoMode()

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: false,
      demoModeResetInSeconds: null,
    })

    expect(result).toEqual({ success: true, enteredDemoMode: false })
    expect(runs).toEqual([
      [
        { action: 'delete', name: 'isDemoModeEnabled' },
        { action: 'delete', name: 'demoModePasscode' },
        { action: 'delete', name: 'demoModeResetInSeconds' },
      ],
    ])
    expect([...machine.keys()]).toEqual(['modelFolderMode'])
    expect(config.currentDemoConfig()).toMatchObject({ source: 'user', sharedInstall: true })
    expect(settings.demoModeResetInSeconds).toBe(30)
  })

  it("keeps the policy's passcode when none is given, not the user's", async () => {
    const { config, runs } = sharedInstall(
      { isDemoModeEnabled: 1, demoModePasscode: hashed },
      { demoModePasscode: 'pbkdf2$1$dXNlcg==$dXNlcg==' },
    )
    config.leaveDemoMode()

    await config.saveDemoConfig({ isDemoModeEnabled: true, demoModeResetInSeconds: null })

    expect(runs[0][0]).toEqual({
      action: 'set',
      name: 'demoModePasscode',
      type: 'REG_SZ',
      data: hashed,
    })
  })

  it('asks for a new passcode instead of keeping a hand-written plain one', async () => {
    const { config, runs } = sharedInstall({ isDemoModeEnabled: 1, demoModePasscode: 'teacher' })
    config.leaveDemoMode()

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModeResetInSeconds: 600,
    })

    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/new Demo Passcode/),
    })
    expect(runs).toEqual([])
  })

  it('replaces a hand-written plain policy passcode with a new hashed one', async () => {
    const { config, runs } = sharedInstall({ isDemoModeEnabled: 1, demoModePasscode: 'teacher' })
    config.leaveDemoMode()

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: null,
    })

    expect(result).toMatchObject({ success: true })
    expect(runs[0]).toContainEqual({
      action: 'set',
      name: 'demoModePasscode',
      type: 'REG_SZ',
      data: hashed,
    })
  })

  it('refuses to turn the policy on without a passcode of its own', async () => {
    const { config, runs } = sharedInstall({}, { demoModePasscode: hashed })

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModeResetInSeconds: null,
    })

    expect(result).toMatchObject({ success: false })
    expect(runs).toEqual([])
  })

  it('changes nothing when the administrator prompt is cancelled', async () => {
    const { config, machine, settings, onDemoModeChanged, failWith } = sharedInstall({})
    failWith({ ok: false, cancelled: true, error: 'The operation was canceled by the user.' })

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: 300,
    })

    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/cancelled/i),
    })
    expect([...machine.keys()]).toEqual(['modelFolderMode'])
    expect(settings).toMatchObject({ isDemoModeEnabled: false, demoModeResetInSeconds: null })
    expect(config.currentDemoConfig()).toMatchObject({ source: 'user' })
    expect(onDemoModeChanged).not.toHaveBeenCalled()
  })

  it('reports a failed write and keeps the live state', async () => {
    const { config, onDemoModeChanged, failWith } = sharedInstall({})
    failWith({ ok: false, cancelled: false, error: 'reg.exe exited with code 1' })

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: true,
      demoModePasscode: hashed,
      demoModeResetInSeconds: null,
    })

    expect(result).toEqual({ success: false, error: 'reg.exe exited with code 1' })
    expect(config.currentDemoConfig()).toMatchObject({ isDemoModeEnabled: false, source: 'user' })
    expect(onDemoModeChanged).not.toHaveBeenCalled()
  })

  it('is refused while the policy keeps Demo Mode active', async () => {
    const { config, runs } = sharedInstall({ isDemoModeEnabled: 1, demoModePasscode: hashed })

    const result = await config.saveDemoConfig({
      isDemoModeEnabled: false,
      demoModeResetInSeconds: null,
    })

    expect(result).toMatchObject({ success: false })
    expect(runs).toEqual([])
  })
})
