import type { IpcMutationResult } from '@/types/ipcChannels'
import { parseRegistryValues, readInstallRegistryStdout } from './installConfig'
import type { LocalSettings } from './localSettings'

export type DemoModeValues = Pick<
  LocalSettings,
  'isDemoModeEnabled' | 'demoModeResetInSeconds' | 'demoModePasscode'
>

export type DemoConfigSource = 'policy' | 'user'

export type EffectiveDemoConfig = DemoModeValues & {
  source: DemoConfigSource
  sharedInstall: boolean
}

/** Test seam. Production probes the machine itself. */
export type DemoConfigProbe = {
  /** `reg query` output of the install key; null when the key does not exist. */
  registryStdout: string | null
}

export type DemoModeConfigDeps = {
  /** The live in-memory settings; the module mutates it, never replaces it. */
  settings: () => LocalSettings
  /** Writes the user's own settings file; throws when it cannot. */
  writeUserSettings: (settings: LocalSettings) => void
  onDemoModeChanged: (enabled: boolean) => void
}

const productionProbe = (): DemoConfigProbe => ({
  registryStdout: process.platform === 'win32' ? readInstallRegistryStdout() : null,
})

function parseDemoPolicy(registryStdout: string | null): DemoModeValues | null {
  if (registryStdout === null) return null
  const values = parseRegistryValues(registryStdout)
  if (values.get('isDemoModeEnabled') !== 1) return null
  const passcode = values.get('demoModePasscode')
  const resetInSeconds = values.get('demoModeResetInSeconds')
  return {
    isDemoModeEnabled: true,
    demoModePasscode: typeof passcode === 'string' ? passcode : undefined,
    demoModeResetInSeconds:
      typeof resetInSeconds === 'number' && resetInSeconds > 0 ? resetInSeconds : null,
  }
}

function demoValuesOf(settings: LocalSettings): DemoModeValues {
  return {
    isDemoModeEnabled: settings.isDemoModeEnabled,
    demoModeResetInSeconds: settings.demoModeResetInSeconds,
    demoModePasscode: settings.demoModePasscode,
  }
}

export function createDemoModeConfig(deps: DemoModeConfigDeps) {
  // Set only while a Demo Policy is in effect: the live settings then carry the policy's values.
  let userOwnValues: DemoModeValues | null = null
  let resolved: Pick<EffectiveDemoConfig, 'source' | 'sharedInstall'> = {
    source: 'user',
    sharedInstall: false,
  }

  const ownValues = () => userOwnValues ?? demoValuesOf(deps.settings())

  function readEffectiveDemoConfig(
    probe: DemoConfigProbe = productionProbe(),
  ): EffectiveDemoConfig {
    const sharedInstall = probe.registryStdout !== null
    const policy = parseDemoPolicy(probe.registryStdout)
    if (policy) return { ...policy, source: 'policy', sharedInstall }
    return { ...ownValues(), source: 'user', sharedInstall }
  }

  /** The settings to write to the user's file: never the policy's Demo Mode values. */
  function withUserDemoValues(settings: LocalSettings): LocalSettings {
    return userOwnValues ? { ...settings, ...userOwnValues } : settings
  }

  function setDemoMode(enabled: boolean): IpcMutationResult {
    const s = deps.settings()
    const previous = s.isDemoModeEnabled
    s.isDemoModeEnabled = enabled
    if (resolved.source === 'user') {
      try {
        deps.writeUserSettings(s)
      } catch (e) {
        s.isDemoModeEnabled = previous
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    deps.onDemoModeChanged(enabled)
    return { success: true }
  }

  /** At settings load: makes the live settings carry the effective values. */
  function resolveIntoSettings(probe?: DemoConfigProbe): EffectiveDemoConfig {
    const own = ownValues()
    const effective = readEffectiveDemoConfig(probe)
    userOwnValues = effective.source === 'policy' ? own : null
    resolved = { source: effective.source, sharedInstall: effective.sharedInstall }
    const s = deps.settings()
    s.isDemoModeEnabled = effective.isDemoModeEnabled
    s.demoModeResetInSeconds = effective.demoModeResetInSeconds
    s.demoModePasscode = effective.demoModePasscode
    return effective
  }

  /** The live state, including a session-only Leave or Enter under a policy. */
  function currentDemoConfig(): EffectiveDemoConfig {
    return { ...demoValuesOf(deps.settings()), ...resolved }
  }

  return {
    readEffectiveDemoConfig,
    resolveIntoSettings,
    currentDemoConfig,
    withUserDemoValues,
    leaveDemoMode: () => setDemoMode(false),
    enterDemoMode: () => setDemoMode(true),
  }
}

export type DemoModeConfig = ReturnType<typeof createDemoModeConfig>
