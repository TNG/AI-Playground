import {
  CHANNEL_FIELD_SPEC,
  type ChannelKind,
  type ChannelPrefs,
} from '@/assets/js/store/channels/types'
import type { IpcMutationResult } from '@/types/ipcChannels'
import type { ChannelsLegacyState, ChannelsState } from '@/types/channelHostIpc'

export const CHANNEL_KINDS = Object.keys(CHANNEL_FIELD_SPEC) as ChannelKind[]

type PrefsFile = { verified: boolean; enabled: boolean }

/** The Home Agent backend's config and prefs files, and its running channel bots. */
export type ChannelStore = {
  loadConfig: (kind: ChannelKind) => Record<string, string> | null
  saveConfig: (kind: ChannelKind, config: Record<string, string>) => IpcMutationResult
  clearConfig: (kind: ChannelKind) => void
  loadPrefs: (kind: ChannelKind) => PrefsFile | null
  savePrefs: (kind: ChannelKind, prefs: Partial<PrefsFile>) => IpcMutationResult
  inject: (
    kind: ChannelKind,
    config: Record<string, string | undefined>,
  ) => Promise<{ status: string; error?: string }>
}

export type ChannelStateDeps = {
  store: ChannelStore
  /** The title-bar switch, kept with the user's preferences; null before it was ever stored. */
  readMaster: () => Promise<boolean | null>
  writeMaster: (on: boolean) => Promise<void>
  log: (message: string, error?: unknown) => void
}

export type ChannelStateHost = {
  init: () => Promise<void>
  state: () => ChannelsState
  activeKinds: () => ChannelKind[]
  onChange: (listener: (state: ChannelsState) => void) => () => void
  setAvailable: (available: boolean) => void
  setMaster: (on: boolean) => Promise<IpcMutationResult>
  setEnabled: (kind: ChannelKind, on: boolean) => IpcMutationResult
  setVerified: (kind: ChannelKind) => IpcMutationResult
  saveConfig: (kind: ChannelKind, config: Record<string, string>) => Promise<IpcMutationResult>
  clearConfig: (kind: ChannelKind) => IpcMutationResult
  migrate: (legacy: ChannelsLegacyState) => Promise<void>
}

const emptyPrefs = (): ChannelPrefs => ({ verified: false, identity: null, enabled: false })

/** Whether Channels run, decided once for every window: the switch, each Channel's setup, the bots. */
export function createChannelState(deps: ChannelStateDeps): ChannelStateHost {
  const prefs = Object.fromEntries(CHANNEL_KINDS.map((kind) => [kind, emptyPrefs()])) as Record<
    ChannelKind,
    ChannelPrefs
  >
  let masterEnabled = true
  let masterStored = false
  let available = false
  const listeners = new Set<(state: ChannelsState) => void>()

  const isActive = (kind: ChannelKind) =>
    available && masterEnabled && prefs[kind].enabled && prefs[kind].verified

  function state(): ChannelsState {
    return {
      available,
      masterEnabled,
      prefs: Object.fromEntries(CHANNEL_KINDS.map((kind) => [kind, { ...prefs[kind] }])) as Record<
        ChannelKind,
        ChannelPrefs
      >,
      active: Object.fromEntries(CHANNEL_KINDS.map((kind) => [kind, isActive(kind)])) as Record<
        ChannelKind,
        boolean
      >,
    }
  }

  function changed(): void {
    const next = state()
    for (const listener of [...listeners]) listener(next)
  }

  function savePrefs(kind: ChannelKind): void {
    const result = deps.store.savePrefs(kind, {
      verified: prefs[kind].verified,
      enabled: prefs[kind].enabled,
    })
    if (!result.success) deps.log(`channels: saving ${kind} prefs failed: ${result.error}`)
  }

  // A channel's bot starts once every required secret is saved; the identity rides along.
  async function inject(kind: ChannelKind): Promise<void> {
    if (!available) return
    const config = deps.store.loadConfig(kind)
    if (!config) return
    const spec = CHANNEL_FIELD_SPEC[kind]
    const payload: Record<string, string | undefined> = { ...config }
    if (spec.requiredSecrets.some((field) => !payload[field])) return
    const identity = prefs[kind].identity
    if (identity && !payload[spec.identityField]) payload[spec.identityField] = identity
    const result = await deps.store.inject(kind, payload)
    if (result.status === 'error') deps.log(`channels: inject(${kind}) failed: ${result.error}`)
  }

  function injectAll(): void {
    for (const kind of CHANNEL_KINDS) {
      void inject(kind).catch((error: unknown) =>
        deps.log(`channels: inject(${kind}) failed:`, error),
      )
    }
  }

  async function init(): Promise<void> {
    for (const kind of CHANNEL_KINDS) {
      const config = deps.store.loadConfig(kind)
      const identity = config?.[CHANNEL_FIELD_SPEC[kind].identityField]
      if (identity) prefs[kind].identity = identity
      const stored = deps.store.loadPrefs(kind)
      if (stored) {
        prefs[kind].verified = stored.verified
        prefs[kind].enabled = stored.enabled
      }
    }
    const master = await deps.readMaster()
    if (master !== null) {
      masterEnabled = master
      masterStored = true
    }
    changed()
  }

  return {
    init,
    state,
    activeKinds: () => CHANNEL_KINDS.filter(isActive),
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setAvailable: (next) => {
      if (next === available) return
      available = next
      if (available) injectAll()
      changed()
    },
    setMaster: async (on) => {
      masterEnabled = on
      masterStored = true
      changed()
      try {
        await deps.writeMaster(on)
        return { success: true }
      } catch (error) {
        deps.log('channels: saving the Channels switch failed:', error)
        return { success: false, error: String(error) }
      }
    },
    setEnabled: (kind, on) => {
      if (on && !prefs[kind].verified) {
        return { success: false, error: `Verify the ${kind} connection before enabling it.` }
      }
      prefs[kind].enabled = on
      savePrefs(kind)
      changed()
      return { success: true }
    },
    setVerified: (kind) => {
      prefs[kind].verified = true
      prefs[kind].enabled = true
      savePrefs(kind)
      changed()
      return { success: true }
    },
    saveConfig: async (kind, config) => {
      const previous = deps.store.loadConfig(kind) ?? {}
      const result = deps.store.saveConfig(kind, config)
      if (!result.success) return result
      const identity = config[CHANNEL_FIELD_SPEC[kind].identityField]
      if (identity !== undefined) prefs[kind].identity = identity
      // New credentials have not been tested; the Channel waits for that, still enabled.
      if (Object.keys(config).some((key) => previous[key] !== config[key])) {
        prefs[kind].verified = false
        savePrefs(kind)
      }
      changed()
      await inject(kind)
      return result
    },
    clearConfig: (kind) => {
      deps.store.clearConfig(kind)
      prefs[kind] = emptyPrefs()
      changed()
      return { success: true }
    },
    migrate: async (legacy) => {
      let touched = false
      if (!masterStored) {
        masterEnabled = legacy.masterEnabled
        masterStored = true
        touched = true
        await deps.writeMaster(legacy.masterEnabled)
      }
      for (const kind of CHANNEL_KINDS) {
        const old = legacy.prefs[kind]
        if (!old || deps.store.loadPrefs(kind)) continue
        prefs[kind].verified = old.verified
        prefs[kind].enabled = old.enabled
        if (!prefs[kind].identity && old.identity) prefs[kind].identity = old.identity
        savePrefs(kind)
        touched = true
      }
      if (touched) changed()
    },
  }
}
