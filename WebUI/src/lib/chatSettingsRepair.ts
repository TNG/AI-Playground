import type { llmBackendTypes } from '@/types/shared'

type LlmBackend = (typeof llmBackendTypes)[number]

export type SavedChatSettings = {
  backend?: LlmBackend
  deviceId?: string
  deviceUuid?: string | null
  model?: string
}

export type ChatSettingsAvailability = {
  presetBackends: readonly LlmBackend[]
  presetPreferredModels?: Partial<Record<LlmBackend, string>>
  cloudEnabled: boolean
  runningBackends: readonly LlmBackend[]
  devices: (backend: LlmBackend) => readonly { id: string; uuid?: string | null }[]
  models: readonly { name: string; type: string }[]
}

export type RepairedChatSettings = {
  backend: LlmBackend | undefined
  /** Device to select; undefined leaves the current selection alone. */
  deviceId: string | undefined
  /** Model to select; undefined leaves the choice to the model picker. */
  model: string | undefined
}

/** The silent repair a preset load applies to saved backend, device and model choices. */
export function repairChatSettings(
  saved: SavedChatSettings,
  available: ChatSettingsAvailability,
): RepairedChatSettings {
  const backend = repairBackend(saved.backend, available)
  return {
    backend,
    deviceId: backend ? repairDevice(saved, available.devices(backend)) : undefined,
    model: backend ? repairModel(saved.model, backend, available) : undefined,
  }
}

function repairBackend(
  saved: LlmBackend | undefined,
  available: ChatSettingsAvailability,
): LlmBackend | undefined {
  // Cloud is feature-flagged and offered for any chat preset, so presets rarely list it.
  const cloudAllowed = saved === 'cloud' && available.cloudEnabled
  if (saved !== undefined && (available.presetBackends.includes(saved) || cloudAllowed)) {
    return saved
  }
  const backends = available.presetBackends
  if (backends.length === 0) return undefined
  if (backends.length === 1) return backends[0]
  return backends.find((b) => available.runningBackends.includes(b)) ?? backends[0]
}

function repairDevice(
  saved: SavedChatSettings,
  devices: readonly { id: string; uuid?: string | null }[],
): string | undefined {
  if (saved.deviceId === undefined) return devices.find((d) => d.id.includes('GPU'))?.id
  const byUuid = saved.deviceUuid
    ? devices.find((d) => d.uuid != null && d.uuid === saved.deviceUuid)
    : undefined
  if (byUuid) return byUuid.id
  return devices.some((d) => d.id === saved.deviceId) ? saved.deviceId : undefined
}

function repairModel(
  saved: string | undefined,
  backend: LlmBackend,
  available: ChatSettingsAvailability,
): string | undefined {
  const exists = (name: string) =>
    available.models.some((m) => m.name === name && m.type === backend)
  if (saved !== undefined) return exists(saved) ? saved : undefined
  const preferred = available.presetPreferredModels?.[backend]
  return preferred && exists(preferred) ? preferred : undefined
}
