import type { IpcMutationResult } from '@/types/ipcChannels'
import type { LocalSettings } from './localSettings'

export type DemoModeValues = Pick<
  LocalSettings,
  'isDemoModeEnabled' | 'demoModeResetInSeconds' | 'demoModePasscode'
>

export type DemoConfigSource = 'user'

const DEMO_MODE_KEYS = [
  'isDemoModeEnabled',
  'demoModePasscode',
  'demoModeResetInSeconds',
] as const satisfies readonly (keyof DemoModeValues)[]

export type EffectiveDemoConfig = DemoModeValues & {
  source: DemoConfigSource
  sharedInstall: boolean
}

/** Test seam. Production probes the machine itself. */
export type DemoConfigProbe = {
  sharedInstall: boolean
}

export type DemoModeConfigDeps = {
  /** The live in-memory settings; the module mutates it, never replaces it. */
  settings: () => LocalSettings
  /** Writes the user's own settings file; throws when it cannot. */
  writeUserSettings: (settings: LocalSettings) => void
  onDemoModeChanged: (enabled: boolean) => void
}

const productionProbe = (): DemoConfigProbe => ({ sharedInstall: false })

export function createDemoModeConfig(deps: DemoModeConfigDeps) {
  function readEffectiveDemoConfig(
    probe: DemoConfigProbe = productionProbe(),
  ): EffectiveDemoConfig {
    const s = deps.settings()
    return {
      isDemoModeEnabled: s.isDemoModeEnabled,
      demoModeResetInSeconds: s.demoModeResetInSeconds,
      demoModePasscode: s.demoModePasscode,
      source: 'user',
      sharedInstall: probe.sharedInstall,
    }
  }

  function setUserDemoMode(enabled: boolean): IpcMutationResult {
    const s = deps.settings()
    const previous = s.isDemoModeEnabled
    s.isDemoModeEnabled = enabled
    try {
      deps.writeUserSettings(s)
    } catch (e) {
      s.isDemoModeEnabled = previous
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    deps.onDemoModeChanged(enabled)
    return { success: true }
  }

  /** At settings load: makes the live settings carry the effective values. */
  function resolveIntoSettings(probe?: DemoConfigProbe): EffectiveDemoConfig {
    const effective = readEffectiveDemoConfig(probe)
    const s = deps.settings()
    s.isDemoModeEnabled = effective.isDemoModeEnabled
    s.demoModeResetInSeconds = effective.demoModeResetInSeconds
    s.demoModePasscode = effective.demoModePasscode
    return effective
  }

  /** Demo Mode settings can only change after leaving Demo Mode with the passcode. */
  function refusesSettingsUpdate(updates: Partial<LocalSettings>): boolean {
    return deps.settings().isDemoModeEnabled && DEMO_MODE_KEYS.some((key) => key in updates)
  }

  return {
    readEffectiveDemoConfig,
    refusesSettingsUpdate,
    resolveIntoSettings,
    leaveDemoMode: () => setUserDemoMode(false),
    enterDemoMode: () => setUserDemoMode(true),
  }
}

export type DemoModeConfig = ReturnType<typeof createDemoModeConfig>
