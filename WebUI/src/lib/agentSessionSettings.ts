import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import { llmBackendTypes } from '@/types/shared'

/** A chat preset's saved-settings bag, as `textInference.settingsPerPreset` stores it. */
export type SettingsBag = Record<string, unknown>

/** The one gate for per-session settings: only the folder-picking Agent preset has them. */
export function usesSessionSettings(
  preset: { name: string; agentPreset?: boolean } | null | undefined,
): boolean {
  return preset?.agentPreset === true && preset.name === 'Agent'
}

/** Bag keys whose values belong to the session rather than to the Default Settings. */
const SESSION_OWNED_KEYS = ['backend', 'selectedModels'] as const

type Backend = (typeof llmBackendTypes)[number]

function isBackend(value: unknown): value is Backend {
  return (llmBackendTypes as readonly unknown[]).includes(value)
}

/** Session Settings fields read from the bag; they are replaced, never merged, on an edit. */
const BAG_DERIVED_SETTINGS = ['backend', 'model'] as const

/** Take the bag's values for the fields it owns, keeping the session's other settings. */
export function updateSessionSettingsFromBag(
  current: AgentSessionSettings | null,
  bag: SettingsBag,
): AgentSessionSettings {
  const kept: AgentSessionSettings = { ...current }
  for (const key of BAG_DERIVED_SETTINGS) delete kept[key]
  return { ...kept, ...sessionSettingsFromBag(bag) }
}

export function sessionSettingsFromBag(bag: SettingsBag): AgentSessionSettings {
  const settings: AgentSessionSettings = {}
  if (isBackend(bag.backend)) {
    settings.backend = bag.backend
    const models = bag.selectedModels as Record<string, string | null> | undefined
    const model = models?.[bag.backend]
    if (typeof model === 'string') settings.model = model
  }
  return settings
}

/** Lay a session's settings over a base bag (the Default Settings) for the chat store to load. */
export function sessionSettingsToBag(
  settings: AgentSessionSettings,
  base: SettingsBag,
): SettingsBag {
  const bag: SettingsBag = { ...base }
  if (settings.backend) {
    bag.backend = settings.backend
    if (settings.model !== undefined) {
      bag.selectedModels = {
        ...(base.selectedModels as Record<string, unknown> | undefined),
        [settings.backend]: settings.model,
      }
    }
  }
  return bag
}

export function withoutSessionOwnedKeys(bag: SettingsBag): SettingsBag {
  const rest = { ...bag }
  for (const key of SESSION_OWNED_KEYS) delete rest[key]
  return rest
}
