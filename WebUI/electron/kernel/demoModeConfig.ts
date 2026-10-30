import z from 'zod'
import type { IpcMutationResult } from '@/types/ipcChannels'
import type { DemoConfigSaveResult } from '@/types/demoModeIpc'
import { DemoConfigUpdateSchema, type DemoConfigUpdate } from '@/types/demoModeIpc'
import { isHashedDemoPasscode } from '@/lib/demoPasscode'
import {
  runElevatedRegistryChanges,
  type ElevatedRegistryRunner,
  type RegistryValueChange,
} from '../adapters/elevatedRegistry'
import { INSTALL_CONFIG_KEY, parseRegistryValues, readInstallRegistryStdout } from './installConfig'
import { ipcFail } from './typedIpc'
import type { LocalSettings } from './localSettings'

export type DemoModeValues = Pick<
  LocalSettings,
  'isDemoModeEnabled' | 'demoModeResetInSeconds' | 'demoModePasscode'
>

export type DemoConfigSource = 'policy' | 'user'

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
  /** `reg query` output of the install key; null when the key does not exist. */
  registryStdout: string | null
}

export type DemoModeConfigDeps = {
  /** The live in-memory settings; the module mutates it, never replaces it. */
  settings: () => LocalSettings
  /** Writes the user's own settings file; throws when it cannot. */
  writeUserSettings: (settings: LocalSettings) => void
  onDemoModeChanged: (enabled: boolean) => void
  /** Writes the Demo Policy behind a UAC prompt; production runs `reg.exe` elevated. */
  runElevated?: ElevatedRegistryRunner
  readProbe?: () => DemoConfigProbe
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

/** Ordered so an interrupted write never leaves a policy enabled with stale values. */
function demoPolicyChanges(values: DemoModeValues): RegistryValueChange[] {
  if (!values.isDemoModeEnabled) {
    return DEMO_MODE_KEYS.map((name) => ({ action: 'delete', name }))
  }
  return [
    {
      action: 'set',
      name: 'demoModePasscode',
      type: 'REG_SZ',
      data: values.demoModePasscode ?? '',
    },
    values.demoModeResetInSeconds
      ? {
          action: 'set',
          name: 'demoModeResetInSeconds',
          type: 'REG_DWORD',
          data: values.demoModeResetInSeconds,
        }
      : { action: 'delete', name: 'demoModeResetInSeconds' },
    { action: 'set', name: 'isDemoModeEnabled', type: 'REG_DWORD', data: 1 },
  ]
}

/** Restores `previous` if a policy write fails; a plain passcode cannot be written back. */
function rollbackTo(previous: DemoModeValues | null): RegistryValueChange[] {
  const changes = demoPolicyChanges(
    previous ?? { isDemoModeEnabled: false, demoModeResetInSeconds: null },
  )
  return changes.filter(
    (change) =>
      !(change.action === 'set' && change.type === 'REG_SZ' && !isHashedDemoPasscode(change.data)),
  )
}

function demoValuesOf(settings: LocalSettings): DemoModeValues {
  return {
    isDemoModeEnabled: settings.isDemoModeEnabled,
    demoModeResetInSeconds: settings.demoModeResetInSeconds,
    demoModePasscode: settings.demoModePasscode,
  }
}

export function createDemoModeConfig(deps: DemoModeConfigDeps) {
  const readProbe = deps.readProbe ?? productionProbe
  const runElevated =
    deps.runElevated ??
    ((changes: RegistryValueChange[], rollback: RegistryValueChange[]) =>
      runElevatedRegistryChanges(INSTALL_CONFIG_KEY, changes, rollback))
  // Set only while a Demo Policy is in effect: the live settings then carry the policy's values.
  let userOwnValues: DemoModeValues | null = null
  let resolved: Pick<EffectiveDemoConfig, 'source' | 'sharedInstall'> = {
    source: 'user',
    sharedInstall: false,
  }

  const ownValues = () => userOwnValues ?? demoValuesOf(deps.settings())

  function readEffectiveDemoConfig(probe: DemoConfigProbe = readProbe()): EffectiveDemoConfig {
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
        return ipcFail(e)
      }
    }
    deps.onDemoModeChanged(enabled)
    return { success: true }
  }

  async function saveDemoConfig(input: DemoConfigUpdate): Promise<DemoConfigSaveResult> {
    const s = deps.settings()
    if (s.isDemoModeEnabled) return ipcFail('Leave Demo Mode before changing its settings')
    const parsed = DemoConfigUpdateSchema.safeParse(input)
    if (!parsed.success) return ipcFail(z.prettifyError(parsed.error))
    const update = parsed.data
    const policy = resolved.sharedInstall ? parseDemoPolicy(readProbe().registryStdout) : null
    const keptPasscode = resolved.sharedInstall
      ? policy?.demoModePasscode
      : ownValues().demoModePasscode
    const next: DemoModeValues = {
      isDemoModeEnabled: update.isDemoModeEnabled,
      demoModePasscode: update.demoModePasscode ?? keptPasscode,
      demoModeResetInSeconds: update.demoModeResetInSeconds,
    }
    if (next.isDemoModeEnabled && !next.demoModePasscode) {
      return ipcFail('Demo Mode needs a Demo Passcode')
    }
    // A hand-written plain policy passcode cannot be carried into the registry write.
    if (
      resolved.sharedInstall &&
      next.isDemoModeEnabled &&
      !update.demoModePasscode &&
      keptPasscode &&
      !isHashedDemoPasscode(keptPasscode)
    ) {
      return ipcFail('The Demo Policy passcode is not stored as a hash; set a new Demo Passcode')
    }
    if (resolved.sharedInstall) {
      const result = await runElevated(demoPolicyChanges(next), rollbackTo(policy))
      if (!result.ok) {
        return ipcFail(
          result.cancelled
            ? 'Administrator approval was cancelled; the Demo Policy is unchanged'
            : result.error,
        )
      }
    } else {
      try {
        deps.writeUserSettings({ ...withUserDemoValues(s), ...next })
      } catch (e) {
        return ipcFail(e)
      }
      Object.assign(s, next)
    }
    const policyWasInEffect = resolved.source === 'policy'
    const effective = resolveIntoSettings()
    // Editing a policy that was left for this session keeps the session-only Leave.
    if (policyWasInEffect && effective.source === 'policy') s.isDemoModeEnabled = false
    const enteredDemoMode = s.isDemoModeEnabled
    if (enteredDemoMode) deps.onDemoModeChanged(true)
    return { success: true, enteredDemoMode }
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

  function touchesDemoModeKeys(updates: Partial<LocalSettings>): boolean {
    return DEMO_MODE_KEYS.some((key) => key in updates)
  }

  /** The live state, including a session-only Leave or Enter under a policy. */
  function currentDemoConfig(): EffectiveDemoConfig {
    return { ...demoValuesOf(deps.settings()), ...resolved }
  }

  return {
    readEffectiveDemoConfig,
    touchesDemoModeKeys,
    resolveIntoSettings,
    currentDemoConfig,
    withUserDemoValues,
    leaveDemoMode: () => setDemoMode(false),
    enterDemoMode: () => setDemoMode(true),
    saveDemoConfig,
  }
}

export type DemoModeConfig = ReturnType<typeof createDemoModeConfig>
